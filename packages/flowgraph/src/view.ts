/**
 * Live view of a walk.
 *
 * Serves the authored graph beside its trajectory and streams new records over
 * SSE as the file grows, so the current node is visible while the walk runs
 * rather than only after it finishes. The stream is driven by filesystem watch
 * events; nothing polls.
 */
import * as fs from "node:fs";

/** Where the view reads its two inputs and which port it listens on. */
export interface ViewOptions {
	graphPath: string;
	trajectoryPath: string;
	port: number;
}

async function readNewLines(path: string, from: number): Promise<{ lines: string[]; offset: number }> {
	const text = await Bun.file(path)
		.text()
		.catch(() => "");
	if (text.length <= from) return { lines: [], offset: from };
	const chunk = text.slice(from);
	const lastBreak = chunk.lastIndexOf("\n");
	if (lastBreak === -1) return { lines: [], offset: from };
	const complete = chunk.slice(0, lastBreak);
	return { lines: complete.split("\n").filter(Boolean), offset: from + lastBreak + 1 };
}

/** Start the view server and return the URL to open. */
export async function serveView(options: ViewOptions): Promise<string> {
	const indexHtml = await Bun.file(new URL("./view/index.html", import.meta.url)).text();
	const server = Bun.serve({
		port: options.port,
		routes: {
			"/": new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
			"/graph": () => new Response(Bun.file(options.graphPath), { headers: { "content-type": "application/json" } }),
			"/trajectory": () => {
				let offset = 0;
				let watcher: fs.FSWatcher | undefined;
				return new Response(
					new ReadableStream({
						async start(controller) {
							const send = async () => {
								const { lines, offset: next } = await readNewLines(options.trajectoryPath, offset);
								offset = next;
								for (const line of lines) controller.enqueue(`event: record\ndata: ${line}\n\n`);
							};
							await send();
							// Watch the directory: the trajectory file may not exist yet when the
							// view is opened before the walk starts, and watching a missing path throws.
							watcher = fs.watch(options.trajectoryPath.replace(/\/[^/]+$/, ""), () => void send());
						},
						cancel() {
							watcher?.close();
						},
					}).pipeThrough(new TextEncoderStream()),
					{ headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
				);
			},
		},
	});
	return `http://localhost:${server.port}/`;
}
