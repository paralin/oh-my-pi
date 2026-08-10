import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { Type } from "../extensibility/legacy-typebox";
import type { IpythonHostRequestChannel } from "../ipython/controller";
import type { AgentSessionEvent, AgentSessionEventListener } from "./agent-session-events";
import type { SessionManager } from "./session-manager";

const ACT_TOOL_NAME = "shared_ipython";

export const ACT_SYSTEM_PROMPT = `You are the retained low-level Act actor working inside the directing model's live IPython world.

Use the shared_ipython tool for every inspection and action. Each call runs one complete IPython cell in the directing session's existing namespace. Calls are serialized. Variables, files, processes, and root-authorized host capabilities are the real shared world, not a copy. Treat named variables as the handoff between you and the directing model: reuse objects already in the namespace, and leave useful intermediate state or results in clear variable names so the director can inspect and continue them after you return.

Finish the assigned task only by executing rlm.done(value) in a shared_ipython cell. The value remains in the root kernel and returns to the calling actor with exact Python identity. A normal text response does not complete the Act. Do not call rlm.done from a detached task. Do not spawn ordinary RLM children or ask for user input. Prefer actions that take about 30 seconds to 5 minutes.`;

export interface ActLaneResult {
	outcome: "done" | "text" | "cancelled";
	text?: string;
}

export interface ActLaneTarget {
	sessionKey: string;
	createSession(tool: AgentTool, signal: AbortSignal): Promise<ActPrivateSession>;
}

export interface ActPrivateSession {
	readonly model?: { provider: string; id: string; name?: string };
	readonly thinkingLevel?: string;
	readonly messages: readonly AgentMessage[];
	readonly sessionManager: Pick<SessionManager, "getEntries">;
	prompt(
		text: string,
		options: {
			expandPromptTemplates: false;
			synthetic: true;
			suppressAutonomousContinuation: true;
			signal: AbortSignal;
		},
	): Promise<unknown>;
	subscribe(listener: AgentSessionEventListener): () => void;
	abort(): void | Promise<void>;
	dispose(): void | Promise<void>;
	getLastAssistantText(): string | undefined;
}

type BeforeActPrompt = (state: {
	sessionKey: string;
	usage: Usage;
	model?: { provider: string; id: string; name?: string };
	thinkingLevel?: string;
}) => void;

export type ActLaneProgress =
	| { type: "assistant_delta"; stream: "thinking" | "text"; text: string }
	| { type: "cell_start"; cellId: string; code: string }
	| {
			type: "cell_terminal";
			cellId: string;
			durationMs?: number;
			status: "ok" | "error" | "cancelled";
			stdout: string;
			stderr: string;
			result?: string;
			error?: string;
	  };

type ActProgressHandler = (progress: ActLaneProgress) => void;

interface ActiveAct {
	channel: IpythonHostRequestChannel;
	controller: AbortController;
	completed: boolean;
	cellActive: boolean;
	abort(): void;
}

interface ActCellResult {
	type: "cell_result";
	durationMs?: number;
	stdout?: string | null;
	stderr?: string | null;
	result?: string | null;
	error?: string | null;
}

