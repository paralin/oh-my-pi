import { type } from "@oh-my-pi/omptype";
import type { AgentIdentity, AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { escapeXmlAttribute, escapeXmlText } from "@oh-my-pi/pi-utils";

export type AdvisorSeverity = "nit" | "concern" | "blocker";

/** One queued advice note. */
export interface AdvisorNote {
	note: string;
	severity?: AdvisorSeverity;
	/** Which configured advisor produced this note (omitted for the default advisor). */
	advisor?: string;
}

/** Details payload on the batched `advisor` custom message rendered in the transcript. */
export interface AdvisorMessageDetails {
	notes: AdvisorNote[];
}

/**
 * Behavioral framing for the watched agent — advice, not orders. Carried as a
 * tag attribute (rather than a prose header) so the rendered agent-facing output
 * stays a clean `<advisory>` block. The primary agent's system prompt never
 * mentions advisories, so this is its only cue for how to treat them.
 */
const ADVISOR_GUIDANCE = "weigh, don't blindly obey";

/**
 * Render a batch of advisor notes as the agent-facing message body: one
 * `<advisory>` element per note, severity as an attribute. Shared by the
 * non-interrupting YieldQueue dispatcher and the interrupting steer path so both
 * build byte-identical content.
 */
export function formatAdvisorBatchContent(notes: readonly AdvisorNote[]): string {
	return notes
		.map(n => {
			const severity = n.severity ? ` severity="${n.severity}"` : "";
			const who = n.advisor ? ` advisor="${escapeXmlAttribute(n.advisor)}"` : "";
			return `<advisory${who}${severity} guidance="${ADVISOR_GUIDANCE}">\n${escapeXmlText(n.note)}\n</advisory>`;
		})
		.join("\n");
}

/**
 * Whether advice at this severity should interrupt the running agent (delivered
 * via the steering channel, aborting in-flight tools) rather than ride the
 * non-interrupting aside queue that lands at the next step boundary. `concern`
 * and `blocker` interrupt; a plain `nit` queues.
 */
export function isInterruptingSeverity(severity: AdvisorSeverity | undefined): boolean {
	return severity === "concern" || severity === "blocker";
}

/** How an advisor note is routed to the primary. */
export type AdvisorDeliveryChannel = "aside" | "steer" | "preserve";
/** Half-open turn-count fence for the post-interrupt cooldown. */
export function isAdvisorInterruptImmuneTurnActive(opts: {
	completedTurns: number;
	immuneTurnStart: number | undefined;
	immuneTurns: number;
}): boolean {
	if (opts.immuneTurnStart === undefined || opts.immuneTurns <= 0) return false;
	return opts.completedTurns < opts.immuneTurnStart + opts.immuneTurns;
}

/**
 * Decide how one advisor note reaches the primary agent.
 *
 * - A `preserveOnly` caller records every note that arrives while the primary
 *   is idle as a visible card and never starts a new primary turn.
 * - A non-interrupting `nit` always rides the non-interrupting aside queue.
 * - An interrupting `concern`/`blocker` is normally steered into the agent: into
 *   the live turn while one is streaming, or (when idle) a triggered turn so the
 *   advice is acted on immediately.
 * - If the primary tail is already a terminal text answer and there is no queued
 *   work, a late `concern` is preserved as a visible card instead of waking the
 *   primary to restate completion. A `blocker` is the exception: it means the
 *   agent handed off broken or unexercised work, so it still steers a triggered
 *   turn to force the primary to acknowledge and continue before the turn is
 *   considered done (#5628) — deferring it to the next user turn is the bug.
 * - After a deliberate user interrupt (`autoResumeSuppressed`) the advisor must
 *   not auto-resume the stopped run. While the agent is idle — or still tearing
 *   the interrupted turn down (`aborting`) — the note is preserved as a visible
 *   card instead of restarting the run. But once a turn is actively streaming
 *   again (a resume the user already drove), steering the note in does NOT
 *   auto-resume anything, so it is delivered live. Parking it during an active
 *   run instead strands it (it never reaches the running agent) and the withheld
 *   notes dump as one burst at the next user prompt — the bug this guards.
 * - During the post-interrupt immune-turn window, further `concern`/`blocker`
 *   notes are downgraded to asides; preservation still wins.
 */
export function resolveAdvisorDeliveryChannel(opts: {
	severity: AdvisorSeverity | undefined;
	autoResumeSuppressed: boolean;
	streaming: boolean;
	aborting: boolean;
	terminalAnswerNoQueuedWork?: boolean;
	interruptImmuneTurnActive?: boolean;
	preserveOnly?: boolean;
}): AdvisorDeliveryChannel {
	if (opts.preserveOnly && !opts.streaming) return "preserve";
	if (!isInterruptingSeverity(opts.severity)) return "aside";
	if (opts.autoResumeSuppressed && (opts.aborting || !opts.streaming)) return "preserve";
	if (opts.terminalAnswerNoQueuedWork && opts.severity !== "blocker" && !opts.streaming && !opts.aborting)
		return "preserve";
	if (opts.interruptImmuneTurnActive) return "aside";
	return "steer";
}

/**
 * Derive the advisor loop's telemetry from the primary session's config so the
 * advisor model's GenAI spans and usage/cost hooks (onChatUsage, onCostDelta,
 * costEstimator) fire under the same pipeline as every other model call —
 * stamped with the advisor's own agent identity. `conversationId` is cleared so
 * the advisor loop falls back to its own `-advisor` session id for
 * `gen_ai.conversation.id` instead of inheriting the primary's conversation.
 *
 * Returns undefined when the primary has no telemetry (instrumentation off), so
 * the advisor `Agent` stays a zero-overhead no-op as well.
 */
export function deriveAdvisorTelemetry(
	primaryTelemetry: AgentTelemetryConfig | undefined,
	identity: AgentIdentity,
): AgentTelemetryConfig | undefined {
	if (!primaryTelemetry) return undefined;
	return { ...primaryTelemetry, agent: identity, conversationId: undefined };
}

const adviceResponseSchema = type({
	note: "string",
	"severity?": "'nit' | 'concern' | 'blocker'",
});

export type AdviceSubmissionResult = "delivered" | "duplicate" | "withheld" | "silence";

function advisorNoteDedupeKey(note: string): string {
	return note.trim().replace(/\s+/g, " ");
}

const ADVISOR_SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };

