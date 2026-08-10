import * as fs from "node:fs/promises";
import type { WorldWatchStop } from "../world/client.js";
import { WorldAuthorityError, WorldOperationError } from "../world/client.js";
import {
	executeWorldOperation,
	type WorldOperationOwner,
	type WorldOperationParams,
} from "../world/operation-executor.js";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_STRING = 65_536;
const MAX_PATH = 4_096;
const MAX_LIST = 256;
const MAX_ITEM = 4_096;
const MAX_RUNTIME = 31_536_000;
const MAX_JSON_BYTES = 1024 * 1024;
const OPERATIONS = [
	"dispatch_submit",
	"dispatch_watch",
	"question_answer",
	"session_input",
	"session_interrupt",
] as const;
type NativeWorldOperation = (typeof OPERATIONS)[number];
const ALLOWED_FIELDS: Readonly<Record<NativeWorldOperation, readonly string[]>> = {
	dispatch_submit: [
		"request_id",
		"objective",
		"done_criteria",
		"adapter_argv",
		"worktree_path",
		"working_directory",
		"max_runtime_seconds",
		"model",
		"owner_artifact",
		"repository",
		"checkout_identity",
		"worktree_identity",
		"deliverable_paths",
		"write_surfaces",
		"child_operations",
	],
	dispatch_watch: ["intent_key", "stop"],
	question_answer: ["request_id", "question", "summary"],
	session_input: ["request_id", "session", "text"],
	session_interrupt: ["request_id", "session", "reason"],
};

export interface IpythonWorldServiceOptions {
	readonly owner: (request: IpythonHostRequest) => WorldOperationOwner | undefined;
}

