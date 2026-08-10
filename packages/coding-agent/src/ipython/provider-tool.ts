import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { IpythonCellResult } from "./cell";
import { createIpythonCellJournalDetail, type IpythonCellJournalDetail } from "./journal";

const ipythonParameters = type({ code: "string" });

export type IpythonProviderTool = AgentTool<typeof ipythonParameters, IpythonCellJournalDetail>;

type ProviderPayload = Record<string, unknown>;

function isProviderPayload(value: unknown): value is ProviderPayload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsTools(payload: ProviderPayload): boolean {
	return Object.entries(payload).some(
		([key, value]) => key === "tools" || (isProviderPayload(value) && containsTools(value)),
	);
}

/** Snapshots tool declarations before an extension can mutate the provider request in place. */
export function snapshotIpythonProviderTools(payload: unknown): unknown {
	if (!isProviderPayload(payload)) return payload;

	const snapshot = { ...payload };
	for (const [key, value] of Object.entries(payload)) {
		if (key === "tools") {
			snapshot.tools = structuredClone(value);
			continue;
		}
		if (isProviderPayload(value) && containsTools(value)) {
			snapshot[key] = snapshotIpythonProviderTools(value);
		}
	}
	return snapshot;
}

/** Restores the provider's tool declarations after an extension transforms its request payload. */
export function preserveIpythonProviderTools(payload: unknown, replacement: unknown): unknown {
	if (!isProviderPayload(payload) || !isProviderPayload(replacement)) return payload;

	const preserved = { ...replacement };
	for (const [key, value] of Object.entries(payload)) {
		if (key === "tools") {
			preserved.tools = value;
			continue;
		}
		if (!isProviderPayload(value) || !containsTools(value)) continue;
		const replacedValue = replacement[key];
		preserved[key] = isProviderPayload(replacedValue) ? preserveIpythonProviderTools(value, replacedValue) : value;
	}
	return preserved;
}

/** The sole provider-facing tool; each call executes one complete cell exclusively. */
export function createIpythonProviderTool(
	execute: (code: string, signal?: AbortSignal, deferJournal?: boolean) => Promise<IpythonCellResult>,
): IpythonProviderTool {
	return {
		name: "ipython",
		label: "IPython",
		description: "Execute one Python or %%bash cell in the persistent IPython runtime.",
		parameters: ipythonParameters,
		approval: "exec",
		concurrency: "exclusive",
		async execute(_toolCallId, params, signal, _onUpdate): Promise<AgentToolResult<IpythonCellJournalDetail>> {
			const result = await execute(params.code, signal, true);
			return {
				content: [{ type: "text", text: result.modelText.text }],
				details: createIpythonCellJournalDetail(result),
			};
		},
	};
}
