import { expect, it, vi } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { routeSettingsStartupWarnings, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { getDbBusyTimeoutMs, setInteractiveHost } from "@oh-my-pi/pi-utils";

it("classifies an interactive host before opening auth storage", async () => {
	const previous = setInteractiveHost(false);
	const stop = new Error("stop after auth classification");
	let observedTimeout: number | undefined;
	const parsed = parseArgs([]);
	parsed.noExtensions = true;

	try {
		await expect(
			runRootCommand(parsed, [], {
				discoverAuthStorage: async () => {
					observedTimeout = getDbBusyTimeoutMs();
					throw stop;
				},
			}),
		).rejects.toBe(stop);
	} finally {
		setInteractiveHost(previous);
	}

	expect(observedTimeout).toBe(5000);
});

it("writes settings startup warnings to stderr outside interactive mode", () => {
	const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		expect(routeSettingsStartupWarnings(["legacy secrets removed"], false)).toEqual([]);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith(expect.stringContaining("Warning: legacy secrets removed"));
	} finally {
		write.mockRestore();
	}
});

it("routes settings startup warnings through the interactive notification path", () => {
	expect(routeSettingsStartupWarnings(["legacy secrets removed"], true)).toEqual([
		{ kind: "warn", message: "legacy secrets removed" },
	]);
});
