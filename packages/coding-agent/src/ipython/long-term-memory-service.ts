/** Typed configured long-term-memory operations for the IPython host boundary. */

import { untilAborted } from "@oh-my-pi/pi-utils";
import { sanitizeSkillName, writeManagedSkill } from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import { ensureBankExists } from "../hindsight/bank";
import type { HindsightSessionState } from "../hindsight/state";
import { localBackend } from "../memory-backend/local-backend";
import type { MemoryBackendId, MemoryBackendSaveResult } from "../memory-backend/types";
import type { MnemopiSessionState } from "../mnemopi/state";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_ITEMS = 32;
const MAX_TOTAL_CONTENT_CHARS = 256_000;
const MAX_MEMORY_CHARS = 64_000;
const MAX_CONTEXT_CHARS = 64_000;
const MAX_QUERY_CHARS = 16_384;
const MAX_MEMORY_ID_CHARS = 512;
const MAX_RESULT_ITEMS = 64;
const MAX_RESULT_CONTENT_CHARS = 8_192;
const MAX_SKILL_NAME_CHARS = 64;
const MAX_SKILL_DESCRIPTION_CHARS = 1_024;
const MAX_SKILL_BODY_CHARS = 64_000;

type IpythonLongTermMemoryBackend = Exclude<MemoryBackendId, "off">;

export interface IpythonLongTermMemoryOwner {
	backend(): MemoryBackendId;
	cwd(): string;
	agentDir(): string;
	autolearnEnabled(): boolean;
	hindsight(): HindsightSessionState | undefined;
	mnemopi(): MnemopiSessionState | undefined;
}

export interface IpythonLongTermMemoryServiceOptions {
	readonly owner: IpythonLongTermMemoryOwner;
	readonly ensureHindsightBank?: (state: HindsightSessionState, signal: AbortSignal) => Promise<void>;
	readonly saveLocalLesson?: (
		context: { readonly agentDir: string; readonly cwd: string },
		input: {
			readonly content: string;
			readonly context?: string;
			readonly source: string;
			readonly importance: number;
		},
	) => Promise<MemoryBackendSaveResult | undefined>;
	readonly writeManagedSkill?: typeof writeManagedSkill;
	readonly isNameClaimedByAuthoredSkill?: typeof isNameClaimedByAuthoredSkill;
}

type EditOperation = "update" | "forget" | "invalidate";

type RetainItem = {
	readonly content: string;
	readonly context?: string;
};

type ManagedSkill = {
	readonly action: "create" | "update";
	readonly name: string;
	readonly description: string;
	readonly body: string;
};

function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function stringValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	options: { readonly optional?: boolean; readonly max?: number } = {},
): string | undefined {
	const value = data[name];
	if (value === undefined && options.optional) return undefined;
	if (typeof value !== "string" || (!options.optional && value.trim().length === 0)) {
		throw new TypeError(`${name} must be ${options.optional ? "a string" : "a nonempty string"}`);
	}
	if (value.length > (options.max ?? MAX_MEMORY_CHARS)) throw new RangeError(`${name} is too large`);
	return value;
}

function finiteNumberValue(data: Readonly<Record<string, unknown>>, name: string): number | undefined {
	const value = data[name];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
	return value;
}

function retainItems(data: Readonly<Record<string, unknown>>): RetainItem[] {
	const value = data.items;
	if (!Array.isArray(value) || value.length === 0) throw new TypeError("items must be a nonempty array");
	if (value.length > MAX_ITEMS) throw new RangeError(`items must contain at most ${MAX_ITEMS} entries`);
	let total = 0;
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new TypeError(`items[${index}] must be an object`);
		}
		const record = item as Readonly<Record<string, unknown>>;
		const unknown = Object.keys(record).find(key => key !== "content" && key !== "context");
		if (unknown) throw new TypeError(`unknown field: items[${index}].${unknown}`);
		const content = stringValue(record, "content", { max: MAX_MEMORY_CHARS });
		const context = stringValue(record, "context", { optional: true, max: MAX_CONTEXT_CHARS });
		total += content!.length + (context?.length ?? 0);
		if (total > MAX_TOTAL_CONTENT_CHARS) throw new RangeError("items are too large");
		return context === undefined ? { content: content! } : { content: content!, context };
	});
}

function editOperation(data: Readonly<Record<string, unknown>>): EditOperation {
	const value = data.op;
	if (value === "update" || value === "forget" || value === "invalidate") return value;
	throw new TypeError("op must be update, forget, or invalidate");
}