function parseCellResult(response: Readonly<Record<string, unknown>>): ActCellResult {
	if (response.type !== "cell_result") throw new Error("Act returned an unexpected cell response");
	if (response.durationMs !== undefined && typeof response.durationMs !== "number") {
		throw new Error("Act cell response has invalid durationMs");
	}
	for (const field of ["stdout", "stderr", "result", "error"] as const) {
		const value = response[field];
		if (value !== undefined && value !== null && typeof value !== "string") {
			throw new Error(`Act cell response has invalid ${field}`);
		}
	}
	return {
		type: "cell_result",
		...(typeof response.durationMs === "number" ? { durationMs: response.durationMs } : {}),
		...(typeof response.stdout === "string" || response.stdout === null ? { stdout: response.stdout } : {}),
		...(typeof response.stderr === "string" || response.stderr === null ? { stderr: response.stderr } : {}),
		...(typeof response.result === "string" || response.result === null ? { result: response.result } : {}),
		...(typeof response.error === "string" || response.error === null ? { error: response.error } : {}),
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const field = value?.[key];
	return typeof field === "string" ? field : undefined;
}

function toolResultText(value: unknown): string | undefined {
	const content = asRecord(value)?.content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.flatMap(block => {
			const item = asRecord(block);
			return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
		})
		.join("\n");
	return text || undefined;
}

function subscribeActProgress(
	session: ActPrivateSession,
	emit: ActProgressHandler,
	isCancelled: () => boolean,
	isCompleted: () => boolean,
): () => void {
	let cellSequence = 0;
	const cellIds = new Map<string, string>();
	return session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_update" && event.message.role === "assistant") {
			if (event.assistantMessageEvent.type === "thinking_delta" && event.assistantMessageEvent.delta) {
				emit({ type: "assistant_delta", stream: "thinking", text: event.assistantMessageEvent.delta });
			} else if (event.assistantMessageEvent.type === "text_delta" && event.assistantMessageEvent.delta) {
				emit({ type: "assistant_delta", stream: "text", text: event.assistantMessageEvent.delta });
			}
			return;
		}
		if (event.type === "tool_execution_start" && event.toolName === ACT_TOOL_NAME) {
			const args = asRecord(event.args);
			if (typeof args?.code !== "string") return;
			const cellId = `cell-${++cellSequence}`;
			cellIds.set(event.toolCallId, cellId);
			emit({ type: "cell_start", cellId, code: args.code });
			return;
		}
		if (event.type !== "tool_execution_end" || event.toolName !== ACT_TOOL_NAME) return;
		const cellId = cellIds.get(event.toolCallId);
		if (!cellId) return;
		cellIds.delete(event.toolCallId);
		const details = asRecord(asRecord(event.result)?.details);
		const completed = isCompleted() || details?.outcome === "done";
		const detailError = stringField(details, "error");
		const error = completed ? undefined : (detailError ?? (event.isError ? toolResultText(event.result) : undefined));
		emit({
			type: "cell_terminal",
			cellId,
			...(typeof details?.durationMs === "number" ? { durationMs: details.durationMs } : {}),
			status: completed ? "ok" : isCancelled() ? "cancelled" : detailError || event.isError ? "error" : "ok",
			stdout: stringField(details, "stdout") ?? "",
			stderr: stringField(details, "stderr") ?? "",
			...(stringField(details, "result") !== undefined ? { result: stringField(details, "result") } : {}),
			...(error ? { error } : {}),
		});
	});
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function actUsageFromSessionManager(sessionManager: Pick<SessionManager, "getEntries">): Usage {
	const usage = emptyUsage();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const current = entry.message.usage;
		usage.input += current.input;
		usage.output += current.output;
		usage.cacheRead += current.cacheRead;
		usage.cacheWrite += current.cacheWrite;
		usage.totalTokens += current.totalTokens;
		usage.cost.input += current.cost.input;
		usage.cost.output += current.cost.output;
		usage.cost.cacheRead += current.cost.cacheRead;
		usage.cost.cacheWrite += current.cost.cacheWrite;
		usage.cost.total += current.cost.total;
	}
	return usage;
}

function usageFromSession(session: ActPrivateSession): Usage {
	return actUsageFromSessionManager(session.sessionManager);
}

