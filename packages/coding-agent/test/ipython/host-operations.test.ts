import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IpythonExtensionHostHandler } from "../../src/extensibility/extensions/types.js";
import type { IpythonCellResult, IpythonCellUpdate } from "../../src/ipython/cell.js";
import {
	IpythonController,
	type IpythonExecutionEvent,
	type IpythonHostOperationEvent,
	type IpythonHostRequest,
	ipythonHostOperationSummary,
} from "../../src/ipython/controller.js";
import {
	createIpythonCellJournalDetail,
	isIpythonJournalDetail,
	renderIpythonJournalText,
} from "../../src/ipython/journal.js";
import { projectIpythonCellPresentation, projectIpythonLiveCellPresentation } from "../../src/ipython/projection.js";
import { IpythonCellMessageComponent } from "../../src/modes/components/ipython-cell-message.js";
import { initTheme } from "../../src/modes/theme/theme.js";

const SECRET = "sk-live-must-not-render";

function operation(
	operationId: string,
	name: string,
	phase: IpythonHostOperationEvent["phase"],
	at: number,
	extra: Partial<IpythonHostOperationEvent> = {},
): IpythonHostOperationEvent {
	return { kind: "host_operation", operationId, operation: name, phase, at, ...extra };
}

/** Two concurrent AST operations interleaved exactly as the controller records them. */
function astEvents(): IpythonExecutionEvent[] {
	return [
		{ kind: "stream", name: "stdout", text: "ordinary output\n" },
		operation("comm-1", "ast.search", "start", 1_000),
		operation("comm-2", "ast.rewrite", "start", 1_005),
		operation("comm-1", "ast.search", "progress", 1_010, {
			message: "Searching syntax trees",
			summary: { path: "src/app.ts" },
		}),
		operation("comm-2", "ast.rewrite", "progress", 1_015, {
			message: "Rewriting syntax trees",
			summary: { path: "src/lib.ts", dryRun: true },
		}),
		operation("comm-1", "ast.search", "progress", 1_020, {
			message: "Syntax-tree search completed",
			summary: { path: "src/app.ts", count: 3, unit: "matches" },
		}),
		operation("comm-1", "ast.search", "terminal", 1_030, { status: "ok", durationMs: 30 }),
		operation("comm-2", "ast.rewrite", "progress", 1_035, {
			message: "Syntax-tree rewrite completed",
			summary: { path: "src/lib.ts", count: 2, unit: "replacements", dryRun: false },
		}),
		operation("comm-2", "ast.rewrite", "terminal", 1_040, { status: "error", durationMs: 35 }),
	];
}

function cellResult(events: IpythonExecutionEvent[], overrides: Partial<IpythonCellResult> = {}): IpythonCellResult {
	const errors = events.filter(event => event.kind === "error");
	return {
		cellId: "cell-1",
		executionId: "execute-1",
		sequence: 4,
		origin: "model",
		authority: "trusted-cell",
		code: "omp.ast.search(path='src/app.ts', patterns=['log($A)'])",
		status: "ok",
		requestedAt: 900,
		startedAt: 950,
		finishedAt: 1_100,
		durationMs: 150,
		stdout: "ordinary output\n",
		stderr: "",
		result: undefined,
		events,
		errors,
		updates: events.map(event => ({ kind: "execution", cellId: "cell-1", origin: "model", event }) as const),
		artifacts: [],
		modelText: { text: "ordinary output\n", truncated: false, totalBytes: 16, outputBytes: 16 },
		...overrides,
	};
}

function liveUpdates(result: IpythonCellResult): IpythonCellUpdate[] {
	return [...result.updates];
}

