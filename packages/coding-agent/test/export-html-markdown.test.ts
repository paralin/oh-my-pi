import { describe, expect, test } from "bun:test";
import * as vm from "node:vm";
import { parseHTML } from "linkedom";
import { Marked } from "marked";

const [templateHtml, templateJs] = await Promise.all([
	Bun.file(new URL("../src/export/html/template.html", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/template.js", import.meta.url)).text(),
]);

interface MinimalMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user" | "assistant";
		content: string | unknown[];
		timestamp: number;
	};
}

interface MinimalCustomEntry {
	type: "custom_message";
	id: string;
	parentId: string | null;
	timestamp: string;
	customType: "ipython-cell";
	content: string;
	display: true;
	details: Record<string, unknown>;
}

interface MinimalSession {
	header: {
		type: "session";
		version: number;
		id: string;
		timestamp: string;
		cwd: string;
	};
	entries: Array<MinimalMessageEntry | MinimalCustomEntry>;
	leafId: string;
}

function renderSession(session: MinimalSession) {
	const { document, window } = parseHTML(templateHtml);
	const sessionData = document.getElementById("session-data");
	if (!sessionData) throw new Error("Export template is missing session data");
	sessionData.textContent = Buffer.from(JSON.stringify(session)).toBase64();
	Object.defineProperty(window, "location", {
		value: new URL("https://example.test/export.html"),
		configurable: true,
	});
	Object.defineProperty(window, "matchMedia", {
		value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		configurable: true,
	});
	// linkedom's HTMLSelectElement.value is getter-only; template.js assigns it
	// under 'use strict', which would throw. Shim a writable value like a browser.
	const themeSelect = document.getElementById("theme-select");
	if (themeSelect) {
		let themeValue = "auto";
		Object.defineProperty(themeSelect, "value", {
			get: () => themeValue,
			set: next => {
				themeValue = String(next);
			},
			configurable: true,
		});
	}

	const context = vm.createContext({
		window,
		document,
		marked: new Marked(),
		hljs: {
			getLanguage: () => false,
			highlight: () => ({ value: "" }),
			highlightAuto: () => ({ value: "" }),
		},
		URL,
		URLSearchParams,
		TextDecoder,
		Uint8Array,
		atob,
		navigator: { clipboard: null },
		localStorage: { getItem: () => null, setItem() {} },
		setTimeout: () => 0,
		clearTimeout() {},
	});
	vm.runInContext(templateJs, context);
	return document;
}

function createSession(
	entries: Array<MinimalMessageEntry | MinimalCustomEntry>,
	leafId: string,
	id: string,
): MinimalSession {
	return {
		header: {
			type: "session",
			version: 3,
			id,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp",
		},
		entries,
		leafId,
	};
}

function createDeepChainSession(depth: number): MinimalSession {
	const entries: MinimalMessageEntry[] = [
		{
			type: "message",
			id: "message-0",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "user",
				content: "root",
				timestamp: 0,
			},
		},
	];
	for (let i = 1; i < depth; i++) {
		entries.push({
			type: "message",
			id: `message-${i}`,
			parentId: `message-${i - 1}`,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
			message: {
				role: "assistant",
				content: [],
				timestamp: i,
			},
		});
	}
	return createSession(entries, "message-0", "deep-chain-test");
}

function renderMarkdown(source: string): Element {
	const document = renderSession(
		createSession(
			[
				{
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: {
						role: "user",
						content: source,
						timestamp: 0,
					},
				},
			],
			"message-1",
			"markdown-test",
		),
	);

	const rendered = document.querySelector(".markdown-content");
	if (!rendered) throw new Error("Export viewer did not render Markdown content");
	return rendered;
}

describe("HTML export Markdown", () => {
	test("renders inline Markdown in ordered, unordered, and nested list items", () => {
		const rendered = renderMarkdown("**outside**\n\n- **bold** and *italic* and `code`\n  1. **nested**");

		expect(rendered.querySelector("p strong")?.textContent).toBe("outside");
		expect(rendered.querySelector("ul > li > strong")?.textContent).toBe("bold");
		expect(rendered.querySelector("ul > li > em")?.textContent).toBe("italic");
		expect(rendered.querySelector("ul > li > code")?.textContent).toBe("code");
		expect(rendered.querySelector("ol > li > strong")?.textContent).toBe("nested");
	});

	test("renders IPython journals with safe text, images, diffs, and artifact references without evaluating HTML", () => {
		const entry: MinimalCustomEntry = {
			type: "custom_message",
			id: "ipython-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "ipython-cell",
			content: "",
			display: true,
			details: {
				version: 1,
				kind: "cell",
				cellId: "cell-1",
				sequence: 7,
				origin: "direct",
				authority: "trusted-cell",
				code: "print('<safe>')",
				status: "ok",
				safeText: "<safe>\n",
				events: [
					{
						kind: "display",
						data: {
							"text/html": "<script>globalThis.unsafe = true</script>",
							"image/png": "cG5n",
							"application/vnd.omp.diff+json": {
								path: "src/file.ts",
								diff: "@@ -1 +1 @@\n-old\n+new",
							},
						},
					},
				],
				artifacts: [{ path: "/tmp/result.txt", mimeType: "text/plain", label: "result" }],
			},
		};
		const document = renderSession(createSession([entry], entry.id, "ipython-export"));
		const cell = document.querySelector(".ipython-cell");
		expect(cell?.getAttribute("data-ipython-status")).toBe("ok");
		expect(cell?.querySelector(".ipython-code")?.textContent).toContain("print('<safe>')");
		expect(cell?.querySelector(".ipython-output")?.textContent).toBe("<safe>\n");
		expect(cell?.querySelector(".ipython-image")?.getAttribute("src")).toBe("data:image/png;base64,cG5n");
		expect(cell?.querySelector(".ipython-diff")?.textContent).toContain("-old\n+new");
		expect(cell?.querySelector(".ipython-artifacts")?.textContent).toContain("/tmp/result.txt");
		expect(cell?.querySelector("script")).toBeNull();
		expect(cell?.textContent).not.toContain("globalThis.unsafe");
		expect(document.querySelector(".tree-node")?.textContent).toContain("IPython ok");
	});

	test("renders a deep valid conversation tree without overflowing the call stack", () => {
		const document = renderSession(createDeepChainSession(30_000));

		expect(document.querySelectorAll(".tree-node").length).toBe(1);
		expect(document.querySelector(".tree-node.active")?.getAttribute("data-id")).toBe("message-0");
		expect(document.querySelector("#messages")?.textContent).toContain("root");
	});
});