function formatCellResult(result: ActCellResult): string {
	const sections = [result.stdout, result.stderr, result.result, result.error].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	return sections.join("\n").trim() || "Cell completed without output.";
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function waitWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError(signal));
	const { promise, reject } = Promise.withResolvers<T>();
	const onAbort = () => reject(abortError(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([work, promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

/** Retains one private session per resolved model and admits one root Act at a time. */
export class ActLane {
	readonly #sessions = new Map<string, ActPrivateSession>();
	#session: ActPrivateSession | undefined;
	#active: ActiveAct | undefined;
	readonly #idleWaiters = new Set<() => void>();
	#lifecycleEpoch = 0;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	async run(
		prompt: string,
		channel: IpythonHostRequestChannel,
		target: ActLaneTarget,
		beforePrompt?: BeforeActPrompt,
		onAdmitted?: () => void,
		onProgress?: ActProgressHandler,
	): Promise<ActLaneResult> {
		if (this.#disposed) throw new Error("Act lane has been disposed");
		if (this.#active) throw new Error("Another Act is already active in this session");
		const controller = new AbortController();
		let active!: ActiveAct;
		const abort = () => {
			if (controller.signal.aborted) return;
			void this.#session?.abort();
			controller.abort();
		};
		active = { channel, controller, completed: false, cellActive: false, abort };
		this.#active = active;
		onAdmitted?.();
		const abortFromChannel = () => abort();
		channel.signal.addEventListener("abort", abortFromChannel, { once: true });
		if (channel.signal.aborted) abortFromChannel();
		try {
			if (controller.signal.aborted) return { outcome: "cancelled" };
			const session = await this.#getSession(target, controller.signal);
			if (controller.signal.aborted) return { outcome: "cancelled" };
			beforePrompt?.({
				sessionKey: target.sessionKey,
				usage: usageFromSession(session),
				model: session.model ? { ...session.model } : undefined,
				thinkingLevel: session.thinkingLevel,
			});
			const unsubscribe = onProgress
				? subscribeActProgress(
						session,
						onProgress,
						() => controller.signal.aborted,
						() => active.completed,
					)
				: () => {};
			try {
				await session.prompt(prompt, {
					expandPromptTemplates: false,
					synthetic: true,
					suppressAutonomousContinuation: true,
					signal: controller.signal,
				});
			} catch (error) {
				if (!active.completed && !controller.signal.aborted) throw error;
			} finally {
				unsubscribe();
			}
			if (active.completed) return { outcome: "done" };
			if (controller.signal.aborted) return { outcome: "cancelled" };
			const lastAssistant = session.messages
				.slice()
				.reverse()
				.find(message => message.role === "assistant");
			if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error") {
				throw new Error(lastAssistant.errorMessage || "Act provider failed");
			}
			return { outcome: "text", text: session.getLastAssistantText() ?? "" };
		} catch (error) {
			if (controller.signal.aborted) return { outcome: "cancelled" };
			throw error;
		} finally {
			channel.signal.removeEventListener("abort", abortFromChannel);
			if (this.#active === active) {
				this.#active = undefined;
				for (const resolve of this.#idleWaiters) resolve();
				this.#idleWaiters.clear();
			}
		}
	}

	cancel(): boolean {
		if (!this.#active) return false;
		this.#active.abort();
		return true;
	}

	waitForIdle(): Promise<void> {
		if (!this.#active) return Promise.resolve();
		return new Promise(resolve => this.#idleWaiters.add(resolve));
	}

	get usage(): Usage {
		return this.#session ? usageFromSession(this.#session) : emptyUsage();
	}

	get model(): { provider: string; id: string; name?: string } | undefined {
		return this.#session?.model ? { ...this.#session.model } : undefined;
	}

	get thinkingLevel(): string | undefined {
		return this.#session?.thinkingLevel;
	}

	get running(): boolean {
		return this.#active !== undefined;
	}

	get cellRunning(): boolean {
		return this.#active?.cellActive ?? false;
	}

	async reset(): Promise<void> {
		if (this.#disposed) return;
		this.#lifecycleEpoch++;
		this.cancel();
		await this.waitForIdle();
		await this.#disposeRetainedSessions();
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#lifecycleEpoch++;
		this.cancel();
		this.#disposePromise = this.waitForIdle().then(() => this.#disposeRetainedSessions());
		return this.#disposePromise;
	}

	async #disposeRetainedSessions(): Promise<void> {
		const sessions = [...this.#sessions.values()];
		this.#sessions.clear();
		this.#session = undefined;
		await Promise.allSettled(sessions.map(session => Promise.resolve(session.dispose())));
	}

	async #getSession(target: ActLaneTarget, signal: AbortSignal): Promise<ActPrivateSession> {
		const epoch = this.#lifecycleEpoch;
		const retained = this.#sessions.get(target.sessionKey);
		if (retained) {
			this.#session = retained;
			return retained;
		}
		this.#session = undefined;
		const creation = target.createSession(this.#createTool(), signal);
		let session: ActPrivateSession;
		try {
			session = await waitWithSignal(creation, signal);
		} catch (error) {
			void creation.then(
				created => Promise.resolve(created.dispose()),
				() => undefined,
			);
			throw error;
		}
		if (signal.aborted || this.#disposed || epoch !== this.#lifecycleEpoch) {
			await session.dispose();
			throw signal.aborted
				? abortError(signal)
				: new Error(this.#disposed ? "Act lane has been disposed" : "Act lane session was reset");
		}
		this.#sessions.set(target.sessionKey, session);
		this.#session = session;
		return session;
	}

	#createTool(): AgentTool {
		return {
			name: ACT_TOOL_NAME,
			label: "Shared IPython",
			description: "Run one complete cell in the directing session's live IPython namespace.",
			parameters: Type.Object({ code: Type.String() }),
			execute: async (_toolCallId, parameters) => {
				const active = this.#active;
				if (!active) throw new Error("No Act is active");
				if (active.cellActive) throw new Error("An Act cell is already active");
				const code =
					typeof parameters === "object" && parameters !== null && "code" in parameters
						? parameters.code
						: undefined;
				if (typeof code !== "string") throw new Error("shared_ipython requires string code");
				active.cellActive = true;
				try {
					await active.channel.send({ type: "cell", code });
					const response = await active.channel.receive(active.controller.signal);
					if (response.type === "done") {
						active.completed = true;
						void this.#session?.abort();
						return {
							content: [{ type: "text" as const, text: "Act completed with an in-kernel value." }],
							details: { outcome: "done" },
						};
					}
					const result = parseCellResult(response);
					return {
						content: [{ type: "text" as const, text: formatCellResult(result) }],
						details: result,
					};
				} finally {
					active.cellActive = false;
				}
			},
		};
	}
}