describe("IPython nested host-operation lifecycle", () => {
	beforeAll(async () => {
		await initTheme();
	});

	test("groups concurrent operations by request identity across live, completed, and replayed cells", () => {
		const result = cellResult(astEvents());
		const live = projectIpythonLiveCellPresentation({
			code: result.code,
			origin: result.origin,
			updates: liveUpdates(result),
		});
		const completed = projectIpythonCellPresentation(result);
		const detail = createIpythonCellJournalDetail(result);
		expect(isIpythonJournalDetail(JSON.parse(JSON.stringify(detail)))).toBe(true);
		const replayed = projectIpythonCellPresentation(detail);

		expect(completed.operations).toEqual([
			{
				operationId: "comm-1",
				operation: "ast.search",
				status: "ok",
				startedAt: 1_000,
				durationMs: 30,
				progress: [
					{ at: 1_010, message: "Searching syntax trees", summary: { path: "src/app.ts" } },
					{
						at: 1_020,
						message: "Syntax-tree search completed",
						summary: { path: "src/app.ts", count: 3, unit: "matches" },
					},
				],
				message: "Syntax-tree search completed",
				summary: { path: "src/app.ts", count: 3, unit: "matches" },
			},
			{
				operationId: "comm-2",
				operation: "ast.rewrite",
				status: "error",
				startedAt: 1_005,
				durationMs: 35,
				progress: [
					{ at: 1_015, message: "Rewriting syntax trees", summary: { path: "src/lib.ts", dryRun: true } },
					{
						at: 1_035,
						message: "Syntax-tree rewrite completed",
						summary: { path: "src/lib.ts", count: 2, unit: "replacements", dryRun: false },
					},
				],
				message: "Syntax-tree rewrite completed",
				summary: { path: "src/lib.ts", count: 2, unit: "replacements", dryRun: false },
			},
		]);
		expect(replayed.operations).toEqual(completed.operations);
		expect(live.operations).toEqual(completed.operations);

		// Ordinary output keeps the bounded safe projection; lifecycle records leave it.
		expect(completed.safeText.text).toBe("ordinary output\n");
		expect(live.safeText.text).toBe(completed.safeText.text);
		expect(completed.safeText.text).not.toContain("ast.search");
		expect(completed.safeText.text).not.toContain("Searching syntax trees");
	});

	test("reports a still-running operation while its cell streams", () => {
		const events = astEvents().slice(0, 4);
		const live = projectIpythonLiveCellPresentation({
			code: "omp.ast.search(...)",
			origin: "direct",
			updates: events.map(event => ({ kind: "execution", cellId: "cell-1", origin: "direct", event }) as const),
		});
		expect(live.operations.map(entry => [entry.operation, entry.status, entry.durationMs])).toEqual([
			["ast.search", "running", undefined],
			["ast.rewrite", "running", undefined],
		]);
	});

	test("keeps raw request, response, and credential-shaped payloads out of the summary", () => {
		const summary = ipythonHostOperationSummary({
			path: "src/app.ts",
			count: 3,
			unit: "matches",
			dry_run: true,
			api_key: SECRET,
			authorization: `Bearer ${SECRET}`,
			patterns: ["log($A)"],
			response: { matches: [{ text: SECRET }] },
			code: `token = "${SECRET}"`,
		});
		expect(summary).toEqual({ path: "src/app.ts", count: 3, unit: "matches", dryRun: true });
		expect(JSON.stringify(summary)).not.toContain(SECRET);

		expect(ipythonHostOperationSummary({ count: 1.5, unit: "   ", path: "  " })).toBeUndefined();
		expect(ipythonHostOperationSummary({})).toBeUndefined();
		const bounded = ipythonHostOperationSummary({ path: "p".repeat(5_000), unit: "u".repeat(500) });
		expect(bounded?.path?.length).toBeLessThanOrEqual(200);
		expect(bounded?.unit?.length).toBeLessThanOrEqual(32);
	});

	test("rejects payload-bearing records and makes incomplete or duplicate replay state safe", () => {
		const result = cellResult(astEvents());
		const detail = createIpythonCellJournalDetail(result);
		const payloadBearing = {
			...detail,
			events: [
				...detail.events,
				{
					...operation("comm-leak", "ast.search", "progress", 2_000, { message: "searching" }),
					summary: { path: "src/app.ts", request: { api_key: SECRET }, response: { token: SECRET } },
				},
			],
		};
		expect(isIpythonJournalDetail(payloadBearing)).toBe(false);
		expect(
			isIpythonJournalDetail({
				...detail,
				events: [operation("i".repeat(201), "ast.search", "start", 2_001)],
			}),
		).toBe(false);
		expect(
			isIpythonJournalDetail({
				...detail,
				events: [operation("comm-long", "o".repeat(201), "start", 2_002)],
			}),
		).toBe(false);

		const normalized = projectIpythonCellPresentation(
			cellResult([
				operation("comm-incomplete", "generic.call", "start", 3_000),
				operation("comm-final", "generic.call", "start", 3_001),
				operation("comm-final", "generic.call", "terminal", 3_010, { status: "error", durationMs: 9 }),
				operation("comm-final", "generic.call", "terminal", 3_011, { status: "ok", durationMs: 10 }),
			]),
		);
		expect(normalized.operations.map(entry => [entry.operationId, entry.status, entry.durationMs])).toEqual([
			["comm-incomplete", "running", undefined],
			["comm-final", "error", 9],
		]);
	});

	test("renders compact nested operations inside the framed cell and expands with Ctrl-O", () => {
		const result = cellResult(astEvents());
		const component = new IpythonCellMessageComponent(createIpythonCellJournalDetail(result));
		const collapsed = Bun.stripANSI(component.render(100).join("\n"));
		expect(collapsed).toContain("Operations");
		expect(collapsed).toContain("ast.search · src/app.ts · 3 matches (30ms)");
		expect(collapsed).toContain("ast.rewrite · src/lib.ts · 2 replacements · applied (35ms)");
		// Compact presentation keeps each distinct progress snapshot beside its operation.
		expect(collapsed).toContain("Searching syntax trees");
		expect(collapsed).toContain("ordinary output");

		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(100).join("\n"));
		expect(expanded).toContain("Searching syntax trees");
		expect(expanded).toContain("Syntax-tree search completed");
		expect(expanded).toContain("Syntax-tree rewrite completed");

		for (const width of [40, 16]) {
			const rows = component.render(width).map(line => Bun.stripANSI(line));
			expect(rows.every(line => Bun.stringWidth(line) <= width)).toBe(true);
		}
	});

	test("coalesces repeated gh watch tables only in compact live and replay cards", () => {
		const runningTable = "NAME              STATUS   ELAPSED\nunit / linux      pending  00:42";
		const failingTable = "NAME              STATUS   ELAPSED\nunit / linux      failed   00:43";
		const events: IpythonExecutionEvent[] = [
			operation("gh-watch", "gh.run.watch", "start", 1_000),
			...Array.from({ length: 8 }, (_, index) =>
				operation("gh-watch", "gh.run.watch", "progress", 1_010 + index, {
					message: runningTable,
					summary: { path: "acme/omp/actions/runs/481516" },
				}),
			),
			operation("gh-watch", "gh.run.watch", "progress", 1_020, {
				message: failingTable,
				summary: { path: "acme/omp/actions/runs/481516", count: 1, unit: "failed check" },
			}),
			operation("gh-watch", "gh.run.watch", "terminal", 1_030, { status: "error", durationMs: 30 }),
		];
		const result = cellResult(events, { status: "error" });
		const detail = createIpythonCellJournalDetail(result);
		const replayed = new IpythonCellMessageComponent(detail);
		const live = new IpythonCellMessageComponent({ code: result.code, origin: result.origin });
		for (const update of result.updates) live.applyUpdate(update);

		expect(projectIpythonCellPresentation(detail).operations[0]?.progress).toHaveLength(9);
		const compactJournal = renderIpythonJournalText(detail);
		expect(compactJournal).not.toContain("pending");
		expect(compactJournal).toContain("failed");
		for (const component of [live, replayed]) {
			const compact = Bun.stripANSI(component.render(100).join("\n"));
			expect(compact.match(/unit \/ linux/g)).toHaveLength(2);
			expect(compact).toContain("×8 identical");
			expect(compact).toContain("failed check");

			component.setExpanded(true);
			const expanded = Bun.stripANSI(component.render(100).join("\n"));
			expect(expanded.match(/unit \/ linux/g)).toHaveLength(9);
			expect(expanded).not.toContain("×8 identical");
		}
	});

	test("uses the same semantic preview beside nested operations live and in replay", () => {
		const code = `import subprocess
subprocess.run(
	args=["rg", "-n", "needle", "src"],
	check=True,
)`;
		const result = cellResult(astEvents(), { code, origin: "direct" });
		const replayed = new IpythonCellMessageComponent(createIpythonCellJournalDetail(result));
		const live = new IpythonCellMessageComponent({ code, origin: "direct" });
		for (const event of result.events) {
			live.applyUpdate({ kind: "execution", cellId: result.cellId, origin: "direct", event });
		}

		for (const component of [live, replayed]) {
			const collapsed = Bun.stripANSI(component.render(100).join("\n"));
			expect(collapsed).toContain("rg -n needle src");
			expect(collapsed).not.toContain("subprocess.run(");
			expect(collapsed).toContain("· direct");
			expect(collapsed).toContain("Operations");
			expect(collapsed).toContain("ast.search · src/app.ts · 3 matches (30ms)");
			for (const width of [40, 16]) {
				const rows = component.render(width).map(line => Bun.stripANSI(line));
				expect(rows.every(line => Bun.stringWidth(line) <= width)).toBe(true);
			}

			component.setExpanded(true);
			const expanded = Bun.stripANSI(component.render(100).join("\n"));
			expect(expanded).toContain("subprocess.run(");
			expect(expanded).toContain('args=["rg", "-n", "needle", "src"]');
			expect(expanded).toContain("Syntax-tree search completed");
		}
	});

	test("keeps Ctrl-O discoverable when a one-line command becomes a semantic preview", () => {
		const code = 'subprocess.run(["rg", "-n", "needle", "src"])';
		const component = new IpythonCellMessageComponent(
			createIpythonCellJournalDetail(cellResult([], { code, origin: "direct" })),
		);
		const collapsed = Bun.stripANSI(component.render(100).join("\n"));
		expect(collapsed).toContain("rg -n needle src");
		expect(collapsed).not.toContain("subprocess.run(");
		expect(collapsed).toContain("Ctrl+O: Expand");

		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(100).join("\n"));
		expect(expanded).toContain(code);
	});

	test("bounds the collapsed operation list and keeps direct-origin failure and abort states legible", () => {
		const events: IpythonExecutionEvent[] = [];
		for (let index = 0; index < 6; index++) {
			events.push(operation(`comm-${index}`, `omp.files.read`, "start", 1_000 + index));
			events.push(
				operation(`comm-${index}`, `omp.files.read`, "terminal", 1_010 + index, {
					status: index === 4 ? "error" : index === 5 ? "aborted" : "ok",
					durationMs: 10,
				}),
			);
		}
		const detail = createIpythonCellJournalDetail(
			cellResult(events, { origin: "direct", status: "error", cellId: "cell-direct" }),
		);
		const component = new IpythonCellMessageComponent(detail);
		const collapsed = Bun.stripANSI(component.render(100).join("\n"));
		expect(collapsed).toContain("· direct");
		expect(collapsed).toContain("… 3 more operations");
		expect(collapsed.match(/omp\.files\.read/g)).toHaveLength(3);

		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(100).join("\n"));
		expect(expanded.match(/omp\.files\.read/g)).toHaveLength(6);
		expect(expanded).not.toContain("more operations");
	});

	test("keeps legacy persisted host progress readable without a nested lifecycle", () => {
		const legacy: IpythonExecutionEvent[] = [
			{ kind: "stream", name: "stdout", text: "ordinary output\n" },
			{ kind: "host_progress", operation: "omp.code.search", message: "2 matches", data: { files: 2 } },
		];
		const detail = createIpythonCellJournalDetail(
			cellResult(legacy, {
				modelText: {
					text: "ordinary output\n[omp.code.search] 2 matches\n",
					truncated: false,
					totalBytes: 45,
					outputBytes: 45,
				},
			}),
		);
		expect(isIpythonJournalDetail(JSON.parse(JSON.stringify(detail)))).toBe(true);
		const presentation = projectIpythonCellPresentation(detail);
		expect(presentation.operations).toEqual([]);
		expect(presentation.safeText.text).toContain("[omp.code.search] 2 matches");
	});
});

