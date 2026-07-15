/**
 * Register and exchange messages with file-backed IRC peers.
 */
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import {
	ensureIrcAgent,
	readIrcInbox,
	registerIrcAgent,
	resolveIrcAgentId,
	resolveIrcDirectory,
	resolveIrcGeneration,
	sendIrcMessage,
	watchIrcInbox,
} from "../irc/file-bus.js";

const ACTIONS = ["register", "send", "watch"] as const;
type IrcAction = (typeof ACTIONS)[number];

export default class Irc extends Command {
	static description = "Register and exchange messages with file-backed IRC peers";

	static args = {
		action: Args.string({
			description: "IRC action",
			required: false,
			options: ACTIONS,
		}),
		message: Args.string({
			description: "Message body for send",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		dir: Flags.string({ description: "Parent-provided shared IRC directory" }),
		to: Flags.string({ description: "Target peer id" }),
		"reply-to": Flags.string({ description: "Message id being answered" }),
		generation: Flags.string({ description: "Agent generation/instance nonce" }),
		cursor: Flags.integer({ description: "Inbox cursor to replay from", default: 0 }),
		once: Flags.boolean({ description: "Replay the inbox and exit instead of following" }),
	};

	static examples = [
		"OMP_IRC_DIR=/tmp/irc OMP_IRC_AGENT_ID=worker-1 omp irc register",
		"omp irc send --to advisor-1 " + '"Please review this change"',
		"omp irc watch --cursor 12",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Irc);
		if (!args.action) {
			renderCommandHelp("omp", "irc", Irc);
			return;
		}
		const action = args.action as IrcAction;
		const sharedDirectory = resolveIrcDirectory(flags.dir);
		const id = resolveIrcAgentId();
		const generation = resolveIrcGeneration(flags.generation);

		if (action === "register") {
			const registration = await registerIrcAgent(sharedDirectory, id, generation);
			process.stdout.write(`${JSON.stringify(registration)}\n`);
			return;
		}

		const registration = await ensureIrcAgent(sharedDirectory, id, generation);
		if (action === "send") {
			const body = args.message?.join(" ") ?? "";
			if (!flags.to) throw new Error("IRC send requires --to <id>");
			const envelope = await sendIrcMessage({
				sharedDirectory,
				from: registration.id,
				fromGeneration: registration.generation,
				to: flags.to,
				body,
				replyTo: flags["reply-to"],
			});
			process.stdout.write(`${JSON.stringify(envelope)}\n`);
			return;
		}

		if (flags.to) throw new Error("IRC watch reads the inbox for the local agent; --to is not valid");
		if (flags["reply-to"]) throw new Error("IRC watch does not accept --reply-to");
		const watchOptions = { cursor: flags.cursor ?? 0, generation: registration.generation };
		if (flags.once) {
			const result = await readIrcInbox(sharedDirectory, registration.id, watchOptions.cursor);
			for (const event of result.events) process.stdout.write(`${JSON.stringify(event)}\n`);
			return;
		}
		for await (const event of watchIrcInbox(sharedDirectory, registration.id, watchOptions)) {
			process.stdout.write(`${JSON.stringify(event)}\n`);
		}
	}
}
