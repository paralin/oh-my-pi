import type { AutoQaReportIssueResult } from "../tools/report-tool-issue";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_TOOL_CHARS = 256;
const MAX_REPORT_CHARS = 16_384;

function strictObject(data: Readonly<Record<string, unknown>>): void {
	const unknown = Object.keys(data).find(key => key !== "type" && key !== "tool" && key !== "report");
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function requiredText(data: Readonly<Record<string, unknown>>, name: "tool" | "report", maxChars: number): string {
	const value = data[name];
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string`);
	if (value.length > maxChars) throw new RangeError(`${name} is too large`);
	return value.trim();
}

export interface IpythonAutoQaReportOwner {
	reportIssue(input: {
		readonly tool: string;
		readonly report: string;
		readonly signal: AbortSignal;
	}): Promise<AutoQaReportIssueResult>;
}

export interface IpythonAutoQaServiceOptions {
	readonly owner: IpythonAutoQaReportOwner;
}

/** Exposes the typed Auto-QA report owner as a direct typed service. */
export class IpythonAutoQaService {
	readonly handlers: IpythonHostHandlers;

	constructor(private readonly options: IpythonAutoQaServiceOptions) {
		this.handlers = { "qa.report_issue": request => this.#reportIssue(request) };
	}

	async #reportIssue(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strictObject(request.data);
		if (request.data.type !== "qa.report_issue") throw new TypeError("type must be qa.report_issue");
		request.signal.throwIfAborted();
		const tool = requiredText(request.data, "tool", MAX_TOOL_CHARS);
		const report = requiredText(request.data, "report", MAX_REPORT_CHARS);
		await request.publishProgress("Auto-QA report started", { tool });
		const result = await this.options.owner.reportIssue({ tool, report, signal: request.signal });
		request.signal.throwIfAborted();
		await request.publishProgress("Auto-QA report completed", { status: result.status, pushed: result.pushed });
		return {
			outcome: result.status,
			pushed: result.pushed,
			push_ok: result.pushOk,
			push_skipped: result.pushSkipped,
		};
	}
}
