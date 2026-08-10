import * as net from "node:net";

import type { ExtensionAPI, IpythonExtensionHostRequest } from "@oh-my-pi/pi-coding-agent";

const MAX_FRAME_BYTES = 256 * 1024;
const OPERATIONS = [
	"abort_task",
	"classify_issue",
	"classify_pr",
	"fetch_issue_thread",
	"fetch_pr",
	"gh_open_pr",
	"gh_post_comment",
	"gh_push_branch",
	"gh_request_review",
	"gh_search_issues",
	"mark_unable_to_reproduce",
	"pr_review_comment",
	"repro_record",
	"search_commits",
	"set_issue_labels",
	"submit_pr_review",
] as const;

type BridgeResponse = { ok: true; result: unknown } | { ok: false; error: string };

function decodeResponse(data: string): BridgeResponse {
	const lines = data.split("\n");
	if (lines.length !== 2 || lines[1] !== "") throw new Error("Robomp host bridge returned multiple frames");
	const value: unknown = JSON.parse(lines[0] ?? "");
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Robomp host bridge returned a non-object response");
	}
	const response = value as Record<string, unknown>;
	if (response.ok === true) {
		if (Object.keys(response).some(key => key !== "ok" && key !== "result") || !("result" in response)) {
			throw new Error("Robomp host bridge returned an invalid success response");
		}
		return { ok: true, result: response.result };
	}
	if (response.ok === false) {
		if (
			Object.keys(response).some(key => key !== "ok" && key !== "error") ||
			typeof response.error !== "string"
		) {
			throw new Error("Robomp host bridge returned an invalid error response");
		}
		return { ok: false, error: response.error };
	}
	throw new Error("Robomp host bridge returned a response without status");
}

function requestHost(operation: (typeof OPERATIONS)[number], request: IpythonExtensionHostRequest): Promise<unknown> {
	const socketPath = process.env.ROBOMP_HOST_SOCKET;
	if (!socketPath) return Promise.reject(new Error("ROBOMP_HOST_SOCKET is not configured"));
	if (request.signal.aborted) return Promise.reject(new Error(`Robomp operation ${operation} was aborted`));

	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let settled = false;
		let response = "";

		const finish = (error?: Error, result?: unknown) => {
			if (settled) return;
			settled = true;
			request.signal.removeEventListener("abort", onAbort);
			socket.destroy();
			if (error) reject(error);
			else resolve(result);
		};
		const onAbort = () => finish(new Error(`Robomp operation ${operation} was aborted`));
		request.signal.addEventListener("abort", onAbort, { once: true });
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			const frame = `${JSON.stringify({ version: 1, operation, arguments: request.data })}\n`;
			if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
				finish(new Error("Robomp host bridge request exceeds the frame limit"));
				return;
			}
			socket.write(frame);
		});
		socket.on("data", chunk => {
			response += chunk;
			if (Buffer.byteLength(response) > MAX_FRAME_BYTES) {
				finish(new Error("Robomp host bridge response exceeds the frame limit"));
				return;
			}
			if (!response.endsWith("\n")) return;
			try {
				const decoded = decodeResponse(response);
				if (decoded.ok) finish(undefined, decoded.result);
				else finish(new Error(decoded.error));
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.on("error", error => finish(error));
		socket.on("end", () => {
			if (!settled) finish(new Error("Robomp host bridge closed without a response"));
		});
	});
}

export default function robompExtension(pi: ExtensionAPI): void {
	for (const operation of OPERATIONS) {
		pi.registerIpythonHostHandler("robomp", operation, async request => ({
			result: await requestHost(operation, request),
		}));
	}
}
