import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "../config/file-lock.js";

export const IRC_DIRECTORY_ENV = "OMP_IRC_DIR";
export const IRC_SHARED_DIRECTORY_ENV = "OMP_IRC_SHARED_DIR";
export const IRC_AGENT_ID_ENV = "OMP_IRC_AGENT_ID";
export const IRC_AGENT_GENERATION_ENV = "OMP_IRC_AGENT_GENERATION";

const REGISTRY_DIRECTORY = "agents";
const INBOX_DIRECTORY = "inboxes";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface IrcEnvelope {
	message_id: string;
	from: string;
	from_generation: string;
	to: string;
	reply_to: string | null;
	created_at: string;
	body: string;
}

export interface IrcRegistration {
	id: string;
	generation: string;
	registered_at: string;
}

export interface IrcWatchEvent {
	cursor: number;
	envelope: IrcEnvelope;
}

export interface IrcReadResult {
	events: IrcWatchEvent[];
	nextCursor: number;
}

export interface IrcWatchOptions {
	cursor?: number;
	generation?: string;
	signal?: AbortSignal;
}

export interface SendIrcMessageOptions {
	sharedDirectory: string;
	from: string;
	fromGeneration: string;
	to: string;
	body: string;
	replyTo?: string | null;
	messageId?: string;
	now?: Date;
}

function validateId(id: string, label: string): string {
	if (!ID_PATTERN.test(id)) {
		throw new Error(`${label} must match ${ID_PATTERN.source}`);
	}
	return id;
}

function validateGeneration(generation: string): string {
	if (!GENERATION_PATTERN.test(generation)) {
		throw new Error(`IRC generation must match ${GENERATION_PATTERN.source}`);
	}
	return generation;
}

function validateBody(body: string): string {
	if (!body.trim()) throw new Error("IRC message body cannot be empty");
	return body;
}

function registryFile(sharedDirectory: string, id: string): string {
	return path.join(sharedDirectory, REGISTRY_DIRECTORY, `${validateId(id, "IRC agent id")}.json`);
}

function inboxFile(sharedDirectory: string, id: string): string {
	return path.join(sharedDirectory, INBOX_DIRECTORY, `${validateId(id, "IRC agent id")}.jsonl`);
}

function validateCursor(cursor: number): number {
	if (!Number.isSafeInteger(cursor) || cursor < 0) {
		throw new Error("IRC cursor must be a non-negative integer");
	}
	return cursor;
}

function parseRegistration(value: unknown): IrcRegistration {
	if (
		!value ||
		typeof value !== "object" ||
		!("id" in value) ||
		!("generation" in value) ||
		!("registered_at" in value) ||
		typeof value.id !== "string" ||
		typeof value.generation !== "string" ||
		typeof value.registered_at !== "string"
	) {
		throw new Error("IRC registration must contain id, generation, and registered_at");
	}
	return {
		id: validateId(value.id, "IRC agent id"),
		generation: validateGeneration(value.generation),
		registered_at: value.registered_at,
	};
}

function parseEnvelope(value: unknown): IrcEnvelope {
	if (
		!value ||
		typeof value !== "object" ||
		!("message_id" in value) ||
		!("from" in value) ||
		!("from_generation" in value) ||
		!("to" in value) ||
		!("reply_to" in value) ||
		!("created_at" in value) ||
		!("body" in value) ||
		typeof value.message_id !== "string" ||
		typeof value.from !== "string" ||
		typeof value.from_generation !== "string" ||
		typeof value.to !== "string" ||
		(value.reply_to !== null && typeof value.reply_to !== "string") ||
		typeof value.created_at !== "string" ||
		typeof value.body !== "string"
	) {
		throw new Error(
			"IRC envelope must contain message_id, from, from_generation, to, reply_to, created_at, and body",
		);
	}
	return {
		message_id: validateId(value.message_id, "IRC message id"),
		from: validateId(value.from, "IRC sender id"),
		from_generation: validateGeneration(value.from_generation),
		to: validateId(value.to, "IRC target id"),
		reply_to: value.reply_to,
		created_at: value.created_at,
		body: validateBody(value.body),
	};
}

async function readFileIfPresent(filePath: string): Promise<string | null> {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

export function resolveIrcDirectory(explicit?: string): string {
	const directory = explicit ?? process.env[IRC_DIRECTORY_ENV] ?? process.env[IRC_SHARED_DIRECTORY_ENV];
	if (!directory?.trim()) {
		throw new Error(`IRC shared directory is required; set ${IRC_DIRECTORY_ENV}`);
	}
	return path.resolve(directory);
}

export function resolveIrcAgentId(explicit?: string): string {
	const id = explicit ?? process.env[IRC_AGENT_ID_ENV];
	if (!id?.trim()) throw new Error(`IRC agent id is required; set ${IRC_AGENT_ID_ENV}`);
	return validateId(id.trim(), "IRC agent id");
}

export function resolveIrcGeneration(explicit?: string): string {
	const generation = explicit ?? process.env[IRC_AGENT_GENERATION_ENV] ?? randomUUID();
	return validateGeneration(generation.trim());
}

export async function registerIrcAgent(
	sharedDirectory: string,
	id: string,
	generation: string = randomUUID(),
	now = new Date(),
): Promise<IrcRegistration> {
	const validId = validateId(id.trim(), "IRC agent id");
	const validGeneration = validateGeneration(generation.trim());
	const registration: IrcRegistration = {
		id: validId,
		generation: validGeneration,
		registered_at: now.toISOString(),
	};
	const filePath = registryFile(sharedDirectory, validId);
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	let handle: FileHandle;
	try {
		handle = await fsp.open(filePath, "wx", 0o600);
	} catch (error) {
		if (isEexist(error)) {
			throw new Error(`IRC agent id collision: ${validId} is already registered`);
		}
		throw error;
	}
	try {
		await handle.writeFile(`${JSON.stringify(registration)}\n`, "utf8");
	} catch (error) {
		await fsp.rm(filePath, { force: true });
		throw error;
	} finally {
		await handle.close();
	}
	return registration;
}

export async function readIrcRegistration(sharedDirectory: string, id: string): Promise<IrcRegistration | null> {
	const filePath = registryFile(sharedDirectory, id);
	const content = await readFileIfPresent(filePath);
	if (content === null) return null;
	return parseRegistration(JSON.parse(content));
}

export async function ensureIrcAgent(
	sharedDirectory: string,
	id: string,
	generation: string,
): Promise<IrcRegistration> {
	const validId = validateId(id.trim(), "IRC agent id");
	const validGeneration = validateGeneration(generation.trim());
	const existing = await readIrcRegistration(sharedDirectory, validId);
	if (existing) {
		if (existing.generation !== validGeneration) {
			throw new Error(`IRC agent id collision: ${validId} is registered by another generation`);
		}
		return existing;
	}
	try {
		return await registerIrcAgent(sharedDirectory, validId, validGeneration);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes("already registered")) throw error;
		const current = await readIrcRegistration(sharedDirectory, validId);
		if (!current || current.generation !== validGeneration) throw error;
		return current;
	}
}

