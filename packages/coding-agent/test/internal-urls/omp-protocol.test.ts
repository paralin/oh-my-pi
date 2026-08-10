import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";

const MAINTAINER_DOC = "natives-architecture.md";

describe("OmpProtocolHandler", () => {
	it("treats omp://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("omp://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("ipython.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("omp://ipython.md");
		const prefixed = await router.resolve("omp://docs/ipython.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# Persistent IPython runtime");
	});

	it("leaves maintainer pages out of the listing", async () => {
		const resource = await InternalUrlRouter.instance().resolve("omp://docs");

		expect(resource.content).not.toContain(MAINTAINER_DOC);
	});

	it("still serves a maintainer page at its exact path", async () => {
		const resource = await InternalUrlRouter.instance().resolve(`omp://${MAINTAINER_DOC}`);

		expect(resource.content).toContain("# Natives Architecture");
		expect(resource.content).not.toContain("omp-audience:");
	});

	it("lists maintainer pages when the calling session turns the filter off", async () => {
		const resource = await InternalUrlRouter.instance().resolve("omp://docs", {
			settings: Settings.isolated({ "docs.hideMaintainer": false }),
		});

		expect(resource.content).toContain(MAINTAINER_DOC);
	});
});
