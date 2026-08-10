import { existsSync } from "node:fs";
import * as path from "node:path";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { ttsrHelp as commandHelp } from "../cli/command-help";
import { runTtsrCommand, TTSR_ACTIONS, TTSR_SOURCES, type TtsrCommandArgs, type TtsrTestArgs } from "../cli/ttsr-cli";
import type { TtsrMatchSource } from "../export/ttsr";

/** Inspect and test regex TTSR rules against text, thinking, or IPython code. */
export default class Ttsr extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({ description: "TTSR action", required: false, options: TTSR_ACTIONS }),
		snippet: Args.string({ description: "Inline snippet text to test", required: false }),
	};
	static flags = {
		file: Flags.string({ description: "Snippet file path, or - for stdin (ttsr test)" }),
		rule: Flags.string({ char: "r", description: "Rule markdown file to test in isolation" }),
		source: Flags.string({ description: "Match source: text, thinking, or tool", options: TTSR_SOURCES }),
		tool: Flags.string({ description: "Tool name when source is tool; only ipython is supported" }),
		verbose: Flags.boolean({ char: "v", description: "Show every evaluated rule, not just triggered ones" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};
	static examples = [
		"omp ttsr list",
		"omp ttsr test 'const x: any = 1'",
		"omp ttsr test --source thinking 'I will use any'",
		"omp ttsr test --source tool --tool ipython 'const x: any = 1'",
		"omp ttsr test --rule .omp/rules/no-any.md --source tool --tool ipython 'const x: any = 1'",
		"echo 'Box::leak(&mut v)' | omp ttsr test --file - --source tool",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Ttsr);
		const action = (args.action ?? "list") as (typeof TTSR_ACTIONS)[number];
		let file = flags.file;
		let snippet = args.snippet;
		if (action === "test" && snippet && !file && existsSync(path.resolve(snippet))) {
			file = path.resolve(snippet);
			snippet = undefined;
		}
		const test: TtsrTestArgs | undefined =
			action === "test"
				? {
						snippet,
						file,
						rule: flags.rule,
						source: flags.source as TtsrMatchSource | undefined,
						tool: flags.tool,
						verbose: flags.verbose,
					}
				: undefined;
		const command: TtsrCommandArgs = { action, test, json: flags.json };
		await runTtsrCommand(command);
	}
}
