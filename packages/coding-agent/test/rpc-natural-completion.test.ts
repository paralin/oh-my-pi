import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type RpcProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

type RpcFrame = {
	id?: string;
	type?: string;
	command?: string;
	success?: boolean;
	data?: {
		outcome?: string;
		stopReason?: string;
		terminalSequence?: number;
	};
	error?: string;
};

type ByteReader = {
	read(): Promise<{ value?: Uint8Array; done: boolean }>;
};

type ByteStream = {
	getReader(): ByteReader;
};

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const textEncoder = new TextEncoder();

let activeProcess: RpcProcess | undefined;
let activeServer: Bun.Server<unknown> | undefined;
let activeRoot = "";

class JsonLineReader {
	readonly #reader: ByteReader;
	#buffer = "";
	readonly #decoder = new TextDecoder();

	constructor(stream: ByteStream) {
		this.#reader = stream.getReader();
	}

	async next(): Promise<RpcFrame | undefined> {
		while (true) {
			const newline = this.#buffer.indexOf("\n");
			if (newline >= 0) {
				const line = this.#buffer.slice(0, newline).trim();
				this.#buffer = this.#buffer.slice(newline + 1);
				if (!line) continue;
				return JSON.parse(line) as RpcFrame;
			}
			const { value, done } = await this.#reader.read();
			if (done) {
				if (!this.#buffer.trim()) return undefined;
				const line = this.#buffer.trim();
				this.#buffer = "";
				return JSON.parse(line) as RpcFrame;
			}
			this.#buffer += this.#decoder.decode(value, { stream: true });
		}
	}
}

async function readResponse(reader: JsonLineReader, id: string): Promise<RpcFrame> {
	const response = (async () => {
		while (true) {
			const frame = await reader.next();
			if (!frame) throw new Error(`RPC process closed before response ${id}`);
			if (frame.id === id) return frame;
		}
	})();
	return response;
}

function send(process: RpcProcess, frame: object): void {
	process.stdin.write(textEncoder.encode(`${JSON.stringify(frame)}\n`));
	process.stdin.flush();
}

async function stopProcess(process: RpcProcess): Promise<void> {
	try {
		process.stdin.end();
	} catch {
		// The child may have closed stdin after a fatal startup error.
	}
	try {
		process.kill("SIGKILL");
	} catch {
		// The child may already have exited.
	}
	await process.exited;
}

afterEach(async () => {
	if (activeProcess) {
		const process = activeProcess;
		activeProcess = undefined;
		await stopProcess(process);
	}
	activeServer?.stop(true);
	activeServer = undefined;
	if (activeRoot) {
		await fs.rm(activeRoot, { recursive: true, force: true });
		activeRoot = "";
	}
});

describe("RPC natural completion", () => {
	it("resolves session.result from a real omp process without closing stdin", async () => {
		activeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-natural-"));
		const agentDir = path.join(activeRoot, "agent");
		const projectDir = path.join(activeRoot, "project");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(projectDir, { recursive: true });

		activeServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				if (new URL(request.url).pathname !== "/v1/chat/completions")
					return new Response("not found", { status: 404 });
				const body = [
					`data: ${JSON.stringify({
						id: "fake-completion",
						object: "chat.completion.chunk",
						model: "fake-model",
						choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }],
					})}`,
					`data: ${JSON.stringify({
						id: "fake-completion",
						object: "chat.completion.chunk",
						model: "fake-model",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})}`,
					"data: [DONE]",
					"",
				].join("\n");
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			},
		});

		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			[
				"providers:",
				"  fake:",
				`    baseUrl: http://127.0.0.1:${activeServer.port}/v1`,
				"    api: openai-completions",
				"    auth: none",
				"    models:",
				"      - id: fake-model",
				"        name: Fake model",
				"        contextWindow: 8192",
				"        maxTokens: 256",
			].join("\n"),
		);

		const child = Bun.spawn(["bun", cliEntry, "--mode", "rpc", "--model", "fake/fake-model", "--no-session"], {
			cwd: projectDir,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_NO_TITLE: "1",
				NO_COLOR: "1",
			},
		});
		activeProcess = child;
		void new Response(child.stderr).text();
		const reader = new JsonLineReader(child.stdout);

		send(child, { id: "start", type: "session.start", run_id: "natural-run" });
		const start = await readResponse(reader, "start");
		expect(start.success).toBe(true);

		send(child, { id: "prompt", type: "prompt", message: "say done" });
		const prompt = await readResponse(reader, "prompt");
		expect(prompt.success).toBe(true);

		send(child, { id: "result", type: "session.result" });
		const result = await readResponse(reader, "result");
		expect(result).toMatchObject({
			success: true,
			command: "session.result",
			data: { outcome: "completed" },
		});
		expect(result.data?.terminalSequence).toBeGreaterThan(0);
		// The test never closes stdin before Result resolves. Cleanup owns the
		// only stdin close after the natural terminal response is observed.
	}, 30_000);
});
