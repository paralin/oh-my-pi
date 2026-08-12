import { describe, expect, test } from "bun:test";
import { previewIpythonCode, previewPythonCode } from "../../src/ipython/code-preview.js";

describe("IPython code preview", () => {
	test("extracts static subprocess argv from positional and keyword calls", () => {
		const expected = { language: "python", text: "rg -n needle src" } as const;
		expect(previewPythonCode('subprocess.run(["rg", "-n", "needle", "src"])')).toEqual(expected);
		expect(previewPythonCode('subprocess.run(args=["rg", "-n", "needle", "src"], check=True)')).toEqual(expected);
		expect(
			previewPythonCode(`subprocess.run(
	args=[
		"rg",
		"-n",
		"needle",
		"src",
	],
	check=True,
)`),
		).toEqual(expected);
	});

	test("extracts commands from subprocess check APIs and os.system", () => {
		const expected = { language: "python", text: "rg -n needle src" } as const;
		expect(previewPythonCode('subprocess.check_call(["rg", "-n", "needle", "src"])')).toEqual(expected);
		expect(previewPythonCode('subprocess.check_output(args=["rg", "-n", "needle", "src"])')).toEqual(expected);
		expect(previewPythonCode('os.system("rg -n needle src")')).toEqual(expected);
	});

	test("shows static shell and IPython magic commands as bash actions", () => {
		expect(previewPythonCode('subprocess.run("rg -n needle src", shell=True)')).toEqual({
			language: "python",
			text: "rg -n needle src",
		});
		expect(previewIpythonCode("%%bash\nset -e\nrg -n needle src")).toEqual({
			language: "bash",
			text: "rg -n needle src",
		});
		expect(previewIpythonCode("!rg -n needle src")).toEqual({ language: "bash", text: "rg -n needle src" });
	});

	test("does not turn dynamic expressions or quoted source into commands", () => {
		expect(previewPythonCode('subprocess.run(["rg", pattern])')).toEqual({
			language: "python",
			text: 'subprocess.run(["rg", pattern])',
		});
		const quoted = previewPythonCode('message = "subprocess.run([\\"rg\\", \\"-n\\"])"');
		expect(quoted.text).toContain("message");
		expect(quoted.text).not.toBe("rg -n");
		expect(previewPythonCode('runner.subprocess.run(["rg", "-n"])').text).not.toBe("rg -n");
		expect(previewPythonCode('subprocess.check_returncode(["rg", "-n"])').text).not.toBe("rg -n");
		expect(previewIpythonCode('message = """\n!rg -n\n"""').text).not.toBe("rg -n");
	});

	test("redacts credential-shaped command arguments", () => {
		const preview = previewPythonCode('subprocess.run(["curl", "--api-key", "sk live must not render"])');
		expect(preview.text).toBe("curl --api-key <redacted>");
		expect(preview.text).not.toContain("sk live must not render");
	});
});
