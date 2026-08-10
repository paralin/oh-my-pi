import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { sanitizeManagedDescription } from "../autolearn/managed-skills";

export type HarnessKind = "prompt" | "memory" | "rule" | "skill" | "subagent";
export type HarnessScope = "local" | "global";

export interface HarnessEntry {
	id: string;
	kind: HarnessKind;
	title: string;
	content: string;
	path: string;
	scope: HarnessScope;
	reference: Record<string, unknown>;
	arguments: Record<string, unknown>;
	metadata: Record<string, unknown>;
	source: string;
	created_at: string;
	updated_at: string;
	version: number;
}

export interface HarnessRefinementEvent {
	id: string;
	trigger: string;
	changes: string[];
	evidence: string;
	outcome: string;
	created_at: string;
}

export interface HarnessWriteInput {
	kind: HarnessKind;
	id?: string;
	title: string;
	content: string;
	path?: string;
	reference?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	source?: string;
	global: boolean;
}

export interface HarnessUpdateInput extends HarnessWriteInput {
	id: string;
	path?: string;
}

export interface HarnessService {
	upsert(input: HarnessWriteInput, signal?: AbortSignal): Promise<HarnessEntry>;
	create(input: HarnessWriteInput, signal?: AbortSignal): Promise<HarnessEntry>;
	update(input: HarnessUpdateInput, signal?: AbortSignal): Promise<HarnessEntry>;
	get(kind: HarnessKind, id: string, global: boolean, signal?: AbortSignal): Promise<HarnessEntry | null>;
	delete(kind: HarnessKind, id: string, global: boolean, signal?: AbortSignal): Promise<boolean>;
	list(kind: HarnessKind | undefined, global: boolean, signal?: AbortSignal): Promise<HarnessEntry[]>;
	recordRefinement(
		input: {
			id?: string;
			trigger: string;
			changes: string[];
			evidence?: string;
			outcome?: string;
			global: boolean;
		},
		signal?: AbortSignal,
	): Promise<HarnessRefinementEvent>;
	refinements(global: boolean, signal?: AbortSignal): Promise<HarnessRefinementEvent[]>;
	overview(global: boolean, maxEntriesPerKind: number, signal?: AbortSignal): Promise<string>;
	snapshot(global: boolean, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export interface OmpHarnessServiceOptions {
	localRoot: () => string | null;
	globalRoot: string;
	refresh?: () => Promise<void>;
	now?: () => Date;
}

const KINDS: readonly HarnessKind[] = ["prompt", "memory", "rule", "skill", "subagent"];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const DISCOVERABLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TITLE_CHARS = 256;
const MAX_CONTENT_CHARS = 64_000;
const MAX_JSON_CHARS = 64_000;
const MAX_ENTRIES = 500;

function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Harness operation aborted");
}

function text(value: string, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
	if (value.length > max) throw new Error(`${label} must be at most ${max} characters`);
	return value.trim();
}

function id(value: string): string {
	const resolved = text(value, "harness id", 80);
	if (!ID_PATTERN.test(resolved)) {
		throw new Error("harness id must use letters, digits, underscores, or hyphens and start with a letter or digit");
	}
	return resolved;
}

function entryIdForKind(entryKind: HarnessKind, value: string): string {
	const resolved = id(value);
	if ((entryKind === "skill" || entryKind === "subagent") && !DISCOVERABLE_ID_PATTERN.test(resolved)) {
		throw new Error(`${entryKind} id must use lowercase letters, digits, or hyphens for OMP discovery`);
	}
	return resolved;
}

function object(value: Record<string, unknown> | undefined, label: string): Record<string, unknown> {
	const resolved = value ?? {};
	const encoded = JSON.stringify(resolved);
	if (encoded.length > MAX_JSON_CHARS) throw new Error(`${label} must be at most ${MAX_JSON_CHARS} JSON characters`);
	return structuredClone(resolved);
}

function kind(value: string): HarnessKind {
	if (!KINDS.includes(value as HarnessKind)) throw new Error(`unknown harness kind ${JSON.stringify(value)}`);
	return value as HarnessKind;
}

function scope(global: boolean): HarnessScope {
	return global ? "global" : "local";
}

function generatedId(kind: HarnessKind): string {
	return `${kind}-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

const DOMAIN_DIR: Readonly<Record<HarnessKind, string>> = {
	prompt: "managed-prompts",
	memory: "managed-memory",
	rule: "managed-rules",
	skill: "managed-skills",
	subagent: "managed-agents",
};

async function assertDirectorySafe(directory: string): Promise<void> {
	const stat = await fs.lstat(directory).catch(error => {
		if ((error as { code?: string }).code === "ENOENT") return null;
		throw error;
	});
	if (stat?.isSymbolicLink()) throw new Error(`Managed OMP directory is a symlink: ${directory}`);
	if (stat && !stat.isDirectory()) throw new Error(`Managed OMP path is not a directory: ${directory}`);
}

async function atomicWrite(file: string, content: string): Promise<void> {
	const directory = path.dirname(file);
	await assertDirectorySafe(directory);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await assertDirectorySafe(directory);
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
		await fs.rename(temporary, file);
	} finally {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
	}
}

function parseDocument(raw: string): { metadata: Record<string, unknown>; body: string } | null {
	if (!raw.startsWith("---\n")) return null;
	const end = raw.indexOf("\n---\n", 4);
	if (end < 0) return null;
	const value: unknown = YAML.parse(raw.slice(4, end));
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return { metadata: value as Record<string, unknown>, body: raw.slice(end + 5).trim() };
}

function entryDocument(entry: HarnessEntry): string {
	const { content, ...metadata } = entry;
	const native =
		entry.kind === "skill" || entry.kind === "subagent"
			? { name: entry.id, description: sanitizeManagedDescription(entry.title), ...metadata }
			: entry.kind === "rule"
				? { description: sanitizeManagedDescription(entry.title), alwaysApply: true, ...metadata }
				: metadata;
	return `---\n${YAML.stringify(native, null, 2).trimEnd()}\n---\n\n${content}\n`;
}

function refinementDocument(event: HarnessRefinementEvent): string {
	return `---\n${YAML.stringify(event, null, 2).trimEnd()}\n---\n`;
}

function parseEntry(raw: string): HarnessEntry | null {
	const document = parseDocument(raw);
	if (!document) return null;
	const { name: _name, description: _description, ...metadata } = document.metadata;
	const item = { ...metadata, content: document.body } as Record<string, unknown>;
	return isEntry(item) ? item : null;
}

function parseRefinement(raw: string): HarnessRefinementEvent | null {
	const document = parseDocument(raw);
	if (!document) return null;
	return isRefinement(document.metadata) ? document.metadata : null;
}

function isEntry(value: unknown): value is HarnessEntry {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.id === "string" &&
		KINDS.includes(item.kind as HarnessKind) &&
		typeof item.title === "string" &&
		typeof item.content === "string" &&
		(item.scope === "local" || item.scope === "global") &&
		typeof item.path === "string" &&
		typeof item.source === "string" &&
		typeof item.created_at === "string" &&
		typeof item.updated_at === "string" &&
		typeof item.version === "number" &&
		item.reference !== null &&
		typeof item.reference === "object" &&
		item.arguments !== null &&
		typeof item.arguments === "object" &&
		item.metadata !== null &&
		typeof item.metadata === "object"
	);
}

function isRefinement(value: unknown): value is HarnessRefinementEvent {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.id === "string" &&
		typeof item.trigger === "string" &&
		Array.isArray(item.changes) &&
		item.changes.every(change => typeof change === "string") &&
		typeof item.evidence === "string" &&
		typeof item.outcome === "string" &&
		typeof item.created_at === "string"
	);
}

export class OmpHarnessService implements HarnessService {
	readonly #localRoot: () => string | null;
	readonly #globalRoot: string;
	readonly #refresh: (() => Promise<void>) | undefined;
	readonly #now: () => Date;

	constructor(options: OmpHarnessServiceOptions) {
		this.#localRoot = options.localRoot;
		this.#globalRoot = options.globalRoot;
		this.#refresh = options.refresh;
		this.#now = options.now ?? (() => new Date());
	}

	#root(global: boolean): string {
		const root = global ? this.#globalRoot : this.#localRoot();
		if (!root) throw new Error("local harness storage requires a persistent session sidecar");
		return root;
	}

	#entryDirectory(root: string, entryKind: HarnessKind): string {
		return path.join(root, DOMAIN_DIR[entryKind]);
	}

	#entryPath(root: string, entryKind: HarnessKind, entryId: string): string {
		const safeId = entryIdForKind(entryKind, entryId);
		const directory = this.#entryDirectory(root, entryKind);
		return entryKind === "skill" ? path.join(directory, safeId, "SKILL.md") : path.join(directory, `${safeId}.md`);
	}

	async #prepareDomain(root: string, entryKind: HarnessKind, create: boolean): Promise<void> {
		const directory = this.#entryDirectory(root, entryKind);
		await assertDirectorySafe(directory);
		if (create) {
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			await assertDirectorySafe(directory);
		}
	}

	async #assertEntryPathSafe(root: string, entryKind: HarnessKind, entryId: string): Promise<void> {
		await this.#prepareDomain(root, entryKind, false);
		if (entryKind === "skill") {
			await assertDirectorySafe(
				path.join(this.#entryDirectory(root, entryKind), entryIdForKind(entryKind, entryId)),
			);
		}
	}

	async #lock<T>(
		global: boolean,
		signal: AbortSignal | undefined,
		operation: (root: string) => Promise<T>,
	): Promise<T> {
		checkAbort(signal);
		const root = this.#root(global);
		await fs.mkdir(root, { recursive: true });
		return await withFileLock(
			path.join(root, ".managed-omp-mutation"),
			async () => {
				checkAbort(signal);
				return await operation(root);
			},
			{ signal },
		);
	}

	async #readEntry(root: string, entryKind: HarnessKind, entryId: string): Promise<HarnessEntry | null> {
		await this.#assertEntryPathSafe(root, entryKind, entryId);
		try {
			return parseEntry(await fs.readFile(this.#entryPath(root, entryKind, entryId), "utf8"));
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return null;
			throw error;
		}
	}

	#makeEntry(input: HarnessWriteInput, existing?: HarnessEntry): HarnessEntry {
		const entryKind = kind(input.kind);
		const entryId = entryIdForKind(entryKind, input.id ?? generatedId(entryKind));
		const now = this.#now().toISOString();
		return {
			id: entryId,
			kind: entryKind,
			title: text(input.title, "harness title", MAX_TITLE_CHARS),
			content: text(input.content, "harness content", MAX_CONTENT_CHARS),
			path: input.path === undefined ? (existing?.path ?? "general") : text(input.path, "harness path", 256),
			scope: scope(input.global),
			reference:
				input.reference === undefined ? (existing?.reference ?? {}) : object(input.reference, "harness reference"),
			arguments:
				input.arguments === undefined ? (existing?.arguments ?? {}) : object(input.arguments, "harness arguments"),
			metadata:
				input.metadata === undefined ? (existing?.metadata ?? {}) : object(input.metadata, "harness metadata"),
			source: input.source === undefined ? (existing?.source ?? "agent") : text(input.source, "harness source", 128),
			created_at: existing?.created_at ?? now,
			updated_at: now,
			version: (existing?.version ?? 0) + 1,
		};
	}

	async #changed<T>(operation: () => Promise<T>): Promise<T> {
		const result = await operation();
		await this.#refresh?.();
		return result;
	}

	async create(input: HarnessWriteInput, signal?: AbortSignal): Promise<HarnessEntry> {
		return await this.#changed(
			async () =>
				await this.#lock(input.global, signal, async root => {
					const entry = this.#makeEntry(input);
					if (await this.#readEntry(root, entry.kind, entry.id)) {
						throw new Error(`harness ${entry.kind} ${JSON.stringify(entry.id)} already exists`);
					}
					await this.#prepareDomain(root, entry.kind, true);
					await atomicWrite(this.#entryPath(root, entry.kind, entry.id), entryDocument(entry));
					return entry;
				}),
		);
	}

	async update(input: HarnessUpdateInput, signal?: AbortSignal): Promise<HarnessEntry> {
		return await this.#changed(
			async () =>
				await this.#lock(input.global, signal, async root => {
					const entryKind = kind(input.kind);
					const entryId = id(input.id);
					const existing = await this.#readEntry(root, entryKind, entryId);
					if (!existing) throw new Error(`harness ${entryKind} ${JSON.stringify(entryId)} does not exist`);
					const entry = this.#makeEntry({ ...input, id: entryId }, existing);
					await this.#prepareDomain(root, entry.kind, true);
					await atomicWrite(this.#entryPath(root, entry.kind, entry.id), entryDocument(entry));
					return entry;
				}),
		);
	}

	async upsert(input: HarnessWriteInput, signal?: AbortSignal): Promise<HarnessEntry> {
		return await this.#changed(
			async () =>
				await this.#lock(input.global, signal, async root => {
					const entryKind = kind(input.kind);
					const entryId = entryIdForKind(entryKind, input.id ?? generatedId(entryKind));
					const existing = await this.#readEntry(root, entryKind, entryId);
					const entry = this.#makeEntry({ ...input, id: entryId }, existing ?? undefined);
					await this.#prepareDomain(root, entry.kind, true);
					await atomicWrite(this.#entryPath(root, entry.kind, entry.id), entryDocument(entry));
					return entry;
				}),
		);
	}

	async get(
		entryKind: HarnessKind,
		entryId: string,
		global: boolean,
		signal?: AbortSignal,
	): Promise<HarnessEntry | null> {
		checkAbort(signal);
		return await this.#readEntry(this.#root(global), kind(entryKind), id(entryId));
	}

	async delete(entryKind: HarnessKind, entryId: string, global: boolean, signal?: AbortSignal): Promise<boolean> {
		return await this.#changed(
			async () =>
				await this.#lock(global, signal, async root => {
					const resolvedKind = kind(entryKind);
					const resolvedId = id(entryId);
					await this.#assertEntryPathSafe(root, resolvedKind, resolvedId);
					const file = this.#entryPath(root, resolvedKind, resolvedId);
					try {
						await fs.unlink(file);
						return true;
					} catch (error) {
						if ((error as { code?: string }).code === "ENOENT") return false;
						throw error;
					}
				}),
		);
	}

	async list(entryKind: HarnessKind | undefined, global: boolean, signal?: AbortSignal): Promise<HarnessEntry[]> {
		checkAbort(signal);
		const root = this.#root(global);
		const kinds = entryKind === undefined ? KINDS : [kind(entryKind)];
		const entries: HarnessEntry[] = [];
		for (const currentKind of kinds) {
			await this.#prepareDomain(root, currentKind, false);
			let names: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
			try {
				names = await fs.readdir(this.#entryDirectory(root, currentKind), { withFileTypes: true });
			} catch (error) {
				if ((error as { code?: string }).code === "ENOENT") continue;
				throw error;
			}
			for (const candidate of names.sort((left, right) => left.name.localeCompare(right.name))) {
				const entryId =
					currentKind === "skill"
						? candidate.isDirectory()
							? candidate.name
							: null
						: candidate.isFile() && candidate.name.endsWith(".md")
							? candidate.name.slice(0, -3)
							: null;
				if (!entryId || !ID_PATTERN.test(entryId)) continue;
				checkAbort(signal);
				const entry = await this.#readEntry(root, currentKind, entryId);
				if (entry) entries.push(entry);
				if (entries.length >= MAX_ENTRIES) return entries;
			}
		}
		return entries.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
	}

	async recordRefinement(
		input: {
			id?: string;
			trigger: string;
			changes: string[];
			evidence?: string;
			outcome?: string;
			global: boolean;
		},
		signal?: AbortSignal,
	): Promise<HarnessRefinementEvent> {
		return await this.#changed(
			async () =>
				await this.#lock(input.global, signal, async root => {
					if (!Array.isArray(input.changes) || input.changes.length === 0 || input.changes.length > 100) {
						throw new Error("harness refinement changes must contain 1 to 100 strings");
					}
					const event: HarnessRefinementEvent = {
						id: id(input.id ?? `refine_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`),
						trigger: text(input.trigger, "harness refinement trigger", 4_000),
						changes: input.changes.map((change, index) =>
							text(change, `harness refinement change ${index + 1}`, 4_000),
						),
						evidence: input.evidence ? text(input.evidence, "harness refinement evidence", 8_000) : "",
						outcome: input.outcome ? text(input.outcome, "harness refinement outcome", 8_000) : "",
						created_at: this.#now().toISOString(),
					};
					await this.#prepareDomain(root, "memory", true);
					const file = path.join(root, DOMAIN_DIR.memory, "refinements", `${event.id}.md`);
					try {
						await fs.access(file);
						throw new Error(`harness refinement ${JSON.stringify(event.id)} already exists`);
					} catch (error) {
						if ((error as { code?: string }).code !== "ENOENT") throw error;
					}
					await atomicWrite(file, refinementDocument(event));
					return event;
				}),
		);
	}

	async refinements(global: boolean, signal?: AbortSignal): Promise<HarnessRefinementEvent[]> {
		checkAbort(signal);
		const root = this.#root(global);
		await this.#prepareDomain(root, "memory", false);
		const dir = path.join(root, DOMAIN_DIR.memory, "refinements");
		let names: string[];
		try {
			names = await fs.readdir(dir);
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return [];
			throw error;
		}
		const events: HarnessRefinementEvent[] = [];
		for (const name of names.sort()) {
			if (!name.endsWith(".md")) continue;
			checkAbort(signal);
			try {
				const value = parseRefinement(await fs.readFile(path.join(dir, name), "utf8"));
				if (value) events.push(value);
			} catch {}
		}
		return events.slice(-MAX_ENTRIES);
	}

	async snapshot(global: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const entries = await this.list(undefined, global, signal);
		return {
			scope: scope(global),
			entries: Object.fromEntries(
				KINDS.map(entryKind => [entryKind, entries.filter(entry => entry.kind === entryKind)]),
			),
			refinements: await this.refinements(global, signal),
		};
	}

	async overview(global: boolean, maxEntriesPerKind: number, signal?: AbortSignal): Promise<string> {
		if (!Number.isInteger(maxEntriesPerKind) || maxEntriesPerKind < 1 || maxEntriesPerKind > 100) {
			throw new Error("max_entries_per_kind must be an integer from 1 to 100");
		}
		const entries = await this.list(undefined, global, signal);
		const lines = [`OMP continual harness (${scope(global)})`];
		for (const entryKind of KINDS) {
			const values = entries.filter(entry => entry.kind === entryKind).slice(0, maxEntriesPerKind);
			lines.push(`${entryKind}: ${values.length}`);
			for (const entry of values) lines.push(`- ${entry.id}: ${entry.title}`);
		}
		const refinements = await this.refinements(global, signal);
		lines.push(`refinements: ${refinements.length}`);
		return lines.join("\n");
	}
}
