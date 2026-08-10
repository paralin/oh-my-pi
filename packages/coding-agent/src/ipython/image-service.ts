import * as fs from "node:fs/promises";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	createImageGenerationOwner,
	type ImageGenerationDetails,
	type ImageGenerationOwner,
	type ImageGenerationParams,
	isImageAspectRatio,
	isImageSize,
} from "../tools/image-gen";
import { isImageProviderId } from "../tools/image-providers";
import type { HostExecutionContext } from "../tools/tool-types";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_STRING = 16_384;
const MAX_CHANGES = 32;
const MAX_INPUT_PATHS = 8;
const MAX_INLINE_IMAGE_CHARS = 350_000;
const MAX_INLINE_TEXT_CHARS = 65_536;
const MAX_ATTACHMENTS = 64;

export interface IpythonImageServiceOptions {
	readonly owner: (request: IpythonHostRequest) => ImageGenerationOwner;
	readonly attachments: () => readonly { label: string; uri: string; image: ImageContent }[];
}
function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const key = Object.keys(data).find(item => item !== "type" && !allowed.includes(item));
	if (key) throw new TypeError(`unknown field: ${key}`);
}
function text(data: Readonly<Record<string, unknown>>, name: string, optional = true): string | undefined {
	const value = data[name];
	if (value === undefined && optional) return undefined;
	if (typeof value !== "string" || (!optional && value.trim() === ""))
		throw new TypeError(`${name} must be ${optional ? "a string" : "a nonempty string"}`);
	if (value.length > MAX_STRING) throw new RangeError(`${name} is too large`);
	return value;
}
function list(data: Readonly<Record<string, unknown>>, name: string, max: number): string[] | undefined {
	const value = data[name];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > max)
		throw new TypeError(`${name} must be a list of at most ${max} strings`);
	return value.map((item, index) => {
		if (typeof item !== "string" || item.trim() === "")
			throw new TypeError(`${name}[${index}] must be a nonempty string`);
		if (item.length > MAX_STRING) throw new RangeError(`${name}[${index}] is too large`);
		return item;
	});
}
function params(data: Readonly<Record<string, unknown>>): ImageGenerationParams {
	strict(data, [
		"subject",
		"action",
		"scene",
		"composition",
		"lighting",
		"style",
		"text",
		"changes",
		"aspect_ratio",
		"image_size",
		"input_paths",
		"provider",
	]);
	const subject = text(data, "subject", false)!;
	const changes = list(data, "changes", MAX_CHANGES);
	const input = list(data, "input_paths", MAX_INPUT_PATHS);
	const aspect = text(data, "aspect_ratio");
	if (aspect && !isImageAspectRatio(aspect)) throw new RangeError("aspect_ratio is invalid");
	const size = text(data, "image_size");
	if (size && !isImageSize(size)) throw new RangeError("image_size is invalid");
	const provider = text(data, "provider");
	if (provider && provider !== "auto" && !isImageProviderId(provider)) throw new RangeError("provider is invalid");
	return {
		subject,
		action: text(data, "action"),
		scene: text(data, "scene"),
		composition: text(data, "composition"),
		lighting: text(data, "lighting"),
		style: text(data, "style"),
		text: text(data, "text"),
		changes,
		aspect_ratio: aspect as ImageGenerationParams["aspect_ratio"],
		image_size: size as ImageGenerationParams["image_size"],
		provider: provider as ImageGenerationParams["provider"],
		input: input?.map(path => ({ path })),
	};
}
function metadata(image: { label: string; uri: string; image: ImageContent }): Readonly<Record<string, unknown>> {
	return {
		label: image.label,
		uri: image.uri,
		mime_type: image.image.mimeType,
		bytes: Buffer.from(image.image.data, "base64").byteLength,
	};
}
function suffix(mime: string): string {
	return mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : ".png";
}
async function boundedText(
	request: IpythonHostRequest,
	label: string,
	value: string | undefined,
): Promise<string | Readonly<Record<string, unknown>> | null> {
	if (value === undefined) return null;
	if (value.length <= MAX_INLINE_TEXT_CHARS) return value;
	const artifact = await request.allocateArtifact({ label, mimeType: "text/plain", suffix: ".txt" });
	request.signal.throwIfAborted();
	await fs.writeFile(artifact.path, value, "utf8");
	request.signal.throwIfAborted();
	return {
		truncated: true,
		artifact: { ...artifact, bytes: Buffer.byteLength(value), mime_type: "text/plain" },
	};
}

async function publishImages(
	request: IpythonHostRequest,
	details: ImageGenerationDetails,
): Promise<Readonly<Record<string, unknown>>[]> {
	const result: Readonly<Record<string, unknown>>[] = [];
	for (const [index, image] of details.images.entries()) {
		request.signal.throwIfAborted();
		const bytes = Buffer.from(image.data, "base64");
		const artifact = await request.allocateArtifact({
			label: `generated-image-${index + 1}`,
			mimeType: image.mimeType,
			suffix: suffix(image.mimeType),
		});
		request.signal.throwIfAborted();
		await fs.writeFile(artifact.path, bytes);
		request.signal.throwIfAborted();
		const item: Record<string, unknown> = {
			path: artifact.path,
			artifact: { ...artifact, bytes: bytes.length, mime_type: image.mimeType },
		};
		if (image.data.length <= MAX_INLINE_IMAGE_CHARS) {
			await request.publishDisplay({
				data: { [image.mimeType]: image.data },
				metadata: {},
				transient: {},
				update: false,
				text: `[generated image: ${image.mimeType}]`,
			});
			item.rich = true;
		} else {
			item.rich = false;
		}
		result.push(item);
	}
	return result;
}
export class IpythonImageService {
	readonly handlers: IpythonHostHandlers;
	constructor(private readonly options: IpythonImageServiceOptions) {
		this.handlers = {
			"images.attachments": request => this.attachments(request),
			"images.generate": request => this.generate(request),
		};
	}
	private async attachments(request: IpythonHostRequest) {
		strict(request.data, []);
		request.signal.throwIfAborted();
		const attachments = this.options.attachments();
		return {
			items: attachments.slice(0, MAX_ATTACHMENTS).map(metadata),
			...(attachments.length > MAX_ATTACHMENTS ? { truncated: true } : {}),
		};
	}
	private async generate(request: IpythonHostRequest) {
		const imageParams = params(request.data);
		request.signal.throwIfAborted();
		await request.publishProgress("Image generation started", { provider: imageParams.provider ?? "auto" });
		const details = await this.options.owner(request).generate(imageParams, request.signal);
		request.signal.throwIfAborted();
		const images = await publishImages(request, details);
		request.signal.throwIfAborted();
		await request.publishProgress("Image generation completed", {
			provider: details.provider,
			model: details.model,
			count: details.imageCount,
		});
		return {
			provider: details.provider,
			model: details.model,
			count: details.imageCount,
			response: await boundedText(request, "image-generation-response", details.responseText),
			revised_prompt: await boundedText(request, "image-generation-revised-prompt", details.revisedPrompt),
			usage: details.usage ?? null,
			images,
		};
	}
}
export function createIpythonImageService(
	context: () => HostExecutionContext,
	attachments: IpythonImageServiceOptions["attachments"],
): IpythonImageService {
	return new IpythonImageService({ owner: () => createImageGenerationOwner(context()), attachments });
}