const FAKE_CONTROLLER = `const send = frame => process.stdout.write(JSON.stringify(frame) + "\\n");
send({ event: "ready", controller_pid: process.pid, kernel_pid: process.pid });
const state = { execution: undefined, pending: 0 };
const keepAlive = setInterval(() => {}, 1_000);
let buffer = "";
const finish = status => {
	if (state.execution === undefined) return;
	const id = state.execution;
	state.execution = undefined;
	send({ event: "done", id, status, result: null });
};
const handle = command => {
	process.stderr.write("command " + JSON.stringify(command) + "\\n");
	if (command.op === "execute") {
		const plan = JSON.parse(command.code);
		state.execution = command.id;
		state.pending = plan.requests.length;
		for (const request of plan.requests) {
			send({
				event: "comm",
				operation: "open",
				comm_id: request.comm_id,
				id: command.id,
				target_name: "host.request",
				data: request.data,
			});
		}
		if (plan.done === "immediate") finish("ok");
		return;
	}
	if (command.op === "comm_reply") {
		state.pending -= 1;
		if (state.pending <= 0) finish("ok");
		return;
	}
	if (command.op === "interrupt") {
		finish("aborted");
		return;
	}
	if (command.op === "shutdown") {
		clearInterval(keepAlive);
		process.exit(0);
	}
};
process.stdin.on("data", chunk => {
	buffer += chunk.toString();
	let index = buffer.indexOf("\\n");
	while (index >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
process.stdin.resume();
`;

