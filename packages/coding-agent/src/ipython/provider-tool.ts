import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { IpythonCellResult } from "./cell";
import { createIpythonCellJournalDetail, type IpythonCellJournalDetail } from "./journal";

const ipythonParameters = type({ code: "string" });
const MAX_RECEIVED_PAYLOAD_BYTES = 512;
const textEncoder = new TextEncoder();

export type IpythonProviderTool = AgentTool<typeof ipythonParameters, IpythonCellJournalDetail>;

function serializeReceivedPayload(args: unknown): string {
	if (typeof args === "object" && args !== null && "__rawJson" in args) return String(args.__rawJson ?? "");
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args) ?? String(args);
	} catch {
		return String(args);
	}
}

function redactReceivedPayload(payload: string): string {
	const credentialLabel =
		/(["']?(?:(?:aws[-_]?)?secret[-_]?access[-_]?key|api[-_]?key|authorization|cookie|credential|password|passwd|private[-_]?key|access[-_]?key|secret|token|key)["']?\s*[:=]\s*)/gi;
	return payload
		.replace(credentialLabel, match => `${match}\u0000`)
		.replace(/\u0000(["'])(?:\\.|(?!\1).)*(?:\1|$)/g, (_match, quote: string) => `${quote}[REDACTED]${quote}`)
		.replace(/\u0000[^\n\r,}\]]*/g, "[REDACTED]")
		.replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*/gi, "[REDACTED PRIVATE KEY]")
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED]");
}

function unicodeBytePrefix(value: string, maxBytes: number): { prefix: string; bytes: number; truncated: boolean } {
	let prefix = "";
	let bytes = 0;
	for (const character of value) {
		const characterBytes = textEncoder.encode(character).byteLength;
		if (bytes + characterBytes > maxBytes) return { prefix, bytes, truncated: true };
		prefix += character;
		bytes += characterBytes;
	}
	return { prefix, bytes, truncated: false };
}

function formatIpythonValidationError(args: unknown): string {
	const received = redactReceivedPayload(serializeReceivedPayload(args));
	const { prefix, bytes, truncated } = unicodeBytePrefix(received, MAX_RECEIVED_PAYLOAD_BYTES);
	return `Invalid ipython payload; expected {code: string}. Received first ${bytes} bytes: ${prefix}${truncated ? "…" : ""}`;
}

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
		formatValidationError: formatIpythonValidationError,
		async execute(_toolCallId, params, signal, _onUpdate): Promise<AgentToolResult<IpythonCellJournalDetail>> {
			const result = await execute(params.code, signal, true);
			return {
				content: [{ type: "text", text: result.modelText.text }],
				details: createIpythonCellJournalDetail(result),
			};
		},
	};
}