function managedSkill(data: Readonly<Record<string, unknown>>): ManagedSkill | undefined {
	const value = data.skill;
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("skill must be an object");
	const record = value as Readonly<Record<string, unknown>>;
	const unknown = Object.keys(record).find(key => !["action", "name", "description", "body"].includes(key));
	if (unknown) throw new TypeError(`unknown field: skill.${unknown}`);
	if (record.action !== "create" && record.action !== "update")
		throw new TypeError("skill.action must be create or update");
	return {
		action: record.action,
		name: stringValue(record, "name", { max: MAX_SKILL_NAME_CHARS })!,
		description: stringValue(record, "description", { max: MAX_SKILL_DESCRIPTION_CHARS })!,
		body: stringValue(record, "body", { max: MAX_SKILL_BODY_CHARS })!,
	};
}

function clipped(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function clippedString(value: unknown, limit: number): string | undefined {
	return typeof value === "string" ? clipped(value, limit) : undefined;
}

function hindsightItems(results: readonly Record<string, unknown>[]): Record<string, unknown>[] {
	return results.slice(0, MAX_RESULT_ITEMS).flatMap(result => {
		const content = clippedString(result.text, MAX_RESULT_CONTENT_CHARS);
		if (!content) return [];
		const item: Record<string, unknown> = { content };
		const id = clippedString(result.id, MAX_MEMORY_ID_CHARS);
		const type = clippedString(result.type, 256);
		const mentionedAt = clippedString(result.mentioned_at, 256);
		if (id) item.id = id;
		if (type) item.type = type;
		if (mentionedAt) item.mentioned_at = mentionedAt;
		return [item];
	});
}

function mnemopiItems(results: readonly Record<string, unknown>[]): Record<string, unknown>[] {
	return results.slice(0, MAX_RESULT_ITEMS).flatMap(result => {
		const content = clippedString(result.content, MAX_RESULT_CONTENT_CHARS);
		if (!content) return [];
		const item: Record<string, unknown> = { content };
		for (const key of ["id", "source", "timestamp", "tier", "tier_label"] as const) {
			const value = clippedString(result[key], key === "id" ? MAX_MEMORY_ID_CHARS : 256);
			if (value) item[key] = value;
		}
		for (const key of ["score", "importance"] as const) {
			const value = result[key];
			if (typeof value === "number" && Number.isFinite(value)) item[key] = value;
		}
		return [item];
	});
}

function configuredBackend(owner: IpythonLongTermMemoryOwner): IpythonLongTermMemoryBackend {
	const backend = owner.backend();
	if (backend === "hindsight" || backend === "mnemopi" || backend === "local") return backend;
	throw new Error("Long-term memory is disabled for this session.");
}

function requireHindsight(owner: IpythonLongTermMemoryOwner): HindsightSessionState {
	if (owner.backend() !== "hindsight")
		throw new Error("This operation requires the configured Hindsight memory backend.");
	const state = owner.hindsight();
	if (!state) throw new Error("Hindsight backend is not initialised for this session.");
	return state;
}

function requireMnemopi(owner: IpythonLongTermMemoryOwner): MnemopiSessionState {
	if (owner.backend() !== "mnemopi") throw new Error("This operation requires the configured Mnemopi memory backend.");
	const state = owner.mnemopi();
	if (!state) throw new Error("Mnemopi backend is not initialised for this session.");
	return state;
}

async function defaultEnsureHindsightBank(state: HindsightSessionState, signal: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await ensureBankExists(state.client, state.bankId, state.config, state.banksSet);
	throwIfAborted(signal);
}

/** Owns the typed IPython projection of the configured long-term memory backend. */
export class IpythonLongTermMemoryService {
	readonly handlers: IpythonHostHandlers;
	readonly #owner: IpythonLongTermMemoryOwner;
	readonly #ensureHindsightBank: (state: HindsightSessionState, signal: AbortSignal) => Promise<void>;
	readonly #saveLocalLesson: NonNullable<IpythonLongTermMemoryServiceOptions["saveLocalLesson"]>;
	readonly #writeManagedSkill: typeof writeManagedSkill;
	readonly #isNameClaimedByAuthoredSkill: typeof isNameClaimedByAuthoredSkill;

	constructor(options: IpythonLongTermMemoryServiceOptions) {
		this.#owner = options.owner;
		this.#ensureHindsightBank = options.ensureHindsightBank ?? defaultEnsureHindsightBank;
		this.#saveLocalLesson =
			options.saveLocalLesson ?? (async (context, input) => await localBackend.save?.(context, input));
		this.#writeManagedSkill = options.writeManagedSkill ?? writeManagedSkill;
		this.#isNameClaimedByAuthoredSkill = options.isNameClaimedByAuthoredSkill ?? isNameClaimedByAuthoredSkill;
		this.handlers = {
			"long_term_memory.retain": request => this.#retain(request),
			"long_term_memory.recall": request => this.#recall(request),
			"long_term_memory.reflect": request => this.#reflect(request),
			"long_term_memory.edit": request => this.#edit(request),
			"long_term_memory.learn": request => this.#learn(request),
		};
	}

	async #retain(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["items"]);
		const items = retainItems(request.data);
		throwIfAborted(request.signal);
		const backend = configuredBackend(this.#owner);
		if (backend === "hindsight") {
			const state = requireHindsight(this.#owner);
			for (const item of items) state.enqueueRetain(item.content, item.context);
			throwIfAborted(request.signal);
			return { backend, queued: items.length };
		}
		if (backend === "mnemopi") {
			const state = requireMnemopi(this.#owner);
			const ids: string[] = [];
			for (const item of items) {
				throwIfAborted(request.signal);
				const id = state.rememberScoped(item.content, {
					source: "coding-agent-retain",
					importance: 0.75,
					metadata: {
						session_id: state.sessionId,
						cwd: this.#owner.cwd(),
						context: item.context ?? null,
						tool: "retain",
					},
					scope: "bank",
					extract: true,
					extractEntities: true,
					veracity: "tool",
					memoryType: "fact",
				});
				if (id) ids.push(clipped(id, MAX_MEMORY_ID_CHARS));
			}
			throwIfAborted(request.signal);
			return { backend, stored: items.length, ...(ids.length > 0 ? { ids } : {}) };
		}
		throw new Error("The local memory backend only supports learn.");
	}

	async #recall(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["query"]);
		const query = stringValue(request.data, "query", { max: MAX_QUERY_CHARS })!;
		throwIfAborted(request.signal);
		const backend = configuredBackend(this.#owner);
		if (backend === "hindsight") {
			const state = requireHindsight(this.#owner);
			return await untilAborted(request.signal, async () => {
				const response = await state.client.recall(state.bankId, query, {
					budget: state.config.recallBudget,
					maxTokens: state.config.recallMaxTokens,
					types: state.config.recallTypes.length > 0 ? state.config.recallTypes : undefined,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
					signal: request.signal,
				});
				throwIfAborted(request.signal);
				const items = hindsightItems(response.results ?? []);
				return { backend, query, count: items.length, items };
			});
		}
		if (backend === "mnemopi") {
			const state = requireMnemopi(this.#owner);
			return await untilAborted(request.signal, async () => {
				const results = await state.recallResultsScoped(query);
				throwIfAborted(request.signal);
				const items = mnemopiItems(results);
				return { backend, query, count: items.length, items };
			});
		}
		throw new Error("The local memory backend does not support recall.");
	}

	async #reflect(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["query", "context"]);
		const query = stringValue(request.data, "query", { max: MAX_QUERY_CHARS })!;
		const context = stringValue(request.data, "context", { optional: true, max: MAX_CONTEXT_CHARS });
		throwIfAborted(request.signal);
		const backend = configuredBackend(this.#owner);
		if (backend === "hindsight") {
			const state = requireHindsight(this.#owner);
			return await untilAborted(request.signal, async () => {
				await this.#ensureHindsightBank(state, request.signal);
				const response = await state.client.reflect(state.bankId, query, {
					context,
					budget: state.config.recallBudget,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
					signal: request.signal,
				});
				throwIfAborted(request.signal);
				return {
					backend,
					text: clipped(response.text?.trim() || "No relevant information found to reflect on.", MAX_MEMORY_CHARS),
				};
			});
		}
		if (backend === "mnemopi") {
			const state = requireMnemopi(this.#owner);
			return await untilAborted(request.signal, async () => {
				const recallQuery = context?.trim() ? `${query.trim()}\n\nAdditional context:\n${context.trim()}` : query;
				const results = await state.recallResultsScoped(recallQuery);
				throwIfAborted(request.signal);
				const text =
					results.length === 0
						? "No relevant information found to reflect on."
						: `Based on recalled memories:\n\n${state.formatContextScoped(results)}`;
				return {
					backend,
					text: clipped(text, MAX_MEMORY_CHARS),
					count: Math.min(results.length, MAX_RESULT_ITEMS),
				};
			});
		}
		throw new Error("The local memory backend does not support reflect.");
	}

	async #edit(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["op", "id", "content", "importance", "replacement_id"]);
		const op = editOperation(request.data);
		const id = stringValue(request.data, "id", { max: MAX_MEMORY_ID_CHARS })!;
		const content = stringValue(request.data, "content", { optional: true, max: MAX_MEMORY_CHARS });
		const importance = finiteNumberValue(request.data, "importance");
		const replacementId = stringValue(request.data, "replacement_id", { optional: true, max: MAX_MEMORY_ID_CHARS });
		if (op === "update" && content === undefined && importance === undefined) {
			throw new Error("edit update requires content or importance.");
		}
		throwIfAborted(request.signal);
		const state = requireMnemopi(this.#owner);
		const result = state.editScopedMemory(op, id, {
			content,
			importance: importance === undefined ? undefined : Math.max(0, Math.min(1, importance)),
			replacementId,
		});
		throwIfAborted(request.signal);
		return {
			status: result.status,
			...(result.bank ? { bank: clipped(result.bank, MAX_MEMORY_ID_CHARS) } : {}),
			...(result.store ? { store: result.store } : {}),
		};
	}

	async #learn(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["memory", "context", "skill"]);
		const memory = stringValue(request.data, "memory", { max: MAX_MEMORY_CHARS })!;
		const context = stringValue(request.data, "context", { optional: true, max: MAX_CONTEXT_CHARS });
		const skill = managedSkill(request.data);
		if (!this.#owner.autolearnEnabled()) throw new Error("Learning requires autolearn.enabled.");
		throwIfAborted(request.signal);
		const backend = configuredBackend(this.#owner);
		let memoryResult: Record<string, unknown>;
		if (backend === "hindsight") {
			const state = requireHindsight(this.#owner);
			state.enqueueRetain(memory, context);
			memoryResult = { status: "queued" };
		} else if (backend === "mnemopi") {
			const state = requireMnemopi(this.#owner);
			const id = state.rememberScoped(memory, {
				source: "coding-agent-learn",
				importance: 0.8,
				metadata: {
					session_id: state.sessionId,
					cwd: this.#owner.cwd(),
					context: context ?? null,
					tool: "learn",
				},
				scope: "bank",
				extract: true,
				extractEntities: true,
				veracity: "tool",
				memoryType: "fact",
			});
			if (!id) throw new Error("Mnemopi did not store the lesson (no memory id returned).");
			memoryResult = { status: "stored", id: clipped(id, MAX_MEMORY_ID_CHARS) };
		} else {
			const result = await this.#saveLocalLesson(
				{ agentDir: this.#owner.agentDir(), cwd: this.#owner.cwd() },
				{ content: memory, context, source: "coding-agent-learn", importance: 0.8 },
			);
			throwIfAborted(request.signal);
			if (!result || result.stored === 0) throw new Error("Lesson was empty after sanitization; nothing stored.");
			memoryResult = { status: "stored", stored: result.stored };
		}
		throwIfAborted(request.signal);
		if (!skill) return { backend, memory: memoryResult, skill: null, partial: false };

		let safeSkillName: string | undefined;
		try {
			safeSkillName = sanitizeSkillName(skill.name);
		} catch {
			// writeManagedSkill returns the authoritative validation message below.
		}
		if (skill.action === "create" && safeSkillName && this.#isNameClaimedByAuthoredSkill(safeSkillName)) {
			return {
				backend,
				memory: memoryResult,
				skill: { status: "failed", name: skill.name, reason: "An authored skill of that name already exists." },
				partial: true,
			};
		}
		try {
			await this.#writeManagedSkill(skill);
			throwIfAborted(request.signal);
			return {
				backend,
				memory: memoryResult,
				skill: { status: skill.action === "create" ? "created" : "updated", name: skill.name },
				partial: false,
			};
		} catch (error) {
			if (request.signal.aborted) throw new ToolAbortError();
			const reason = error instanceof Error ? error.message : String(error);
			return {
				backend,
				memory: memoryResult,
				skill: { status: "failed", name: skill.name, reason: clipped(reason, 4_096) },
				partial: true,
			};
		}
	}
}
