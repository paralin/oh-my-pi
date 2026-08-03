import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { toolRenderers } from "@oh-my-pi/pi-coding-agent/tools/renderers";

describe("cron renderer path privacy", () => {
	let theme: Theme;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		setThemeInstance(theme);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("shortens home paths in pending create and delete arguments", () => {
		const privatePath = `${os.homedir()}/private/schedule`;
		const options = { expanded: false, isPartial: true };
		const create = Bun.stripANSI(
			toolRenderers.cron_create.renderCall({ expression: privatePath }, options, theme).render(160).join("\n"),
		);
		const remove = Bun.stripANSI(
			toolRenderers.cron_delete.renderCall({ id: privatePath }, options, theme).render(160).join("\n"),
		);

		expect(create).toContain("~/private/schedule");
		expect(remove).toContain("~/private/schedule");
		expect(create).not.toContain(os.homedir());
		expect(remove).not.toContain(os.homedir());
	});
});
