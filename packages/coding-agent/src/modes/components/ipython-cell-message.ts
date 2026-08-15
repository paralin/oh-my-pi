import { type Component, Container, Text, visibleWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { IpythonMimeRenderer } from "../../extensibility/extensions/types";
import type { IpythonCellUpdate } from "../../ipython/cell";
import { previewIpythonCode } from "../../ipython/code-preview";
import { collectIpythonMimeItems } from "../../ipython/extension-registry";
import type { IpythonCellJournalDetail, IpythonJournalDetail } from "../../ipython/journal";
import {
	type IpythonCellPresentation,
	type IpythonHostOperationPresentation,
	ipythonHostOperationDetails,
	projectIpythonCellPresentation,
	projectIpythonLiveCellPresentation,
} from "../../ipython/projection";
import type { ActProjectionEvent } from "../../session/act-events";
import {
	formatDuration,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
	truncateToWidth,
	wrapTextWithAnsi,
} from "../../tools/render-utils";
import { renderStatusLine } from "../../tui";
import { highlightCode, theme } from "../theme/theme";

const MAX_DISPLAY_LINE_CHARS = 4_000;
const BODY_INDENT = "  ";

function clampLine(line: string): string {
	return truncateToWidth(line, MAX_DISPLAY_LINE_CHARS);
}

function displayText(text: string): string {
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function cellStatus(status: IpythonCellPresentation["status"]): "running" | "success" | "error" | "aborted" {
	if (status === "running") return "running";
	if (status === "ok") return "success";
	if (status === "aborted") return "aborted";
	return "error";
}

function operationStatus(status: IpythonHostOperationPresentation["status"]): "running" | "done" | "error" | "aborted" {
	if (status === "running") return "running";
	if (status === "ok") return "done";
	if (status === "aborted") return "aborted";
	return "error";
}

function sourceLineCount(code: string, language: "bash" | "python"): number {
	const source =
		language === "bash" && /^\s*%%bash\b[^\n]*(?:\n|$)/u.test(code)
			? code.replace(/^\s*%%bash\b[^\n]*(?:\n|$)/u, "")
			: code;
	return displayText(source)
		.split("\n")
		.filter(line => line.trim().length > 0).length;
}

function cellSummary(presentation: IpythonCellPresentation, expanded: boolean, width: number): string {
	const preview = previewIpythonCode(sanitizeText(presentation.code));
	const marker =
		presentation.status === "ok"
			? theme.fg("success", "✓")
			: formatStatusIcon(cellStatus(presentation.status), theme);
	const parts = [`${marker} ${theme.fg("muted", preview.language)}`];
	if (preview.text) parts.push(theme.fg("pythonMode", replaceTabs(preview.text)));

	const inputLines = sourceLineCount(presentation.code, preview.language);
	const outputLines = presentation.safeText.totalLines ?? 0;
	const counts = [inputLines > 0 ? `↑ ${inputLines}` : "", outputLines > 0 ? `↓ ${outputLines}` : ""].filter(Boolean);
	if (counts.length > 0) parts.push(theme.fg("muted", `${counts.join(" ")} lines`));
	if (presentation.phase === "complete") parts.push(theme.fg("muted", formatDuration(presentation.durationMs)));

	const separator = theme.fg("dim", " · ");
	let summary = ` ${parts.join(separator)}`;
	const hint = formatExpandHint(theme, expanded, true);
	if (hint && visibleWidth(`${summary}${separator}${hint}`) <= width) summary += `${separator}${hint}`;
	return truncateToWidth(summary, width);
}

function appendWrapped(rows: string[], prefix: string, text: string, width: number): void {
	const available = Math.max(1, width - 1 - prefix.length);
	const wrapped = wrapTextWithAnsi(text || " ", available);
	for (const [index, row] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
		rows.push(truncateToWidth(` ${index === 0 ? prefix : " ".repeat(prefix.length)}${row}`, width));
	}
}

function cellRows(presentation: IpythonCellPresentation, expanded: boolean, width: number): string[] {
	const rows = [cellSummary(presentation, expanded, width)];
	if (!expanded) return rows;

	const code = displayText(sanitizeText(presentation.code));
	if (code) {
		rows.push("");
		const highlighted = highlightCode(code, previewIpythonCode(code).language);
		for (const [index, line] of highlighted.entries()) {
			appendWrapped(rows, index === 0 ? "› " : BODY_INDENT, line, width);
		}
	}

	const output = displayText(sanitizeText(presentation.safeText.text));
	if (output) {
		rows.push("");
		for (const line of output.split("\n")) appendWrapped(rows, BODY_INDENT, theme.fg("toolOutput", line), width);
	}
	return rows;
}

function operationProgressRows(
	progress: IpythonHostOperationPresentation["progress"][number],
	width: number,
): string[] {
	const details = ipythonHostOperationDetails(
		{ summary: progress.summary },
		progress.summary?.path ? shortenPath(progress.summary.path) : undefined,
	).map(detail => replaceTabs(sanitizeText(detail)));
	const suffix = details.length > 0 ? ` · ${details.join(" · ")}` : "";
	const lines = replaceTabs(sanitizeText(progress.message)).split("\n");
	const visible = lines.slice(0, PREVIEW_LIMITS.EXPANDED_LINES);
	const rows = visible.map((line, index) =>
		truncateToWidth(
			`${index === 0 ? "    " : "      "}${theme.fg("dim", `${line}${index === 0 ? suffix : ""}`)}`,
			width,
		),
	);
	if (lines.length > visible.length) {
		rows.push(
			truncateToWidth(
				`      ${theme.fg("dim", formatMoreItems(lines.length - visible.length, "evidence line"))}`,
				width,
			),
		);
	}
	return rows;
}

function operationRows(operations: readonly IpythonHostOperationPresentation[], width: number): string[] {
	if (operations.length === 0) return [];
	const visible = operations.slice(-PREVIEW_LIMITS.OUTPUT_EXPANDED);
	const hidden = operations.length - visible.length;
	const rows = ["", theme.fg("toolTitle", " Operations")];
	for (const operation of visible) {
		const path = operation.summary?.path;
		const details = ipythonHostOperationDetails(operation, path ? shortenPath(path) : undefined).map(detail =>
			replaceTabs(sanitizeText(detail)),
		);
		if (operation.durationMs !== undefined) details.push(formatDuration(operation.durationMs));
		rows.push(
			`  ${renderStatusLine(
				{
					icon: operationStatus(operation.status),
					title: replaceTabs(sanitizeText(operation.operation)),
					meta: details,
				},
				theme,
			)}`,
		);
		const progress = operation.progress.slice(-PREVIEW_LIMITS.OUTPUT_EXPANDED);
		const hiddenProgress = operation.progress.length - progress.length;
		if (hiddenProgress > 0) rows.push(`    ${theme.fg("dim", formatMoreItems(hiddenProgress, "progress update"))}`);
		for (const snapshot of progress) rows.push(...operationProgressRows(snapshot, width));
	}
	if (hidden > 0) rows.push(`  ${theme.fg("dim", formatMoreItems(hidden, "operation"))}`);
	return rows.map(row => truncateToWidth(row, width));
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
		if (update.kind === "output") {
			const index = this.#live.updates.findIndex(candidate => candidate.kind === "output");
			if (index >= 0) this.#live.updates[index] = update;
			else this.#live.updates.push(update);
		} else this.#live.updates.push(update);
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
		const cell: Component = { render: width => cellRows(presentation, this.#expanded, width) };
		this.addChild(cell);
		if (this.#expanded) this.#appendOperations(presentation);

		if (this.#expanded) {
			const visibleStartupProgress = presentation.startupProgress.slice(-PREVIEW_LIMITS.OUTPUT_EXPANDED);
			const progress = visibleStartupProgress.map(update => `${update.stage}: ${sanitizeText(update.message)}`);
			const hiddenStartupProgress = presentation.startupProgress.length - visibleStartupProgress.length;
			const artifactLimit = PREVIEW_LIMITS.OUTPUT_EXPANDED;
			const visibleArtifacts = presentation.artifacts.slice(-artifactLimit);
			const artifacts = visibleArtifacts.map(artifact => {
				const type = artifact.mimeType ? ` (${artifact.mimeType})` : "";
				const artifactPath = sanitizeText(shortenPath(artifact.path));
				const label = artifact.label ? `${sanitizeText(artifact.label)} · ` : "";
				return `${label}${artifactPath}${type}`;
			});
			const hiddenArtifacts = presentation.artifacts.length - visibleArtifacts.length;
			const metadata = [
				...(hiddenStartupProgress > 0
					? [`startup · ${formatMoreItems(hiddenStartupProgress, "startup update")}`]
					: []),
				...progress.map(message => `startup · ${message}`),
				...(hiddenArtifacts > 0 ? [`artifact · ${formatMoreItems(hiddenArtifacts, "artifact")}`] : []),
				...artifacts.map(message => `artifact · ${message}`),
			];
			if (metadata.length > 0)
				this.addChild(new Text(`\n${metadata.map(line => theme.fg("dim", line)).join("\n")}`, 1, 0));
		}

		if (presentation.safeText.truncated) {
			const omitted = presentation.safeText.omittedBytes;
			const notice =
				omitted === undefined
					? `Output truncated from ${presentation.safeText.totalBytes} bytes.`
					: `Output truncated from ${presentation.safeText.totalBytes} bytes; ${omitted} bytes omitted.`;
			this.addChild(new Text(theme.fg("warning", `\n${notice}`), 1, 0));
		}
		if (this.#expanded) this.#appendMimeComponents(presentation);
		this.#rebuildActs();
	}

	#rebuildLive(): void {
		const live = this.#live;
		if (!live) return;
		const presentation = projectIpythonLiveCellPresentation(live);
		const cell: Component = { render: width => cellRows(presentation, this.#expanded, width) };
		this.addChild(cell);
		if (this.#expanded) {
			this.#appendOperations(presentation);
			const progress = presentation.startupProgress.at(-1);
			if (progress) {
				this.addChild(new Text(theme.fg("dim", `\n${progress.stage}: ${sanitizeText(progress.message)}`), 1, 0));
			}
			this.#appendMimeComponents(presentation);
		}
		this.#rebuildActs();
	}

	#appendOperations(presentation: IpythonCellPresentation): void {
		if (presentation.operations.length === 0) return;
		this.addChild({
			render: width => operationRows(presentation.operations, width),
		});
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
			const shown = this.#expanded ? lines : lines.slice(-PREVIEW_LIMITS.OUTPUT_COLLAPSED);
			if (shown.length > 0) this.addChild(new Text(`\n${shown.join("\n")}`, 2, 0));
		}
	}
}
