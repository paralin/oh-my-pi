import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BENCHMARK_DEFINITIONS, readBenchmarkSnapshot } from "../src/benchmarks";

const cleanups: string[] = [];

function jobDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-benchmark-"));
	cleanups.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("benchmark adapters", () => {
	it("normalizes SnapCompact records and weighted quality metrics", () => {
		const dir = jobDir();
		fs.writeFileSync(
			path.join(dir, "records.jsonl"),
			`${JSON.stringify({ cond: "text", chunk: 0, pos_rel: 0.2, q: "q", answer: "a", golds: ["a"], em: 1, f1: 1 })}\n`,
		);
		fs.writeFileSync(
			path.join(dir, "summary.json"),
			JSON.stringify({
				rows: [
					{ n: 2, f1: 0.75, em: 0.5, cost_usd: 1.25, tokens_in: 200, tokens_out: 30, cache_w: 10, cache_r: 20 },
				],
			}),
		);

		const snapshot = readBenchmarkSnapshot("snapcompact", dir);
		expect(snapshot.metrics).toEqual({ f1: 0.75, exact_match: 0.5 });
		expect(snapshot.traces[0]).toMatchObject({ status: "pass", reward: 1, tracePath: "record:1" });
		expect(snapshot.costUsd).toBe(1.25);
		expect(snapshot.tokCache).toBe(30);
	});

	it("publishes metric definitions for every managed benchmark", () => {
		expect(BENCHMARK_DEFINITIONS.map(definition => definition.kind)).toEqual(["harbor", "snapcompact"]);
		expect(BENCHMARK_DEFINITIONS.every(definition => definition.metrics.length > 0)).toBe(true);
	});
});
