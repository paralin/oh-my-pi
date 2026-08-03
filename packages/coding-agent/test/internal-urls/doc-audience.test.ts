import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { readDocAudience, stripDocAudienceMarker } from "@oh-my-pi/pi-coding-agent/internal-urls/doc-audience";
import { Glob } from "bun";

const docsDir = path.resolve(import.meta.dir, "../../../../docs");

describe("readDocAudience", () => {
	it("reads the marker off the first line", () => {
		expect(readDocAudience("<!-- omp-audience: maintainer -->\n\n# Natives\n")).toBe("maintainer");
		expect(readDocAudience("  <!--   omp-audience:   maintainer   -->\n")).toBe("maintainer");
	});

	it("reads and strips a marker after a UTF-8 BOM", () => {
		const body = "\uFEFF<!-- omp-audience: maintainer -->\n\n# Natives\n";
		expect(readDocAudience(body)).toBe("maintainer");
		expect(stripDocAudienceMarker(body)).toBe("\n\n# Natives\n");
	});

	it("defaults an unmarked page to the agent audience", () => {
		expect(readDocAudience("# Hooks\n\nThis document describes hooks.\n")).toBe("agent");
		expect(readDocAudience("")).toBe("agent");
	});

	it("ignores a marker that is not on the first line", () => {
		expect(readDocAudience("# Hooks\n\n<!-- omp-audience: maintainer -->\n")).toBe("agent");
	});

	it("rejects an unknown audience", () => {
		expect(() => readDocAudience("<!-- omp-audience: nobody -->\n")).toThrow("Unknown omp-audience value: nobody");
	});

	it("rejects uppercase, numeric, and empty declarations", () => {
		expect(() => readDocAudience("<!-- omp-audience: Maintainer -->\n")).toThrow(
			"Unknown omp-audience value: Maintainer",
		);
		expect(() => readDocAudience("<!-- omp-audience: maintainer2 -->\n")).toThrow(
			"Unknown omp-audience value: maintainer2",
		);
		expect(() => readDocAudience("<!-- omp-audience: -->\n")).toThrow("Unknown omp-audience value: (empty)");
	});

	it("rejects malformed declaration terminators", () => {
		for (const body of ["<!-- omp-audience: maintainer", "<!-- omp-audience: maintainer -- >\n"]) {
			expect(() => readDocAudience(body)).toThrow("Malformed omp-audience declaration");
			expect(() => stripDocAudienceMarker(body)).toThrow("Malformed omp-audience declaration");
		}
	});

	it("rejects a missing or spaced declaration separator", () => {
		for (const body of ["<!-- omp-audience maintainer -->\n", "<!-- omp-audience : maintainer -->\n"]) {
			expect(() => readDocAudience(body)).toThrow("Malformed omp-audience declaration");
			expect(() => stripDocAudienceMarker(body)).toThrow("Malformed omp-audience declaration");
		}
	});

	it("preserves first-line content after the marker", () => {
		const body = "<!-- omp-audience: maintainer --> # Architecture\n\nDetails.\n";
		expect(readDocAudience(body)).toBe("maintainer");
		expect(stripDocAudienceMarker(body)).toBe(" # Architecture\n\nDetails.\n");
	});
});

describe("docs corpus", () => {
	// The marker is the only thing splitting the corpus, so a typo in one page
	// silently republishes it to every session. Assert the whole tree parses to a
	// known audience and that both halves are non-empty.
	it("classifies every page and keeps both audiences populated", async () => {
		const relativePaths = await Array.fromAsync(new Glob("**/*.md").scan(docsDir));
		const audiences = await Promise.all(
			relativePaths.map(async relativePath =>
				readDocAudience(await Bun.file(path.join(docsDir, relativePath)).text()),
			),
		);

		expect(audiences.length).toBeGreaterThan(0);
		expect(audiences.filter(audience => audience === "maintainer").length).toBeGreaterThan(0);
		expect(audiences.filter(audience => audience === "agent").length).toBeGreaterThan(0);
	});

	it("leaves the tool reference on the agent side", async () => {
		const relativePaths = await Array.fromAsync(new Glob("tools/*.md").scan(docsDir));
		await Promise.all(
			relativePaths.map(async relativePath => {
				const body = await Bun.file(path.join(docsDir, relativePath)).text();
				expect(readDocAudience(body), `docs/${relativePath} is hidden from the sessions that use the tool`).toBe(
					"agent",
				);
			}),
		);
	});
});
