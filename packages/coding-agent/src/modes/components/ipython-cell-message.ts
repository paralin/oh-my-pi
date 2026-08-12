import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { IpythonMimeRenderer } from "../../extensibility/extensions/types";
import type { IpythonCellUpdate } from "../../ipython/cell";
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
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
	truncateToWidth,
} from "../../tools/render-utils";
import { outputBlockContentWidth, renderCodeCell, renderStatusLine } from "../../tui";
import { theme } from "../theme/theme";

const MAX_DISPLAY_LINE_CHARS = 4_000;

function clampLine(line: string): string {
	return truncateToWidth(line, MAX_DISPLAY_LINE_CHARS);
}

function displayText(text: string): string {
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function clampPreviewLines(text: string, width: number): string {
	const contentWidth = outputBlockContentWidth(width);
	return displayText(text)
		.split("\n")
		.map(line => truncateToWidth(line, contentWidth))
		.join("\n");
}

function cellStatus(detail: IpythonCellJournalDetail): "complete" | "warning" | "error" {
	if (detail.status === "ok") return "complete";
	if (detail.status === "aborted") return "warning";
	return "error";
}

function operationStatus(status: IpythonHostOperationPresentation["status"]): "running" | "done" | "error" | "aborted" {
	if (status === "running") return "running";
	if (status === "ok") return "done";
	if (status === "aborted") return "aborted";
	return "error";
}

function operationRows(
	operations: readonly IpythonHostOperationPresentation[],
	expanded: boolean,
	width: number,
): string[] {
	if (operations.length === 0) return [];
	const visible = expanded ? operations : operations.slice(-PREVIEW_LIMITS.OUTPUT_COLLAPSED);
	const hidden = operations.length - visible.length;
	const rows = [theme.fg("toolTitle", "Operations")];
	for (const operation of visible) {
		const path = operation.summary?.path;
		const details = ipythonHostOperationDetails(operation, path ? shortenPath(path) : undefined).map(detail =>
			replaceTabs(sanitizeText(detail)),
		);
		if (operation.durationMs !== undefined) {
			const duration = `(${formatDuration(operation.durationMs)})`;
			if (details.length > 0) details[details.length - 1] = `${details.at(-1)} ${duration}`;
			else details.push(duration);
		}
		const metadata =
			details.length > 0 ? [`${theme.sep.dot.trimStart()}${details[0]}`, ...details.slice(1)] : details;
		rows.push(
			`  ${renderStatusLine(
				{
					icon: operationStatus(operation.status),
					title: replaceTabs(sanitizeText(operation.operation)),
					meta: metadata,
				},
				theme,
			)}`,
		);
		if (expanded && operation.message) {
			rows.push(`    ${theme.fg("dim", replaceTabs(sanitizeText(operation.message)))}`);
		}
	}
	if (hidden > 0) {
		const hint = formatExpandHint(theme, expanded, true);
		rows.push(`  ${theme.fg("dim", `${formatMoreItems(hidden, "operation")}${hint ? ` ${hint}` : ""}`)}`);
	}
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
		const cell: Component = {
			render: width =>
				renderCodeCell(
					{
						code: this.#expanded
							? sanitizeText(presentation.code)
							: clampPreviewLines(sanitizeText(presentation.code), width),
						language: "python",
						showLanguage: true,
						title: `In [${presentation.sequence}]${presentation.origin === "direct" ? " · direct" : ""}`,
						status: cellStatus(detail),
						duration: presentation.durationMs,
						output: this.#expanded
							? displayText(sanitizeText(presentation.safeText.text))
							: clampPreviewLines(sanitizeText(presentation.safeText.text), width),
						codeMaxLines: PREVIEW_LIMITS.COLLAPSED_LINES,
						outputMaxLines: PREVIEW_LIMITS.OUTPUT_COLLAPSED,
						codeTail: true,
						outputTail: true,
						expanded: this.#expanded,
						width,
					},
					theme,
				),
		};
		this.addChild(cell);
		this.#appendOperations(presentation);

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
		const presentation = projectIpythonLiveCellPresentation(live);
		const cell: Component = {
			render: width =>
				renderCodeCell(
					{
						code: this.#expanded ? sanitizeText(live.code) : clampPreviewLines(sanitizeText(live.code), width),
						language: "python",
						showLanguage: true,
						title: `IPython${live.origin === "direct" ? " · direct" : ""}`,
						status: "running",
						output: this.#expanded
							? displayText(sanitizeText(presentation.safeText.text))
							: clampPreviewLines(sanitizeText(presentation.safeText.text), width),
						codeMaxLines: PREVIEW_LIMITS.COLLAPSED_LINES,
						outputMaxLines: PREVIEW_LIMITS.OUTPUT_COLLAPSED,
						codeTail: true,
						outputTail: true,
						expanded: this.#expanded,
						width,
					},
					theme,
				),
		};
		this.addChild(cell);
		this.#appendOperations(presentation);

		const progress = presentation.startupProgress.at(-1);
		if (progress) {
			this.addChild(new Text(theme.fg("dim", `\n${progress.stage}: ${sanitizeText(progress.message)}`), 1, 0));
		}
		if (this.#expanded) this.#appendMimeComponents(presentation);
		this.#rebuildActs();
	}

	#appendOperations(presentation: IpythonCellPresentation): void {
		if (presentation.operations.length === 0) return;
		this.addChild({
			render: width => operationRows(presentation.operations, this.#expanded, width),
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
