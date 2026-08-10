import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IpythonDisplayEvent, IpythonHostRequest } from "../../src/ipython/controller";
import { IpythonImageService } from "../../src/ipython/image-service";
import type { ImageGenerationDetails, ImageGenerationOwner, ImageGenerationParams } from "../../src/tools/image-gen";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function hostRequest(data: Readonly<Record<string, unknown>>, signal = new AbortController().signal) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-service-"));
	temporaryDirectories.push(directory);
	const progress: string[] = [];
	const displays: Array<Omit<IpythonDisplayEvent, "kind">> = [];
	const artifacts: string[] = [];
	const request: IpythonHostRequest = {
		requestId: "request-1",
		commId: "comm-1",
		targetName: "host.request",
		data,
		signal,
		executionId: "execution-1",
		sessionId: "session-1",
		cwd: "/workspace",
		cellId: "cell-1",
		sequence: 1,
		origin: "model",
		authority: "trusted-cell",
		publishProgress: async message => {
			progress.push(message);
		},
		publishDisplay: async display => {
			displays.push(display);
		},
		allocateArtifact: async artifact => {
			const artifactPath = path.join(directory, `${artifacts.length}${artifact.suffix}`);
			artifacts.push(artifactPath);
			return {
				id: `artifact-${artifacts.length}`,
				path: artifactPath,
				label: artifact.label,
				mimeType: artifact.mimeType,
			};
		},
	};
	return { request, progress, displays, artifacts };
}

function details(images: ImageGenerationDetails["images"]): ImageGenerationDetails {
	return {
		provider: "gemini",
		model: "image-model",
		imageCount: images.length,
		imagePaths: images.map((_, index) => `/tmp/unmanaged-${index}.png`),
		images,
		responseText: "generated",
		revisedPrompt: "revised",
		usage: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
	};
}

function service(owner: ImageGenerationOwner): IpythonImageService {
	return new IpythonImageService({
		owner: () => owner,
		attachments: () => [
			{
				label: "Image #1",
				uri: "attachment://1",
				image: { type: "image", mimeType: "image/png", data: Buffer.from("pixels").toString("base64") },
			},
		],
	});
}