export async function sendIrcMessage(options: SendIrcMessageOptions): Promise<IrcEnvelope> {
	const from = validateId(options.from.trim(), "IRC sender id");
	const fromGeneration = validateGeneration(options.fromGeneration.trim());
	const to = validateId(options.to.trim(), "IRC target id");
	const body = validateBody(options.body);
	const registration = await readIrcRegistration(options.sharedDirectory, from);
	if (!registration || registration.generation !== fromGeneration) {
		throw new Error(`IRC sender ${from} is not registered for generation ${fromGeneration}`);
	}
	if (!(await readIrcRegistration(options.sharedDirectory, to))) {
		throw new Error(`IRC target ${to} is not registered`);
	}
	const envelope: IrcEnvelope = {
		message_id: validateId(options.messageId?.trim() ?? randomUUID(), "IRC message id"),
		from,
		from_generation: fromGeneration,
		to,
		reply_to: options.replyTo?.trim() || null,
		created_at: (options.now ?? new Date()).toISOString(),
		body,
	};
	const filePath = inboxFile(options.sharedDirectory, to);
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	await withFileLock(filePath, async () => {
		await fsp.appendFile(filePath, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
	});
	return envelope;
}

export async function readIrcInbox(sharedDirectory: string, id: string, cursor = 0): Promise<IrcReadResult> {
	const validCursor = validateCursor(cursor);
	const filePath = inboxFile(sharedDirectory, id);
	const content = await readFileIfPresent(filePath);
	if (content === null) return { events: [], nextCursor: validCursor };
	const lines = content.split("\n");
	const completeLineCount = lines.length - 1;
	const events: IrcWatchEvent[] = [];
	for (let index = validCursor; index < completeLineCount; index++) {
		const line = lines[index]?.trim();
		if (!line) continue;
		events.push({ cursor: index + 1, envelope: parseEnvelope(JSON.parse(line)) });
	}
	return { events, nextCursor: completeLineCount };
}

function createAbortWait(signal: AbortSignal): { promise: Promise<void>; dispose: () => void } {
	if (signal.aborted) return { promise: Promise.resolve(), dispose: () => {} };
	const deferred = Promise.withResolvers<void>();
	const listener = () => deferred.resolve();
	signal.addEventListener("abort", listener, { once: true });
	return {
		promise: deferred.promise,
		dispose: () => signal.removeEventListener("abort", listener),
	};
}

export async function* watchIrcInbox(
	sharedDirectory: string,
	id: string,
	options: IrcWatchOptions = {},
): AsyncGenerator<IrcWatchEvent> {
	const validId = validateId(id, "IRC agent id");
	const registration = await readIrcRegistration(sharedDirectory, validId);
	if (!registration) throw new Error(`IRC agent ${validId} is not registered`);
	if (options.generation !== undefined && registration.generation !== validateGeneration(options.generation.trim())) {
		throw new Error(`IRC agent ${validId} is registered by another generation`);
	}
	let cursor = validateCursor(options.cursor ?? 0);
	const directory = path.dirname(inboxFile(sharedDirectory, validId));
	const filename = path.basename(inboxFile(sharedDirectory, validId));
	await fsp.mkdir(directory, { recursive: true });
	const watcher = fs.watch(directory, { persistent: false });
	let wake = Promise.withResolvers<void>();
	const wakePromise = () => {
		wake.resolve();
		wake = Promise.withResolvers<void>();
	};
	const abortWait = options.signal ? createAbortWait(options.signal) : null;
	watcher.on("change", (_event, changed) => {
		if (changed === undefined || changed.toString() === filename) wakePromise();
	});
	watcher.on("rename", changed => {
		if (changed === undefined || changed.toString() === filename) wakePromise();
	});
	try {
		for (;;) {
			const replay = await readIrcInbox(sharedDirectory, validId, cursor);
			for (const event of replay.events) {
				cursor = event.cursor;
				yield event;
			}
			cursor = replay.nextCursor;
			const pendingWake = wake.promise;
			const gap = await readIrcInbox(sharedDirectory, validId, cursor);
			for (const event of gap.events) {
				cursor = event.cursor;
				yield event;
			}
			cursor = gap.nextCursor;
			if (abortWait) {
				await Promise.race([pendingWake, abortWait.promise]);
				if (options.signal?.aborted) return;
			} else {
				await pendingWake;
			}
		}
	} finally {
		abortWait?.dispose();
		watcher.close();
	}
}
