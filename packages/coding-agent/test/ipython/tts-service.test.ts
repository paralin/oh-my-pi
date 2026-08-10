import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IpythonHostRequest } from "../../src/ipython/controller.js";
import {
	createIpythonTtsService,
	IpythonTtsService,
	type IpythonTtsSynthesisRequest,
} from "../../src/ipython/tts-service.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function request(
	cwd: string,
	data: Readonly<Record<string, unknown>>,
	signal = new AbortController().signal,
): IpythonHostRequest {
	return {
		requestId: "request-1",
		commId: "comm-1",
		targetName: "host.request",
		data,
		signal,
		executionId: "execution-1",
		sessionId: "session-1",
		cwd,
		cellId: "cell-1",
		sequence: 1,
		origin: "model",
		authority: "trusted-cell",
		publishProgress: async () => {},
		publishDisplay: async () => {},
		allocateArtifact: async () => {
			throw new Error("speech does not allocate artifacts");
		},
	};
}

async function root(): Promise<string> {
	const value = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-tts-"));
	roots.push(value);
	return value;
}

describe("IPython TTS service", () => {
	test("keeps the advertised Python request mapped to a fixed host handler", async () => {
		const source = await Bun.file(new URL("../../src/ipython/python/omp/tts.py", import.meta.url)).text();
		const advertised = [...source.matchAll(/host_request\("(tts\.[a-z]+)"/g)].map(match => match[1]);
		const service = new IpythonTtsService({
			owner: () => {
				throw new Error("mapping only");
			},
		});
		expect(advertised.sort()).toEqual(Object.keys(service.handlers).sort());
	});

	test("uses the selected backend, writes local PCM16 WAV bytes, and confines output paths", async () => {
		const cwd = await root();
		const localCalls: Array<{ model: string; text: string; voice: string | undefined }> = [];
		const service = createIpythonTtsService({
			settings: {
				get: (key: unknown) => (key === "tts.localModel" ? "kokoro" : "af_heart"),
			} as never,
			modelRegistry: {} as never,
			sessionId: () => "session-1",
			localClient: {
				synthesize: async (model, text, options) => {
					localCalls.push({ model, text, voice: options?.voice });
					return { pcm: Float32Array.from([0, 0.5, -0.5]), sampleRate: 24_000 };
				},
			},
		});
		const result = await service.handlers["tts.synthesize"]!(
			request(cwd, { type: "tts.synthesize", text: "hello", output_path: "speech.mp3", backend: "local" }),
		);
		expect(result).toMatchObject({
			backend: "local",
			codec: "wav",
			path: path.join(cwd, "speech.wav"),
			sample_rate: 24_000,
		});
		const bytes = await fs.readFile(path.join(cwd, "speech.wav"));
		expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
		expect(result.bytes).toBe(bytes.byteLength);
		expect(localCalls).toEqual([{ model: "kokoro", text: "hello", voice: "af_heart" }]);
		await expect(
			service.handlers["tts.synthesize"]!(
				request(cwd, { type: "tts.synthesize", text: "no", output_path: "../outside.wav", backend: "local" }),
			),
		).rejects.toThrow("inside the project");
		await expect(
			service.handlers["tts.synthesize"]!(
				request(cwd, { type: "tts.synthesize", text: "no", output_path: "outside.ogg", backend: "local" }),
			),
		).rejects.toThrow("must end in .wav or .mp3");
		expect(localCalls).toHaveLength(1);
	});

	test("passes xAI selection through the typed handler and surfaces missing credentials without leaking a secret", async () => {
		const cwd = await root();
		const selected: IpythonTtsSynthesisRequest[] = [];
		const service = new IpythonTtsService({
			owner: () => ({
				synthesize: async input => {
					selected.push(input);
					return { path: input.outputPath, bytes: 3, backend: input.backend, codec: "mp3", voiceId: "eve" };
				},
			}),
		});
		await service.handlers["tts.synthesize"]!(
			request(cwd, {
				type: "tts.synthesize",
				text: "cloud",
				output_path: "cloud.mp3",
				backend: "xai",
				voice_id: "eve",
			}),
		);
		expect(selected).toEqual([expect.objectContaining({ backend: "xai", voiceId: "eve" })]);

		const noCredentials = createIpythonTtsService({
			settings: { get: () => "kokoro" } as never,
			modelRegistry: {} as never,
			sessionId: () => "session-1",
			resolveXaiCredentials: async () => null,
		});
		await expect(
			noCredentials.handlers["tts.synthesize"]!(
				request(cwd, { type: "tts.synthesize", text: "cloud", output_path: "cloud.mp3", backend: "xai" }),
			),
		).rejects.toThrow("No xAI credentials");
	});

	test("forwards active cancellation and does not run synthesis after the cell is cancelled", async () => {
		const cwd = await root();
		let calls = 0;
		const entered = Promise.withResolvers<void>();
		const service = new IpythonTtsService({
			owner: () => ({
				synthesize: async (_input, signal) => {
					calls++;
					entered.resolve();
					await new Promise<void>((_resolve, reject) =>
						signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
					);
					throw new Error("unreachable");
				},
			}),
		});
		const before = new AbortController();
		before.abort(new Error("cancelled before synthesis"));
		await expect(
			service.handlers["tts.synthesize"]!(
				request(cwd, { type: "tts.synthesize", text: "cancel", output_path: "cancel.wav" }, before.signal),
			),
		).rejects.toThrow("cancelled before synthesis");
		expect(calls).toBe(0);

		const during = new AbortController();
		const pending = service.handlers["tts.synthesize"]!(
			request(cwd, { type: "tts.synthesize", text: "cancel", output_path: "cancel.wav" }, during.signal),
		);
		await entered.promise;
		during.abort(new Error("cancelled during synthesis"));
		await expect(pending).rejects.toThrow("cancelled during synthesis");
		expect(calls).toBe(1);
	});
});