describe("IPython image service", () => {
	test("returns attachment metadata without image data", async () => {
		const imageService = service({ generate: async () => details([]) });
		const active = await hostRequest({ type: "images.attachments" });
		const result = await imageService.handlers["images.attachments"]!(active.request);
		expect(result).toEqual({
			items: [{ label: "Image #1", uri: "attachment://1", mime_type: "image/png", bytes: 6 }],
		});
		expect(JSON.stringify(result)).not.toContain(Buffer.from("pixels").toString("base64"));
	});

	test("forwards bounded generation input and active cancellation to the owner", async () => {
		let received: ImageGenerationParams | undefined;
		let receivedSignal: AbortSignal | undefined;
		const imageService = service({
			generate: async (params, signal) => {
				received = params;
				receivedSignal = signal;
				return details([{ mimeType: "image/png", data: Buffer.from("small-image").toString("base64") }]);
			},
		});
		const active = await hostRequest({
			type: "images.generate",
			subject: "diagram",
			style: "line art",
			changes: ["add labels"],
			aspect_ratio: "16:9",
			image_size: "1536x1024",
			input_paths: ["reference.png"],
			provider: "auto",
		});
		const result = await imageService.handlers["images.generate"]!(active.request);
		expect(received).toEqual({
			subject: "diagram",
			action: undefined,
			scene: undefined,
			composition: undefined,
			lighting: undefined,
			style: "line art",
			text: undefined,
			changes: ["add labels"],
			aspect_ratio: "16:9",
			image_size: "1536x1024",
			provider: "auto",
			input: [{ path: "reference.png" }],
		});
		expect(receivedSignal).toBe(active.request.signal);
		expect(active.progress).toEqual(["Image generation started", "Image generation completed"]);
		expect(active.displays).toHaveLength(1);
		expect(active.artifacts).toHaveLength(1);
		expect(await fs.readFile(active.artifacts[0]!, "utf8")).toBe("small-image");
		expect(JSON.stringify(result)).not.toContain("unmanaged");
		expect(JSON.stringify(result)).not.toContain(Buffer.from("small-image").toString("base64"));
		expect(result.images).toEqual([
			{
				path: active.artifacts[0],
				artifact: expect.objectContaining({ path: active.artifacts[0], bytes: 11, mime_type: "image/png" }),
				rich: true,
			},
		]);
	});

	test("spills an oversized image artifact without publishing raw rich data", async () => {
		const encoded = Buffer.alloc(270_000, 1).toString("base64");
		const imageService = service({ generate: async () => details([{ mimeType: "image/webp", data: encoded }]) });
		const active = await hostRequest({ type: "images.generate", subject: "large" });
		const result = await imageService.handlers["images.generate"]!(active.request);
		expect(active.displays).toHaveLength(0);
		expect(active.artifacts).toHaveLength(1);
		expect((await fs.stat(active.artifacts[0]!)).size).toBe(270_000);
		expect((result.images as Array<{ rich: boolean }>)[0]?.rich).toBe(false);
		expect(JSON.stringify(result)).not.toContain(encoded.slice(0, 100));
	});

	test("bounds attachment metadata and spills oversized provider text", async () => {
		const imageService = new IpythonImageService({
			owner: () => ({
				generate: async () => ({
					...details([]),
					responseText: "x".repeat(70_000),
					revisedPrompt: undefined,
				}),
			}),
			attachments: () =>
				Array.from({ length: 65 }, (_, index) => ({
					label: `Image #${index + 1}`,
					uri: `attachment://${index + 1}`,
					image: { type: "image" as const, mimeType: "image/png", data: "" },
				})),
		});
		const attachmentRequest = await hostRequest({ type: "images.attachments" });
		const attachments = await imageService.handlers["images.attachments"]!(attachmentRequest.request);
		expect((attachments.items as unknown[]).length).toBe(64);
		expect(attachments.truncated).toBe(true);

		const generationRequest = await hostRequest({ type: "images.generate", subject: "large response" });
		const result = await imageService.handlers["images.generate"]!(generationRequest.request);
		expect(generationRequest.artifacts).toHaveLength(1);
		expect((await fs.stat(generationRequest.artifacts[0]!)).size).toBe(70_000);
		expect(result.response).toEqual({
			truncated: true,
			artifact: expect.objectContaining({ path: generationRequest.artifacts[0], bytes: 70_000 }),
		});
		expect(JSON.stringify(result)).not.toContain("x".repeat(1_000));
	});

	test("rejects invalid fields and bounds before resolving an owner", async () => {
		let calls = 0;
		const imageService = new IpythonImageService({
			owner: () => {
				calls++;
				return { generate: async () => details([]) };
			},
			attachments: () => [],
		});
		for (const data of [
			{ type: "images.generate", subject: "x", surprise: true },
			{ type: "images.generate", subject: "x", provider: "secret-provider" },
			{ type: "images.generate", subject: "x", aspect_ratio: "10:1" },
			{ type: "images.generate", subject: "x", image_size: "huge" },
			{ type: "images.generate", subject: "x", input_paths: Array.from({ length: 9 }, () => "x.png") },
		]) {
			const active = await hostRequest(data);
			await expect(imageService.handlers["images.generate"]!(active.request)).rejects.toThrow();
		}
		expect(calls).toBe(0);
	});

	test("rejects cancellation before resolving the provider owner", async () => {
		let calls = 0;
		const imageService = new IpythonImageService({
			owner: () => {
				calls++;
				return { generate: async () => details([]) };
			},
			attachments: () => [],
		});
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const active = await hostRequest({ type: "images.generate", subject: "x" }, controller.signal);
		await expect(imageService.handlers["images.generate"]!(active.request)).rejects.toThrow("cancelled");
		expect(calls).toBe(0);
	});
});
