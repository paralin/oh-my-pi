import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../session/tool-session";
import { type BrowserParams, openBrowserTab } from "../tools/browser";
import type { Observation, ScreenshotResult } from "../tools/browser/tab-protocol";
import * as tabs from "../tools/browser/tab-supervisor";
import { clampTimeout } from "../tools/operation-timeouts";
import { ToolError } from "../tools/tool-errors";
import type { IpythonHostArtifact, IpythonHostHandlers, IpythonHostRequest } from "./controller";

const DEFAULT_TAB_NAME = "main";
const MAX_NAME_CHARS = 256;
const MAX_URL_CHARS = 8_192;
const MAX_CODE_CHARS = 256_000;
const MAX_INLINE_TEXT_CHARS = 200_000;
const MAX_INLINE_IMAGE_CHARS = 350_000;

interface BrowserOpenResult {
	readonly created: boolean;
	readonly browser: string;
	readonly url: string;
	readonly title?: string;
	readonly viewport?: Readonly<Record<string, unknown>>;
}

interface BrowserRunResult {
	readonly displays: readonly (TextContent | ImageContent)[];
	readonly returnValue: unknown;
	readonly screenshots: readonly ScreenshotResult[];
	readonly observation?: Observation;
}

interface BrowserTabInfo {
	readonly browser: string;
	readonly url: string;
	readonly title?: string;
	readonly viewport?: Readonly<Record<string, unknown>>;
}

export interface IpythonBrowserOwner {
	open(name: string, params: BrowserParams, timeoutMs: number, signal: AbortSignal): Promise<BrowserOpenResult>;
	run(name: string, code: string, timeoutMs: number, signal: AbortSignal): Promise<BrowserRunResult>;
	close(name: string, options: { kill: boolean; timeoutMs: number }): Promise<boolean>;
	info(name: string): Promise<BrowserTabInfo | undefined>;
}

export interface IpythonBrowserServiceOptions {
	readonly owner: IpythonBrowserOwner;
	readonly timeoutMs: (requested: number | undefined) => Promise<number>;
	readonly sessionId: () => string;
}

function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function stringValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	options: { optional?: boolean; max?: number } = {},
): string {
	const value = data[name];
	if (value === undefined && options.optional) return "";
	if (typeof value !== "string" || (!options.optional && value.trim().length === 0)) {
		throw new TypeError(`${name} must be ${options.optional ? "a string" : "a nonempty string"}`);
	}
	if (value.length > (options.max ?? 16_384)) throw new RangeError(`${name} is too large`);
	return value;
}

function booleanValue(data: Readonly<Record<string, unknown>>, name: string, fallback: boolean): boolean {
	const value = data[name] ?? fallback;
	if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
	return value;
}

