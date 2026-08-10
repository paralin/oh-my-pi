import { type ApiKey, withAuth } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { ohMyPiXAIUserAgent, resolveXAIHttpCredentials, type XAIHttpProvider } from "../lib/xai-http";
import { confineToWorkspace } from "../tools/path-utils";
import { DEFAULT_TTS_LOCAL_MODEL_KEY, DEFAULT_TTS_VOICE, isTtsLocalModelKey } from "../tts/models";
import { type TtsClient, ttsClient } from "../tts/tts-client";
import { encodeWav } from "../tts/wav";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_TEXT_CHARS = 15_000;
const MAX_PATH_CHARS = 4_096;
const MAX_VOICE_CHARS = 128;
const MAX_LANGUAGE_CHARS = 32;
const DEFAULT_SAMPLE_RATE = 24_000;
const DEFAULT_BIT_RATE = 128_000;
const SYNTHESIS_TIMEOUT_MS = 60_000;

export type IpythonTtsBackend = "local" | "xai";
export type IpythonTtsCodec = "wav" | "mp3";

export interface IpythonTtsSynthesisRequest {
	readonly text: string;
	readonly outputPath: string;
	readonly backend: IpythonTtsBackend;
	readonly voiceId?: string;
	readonly language: string;
	readonly sampleRate?: number;
	readonly bitRate?: number;
}

export interface IpythonTtsSynthesisResult {
	readonly path: string;
	readonly bytes: number;
	readonly backend: IpythonTtsBackend;
	readonly codec: IpythonTtsCodec;
	readonly voiceId: string;
	readonly sampleRate?: number;
}

export interface IpythonTtsSynthesisOwner {
	synthesize(request: IpythonTtsSynthesisRequest, signal: AbortSignal): Promise<IpythonTtsSynthesisResult>;
}

export interface IpythonTtsServiceOptions {
	readonly owner: (request: IpythonHostRequest) => IpythonTtsSynthesisOwner;
}

export interface CreateIpythonTtsServiceOptions {
	readonly settings: Pick<Settings, "get">;
	readonly modelRegistry: ModelRegistry;
	readonly sessionId: () => string;
	readonly localClient?: Pick<TtsClient, "synthesize">;
	readonly resolveXaiCredentials?: () => Promise<XaiCredentials | null>;
	readonly fetch?: typeof fetch;
}

export interface XaiCredentials {
	readonly provider: XAIHttpProvider;
	readonly baseURL: string;
}

