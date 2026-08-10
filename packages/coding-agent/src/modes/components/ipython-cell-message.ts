import { Container, Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { IpythonMimeRenderer } from "../../extensibility/extensions/types";
import type { IpythonCellUpdate } from "../../ipython/cell";
import { collectIpythonMimeItems } from "../../ipython/extension-registry";
import type { IpythonCellJournalDetail, IpythonJournalDetail } from "../../ipython/journal";
import {
	type IpythonCellPresentation,
	projectIpythonCellPresentation,
	projectIpythonLiveCellPresentation,
} from "../../ipython/projection";
import type { ActProjectionEvent } from "../../session/act-events";
import { expandKeyHint, shortenPath, truncateToWidth } from "../../tools/render-utils";
import { highlightCode, theme } from "../theme/theme";

const COLLAPSED_OUTPUT_LINES = 20;
const MAX_DISPLAY_LINE_CHARS = 4_000;

function clampLine(line: string): string {
	return truncateToWidth(line, MAX_DISPLAY_LINE_CHARS);
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

/** Renders live or replayed IPython journal details without evaluating rich MIME data. */
export class IpythonCellMessageComponent extends Container {
	readonly #live: { code: string; origin: "model" | "direct"; updates: IpythonCellUpdate[] } | undefined;
	#detail: IpythonJournalDetail | undefined;
	#expanded = false;
	readonly #actEvents = new Map<string, ActProjectionEvent[]>();

	constructor(
		detail: IpythonJournalDetail | IpythonLiveCellView,
		readonly getMimeRenderer?: (mimeType: string) => IpythonMimeRenderer | undefined,
	) {
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

	appendActEvent(event: ActProjectionEvent): void {
		const events = this.#actEvents.get(event.actId) ?? [];
		if (events.some(entry => entry.sequence >= event.sequence)) return;
		events.push(event);
		this.#actEvents.set(event.actId, events);
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

		const presentation = projectIpythonCellPresentation(detail);
		const origin = presentation.origin === "direct" ? "direct" : "model";
		const heading = `${theme.fg("pythonMode", theme.bold(`In [${presentation.sequence}]`))} ${theme.fg("muted", `· ${origin} · `)}${statusLabel(detail)}${theme.fg("muted", ` · ${durationLabel(presentation.durationMs)}`)}`;
		const codeLines = highlightCode(sanitizeText(presentation.code), "python");
		const code = codeLines
			.map((line, index) => `${theme.fg("pythonMode", index === 0 ? ">>>" : "...")} ${line}`)
			.join("\n");
		this.addChild(new Text(`${heading}\n${code}`, 1, 0));

		const cleanOutput = sanitizeText(presentation.safeText.text);
		const outputLines = cleanOutput
			? cleanOutput.split("\n").filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
			: [];
		const shownOutput = this.#expanded ? outputLines : outputLines.slice(-COLLAPSED_OUTPUT_LINES).map(clampLine);
		const outputOmitted = outputLines.length - shownOutput.length;
		if (shownOutput.length > 0) {
			const prefix =
				outputOmitted > 0
					? theme.fg("dim", `… ${outputOmitted} output lines omitted (${expandKeyHint()} to expand)\n`)
					: "";
			this.addChild(new Text(`\n${prefix}${shownOutput.map(line => theme.fg("muted", line)).join("\n")}`, 1, 0));
		}

		if (this.#expanded) {
			const progress = presentation.startupProgress.map(
				update => `${update.stage}: ${sanitizeText(update.message)}`,
			);
			const artifacts = presentation.artifacts.map(artifact => {
				const type = artifact.mimeType ? ` (${artifact.mimeType})` : "";
				return `${sanitizeText(artifact.label ?? shortenPath(artifact.path))}${type}`;
			});
			const metadata = [
				...progress.map(message => `startup · ${message}`),
				...artifacts.map(message => `artifact · ${message}`),
			];
			if (metadata.length > 0)
				this.addChild(new Text(`\n${metadata.map(line => theme.fg("dim", line)).join("\n")}`, 1, 0));
		}

		if (presentation.safeText.truncated) {
			this.addChild(
				new Text(theme.fg("warning", `\nOutput truncated from ${presentation.safeText.totalBytes} bytes.`), 1, 0),
			);
		}
		if (this.#expanded) this.#appendMimeComponents(presentation);
		this.#rebuildActs();
	}

	#rebuildLive(): void {
		const live = this.#live;
		if (!live) return;
		const heading = `${theme.fg("pythonMode", theme.bold("IPython"))} ${theme.fg("muted", `· ${live.origin} · `)}${theme.fg("accent", "running")}`;
		const codeLines = highlightCode(sanitizeText(live.code), "python");
		const code = codeLines
			.map((line, index) => `${theme.fg("pythonMode", index === 0 ? ">>>" : "...")} ${line}`)
			.join("\n");
		this.addChild(new Text(`${heading}\n${code}`, 1, 0));
		const presentation = projectIpythonLiveCellPresentation(live);
		const outputLines = sanitizeText(presentation.safeText.text)
			.split("\n")
			.filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
		const shownOutput = this.#expanded ? outputLines : outputLines.slice(-COLLAPSED_OUTPUT_LINES).map(clampLine);
		const outputOmitted = outputLines.length - shownOutput.length;
		if (shownOutput.length > 0) {
			const prefix =
				outputOmitted > 0
					? theme.fg("dim", `… ${outputOmitted} output lines omitted (${expandKeyHint()} to expand)\n`)
					: "";
			this.addChild(new Text(`\n${prefix}${shownOutput.map(line => theme.fg("muted", line)).join("\n")}`, 1, 0));
		}
		const progress = presentation.startupProgress.at(-1);
		if (progress) {
			this.addChild(new Text(theme.fg("dim", `\n${progress.stage}: ${sanitizeText(progress.message)}`), 1, 0));
		}
		if (this.#expanded) this.#appendMimeComponents(presentation);
		this.#rebuildActs();
	}

	#appendMimeComponents(presentation: IpythonCellPresentation): void {
		if (!this.getMimeRenderer) return;
		for (const item of collectIpythonMimeItems(presentation)) {
			try {
				const renderer = this.getMimeRenderer(item.mimeType);
				if (!renderer) continue;
				const component = renderer({ presentation, item, safeText: presentation.safeText, theme });
				if (component) this.addChild(component);
			} catch {
				// The shared safe-text projection remains visible when an extension renderer fails.
			}
		}
	}

	#rebuildActs(): void {
		for (const events of this.#actEvents.values()) {
			const lines: string[] = [];
			for (const event of events) {
				switch (event.event) {
					case "start":
						lines.push(
							theme.fg("accent", `Act · ${sanitizeText(event.model.name?.trim() || event.model.id)} · running`),
						);
						break;
					case "assistant_delta":
						lines.push(
							theme.fg(event.stream === "thinking" ? "dim" : "muted", clampLine(sanitizeText(event.text))),
						);
						break;
					case "cell_start":
						lines.push(
							theme.fg(
								"pythonMode",
								`cell ${sanitizeText(event.cellId)} >>> ${clampLine(sanitizeText(event.code))}`,
							),
						);
						break;
					case "cell_terminal": {
						const output = [event.stdout, event.stderr, event.result, event.error]
							.filter((value): value is string => typeof value === "string" && value.length > 0)
							.map(value => clampLine(sanitizeText(value)))
							.join(" · ");
						lines.push(
							theme.fg(
								event.status === "ok" ? "success" : event.status === "cancelled" ? "warning" : "error",
								`cell ${sanitizeText(event.cellId)} · ${event.status}${output ? ` · ${output}` : ""}`,
							),
						);
						break;
					}
					case "terminal":
						lines.push(
							theme.fg(
								event.status === "done" ? "success" : event.status === "cancelled" ? "warning" : "error",
								`Act · ${event.status}${event.error ? ` · ${clampLine(sanitizeText(event.error))}` : ""}`,
							),
						);
						break;
				}
			}
			const shown = this.#expanded ? lines : lines.slice(-COLLAPSED_OUTPUT_LINES);
			if (shown.length > 0) this.addChild(new Text(`\n${shown.join("\n")}`, 2, 0));
		}
	}
}
