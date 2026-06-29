import { replaceTabs, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type {
	AutoCompactionAction,
	AutoCompactionReason,
	MaintenanceTraceDeltaContent,
	MaintenanceTraceFallbackCause,
	MaintenanceTracePhase,
	MaintenanceTraceTerminalResult,
} from "../../extensibility/shared-events";
import { previewLine, shortenPath, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { ChatBlock } from "./chat-block";

export interface MaintenanceTraceCardOptions {
	action: AutoCompactionAction;
	reason: AutoCompactionReason;
	fallbackCause?: MaintenanceTraceFallbackCause;
	targetPath?: string;
	canCancel: boolean;
}

export interface MaintenanceTraceCardTerminalOptions {
	errorMessage?: string;
	willRetry?: boolean;
	debugLogRef?: string;
}

type ScratchPhase = Exclude<MaintenanceTracePhase, "start" | "stream" | "terminal" | "action-fallback">;

const SCRATCH_PHASES = new Set<MaintenanceTracePhase>([
	"scratch-target-resolved",
	"scratch-successor-session-reset",
	"scratch-read-injected",
	"scratch-session-rebuilt",
	"scratch-todo-synced",
]);

/**
 * MaintenanceTraceCard renders context-maintenance work as UI-only transcript
 * state. It never writes session messages; EventController feeds it from
 * maintenance trace events.
 */
export class MaintenanceTraceCard extends ChatBlock {
	#action: AutoCompactionAction;
	#reason: AutoCompactionReason;
	#fallbackCause: MaintenanceTraceFallbackCause | undefined;
	#targetPath: string | undefined;
	#canCancel: boolean;
	#assistantText = "";
	#activityLines: string[] = [];
	#scratchPhases: ScratchPhase[] = [];
	#terminalResult: MaintenanceTraceTerminalResult | undefined;
	#errorMessage: string | undefined;
	#willRetry = false;
	#debugLogRef: string | undefined;

	constructor(options: MaintenanceTraceCardOptions) {
		super();
		this.#action = options.action;
		this.#reason = options.reason;
		this.#fallbackCause = options.fallbackCause;
		this.#targetPath = options.targetPath;
		this.#canCancel = options.canCancel;
	}

	updatePhase(phase: Exclude<MaintenanceTracePhase, "start" | "stream" | "terminal">, targetPath?: string): void {
		if (targetPath !== undefined) this.#targetPath = targetPath;
		if (phase === "action-fallback") {
			this.#action = "context-full";
			this.#fallbackCause = "no-document-handoff-fallback";
		} else if (SCRATCH_PHASES.has(phase) && !this.#scratchPhases.includes(phase as ScratchPhase)) {
			this.#scratchPhases.push(phase as ScratchPhase);
		}
		const activity = this.#phaseActivityLine(phase, targetPath);
		if (activity) this.#appendActivity(activity);
		this.requestRender();
	}

	appendTraceDelta(content: MaintenanceTraceDeltaContent, delta: string): void {
		if (delta.length === 0) return;
		if (content === "activity") this.#appendActivity(delta);
		else this.#assistantText += delta;
		this.requestRender();
	}

	complete(result: MaintenanceTraceTerminalResult, options: MaintenanceTraceCardTerminalOptions = {}): void {
		this.#terminalResult = result;
		this.#errorMessage = options.errorMessage;
		this.#willRetry = options.willRetry === true;
		this.#debugLogRef = options.debugLogRef;
		this.finish();
	}

	override render(width: number): readonly string[] {
		const contentWidth = Math.max(20, width - 2);
		const lines: string[] = [""];
		lines.push(` ${theme.bold(theme.fg("accent", this.#title()))}`);
		lines.push(` ${theme.fg("dim", this.#metadataLine())}`);
		for (const line of this.#wrappedActivityLines(contentWidth)) {
			lines.push(` ${theme.fg("toolOutput", line)}`);
		}
		if (this.#assistantText.trim().length > 0) {
			lines.push(` ${theme.fg("muted", "LLM output:")}`);
			for (const line of this.#wrappedAssistantLines(contentWidth)) {
				lines.push(` ${theme.fg("toolOutput", line)}`);
			}
		}
		if (this.#scratchPhases.length > 0) {
			lines.push(` ${theme.fg("muted", "Scratch continuity:")}`);
			for (const phase of this.#scratchPhases) {
				lines.push(` ${theme.fg("toolOutput", `- ${this.#scratchPhaseLabel(phase)}`)}`);
			}
		}
		if (this.#terminalResult) {
			lines.push(` ${this.#terminalLine()}`);
			if (this.#debugLogRef) {
				const debugRef = previewLine(replaceTabs(this.#debugLogRef), TRUNCATE_LENGTHS.SHORT);
				lines.push(` ${theme.fg("muted", `Debug raw provider frames: ${debugRef}`)}`);
			}
		} else if (this.#canCancel) {
			lines.push(` ${theme.fg("dim", "Esc cancels this maintenance run.")}`);
		}
		return lines;
	}

	#title(): string {
		switch (this.#action) {
			case "scratch-handoff":
				return "Maintenance: scratch continuity";
			case "handoff":
				return "Maintenance model: auto-handoff";
			case "context-full":
				return "Maintenance model: context-full";
			case "snapcompact":
				return "Maintenance model: snapcompact";
			case "shake":
				return "Maintenance: auto-shake";
		}
	}

	#metadataLine(): string {
		const parts = [this.#reasonLabel(), "UI-only"];
		if (this.#fallbackCause) parts.push(`fallback: ${this.#fallbackLabel(this.#fallbackCause)}`);
		if (this.#targetPath) {
			parts.push(`target: ${previewLine(shortenPath(this.#targetPath), TRUNCATE_LENGTHS.SHORT)}`);
		}
		return parts.join(" | ");
	}

	#appendActivity(line: string): void {
		const normalized = line.trim();
		if (normalized.length === 0) return;
		if (this.#activityLines[this.#activityLines.length - 1] === normalized) return;
		this.#activityLines.push(normalized);
	}

	#wrappedActivityLines(width: number): string[] {
		if (this.#activityLines.length === 0) return [];
		const lines = [theme.fg("muted", "Process:")];
		for (const activity of this.#activityLines) {
			const bullet = `- ${previewLine(replaceTabs(activity), TRUNCATE_LENGTHS.CONTENT)}`;
			lines.push(...wrapTextWithAnsi(bullet, Math.max(20, width)));
		}
		return lines;
	}

	#wrappedAssistantLines(width: number): string[] {
		const text = replaceTabs(this.#assistantText).trimEnd();
		if (text.length === 0) return [];
		return wrapTextWithAnsi(text, Math.max(20, width));
	}

	#terminalLine(): string {
		const base = this.#terminalLabel(this.#terminalResult);
		const retry = this.#willRetry ? " Will retry." : "";
		const message = this.#errorMessage
			? ` ${previewLine(replaceTabs(this.#errorMessage), TRUNCATE_LENGTHS.CONTENT)}`
			: "";
		const color = this.#terminalResult === "done" || this.#terminalResult === "skipped" ? "success" : "warning";
		return theme.fg(color, `${base}.${retry}${message}`);
	}

	#reasonLabel(): string {
		switch (this.#reason) {
			case "threshold":
				return "threshold";
			case "overflow":
				return "context overflow";
			case "idle":
				return "idle";
			case "incomplete":
				return "incomplete response";
			case "budget":
				return "goal budget";
			case "manual":
				return "manual";
		}
	}

	#fallbackLabel(cause: MaintenanceTraceFallbackCause): string {
		switch (cause) {
			case "overflow":
				return "overflow";
			case "mid-turn-handoff-suppressed":
				return "mid-turn handoff suppressed";
			case "snapcompact-fallback":
				return "snapcompact fallback";
			case "no-document-handoff-fallback":
				return "handoff produced no document";
			case "idle":
				return "idle";
			case "incomplete-response":
				return "incomplete response";
		}
	}

	#phaseActivityLine(
		phase: Exclude<MaintenanceTracePhase, "start" | "stream" | "terminal">,
		targetPath?: string,
	): string {
		switch (phase) {
			case "action-fallback":
				return `Falling back to ${this.#actionLabel(this.#action)}.`;
			case "scratch-target-resolved": {
				const target = targetPath ?? this.#targetPath;
				const suffix = target ? `: ${previewLine(shortenPath(target), TRUNCATE_LENGTHS.SHORT)}` : "";
				return `Resolved scratch target${suffix}.`;
			}
			case "scratch-successor-session-reset":
				return "Created successor session for scratch handoff.";
			case "scratch-read-injected":
				return "Injected scratch file as the successor session context.";
			case "scratch-session-rebuilt":
				return "Rebuilt model context from the successor session.";
			case "scratch-todo-synced":
				return "Synced todo state into the successor session.";
		}
	}

	#actionLabel(action: AutoCompactionAction): string {
		switch (action) {
			case "scratch-handoff":
				return "scratch handoff";
			case "handoff":
				return "auto-handoff";
			case "context-full":
				return "context-full maintenance";
			case "snapcompact":
				return "snapcompact";
			case "shake":
				return "auto-shake";
		}
	}

	#scratchPhaseLabel(phase: ScratchPhase): string {
		switch (phase) {
			case "scratch-target-resolved":
				return "target resolved";
			case "scratch-successor-session-reset":
				return "successor session reset";
			case "scratch-read-injected":
				return "scratch read injected";
			case "scratch-session-rebuilt":
				return "session rebuilt";
			case "scratch-todo-synced":
				return "todos synced";
		}
	}

	#terminalLabel(result: MaintenanceTraceTerminalResult | undefined): string {
		switch (result) {
			case "done":
				return "Done";
			case "cancelled":
				return "Cancelled";
			case "failed":
				return "Failed";
			case "skipped":
				return "Skipped";
			case "no-progress":
				return "No progress";
			case undefined:
				return "Running";
		}
	}
}