function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function requiredString(data: Readonly<Record<string, unknown>>, name: string, max: number): string {
	const value = data[name];
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string`);
	if (value.length > max) throw new RangeError(`${name} is too large`);
	return value;
}

function optionalString(data: Readonly<Record<string, unknown>>, name: string, max: number): string | undefined {
	if (data[name] === undefined) return undefined;
	return requiredString(data, name, max);
}

function optionalInteger(
	data: Readonly<Record<string, unknown>>,
	name: string,
	minimum: number,
	maximum: number,
): number | undefined {
	const value = data[name];
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
	}
	return value as number;
}

function codecFor(outputPath: string): IpythonTtsCodec {
	if (outputPath.toLowerCase().endsWith(".wav")) return "wav";
	if (outputPath.toLowerCase().endsWith(".mp3")) return "mp3";
	throw new TypeError("output_path must end in .wav or .mp3");
}

function localWavPath(outputPath: string): string {
	if (codecFor(outputPath) === "wav") return outputPath;
	return `${outputPath.slice(0, -4)}.wav`;
}

function parseRequest(request: IpythonHostRequest): IpythonTtsSynthesisRequest {
	strict(request.data, ["text", "output_path", "backend", "voice_id", "language", "sample_rate", "bit_rate"]);
	const outputInput = requiredString(request.data, "output_path", MAX_PATH_CHARS);
	const outputPath = confineToWorkspace(outputInput, request.cwd);
	if (!outputPath) throw new TypeError("output_path must be a relative path inside the project");
	codecFor(outputPath);
	const backend = request.data.backend ?? "local";
	if (backend !== "local" && backend !== "xai") throw new TypeError("backend must be local or xai");
	return {
		text: requiredString(request.data, "text", MAX_TEXT_CHARS),
		outputPath,
		backend,
		voiceId: optionalString(request.data, "voice_id", MAX_VOICE_CHARS),
		language: optionalString(request.data, "language", MAX_LANGUAGE_CHARS) ?? "en",
		sampleRate: optionalInteger(request.data, "sample_rate", 8_000, 48_000),
		bitRate: optionalInteger(request.data, "bit_rate", 8_000, 512_000),
	};
}

/** Exposes bounded speech-file synthesis through the session's TTS and credential owners. */
export class IpythonTtsService {
	readonly handlers: IpythonHostHandlers;

	constructor(private readonly options: IpythonTtsServiceOptions) {
		this.handlers = { "tts.synthesize": request => this.#synthesize(request) };
	}

	async #synthesize(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		const input = parseRequest(request);
		request.signal.throwIfAborted();
		await request.publishProgress("Speech synthesis started", { backend: input.backend });
		const result = await this.options.owner(request).synthesize(input, request.signal);
		request.signal.throwIfAborted();
		await request.publishProgress("Speech synthesis completed", { backend: result.backend, bytes: result.bytes });
		return {
			path: result.path,
			bytes: result.bytes,
			backend: result.backend,
			codec: result.codec,
			voice_id: result.voiceId,
			...(result.sampleRate === undefined ? {} : { sample_rate: result.sampleRate }),
		};
	}
}

/** Build the host-owned synthesis service used by an AgentSession IPython composition. */
export function createIpythonTtsService(options: CreateIpythonTtsServiceOptions): IpythonTtsService {
	const owner = new SessionTtsSynthesisOwner(options);
	return new IpythonTtsService({ owner: () => owner });
}

class SessionTtsSynthesisOwner implements IpythonTtsSynthesisOwner {
	readonly #localClient: Pick<TtsClient, "synthesize">;

	constructor(private readonly options: CreateIpythonTtsServiceOptions) {
		this.#localClient = options.localClient ?? ttsClient;
	}

	async synthesize(request: IpythonTtsSynthesisRequest, signal: AbortSignal): Promise<IpythonTtsSynthesisResult> {
		return request.backend === "local" ? await this.#local(request, signal) : await this.#xai(request, signal);
	}

	async #local(request: IpythonTtsSynthesisRequest, signal: AbortSignal): Promise<IpythonTtsSynthesisResult> {
		const configuredModel = this.options.settings.get("tts.localModel");
		const modelKey = isTtsLocalModelKey(configuredModel) ? configuredModel : DEFAULT_TTS_LOCAL_MODEL_KEY;
		const configuredVoice = this.options.settings.get("tts.localVoice");
		const voice = typeof configuredVoice === "string" ? configuredVoice : DEFAULT_TTS_VOICE;
		const audio = await this.#localClient.synthesize(modelKey, request.text, { voice, signal });
		signal.throwIfAborted();
		if (!audio) throw new Error(`Local TTS synthesis failed (model=${modelKey}).`);
		const path = localWavPath(request.outputPath);
		const wav = encodeWav(audio.pcm, audio.sampleRate);
		await Bun.write(path, wav);
		signal.throwIfAborted();
		return {
			path,
			bytes: wav.byteLength,
			backend: "local",
			codec: "wav",
			voiceId: `${modelKey}/${voice}`,
			sampleRate: audio.sampleRate,
		};
	}

	async #xai(request: IpythonTtsSynthesisRequest, signal: AbortSignal): Promise<IpythonTtsSynthesisResult> {
		const credentials = await (this.options.resolveXaiCredentials?.() ??
			resolveXAIHttpCredentials(this.options.modelRegistry));
		if (!credentials) {
			throw new Error("No xAI credentials. Run /login → xAI Grok OAuth or set XAI_API_KEY.");
		}
		const codec = codecFor(request.outputPath);
		const voiceId = request.voiceId ?? "eve";
		const sampleRate = request.sampleRate ?? DEFAULT_SAMPLE_RATE;
		const bitRate = request.bitRate ?? DEFAULT_BIT_RATE;
		const payload: Record<string, unknown> = { text: request.text, voice_id: voiceId, language: request.language };
		if (codec !== "mp3" || sampleRate !== DEFAULT_SAMPLE_RATE || (codec === "mp3" && bitRate !== DEFAULT_BIT_RATE)) {
			payload.output_format = {
				codec,
				sample_rate: sampleRate,
				...(codec === "mp3" ? { bit_rate: bitRate } : {}),
			};
		}
		const timeout = AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS);
		const combinedSignal = AbortSignal.any([signal, timeout]);
		const apiKey: ApiKey = this.options.modelRegistry.resolver(credentials.provider, {
			sessionId: this.options.sessionId(),
			baseUrl: credentials.baseURL,
		});
		const response = await withAuth(
			apiKey,
			async key => {
				const response = await (this.options.fetch ?? fetch)(`${credentials.baseURL}/tts`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${key}`,
						"Content-Type": "application/json",
						"User-Agent": ohMyPiXAIUserAgent(),
					},
					body: JSON.stringify(payload),
					signal: combinedSignal,
				});
				if (!response.ok) {
					const detail = await response.text();
					throw new ProviderHttpError(
						`xAI TTS failed (${response.status}): ${detail.slice(0, 300)}`,
						response.status,
						{
							headers: response.headers,
						},
					);
				}
				return response;
			},
			{ signal: combinedSignal },
		);
		const bytes = new Uint8Array(await response.arrayBuffer());
		signal.throwIfAborted();
		await Bun.write(request.outputPath, bytes);
		signal.throwIfAborted();
		return { path: request.outputPath, bytes: bytes.byteLength, backend: "xai", codec, voiceId, sampleRate };
	}
}
