import { type IrcMessage, PermanentIrcDeliveryError } from "../irc/bus";
import type { AgentPeer } from "../registry/agent-registry";
import type { ClaudeCodeQuery } from "./claude-code-sdk";

/** Terminal abort evidence consumed by the Task result owner. */
export interface ClaudeCodePeerAbortState {
	aborted: boolean;
	reason?: string;
}

interface ClaudeCodeQueryCloseFailure {
	error: unknown;
}
/** One live Claude Code query registered as an OMP peer. */
export class ClaudeCodePeer implements AgentPeer {
	readonly messages: unknown[];
	readonly #abortController: AbortController;
	#query: ClaudeCodeQuery | undefined;
	#disposePromise: Promise<void> | undefined;
	#abortState: ClaudeCodePeerAbortState = { aborted: false };
	#queryCloseAttempted = false;
	#queryCloseFailure: ClaudeCodeQueryCloseFailure | undefined;

	constructor(prompt: string, abortController: AbortController) {
		this.#abortController = abortController;
		this.messages = [{ role: "user", content: prompt, timestamp: Date.now() }];
	}

	get abortState(): Readonly<ClaudeCodePeerAbortState> {
		return this.#abortState;
	}

	get queryClosed(): boolean {
		return this.#queryCloseAttempted && !this.#queryCloseFailure;
	}

	get queryCloseFailure(): Readonly<ClaudeCodeQueryCloseFailure> | undefined {
		return this.#queryCloseFailure;
	}

	/** Attach the constructed query unless teardown started while the SDK was starting. */
	attachQuery(query: ClaudeCodeQuery): boolean {
		if (this.#disposePromise) {
			this.#closeQuery(query);
			return false;
		}
		if (this.#query) {
			this.#closeQuery(query);
			return false;
		}
		this.#query = query;
		return true;
	}

	recordAssistantText(text: string): void {
		this.messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });
	}

	async deliverIrcMessage(_message: IrcMessage, _options?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		throw new PermanentIrcDeliveryError("Claude Code peer delivery is unavailable before live mailbox support.");
	}

	async abort(options?: { reason?: string }): Promise<void> {
		if (!this.#disposePromise) {
			this.#abortState = {
				aborted: true,
				...(options?.reason === undefined ? {} : { reason: options.reason }),
			};
			this.#disposePromise = this.#dispose(options?.reason);
		}
		await this.#disposePromise;
	}

	dispose(): Promise<void> {
		this.#disposePromise ??= this.#dispose();
		return this.#disposePromise;
	}

	async #dispose(reason?: string): Promise<void> {
		this.#abortController.abort(reason === undefined ? undefined : new Error(reason));
		const query = this.#query;
		this.#query = undefined;
		if (query) this.#closeQuery(query);
	}

	#closeQuery(query: ClaudeCodeQuery): void {
		this.#queryCloseAttempted = true;
		try {
			query.close();
		} catch (error) {
			this.#queryCloseFailure ??= { error };
		}
	}
}
