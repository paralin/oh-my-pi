import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { getDocFilenames } from "@oh-my-pi/pi-coding-agent/internal-urls/docs-index";
import { isMaintainerDocPath } from "@oh-my-pi/pi-coding-agent/internal-urls/omp-doc-visibility";

describe("OmpProtocolHandler", () => {
	const hidden = Settings.isolated();
	const complete = Settings.isolated({ "docs.hideInternal": false });

	it("owns the approved 53-document maintainer taxonomy", () => {
		const filenames = getDocFilenames();
		const hiddenFilenames = filenames.filter(isMaintainerDocPath);

		expect(filenames).toHaveLength(121);
		expect(hiddenFilenames).toHaveLength(53);
		expect(hiddenFilenames).toContain("ERRATA-GPT5-HARMONY.md");
		expect(hiddenFilenames).toContain("toolconv/harmony.md");
		expect(hiddenFilenames).toContain("session-tree-plan.md");
		expect(hiddenFilenames).not.toContain("approval-mode.md");
		expect(hiddenFilenames).not.toContain("tools/read.md");
	});

	it("hides maintainer documentation by default", async () => {
		expect(getDefault("docs.hideInternal")).toBe(true);

		const router = InternalUrlRouter.instance();
		const root = await router.resolve("omp://", { settings: hidden });
		const completions = await router.complete("omp", "", { settings: hidden });

		expect(root.content).toContain("68 files available");
		expect(root.content).not.toContain("ERRATA-GPT5-HARMONY.md");
		expect(completions?.map(item => item.value)).not.toContain("ERRATA-GPT5-HARMONY.md");
		await expect(router.resolve("omp://ERRATA-GPT5-HARMONY.md", { settings: hidden })).rejects.toThrow(
			"Documentation file not found",
		);
		await expect(router.resolve("omp://adding-a-provide.md", { settings: hidden })).rejects.toThrow(
			"Documentation file not found: adding-a-provide.md\nUse omp:// to list available files.",
		);
	});

	it("uses the hidden default without caller settings", async () => {
		await expect(InternalUrlRouter.instance().resolve("omp://adding-a-provider.md")).rejects.toThrow(
			"Documentation file not found",
		);
	});

	it("restores every OMP surface when filtering is disabled", async () => {
		const router = InternalUrlRouter.instance();
		const root = await router.resolve("omp://", { settings: complete });
		const completions = await router.complete("omp", "", { settings: complete });
		const direct = await router.resolve("omp://docs/ERRATA-GPT5-HARMONY.md", { settings: complete });

		expect(root.content).toContain("121 files available");
		expect(root.content).toContain("ERRATA-GPT5-HARMONY.md");
		expect(completions?.map(item => item.value)).toContain("ERRATA-GPT5-HARMONY.md");
		expect(direct.content).toContain("GPT-5 Harmony-Header Leakage");
	});

	it("does not leak visibility through the process-global router", async () => {
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("omp://adding-a-provider.md", { settings: hidden })).rejects.toThrow(
			"Documentation file not found",
		);
		expect((await router.resolve("omp://adding-a-provider.md", { settings: complete })).content).toContain(
			"# Adding a provider",
		);
		await expect(router.resolve("omp://adding-a-provider.md", { settings: hidden })).rejects.toThrow(
			"Documentation file not found",
		);
	});

	it("treats omp://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("omp://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("omp://tools/read.md");
		const prefixed = await router.resolve("omp://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});
});