async function scriptedController(
	handlers: Record<string, (request: IpythonHostRequest) => Promise<Record<string, unknown>>>,
	extensionHostHandlerResolver?: (operation: string) => IpythonExtensionHostHandler | undefined,
) {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-host-operation-"));
	const scriptPath = path.join(tempRoot, "scripted-controller.js");
	await Bun.write(scriptPath, FAKE_CONTROLLER);
	const controller = new IpythonController({
		pythonExecutable: process.execPath,
		controllerArgs: [],
		controllerPath: scriptPath,
		cwd: tempRoot,
		hostHandlers: handlers,
		extensionHostHandlerResolver,
		shutdownGraceMs: 25,
	});
	return { controller, tempRoot };
}

const hostContext = {
	sessionId: "session-1",
	cwd: "/workspace",
	cellId: "cell-1",
	sequence: 1,
	origin: "model" as const,
	authority: "trusted-cell" as const,
};

function operations(events: readonly IpythonExecutionEvent[]): IpythonHostOperationEvent[] {
	return events.filter((event): event is IpythonHostOperationEvent => event.kind === "host_operation");
}

describe("IPython controller nested operation records", () => {
	test("records one ordered start, progress, and terminal per fixed and extension request", async () => {
		const { controller, tempRoot } = await scriptedController(
			{
				"probe.ok": async request => {
					await request.publishProgress("probing", { path: "src/app.ts", api_key: SECRET });
					await request.publishProgress("probe completed", { path: "src/app.ts", count: 2, unit: "matches" });
					return { secret: SECRET };
				},
				"probe.fail": async () => {
					throw new Error(`probe failed with ${SECRET}`);
				},
			},
			operation =>
				operation === "extension.demo.run"
					? async request => {
							await request.publishProgress("extension completed", {
								path: "src/extension.ts",
								count: 1,
								unit: "entries",
							});
							return { secret: SECRET };
						}
					: undefined,
		);
		try {
			const result = await controller.execute(
				JSON.stringify({
					done: "await",
					requests: [
						{ comm_id: "comm-a", data: { type: "probe.ok", token: SECRET } },
						{ comm_id: "comm-b", data: { type: "probe.fail", token: SECRET } },
						{ comm_id: "comm-c", data: { type: "extension.demo.run", token: SECRET } },
					],
				}),
				{ hostContext },
			);
			expect(result.status).toBe("ok");
			const records = operations(result.events);
			const first = records.filter(record => record.operationId === "comm-a");
			const second = records.filter(record => record.operationId === "comm-b");
			const extension = records.filter(record => record.operationId === "comm-c");
			expect(first.map(record => record.phase)).toEqual(["start", "progress", "progress", "terminal"]);
			expect(second.map(record => record.phase)).toEqual(["start", "terminal"]);
			expect(extension.map(record => record.phase)).toEqual(["start", "progress", "terminal"]);
			expect(first.map(record => record.operation)).toEqual(Array(4).fill("probe.ok"));
			expect(first.at(-1)).toMatchObject({ status: "ok" });
			expect(second.at(-1)).toMatchObject({ status: "error" });
			expect(extension.at(-1)).toMatchObject({ status: "ok" });
			expect(first.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
			expect(first[1]).toMatchObject({ message: "probing", summary: { path: "src/app.ts" } });
			expect(first[2]).toMatchObject({ summary: { path: "src/app.ts", count: 2, unit: "matches" } });
			expect(extension[1]).toMatchObject({
				message: "extension completed",
				summary: { path: "src/extension.ts", count: 1, unit: "entries" },
			});
			const at = records.map(record => record.at);
			expect(at).toEqual([...at].sort((left, right) => left - right));
			expect(JSON.stringify(records)).not.toContain(SECRET);
		} finally {
			await controller.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 15_000);

	test("does not record an unknown secret-shaped operation", async () => {
		const { controller, tempRoot } = await scriptedController({});
		try {
			const result = await controller.execute(
				JSON.stringify({ done: "none", requests: [{ comm_id: "comm-unknown", data: { type: SECRET } }] }),
				{ hostContext },
			);
			expect(result.status).toBe("ok");
			expect(operations(result.events)).toEqual([]);
			expect(JSON.stringify(result.events)).not.toContain(SECRET);
		} finally {
			await controller.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 15_000);

	test("terminates an interrupted operation and an operation left open by its cell", async () => {
		const { controller, tempRoot } = await scriptedController({
			"probe.hang": request =>
				new Promise((_resolve, reject) => {
					request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		});
		try {
			const running = controller.execute(
				JSON.stringify({ done: "none", requests: [{ comm_id: "comm-hang", data: { type: "probe.hang" } }] }),
				{ hostContext },
			);
			await Bun.sleep(200);
			await controller.interrupt();
			const aborted = await running;
			expect(aborted.status).toBe("aborted");
			expect(operations(aborted.events).at(-1)).toMatchObject({
				operationId: "comm-hang",
				operation: "probe.hang",
				phase: "terminal",
				status: "aborted",
			});

			const detached = await controller.execute(
				JSON.stringify({ done: "immediate", requests: [{ comm_id: "comm-open", data: { type: "probe.hang" } }] }),
				{ hostContext },
			);
			const records = operations(detached.events);
			expect(records.map(record => record.phase)).toEqual(["start", "terminal"]);
			expect(records.at(-1)).toMatchObject({ operationId: "comm-open", status: "error" });
		} finally {
			await controller.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 15_000);
});
