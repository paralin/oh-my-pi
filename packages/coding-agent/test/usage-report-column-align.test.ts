import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const HOUR = 3_600_000;

beforeAll(async () => {
	await initTheme();
});

function win(label: string, windowId: string, durationMs: number, frac: number) {
	return {
		id: windowId,
		label,
		scope: { provider: "kimi-code", windowId },
		window: { id: windowId, label, durationMs },
		amount: { unit: "percent", usedFraction: frac },
		status: frac >= 1 ? "exhausted" : frac >= 0.9 ? "warning" : "ok",
	} satisfies UsageReport["limits"][number];
}

function acct(email: string, total: number, fiveH: number): UsageReport {
	return {
		provider: "kimi-code",
		fetchedAt: Date.now(),
		metadata: { email },
		limits: [
			win("Total quota", "usage-window", 7 * 24 * HOUR, total),
			win("5h limit", "rolling-5h", 5 * HOUR, fiveH),
		],
	} satisfies UsageReport;
}

describe("renderUsageReports multi-account column alignment (#6067)", () => {
	it("keeps account columns in the same order across every window row", () => {
		// Account A: weekly exhausted, 5h free. Account B: weekly light, 5h exhausted.
		// A naive per-window sort by used fraction swaps the columns between rows.
		const reports: UsageReport[] = [acct("alice@example.test", 1.0, 0.0), acct("bob@example.test", 0.2, 1.0)];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 160));
		const lines = text.split("\n");

		const columnOrder = (sectionLabel: string): string[] => {
			const headerIdx = lines.findIndex(l => l.includes(sectionLabel));
			expect(headerIdx).toBeGreaterThanOrEqual(0);
			// The account-label row is the line right after the section header.
			const labelRow = lines[headerIdx + 1];
			return ["alice@example.test", "bob@example.test"].sort((a, b) => labelRow.indexOf(a) - labelRow.indexOf(b));
		};

		const totalOrder = columnOrder("Total quota");
		const fiveHOrder = columnOrder("5h limit");
		expect(fiveHOrder).toEqual(totalOrder);
	});
});
