import * as fs from "node:fs/promises";
import type { ComputerRunOk, ComputerSessionSnapshot } from "../tools/computer/protocol";
import type { ComputerController } from "../tools/computer/supervisor";
import type { IpythonHostArtifact, IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_CODE_CHARS = 256_000;
const MAX_INLINE_TEXT_CHARS = 200_000;
const MAX_INLINE_IMAGE_CHARS = 350_000;

export interface IpythonComputerServiceOptions {
	readonly createController: () => Promise<ComputerController>;
	readonly snapshot: (
		readOnly: boolean,
		identity: Pick<ComputerSessionSnapshot, "cwd" | "sessionId">,
	) => Promise<ComputerSessionSnapshot>;
	readonly timeoutMs: (requested: number | undefined) => Promise<number>;
}

function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function codeValue(data: Readonly<Record<string, unknown>>): string {
	const code = data.code;
	if (typeof code !== "string" || code.trim().length === 0) throw new TypeError("code must be a nonempty string");
	if (code.length > MAX_CODE_CHARS) throw new RangeError("code is too large");
	return code;
}

function booleanValue(data: Readonly<Record<string, unknown>>, name: string, fallback: boolean): boolean {
	const value = data[name] ?? fallback;
	if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
	return value;
}

function timeoutValue(data: Readonly<Record<string, unknown>>): number | undefined {
	const value = data.timeout;
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new RangeError("timeout must be a positive number");
	}
	return value;
}

function returnValue(value: unknown): unknown {
	if (value === undefined) return null;
	try {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) return String(value);
		return JSON.parse(encoded);
	} catch {
		return String(value);
	}
}

async function publishRunOutput(
	request: IpythonHostRequest,
	run: ComputerRunOk,
): Promise<Readonly<Record<string, unknown>>> {
	const text = run.displays
		.filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
		.map(entry => entry.text)
		.join("\n");
	let visibleText = text;
	let textArtifact: (IpythonHostArtifact & { bytes: number; mime_type: string }) | undefined;
	if (text.length > MAX_INLINE_TEXT_CHARS) {
		const artifact = await request.allocateArtifact({
			label: "computer-output",
			mimeType: "text/plain",
			suffix: ".txt",
		});
		await fs.writeFile(artifact.path, text, "utf8");
		visibleText = text.slice(0, MAX_INLINE_TEXT_CHARS);
		textArtifact = { ...artifact, bytes: Buffer.byteLength(text), mime_type: "text/plain" };
	}

	const images: Readonly<Record<string, unknown>>[] = [];
	for (const [index, entry] of run.displays.filter(entry => entry.type === "image").entries()) {
		if (entry.type !== "image") continue;
		const mimeType = entry.mimeType;
		if (entry.data.length <= MAX_INLINE_IMAGE_CHARS) {
			await request.publishDisplay({
				data: { [mimeType]: entry.data },
				metadata: {},
				transient: {},
				update: false,
				text: `[computer image: ${mimeType}]`,
			});
			images.push({ mime_type: mimeType, rich: true });
			continue;
		}
		const suffix = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
		const artifact = await request.allocateArtifact({ label: `computer-image-${index + 1}`, mimeType, suffix });
		const bytes = Buffer.from(entry.data, "base64");
		await fs.writeFile(artifact.path, bytes);
		images.push({ artifact: { ...artifact, bytes: bytes.length, mime_type: mimeType }, rich: false });
	}

	return {
		return_value: returnValue(run.returnValue),
		text: visibleText,
		text_artifact: textArtifact ?? null,
		images,
		screenshots: run.screenshots.map(screenshot => ({
			path: screenshot.path,
			width: screenshot.width,
			height: screenshot.height,
			source_width: screenshot.sourceWidth ?? null,
			source_height: screenshot.sourceHeight ?? null,
			target: screenshot.target,
		})),
		capabilities: run.capabilities ?? null,
	};
}

/** Owns one lazy crash-recovering desktop worker for the current OMP session. */
export class IpythonComputerService {
	readonly handlers: IpythonHostHandlers;
	#controller?: Promise<ComputerController>;
	#active = false;
	#suspending = false;
	#suspendPromise?: Promise<void>;
	#disposed = false;
	#disposePromise?: Promise<void>;

	constructor(private readonly options: IpythonComputerServiceOptions) {
		this.handlers = {
			"computer.capabilities": request => this.#capabilities(request),
			"computer.evaluate": request => this.#evaluate(request),
			"computer.release": request => this.#release(request),
		};
	}

	#getController(): Promise<ComputerController> {
		if (this.#disposed) throw new Error("computer service is disposed");
		if (this.#suspending) throw new Error("computer service is suspending");
		if (!this.#controller) this.#controller = this.options.createController();
		return this.#controller;
	}

	async #capabilities(request: IpythonHostRequest) {
		strict(request.data, []);
		request.signal.throwIfAborted();
		const capabilities = await (await this.#getController()).capabilities();
		request.signal.throwIfAborted();
		return { capabilities: capabilities ?? null };
	}

	async #evaluate(request: IpythonHostRequest) {
		strict(request.data, ["code", "read_only", "timeout"]);
		const code = codeValue(request.data);
		const readOnly = booleanValue(request.data, "read_only", false);
		return await this.#execute(request, code, readOnly, timeoutValue(request.data));
	}

	async #execute(request: IpythonHostRequest, code: string, readOnly: boolean, timeout: number | undefined) {
		request.signal.throwIfAborted();
		if (this.#active) throw new Error("computer session is busy");
		this.#active = true;
		try {
			const timeoutMs = await this.options.timeoutMs(timeout);
			await request.publishProgress(readOnly ? "Computer inspection started" : "Computer operation started", {
				read_only: readOnly,
			});
			const controller = await this.#getController();
			const snapshot = await this.options.snapshot(readOnly, {
				cwd: request.cwd,
				sessionId: request.sessionId,
			});
			const result = await controller.run(code, timeoutMs, snapshot, request.signal);
			request.signal.throwIfAborted();
			const output = await publishRunOutput(request, result);
			await request.publishProgress(readOnly ? "Computer inspection completed" : "Computer operation completed", {
				read_only: readOnly,
			});
			return { read_only: readOnly, ...output };
		} finally {
			this.#active = false;
		}
	}

	async #release(request: IpythonHostRequest) {
		strict(request.data, []);
		request.signal.throwIfAborted();
		if (this.#active) throw new Error("computer session is busy");
		await this.suspend();
		return { closed: true };
	}

	suspend(): Promise<void> {
		if (this.#suspendPromise) return this.#suspendPromise;
		this.#suspending = true;
		const controller = this.#controller;
		this.#controller = undefined;
		this.#suspendPromise = (async () => {
			if (controller) await (await controller).close();
		})().finally(() => {
			this.#suspending = false;
			this.#suspendPromise = undefined;
		});
		return this.#suspendPromise;
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#disposePromise = this.suspend();
		return this.#disposePromise;
	}
}