function numberValue(data: Readonly<Record<string, unknown>>, name: string): number | undefined {
	const value = data[name];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive number`);
	}
	return value;
}

function integerValue(data: Readonly<Record<string, unknown>>, name: string, min: number, max: number): number {
	const value = data[name];
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		throw new RangeError(`${name} must be an integer from ${min} through ${max}`);
	}
	return value as number;
}

function waitUntilValue(data: Readonly<Record<string, unknown>>): BrowserParams["wait_until"] {
	const value = stringValue(data, "wait_until", { optional: true, max: 32 });
	if (value && !["load", "domcontentloaded", "networkidle0", "networkidle2"].includes(value)) {
		throw new RangeError("wait_until is invalid");
	}
	return (value || undefined) as BrowserParams["wait_until"];
}

function openParams(data: Readonly<Record<string, unknown>>): BrowserParams {
	strict(data, ["name", "url", "viewport", "wait_until", "dialogs", "timeout"]);
	let viewport: BrowserParams["viewport"];
	if (data.viewport !== undefined) {
		if (!data.viewport || typeof data.viewport !== "object" || Array.isArray(data.viewport)) {
			throw new TypeError("viewport must be an object");
		}
		const value = data.viewport as Readonly<Record<string, unknown>>;
		strict(value, ["width", "height", "scale"]);
		const scale = numberValue(value, "scale");
		if (scale !== undefined && scale > 4) throw new RangeError("viewport.scale must not exceed 4");
		viewport = {
			width: integerValue(value, "width", 1, 10_000),
			height: integerValue(value, "height", 1, 10_000),
			scale,
		};
	}
	const dialogs = stringValue(data, "dialogs", { optional: true, max: 16 });
	if (dialogs && dialogs !== "accept" && dialogs !== "dismiss")
		throw new RangeError("dialogs must be accept or dismiss");
	return {
		action: "open",
		name: stringValue(data, "name", { optional: true, max: MAX_NAME_CHARS }) || DEFAULT_TAB_NAME,
		url: stringValue(data, "url", { optional: true, max: MAX_URL_CHARS }) || undefined,
		viewport,
		wait_until: waitUntilValue(data),
		dialogs: (dialogs || undefined) as BrowserParams["dialogs"],
		timeout: numberValue(data, "timeout"),
	};
}

function jsonValue(value: unknown): unknown {
	if (value === undefined) return null;
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? String(value) : JSON.parse(encoded);
	} catch {
		return String(value);
	}
}

async function publishRunOutput(request: IpythonHostRequest, result: BrowserRunResult) {
	const textParts = result.displays
		.filter((entry): entry is TextContent => entry.type === "text")
		.map(entry => entry.text);
	if (result.returnValue !== undefined) {
		const value = jsonValue(result.returnValue);
		textParts.push(typeof value === "string" ? value : JSON.stringify(value, null, 2));
	}
	const complete = textParts.join("\n");
	let text = complete;
	let artifact: (IpythonHostArtifact & { bytes: number; mime_type: string }) | undefined;
	if (complete.length > MAX_INLINE_TEXT_CHARS) {
		const allocated = await request.allocateArtifact({
			label: "browser-output",
			mimeType: "text/plain",
			suffix: ".txt",
		});
		await fs.writeFile(allocated.path, complete, "utf8");
		text = complete.slice(0, MAX_INLINE_TEXT_CHARS);
		artifact = { ...allocated, bytes: Buffer.byteLength(complete), mime_type: "text/plain" };
	}
	const images: Readonly<Record<string, unknown>>[] = [];
	for (const [index, entry] of result.displays.filter(entry => entry.type === "image").entries()) {
		if (entry.type !== "image") continue;
		if (entry.data.length <= MAX_INLINE_IMAGE_CHARS) {
			await request.publishDisplay({
				data: { [entry.mimeType]: entry.data },
				metadata: {},
				transient: {},
				update: false,
				text: `[browser image: ${entry.mimeType}]`,
			});
			images.push({ mime_type: entry.mimeType, rich: true });
			continue;
		}
		const suffix = entry.mimeType === "image/jpeg" ? ".jpg" : entry.mimeType === "image/webp" ? ".webp" : ".png";
		const allocated = await request.allocateArtifact({
			label: `browser-image-${index + 1}`,
			mimeType: entry.mimeType,
			suffix,
		});
		const bytes = Buffer.from(entry.data, "base64");
		await fs.writeFile(allocated.path, bytes);
		images.push({ artifact: { ...allocated, bytes: bytes.length, mime_type: entry.mimeType }, rich: false });
	}
	return {
		text,
		artifact: artifact ?? null,
		images,
		screenshots: result.screenshots,
		observation: result.observation ?? null,
	};
}

interface BrowserEntry {
	readonly handle: string;
	readonly name: string;
	readonly internalName: string;
}

/** Owns opaque browser tab handles for one OMP session. */
export class IpythonBrowserService {
	readonly handlers: IpythonHostHandlers;
	readonly #entries = new Map<string, BrowserEntry>();
	readonly #names = new Map<string, string>();
	readonly #openChains = new Map<string, Promise<void>>();
	readonly #activeOpens = new Set<Promise<unknown>>();
	#transitionAbort = new AbortController();
	#suspending = false;
	#suspendPromise?: Promise<void>;
	#disposed = false;
	#disposePromise?: Promise<void>;

	constructor(private readonly options: IpythonBrowserServiceOptions) {
		this.handlers = {
			"browser.tabs": request => this.#tabs(request),
			"browser.open": request => this.#open(request),
			"browser.evaluate": request => this.#evaluate(request),
			"browser.release": request => this.#release(request),
		};
	}

	async #open(request: IpythonHostRequest) {
		request.signal.throwIfAborted();
		if (this.#disposed) throw new Error("browser service is disposed");
		if (this.#suspending) throw new Error("browser service is suspending");
		const params = openParams(request.data);
		const name = params.name ?? DEFAULT_TAB_NAME;
		const signal = AbortSignal.any([request.signal, this.#transitionAbort.signal]);
		const previous = this.#openChains.get(name) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>(resolve => {
			release = resolve;
		});
		const tail = previous.then(
			() => current,
			() => current,
		);
		this.#openChains.set(name, tail);
		void tail.finally(() => {
			if (this.#openChains.get(name) === tail) this.#openChains.delete(name);
		});
		const operation = (async () => {
			try {
				await untilAborted(signal, () => previous.catch(() => undefined));
				signal.throwIfAborted();
				if (this.#disposed) throw new Error("browser service is disposed");
				if (this.#suspending) throw new Error("browser service is suspending");
				return await this.#openNamed(request, params, name, signal);
			} finally {
				release();
			}
		})();
		this.#activeOpens.add(operation);
		try {
			return await operation;
		} finally {
			this.#activeOpens.delete(operation);
		}
	}

	async #openNamed(request: IpythonHostRequest, params: BrowserParams, name: string, signal: AbortSignal) {
		const existingHandle = this.#names.get(name);
		const existing = existingHandle ? this.#entries.get(existingHandle) : undefined;
		const handle = existing?.handle ?? `browser-${randomUUID()}`;
		const internalName = existing?.internalName ?? `${this.options.sessionId()}:${handle}`;
		const entry = { handle, name, internalName };
		const timeoutMs = await this.options.timeoutMs(params.timeout);
		await request.publishProgress("Browser tab open started", { name });
		const opened = await this.options.owner.open(internalName, params, timeoutMs, signal);
		if (signal.aborted || this.#disposed || this.#suspending) {
			this.#entries.set(handle, entry);
			this.#names.set(name, handle);
			try {
				await this.options.owner.close(internalName, {
					kill: this.#disposed || this.#suspending,
					timeoutMs: 5_000,
				});
				this.#deleteEntry(entry);
			} catch {
				// Retain the opaque entry so suspension or disposal can retry cleanup.
			}
			signal.throwIfAborted();
			throw new Error(this.#disposed ? "browser service is disposed" : "browser service is suspending");
		}
		this.#entries.set(handle, entry);
		this.#names.set(name, handle);
		await request.publishProgress(opened.created ? "Browser tab opened" : "Browser tab reused", {
			name,
			url: opened.url,
		});
		return { handle, name, ...opened };
	}

	#deleteEntry(entry: BrowserEntry): void {
		this.#entries.delete(entry.handle);
		if (this.#names.get(entry.name) === entry.handle) this.#names.delete(entry.name);
	}

	async #evaluate(request: IpythonHostRequest) {
		strict(request.data, ["handle", "code", "timeout"]);
		const code = stringValue(request.data, "code", { max: MAX_CODE_CHARS });
		return await this.#runTab(request, code, numberValue(request.data, "timeout"));
	}

	async #runTab(request: IpythonHostRequest, code: string, timeout: number | undefined) {
		request.signal.throwIfAborted();
		const handle = stringValue(request.data, "handle", { max: MAX_NAME_CHARS });
		const entry = this.#entries.get(handle);
		if (!entry) throw new ToolError("unknown or closed browser handle");
		const timeoutMs = await this.options.timeoutMs(timeout);
		await request.publishProgress("Browser run started", { name: entry.name });
		const result = await this.options.owner.run(entry.internalName, code, timeoutMs, request.signal);
		request.signal.throwIfAborted();
		const output = await publishRunOutput(request, result);
		await request.publishProgress("Browser run completed", { name: entry.name });
		return { handle, name: entry.name, ...output };
	}

	async #release(request: IpythonHostRequest) {
		strict(request.data, ["handle", "all", "kill", "timeout"]);
		request.signal.throwIfAborted();
		const all = booleanValue(request.data, "all", false);
		const hasHandle = request.data.handle !== undefined;
		if (hasHandle && (typeof request.data.handle !== "string" || request.data.handle.trim().length === 0)) {
			throw new TypeError("handle must be a nonempty string");
		}
		if (all === hasHandle) throw new TypeError("release requires exactly one handle or all=true");
		const kill = booleanValue(request.data, "kill", false);
		const timeoutMs = await this.options.timeoutMs(numberValue(request.data, "timeout"));
		if (all) return { closed: await this.#closeAll(kill, timeoutMs, false) };
		const handle = stringValue(request.data, "handle", { max: MAX_NAME_CHARS });
		const entry = this.#entries.get(handle);
		if (!entry) return { handle, closed: false };
		const closed = await this.options.owner.close(entry.internalName, { kill, timeoutMs });
		this.#deleteEntry(entry);
		return { handle, name: entry.name, closed };
	}

	async #tabs(request: IpythonHostRequest) {
		strict(request.data, []);
		request.signal.throwIfAborted();
		return {
			items: await Promise.all(
				[...this.#entries.values()].map(async entry => ({
					handle: entry.handle,
					name: entry.name,
					info: (await this.options.owner.info(entry.internalName)) ?? null,
				})),
			),
		};
	}

	async #closeAll(kill: boolean, timeoutMs: number, bestEffort: boolean): Promise<number> {
		let closed = 0;
		let failure: unknown;
		for (const entry of [...this.#entries.values()]) {
			try {
				if (await this.options.owner.close(entry.internalName, { kill, timeoutMs })) closed += 1;
				this.#deleteEntry(entry);
			} catch (error) {
				failure ??= error;
			}
		}
		if (failure && !bestEffort) throw failure;
		if (bestEffort) {
			this.#entries.clear();
			this.#names.clear();
		}
		return closed;
	}

	suspend(): Promise<void> {
		if (this.#suspendPromise) return this.#suspendPromise;
		this.#suspending = true;
		this.#transitionAbort.abort(new Error("browser service is suspending"));
		this.#suspendPromise = (async () => {
			await Promise.allSettled([...this.#activeOpens]);
			await this.#closeAll(true, 5_000, true);
		})().finally(() => {
			this.#suspending = false;
			this.#suspendPromise = undefined;
			if (!this.#disposed) this.#transitionAbort = new AbortController();
		});
		return this.#suspendPromise;
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#transitionAbort.abort(new Error("browser service is disposed"));
		this.#disposePromise = (async () => {
			if (this.#suspendPromise) await this.#suspendPromise;
			await Promise.allSettled([...this.#activeOpens]);
			await this.#closeAll(true, 5_000, true);
		})();
		return this.#disposePromise;
	}
}

/** Binds browser registry and tab-supervisor owners to one ToolSession. */
export function createIpythonBrowserService(session: ToolSession): IpythonBrowserService {
	const owner: IpythonBrowserOwner = {
		open: async (name, params, timeoutMs, signal) => {
			const result = await openBrowserTab(session, name, params, timeoutMs, signal);
			return {
				created: result.created,
				browser: result.tab.kindTag,
				url: result.tab.info.url,
				title: result.tab.info.title,
				viewport: result.tab.info.viewport,
			};
		},
		run: async (name, code, timeoutMs, signal) => {
			return await tabs.runInTab(name, { code, timeoutMs, signal, session });
		},
		close: async (name, options) => {
			return await tabs.releaseTab(name, options);
		},
		info: async name => {
			const tab = tabs.getTab(name);
			return tab
				? { browser: tab.browser.kind.kind, url: tab.info.url, title: tab.info.title, viewport: tab.info.viewport }
				: undefined;
		},
	};
	return new IpythonBrowserService({
		owner,
		timeoutMs: async requested => {
			return clampTimeout("browser", requested, session.settings.get("tools.maxTimeout")) * 1_000;
		},
		sessionId: () => session.getSessionId?.() ?? "browser",
	});
}
