import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView } from "../src/tool-render/ToolView";

describe("ToolView generic historical records", () => {
	it("renders current IPython records with the generic read-only renderer", () => {
		const html = renderToStaticMarkup(
			<ToolView name="ipython" defaultOpen args={{ code: "print(1)" }} result={{ content: [] }} />,
		);

		expect(html).toContain("ipython");
		expect(html).toContain("print(1)");
		expect(html).toContain("tv-out-title");
	});

	it("renders unknown historical records generically without dispatching xdev details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="removed_legacy_tool"
				defaultOpen
				args={{ value: "kept as data" }}
				result={{
					content: [{ type: "text", text: "historical output" }],
					details: { xdev: { mode: "execute", tool: "bash", args: { command: "rm -rf /" } } },
				}}
			/>,
		);

		expect(html).toContain("removed_legacy_tool");
		expect(html).toContain("kept as data");
		expect(html).toContain("historical output");
		expect(html).not.toContain("xd://");
		expect(html).not.toContain("rm -rf /");
	});
});
