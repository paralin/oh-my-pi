/**
 * IPython cell admission authority.
 *
 * Model-origin cells pass exactly one exec-tier approval decision before the
 * kernel pumps them. OMP claims no read/write mediation inside raw Python, so
 * a single decision governs the complete cell. Direct-user cells remain
 * operator-owned and never pass this gate.
 */
import type { Settings } from "../config/settings";

/** Approval modes relevant to a model-origin IPython cell. */
export type IpythonApprovalMode = "always-ask" | "write" | "yolo";

/** The only two outcomes for a complete IPython cell under the current policy. */
type IpythonCellApprovalPolicy = "allow" | "prompt";

export interface IpythonCellApproval {
	readonly decision: {
		readonly policy: IpythonCellApprovalPolicy;
		readonly reason?: string;
	};
	readonly mode: IpythonApprovalMode;
}

const IPYTHON_APPROVAL_PROMPT_MAX_CHARS = 2000;

function truncateIpythonApprovalPrompt(value: string): string {
	if (value.length <= IPYTHON_APPROVAL_PROMPT_MAX_CHARS) return value;
	const omitted = value.length - IPYTHON_APPROVAL_PROMPT_MAX_CHARS;
	return `${value.slice(0, IPYTHON_APPROVAL_PROMPT_MAX_CHARS)}[…${omitted}ch elided…]`;
}

/** Resolve model-origin whole-cell admission from the active approval mode. */
export function resolveIpythonCellApproval(settings: Settings, autoApprove: boolean): IpythonCellApproval {
	const configuredMode = (settings.get("tools.approvalMode") ?? "yolo") as IpythonApprovalMode;
	const mode = autoApprove ? "yolo" : configuredMode;
	return { decision: { policy: mode === "yolo" ? "allow" : "prompt" }, mode };
}

/** Build the approval prompt shown for the complete cell. */
export function formatIpythonApprovalPrompt(code: string, reason?: string): string {
	const lines = ["Allow IPython cell"];
	if (reason) lines.push(`Reason: ${reason}`);
	lines.push(`Python cell:\n${truncateIpythonApprovalPrompt(code)}`);
	return lines.join("\n");
}
