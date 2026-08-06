import { Container, Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { IpythonCellUpdate } from "../../ipython/cell";
import type { IpythonExecutionEvent } from "../../ipython/controller";
import type { IpythonCellJournalDetail, IpythonJournalDetail } from "../../ipython/journal";
import { highlightCode, theme } from "../theme/theme";

const COLLAPSED_OUTPUT_LINES = 20;
const COLLAPSED_CODE_LINES = 12;
const MAX_DISPLAY_LINE_CHARS = 4_000;

function clampLine(line: string): string {
	if (line.length <= MAX_DISPLAY_LINE_CHARS) return line;
	return `${line.slice(0, MAX_DISPLAY_LINE_CHARS)}… [${line.length - MAX_DISPLAY_LINE_CHARS} chars omitted]`;
}

function statusLabel(detail: IpythonCellJournalDetail): string {
	if (detail.status === "ok") return theme.fg("success", "completed");
	if (detail.status === "aborted") return theme.fg("warning", "aborted");
	return theme.fg("error", "failed");
}

function durationLabel(durationMs: number): string {
	return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(2)}s`;
}

export interface IpythonLiveCellView {
	readonly code: string;
	readonly origin: "model" | "direct";
}

function safeEventText(event: IpythonExecutionEvent): string {
	if (event.kind === "stream") return sanitizeText(event.text);
	if (event.kind === "display") return sanitizeText(event.text);
	if (event.kind === "host_progress") return sanitizeText(`[${event.operation}] ${event.message}`);
	if (event.kind === "error") {
		return sanitizeText(event.traceback.length > 0 ? event.traceback.join("\n") : `${event.ename}: ${event.evalue}`);
	}
	const plain = event.data["text/plain"];
	if (typeof plain === "string") return sanitizeText(plain);
	const mimeTypes = Object.keys(event.data).sort();
	return mimeTypes.length > 0 ? `[result MIME types: ${mimeTypes.join(", ")}]` : "[result data]";
}

/** Renders live or replayed IPython journal details without evaluating rich MIME data. */
export class IpythonCellMessageComponent extends Container {
	readonly #live: { code: string; origin: "model" | "direct"; updates: IpythonCellUpdate[] } | undefined;
	#detail: IpythonJournalDetail | undefined;
	#expanded = false;

	constructor(detail: IpythonJournalDetail | IpythonLiveCellView) {
		super();
		if ("version" in detail) this.#detail = detail;
		else this.#live = { ...detail, updates: [] };
		this.#rebuild();
	}

	applyUpdate(update: IpythonCellUpdate): void {
		if (!this.#live || this.#detail) return;
		this.#live.updates.push(update);
		this.#rebuild();
	}

	complete(detail: IpythonCellJournalDetail): void {
		this.#detail = detail;
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#rebuild(): void {
		this.clear();
		const detail = this.#detail;
		if (!detail) {
			this.#rebuildLive();
			return;
		}
		if (detail.kind === "lifecycle") {
			const color = detail.level === "warning" ? "warning" : "accent";
			const pids = detail.processIds
				? ` · controller ${detail.processIds.controllerPid}, kernel ${detail.processIds.kernelPid}`
				: "";
			this.addChild(
				new Text(
					theme.fg(color, `IPython ${detail.event}`) +
						theme.fg("muted", ` · ${sanitizeText(detail.message)}${pids}`),
					1,
					0,
				),
			);
			return;
		}

		const origin = detail.origin === "direct" ? "direct" : "model";
		const heading = `${theme.fg("pythonMode", theme.bold(`In [${detail.sequence}]`))} ${theme.fg("muted", `· ${origin} · `)}${statusLabel(detail)}${theme.fg("muted", ` · ${durationLabel(detail.durationMs)}`)}`;
		const codeLines = highlightCode(sanitizeText(detail.code), "python");
		const shownCode = this.#expanded ? codeLines : codeLines.slice(0, COLLAPSED_CODE_LINES);
		const codeOmitted = codeLines.length - shownCode.length;
		const code = shownCode
			.map((line, index) => `${theme.fg("pythonMode", index === 0 ? ">>>" : "...")} ${clampLine(line)}`)
			.join("\n");
		this.addChild(
			new Text(
				`${heading}\n${code}${codeOmitted > 0 ? theme.fg("dim", `\n… ${codeOmitted} code lines omitted`) : ""}`,
				1,
				0,
			),
		);

		const cleanOutput = sanitizeText(detail.safeText);
		const outputLines = cleanOutput ? cleanOutput.split("\n").map(clampLine) : [];
		const shownOutput = this.#expanded ? outputLines : outputLines.slice(-COLLAPSED_OUTPUT_LINES);
		const outputOmitted = outputLines.length - shownOutput.length;
		if (shownOutput.length > 0) {
			const prefix = outputOmitted > 0 ? theme.fg("dim", `… ${outputOmitted} output lines omitted\n`) : "";
			this.addChild(new Text(`\n${prefix}${shownOutput.map(line => theme.fg("muted", line)).join("\n")}`, 1, 0));
		}

		if (this.#expanded) {
			const progress = detail.updates
				.filter(update => update.kind === "startup")
				.map(update => `${update.progress.stage}: ${sanitizeText(update.progress.message)}`);
			const artifacts = detail.artifacts.map(artifact => {
				const type = artifact.mimeType ? ` (${artifact.mimeType})` : "";
				return `${sanitizeText(artifact.label ?? artifact.path)}${type}`;
			});
			const metadata = [
				...progress.map(message => `startup · ${message}`),
				...artifacts.map(message => `artifact · ${message}`),
			];
			if (metadata.length > 0)
				this.addChild(new Text(`\n${metadata.map(line => theme.fg("dim", line)).join("\n")}`, 1, 0));
		}

		if (detail.safeTextTruncated) {
			this.addChild(
				new Text(theme.fg("warning", `\nOutput truncated from ${detail.totalOutputBytes} bytes.`), 1, 0),
			);
		}
	}

	#rebuildLive(): void {
		const live = this.#live;
		if (!live) return;
		const heading = `${theme.fg("pythonMode", theme.bold("IPython"))} ${theme.fg("muted", `· ${live.origin} · `)}${theme.fg("accent", "running")}`;
		const codeLines = highlightCode(sanitizeText(live.code), "python");
		const shownCode = this.#expanded ? codeLines : codeLines.slice(0, COLLAPSED_CODE_LINES);
		const code = shownCode
			.map((line, index) => `${theme.fg("pythonMode", index === 0 ? ">>>" : "...")} ${clampLine(line)}`)
			.join("\n");
		this.addChild(new Text(`${heading}\n${code}`, 1, 0));
		const records = live.updates.flatMap(update =>
			update.kind === "execution" ? [safeEventText(update.event)] : [],
		);
		const outputLines = sanitizeText(records.join("\n"))
			.split("\n")
			.map(clampLine)
			.filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
		const shownOutput = this.#expanded ? outputLines : outputLines.slice(-COLLAPSED_OUTPUT_LINES);
		if (shownOutput.length > 0) {
			this.addChild(new Text(`\n${shownOutput.map(line => theme.fg("muted", line)).join("\n")}`, 1, 0));
		}
		const progress = live.updates.filter(update => update.kind === "startup").at(-1);
		if (progress?.kind === "startup") {
			this.addChild(
				new Text(theme.fg("dim", `\n${progress.progress.stage}: ${sanitizeText(progress.progress.message)}`), 1, 0),
			);
		}
	}
}