function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}
function stringValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	max = MAX_STRING,
	required = false,
): string | undefined {
	const value = data[name];
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || (required && value.trim().length === 0))
		throw new TypeError(`${name} must be ${required ? "a nonempty string" : "a string"}`);
	if (value.length > max) throw new RangeError(`${name} is too large`);
	return value;
}
function listValue(data: Readonly<Record<string, unknown>>, name: string): string[] | undefined {
	const value = data[name];
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.length > MAX_LIST ||
		!value.every(item => typeof item === "string" && item.length <= MAX_ITEM)
	)
		throw new RangeError(`${name} must be a bounded string list`);
	return value;
}
function numberValue(data: Readonly<Record<string, unknown>>, name: string): number | undefined {
	const value = data[name];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_RUNTIME)
		throw new RangeError(`${name} must be a finite number from 0 through ${MAX_RUNTIME}`);
	return value;
}
function params(data: Readonly<Record<string, unknown>>, op: NativeWorldOperation): WorldOperationParams {
	strict(data, ALLOWED_FIELDS[op]);
	const result: WorldOperationParams = { op };
	const strings: [keyof WorldOperationParams, number][] = [
		["request_id", 256],
		["objective", MAX_STRING],
		["done_criteria", MAX_STRING],
		["worktree_path", MAX_PATH],
		["working_directory", MAX_PATH],
		["model", 256],
		["owner_artifact", MAX_PATH],
		["repository", MAX_PATH],
		["checkout_identity", 256],
		["worktree_identity", 256],
		["intent_key", MAX_PATH],
		["question", MAX_PATH],
		["summary", MAX_STRING],
		["session", MAX_PATH],
		["text", MAX_STRING],
		["reason", MAX_STRING],
	];
	for (const [name, max] of strings) {
		const value = stringValue(data, name, max);
		if (value !== undefined) result[name] = value as never;
	}
	for (const [name, value] of [
		["adapter_argv", listValue(data, "adapter_argv")],
		["deliverable_paths", listValue(data, "deliverable_paths")],
		["write_surfaces", listValue(data, "write_surfaces")],
		["child_operations", listValue(data, "child_operations")],
	] as const)
		if (value !== undefined) result[name] = value as never;
	const runtime = numberValue(data, "max_runtime_seconds");
	if (runtime !== undefined) result.max_runtime_seconds = runtime;
	const stop = stringValue(data, "stop", 16);
	if (stop !== undefined) {
		if (stop !== "current" && stop !== "custody" && stop !== "terminal") throw new RangeError("stop is invalid");
		result.stop = stop as WorldWatchStop;
	}
	if (op === "dispatch_submit") {
		for (const key of [
			"objective",
			"worktree_path",
			"working_directory",
			"worktree_identity",
			"deliverable_paths",
			"write_surfaces",
		] as const) {
			if (result[key] === undefined || (Array.isArray(result[key]) && result[key].length === 0))
				throw new TypeError(`world ${op} requires \`${key}\`.`);
		}
	}
	if (op === "dispatch_watch" && result.intent_key === undefined)
		throw new TypeError("world dispatch_watch requires `intent_key`.");
	if (op === "question_answer" && [result.request_id, result.question, result.summary].some(value => !value))
		throw new TypeError("world question_answer requires request_id, question, and summary.");
	if (
		(op === "session_input" || op === "session_interrupt") &&
		[result.request_id, result.session].some(value => !value)
	)
		throw new TypeError(`world ${op} requires request_id and session.`);
	if (op === "session_input" && !result.text) throw new TypeError("world session_input requires `text`.");
	return result;
}
function json(value: unknown): unknown {
	if (value === undefined) return null;
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) return value.map(json);
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, json(child)]));
	return value;
}
async function boundedJson(request: IpythonHostRequest, value: unknown): Promise<Readonly<Record<string, unknown>>> {
	const projected = json(value);
	const encoded = JSON.stringify(projected);
	if (Buffer.byteLength(encoded) <= MAX_JSON_BYTES) return projected as Readonly<Record<string, unknown>>;
	request.signal.throwIfAborted();
	const artifact = await request.allocateArtifact({
		label: "world-operation-result",
		mimeType: "application/json",
		suffix: ".json",
	});
	request.signal.throwIfAborted();
	await fs.writeFile(artifact.path, encoded, "utf8");
	request.signal.throwIfAborted();
	return {
		kind: "artifact",
		artifact: { ...artifact, bytes: Buffer.byteLength(encoded), mime_type: "application/json" },
	};
}

function publicError(error: WorldAuthorityError | WorldOperationError): Readonly<Record<string, unknown>> {
	if (error instanceof WorldAuthorityError)
		return {
			kind: "denied",
			operation: error.operation,
			code: error.codeName,
			required_permission: error.requiredPermission || undefined,
			detail: error.detail || undefined,
		};
	return {
		kind: "failure",
		operation: error.operation,
		code: error.codeName,
		request_id: error.requestId || undefined,
		target: error.targetObjectKey || undefined,
		detail: error.detail || undefined,
	};
}

/** Exposes authority-checked World operations through the native IPython host. */
export class IpythonWorldService {
	readonly handlers: IpythonHostHandlers;
	constructor(private readonly options: IpythonWorldServiceOptions) {
		this.handlers = Object.fromEntries(OPERATIONS.map(op => [`world.${op}`, request => this.#run(request, op)]));
	}
	async #run(request: IpythonHostRequest, op: NativeWorldOperation): Promise<Readonly<Record<string, unknown>>> {
		request.signal.throwIfAborted();
		const parsed = params(request.data, op);
		const client = this.options.owner(request);
		if (!client) return { kind: "unavailable", operation: parsed.op, message: "World runtime is unavailable" };
		try {
			const result = await executeWorldOperation(client, parsed, request.signal);
			request.signal.throwIfAborted();
			return await boundedJson(request, { kind: "ok", ...result });
		} catch (error) {
			if (error instanceof WorldAuthorityError || error instanceof WorldOperationError) {
				return await boundedJson(request, publicError(error));
			}
			throw error;
		}
	}
}
