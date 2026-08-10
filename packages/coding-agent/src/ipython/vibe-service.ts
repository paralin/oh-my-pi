import { truncateHeadBytes } from "../session/streaming-output-constants";
import type { ToolSession } from "../session/tool-session";
import type {
	VibeCli,
	VibeKillOutcome,
	VibeScreenSnapshot,
	VibeSendOutcome,
	VibeSessionRegistry,
	VibeSpawnOutcome,
	VibeWaitOutcome,
} from "../vibe/runtime";
import { VibeSessionRegistry as RuntimeVibeSessionRegistry } from "../vibe/runtime";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_NAME_CHARS = 48;
const MAX_ID_CHARS = 128;
const MAX_PROMPT_CHARS = 65_536;
const MAX_MESSAGE_CHARS = 65_536;
const MAX_WAIT_SECONDS = 3_600;
const MAX_SESSIONS = 64;
const MAX_SCREENS = 64;
const MAX_RESULT_TEXT_BYTES = 4 * 1024;

type VibeRegistry = Pick<VibeSessionRegistry, "spawn" | "send" | "wait" | "kill" | "screens">;

function strictObject(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function requiredText(data: Readonly<Record<string, unknown>>, name: string, maxChars: number): string {
	const value = data[name];
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string`);
	if (value.length > maxChars) throw new RangeError(`${name} is too large`);
	return value.trim();
}

function optionalText(data: Readonly<Record<string, unknown>>, name: string, maxChars: number): string | undefined {
	if (data[name] === undefined) return undefined;
	return requiredText(data, name, maxChars);
}

function waitWithAbort<T>(signal: AbortSignal, invoke: () => Promise<T>): Promise<T> {
	signal.throwIfAborted();
	const { promise, reject } = Promise.withResolvers<T>();
	const onAbort = () =>
		reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([invoke(), promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

function boundedText(value: string | undefined, maxChars: number): string | undefined {
	if (value === undefined) return undefined;
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function boundedScreens(screens: readonly VibeScreenSnapshot[]): readonly Readonly<Record<string, unknown>>[] {
	return screens.slice(0, MAX_SCREENS).map(screen => ({
		id: boundedText(screen.id, MAX_ID_CHARS),
		cli: screen.cli,
		state: screen.state,
		model: boundedText(screen.model, 256),
		turns: screen.turns,
		queued: screen.queued,
		turn_started_at: screen.turnStartedAt,
		turn_message: boundedText(screen.turnMessage, 256),
		current_tool: boundedText(screen.currentTool, 256),
		current_tool_args: boundedText(screen.currentToolArgs, 256),
		last_intent: boundedText(screen.lastIntent, 256),
		trace: screen.trace.slice(0, 6).map(line => boundedText(line, 256) ?? ""),
		output_tail: screen.outputTail.slice(0, 3).map(line => boundedText(line, 256) ?? ""),
		last_activity: boundedText(screen.lastActivity, 256),
		last_activity_at: screen.lastActivityAt,
	}));
}

function spawnInput(data: Readonly<Record<string, unknown>>): { cli: VibeCli; name?: string; prompt: string } {
	strictObject(data, ["cli", "name", "prompt"]);
	const cli = data.cli;
	if (cli !== "fast" && cli !== "good") throw new TypeError("cli must be fast or good");
	return {
		cli,
		name: optionalText(data, "name", MAX_NAME_CHARS),
		prompt: requiredText(data, "prompt", MAX_PROMPT_CHARS),
	};
}

function sendInput(data: Readonly<Record<string, unknown>>): { session: string; message: string } {
	strictObject(data, ["session", "message"]);
	return {
		session: requiredText(data, "session", MAX_ID_CHARS),
		message: requiredText(data, "message", MAX_MESSAGE_CHARS),
	};
}

function waitInput(data: Readonly<Record<string, unknown>>): { sessions?: string[]; timeoutMs?: number } {
	strictObject(data, ["sessions", "timeout_seconds"]);
	let sessions: string[] | undefined;
	if (data.sessions !== undefined) {
		if (!Array.isArray(data.sessions) || data.sessions.length > MAX_SESSIONS) {
			throw new TypeError(`sessions must contain at most ${MAX_SESSIONS} items`);
		}
		sessions = data.sessions.map((value, index) => {
			if (typeof value !== "string") throw new TypeError(`sessions[${index}] must be a string`);
			return requiredText({ session: value }, "session", MAX_ID_CHARS);
		});
		if (new Set(sessions).size !== sessions.length) throw new TypeError("sessions must be unique");
	}
	const timeout = data.timeout_seconds;
	if (timeout === undefined) return { sessions };
	if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_WAIT_SECONDS) {
		throw new RangeError(`timeout_seconds must be between 0 and ${MAX_WAIT_SECONDS}`);
	}
	return { sessions, timeoutMs: Math.max(1, Math.round(timeout * 1_000)) };
}

function killInput(data: Readonly<Record<string, unknown>>): string {
	strictObject(data, ["session"]);
	return requiredText(data, "session", MAX_ID_CHARS);
}

export interface IpythonVibeServiceOptions {
	readonly session: ToolSession;
	readonly registry?: VibeRegistry;
}

/** Typed IPython boundary for Vibe's task-backed, addressable worker registry. */
export class IpythonVibeService {
	readonly handlers: IpythonHostHandlers;
	readonly #registry: VibeRegistry;

	constructor(private readonly options: IpythonVibeServiceOptions) {
		this.#registry = options.registry ?? RuntimeVibeSessionRegistry.global();
		this.handlers = {
			"vibe.spawn": request => this.#spawn(request),
			"vibe.send": request => this.#send(request),
			"vibe.wait": request => this.#wait(request),
			"vibe.kill": request => this.#kill(request),
			"vibe.list": request => this.#list(request),
		};
	}

	async #spawn(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		request.signal.throwIfAborted();
		const input = spawnInput(request.data);
		await request.publishProgress("Vibe worker spawn started", { cli: input.cli });
		const outcome: VibeSpawnOutcome = await this.#registry.spawn(this.options.session, input);
		request.signal.throwIfAborted();
		await request.publishProgress("Vibe worker spawn scheduled", { session: outcome.id, job_id: outcome.jobId });
		return { id: outcome.id, cli: input.cli, job_id: outcome.jobId };
	}

	async #send(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		request.signal.throwIfAborted();
		const input = sendInput(request.data);
		await request.publishProgress("Vibe message started", { session: input.session });
		const outcome: VibeSendOutcome = await this.#registry.send(this.options.session, input);
		request.signal.throwIfAborted();
		await request.publishProgress("Vibe message accepted", { session: outcome.id, mode: outcome.mode });
		return { id: outcome.id, mode: outcome.mode, ...(outcome.jobId ? { job_id: outcome.jobId } : {}) };
	}

	async #wait(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		request.signal.throwIfAborted();
		const input = waitInput(request.data);
		await request.publishProgress("Vibe wait started", { sessions: input.sessions ?? [] });
		const outcome: VibeWaitOutcome = await waitWithAbort(
			request.signal,
			async () => await this.#registry.wait(this.options.session, { ...input, signal: request.signal }),
		);
		request.signal.throwIfAborted();
		await request.publishProgress("Vibe wait completed", {
			settled: outcome.settled.length,
			running: outcome.stillRunning.length,
		});
		const settled = outcome.settled.slice(0, MAX_SESSIONS);
		const running = outcome.stillRunning.slice(0, MAX_SESSIONS);
		return {
			settled: settled.map(entry => ({
				id: boundedText(entry.id, MAX_ID_CHARS) ?? "",
				job_id: boundedText(entry.jobId, MAX_ID_CHARS) ?? "",
				status: entry.status,
				result_text: truncateHeadBytes(entry.resultText, MAX_RESULT_TEXT_BYTES).text,
			})),
			settled_truncated: outcome.settled.length > settled.length,
			settled_omitted: outcome.settled.length - settled.length,
			still_running: running.map(id => boundedText(id, MAX_ID_CHARS) ?? ""),
			still_running_truncated: outcome.stillRunning.length > running.length,
			timed_out: outcome.timedOut,
		};
	}

	async #kill(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		request.signal.throwIfAborted();
		const session = killInput(request.data);
		await request.publishProgress("Vibe worker termination started", { session });
		const outcome: VibeKillOutcome = await this.#registry.kill(this.options.session, session);
		request.signal.throwIfAborted();
		await request.publishProgress("Vibe worker terminated", {
			session: outcome.id,
			cancelled_turn: outcome.cancelledTurn,
		});
		return { id: outcome.id, cancelled_turn: outcome.cancelledTurn };
	}

	async #list(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strictObject(request.data, []);
		request.signal.throwIfAborted();
		const screens = this.#registry.screens(this.options.session);
		return { sessions: boundedScreens(screens), truncated: screens.length > MAX_SCREENS };
	}
}