function advisorSeverityRank(severity: AdvisorSeverity | undefined): number {
	return ADVISOR_SEVERITY_RANK[severity ?? "nit"];
}

/**
 * Validates and accepts the advisor model's final JSON response.
 *
 * The provider sees no tool or tool schema. A response is either
 * `{"note": null}` for silence or one object containing a note and optional
 * severity. This host-owned sink preserves delivery policy without exposing
 * the primary session as an executable advisor action channel.
 */
export class AdviceSink {
	#deliveredNoteSeverities = new Map<string, number>();
	#inProgressUpdate = false;

	constructor(private readonly onAdvice: (note: string, severity?: AdvisorSeverity) => void) {}

	beginUpdate(inProgress: boolean): void {
		this.#inProgressUpdate = inProgress;
	}

	reset(): void {
		this.#deliveredNoteSeverities.clear();
		this.#inProgressUpdate = false;
	}

	submit(response: string): AdviceSubmissionResult {
		if (!response.trim()) return "silence";
		let parsed: unknown;
		try {
			parsed = JSON.parse(response);
		} catch {
			throw new Error("Advisor final response must be one JSON object");
		}
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			"note" in parsed &&
			parsed.note === null &&
			Object.keys(parsed).length === 1
		) {
			return "silence";
		}

		const result = adviceResponseSchema(parsed);
		if (result instanceof type.errors) {
			throw new Error(`Invalid advisor final response: ${result.summary}`);
		}
		if (!result.note.trim()) throw new Error("Invalid advisor final response: note must not be empty");
		if (this.#inProgressUpdate && result.severity !== "blocker") return "withheld";

		const key = advisorNoteDedupeKey(result.note);
		const rank = advisorSeverityRank(result.severity);
		const previousRank = this.#deliveredNoteSeverities.get(key) ?? 0;
		if (rank <= previousRank) return "duplicate";

		this.#deliveredNoteSeverities.set(key, rank);
		this.onAdvice(result.note, result.severity);
		return "delivered";
	}
}
