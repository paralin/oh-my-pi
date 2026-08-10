import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "../../src/extensibility/skills";
import {
	FIXED_PYTHON_IMPORTS,
	MAX_PYTHON_PACKAGE_BYTES,
	MAX_PYTHON_PACKAGE_FILES,
	resolvePythonSkillPackages,
} from "../../src/ipython/python-packages";

let tempRoot: string | undefined;

afterEach(async () => {
	if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
	tempRoot = undefined;
});

async function root(): Promise<string> {
	tempRoot ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-python-packages-"));
	return tempRoot;
}

async function makePackage(
	importName: string,
	options: { projectName?: string; callableName?: string; lock?: boolean } = {},
): Promise<Skill> {
	const packageRoot = path.join(await root(), importName);
	await fs.mkdir(path.join(packageRoot, "src", importName), { recursive: true });
	await fs.writeFile(path.join(packageRoot, "SKILL.md"), `---\nname: ${importName}\ndescription: test\n---\n`);
	await fs.writeFile(
		path.join(packageRoot, "pyproject.toml"),
		`[project]\nname = "${options.projectName ?? `test-${importName}`}"\n`,
	);
	if (options.lock !== false) await fs.writeFile(path.join(packageRoot, "uv.lock"), "version = 1\n");
	await fs.writeFile(path.join(packageRoot, "src", importName, "__init__.py"), `value = "${importName}"\n`);
	await fs.writeFile(path.join(packageRoot, "src", importName, "z.py"), "z = 1\n");
	return {
		name: importName,
		description: "test",
		filePath: path.join(packageRoot, "SKILL.md"),
		baseDir: packageRoot,
		source: "test:project",
		pythonImport: importName,
		pythonCallable: options.callableName ?? "run",
		pythonPath: path.join(packageRoot, "src"),
	};
}

describe("Python skill package resolver", () => {
	it("resolves valid packages deterministically and hashes file content", async () => {
		const skill = await makePackage("sample_pkg", { projectName: "quoted-name" });
		const first = await resolvePythonSkillPackages([skill]);
		const pkg = first.packages[0];
		expect(first.warnings).toEqual([]);
		expect(pkg).toBeDefined();
		expect(pkg?.projectName).toBe("quoted-name");
		expect(pkg?.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(pkg?.files.map(file => file.path)).toEqual([
			"SKILL.md",
			"pyproject.toml",
			"src/sample_pkg/__init__.py",
			"src/sample_pkg/z.py",
			"uv.lock",
		]);
		const originalHash = pkg?.contentHash;
		await fs.writeFile(path.join(skill.baseDir, "src", "sample_pkg", "z.py"), "z = 2\n");
		const changed = await resolvePythonSkillPackages([skill]);
		expect(changed.packages[0]?.contentHash).not.toBe(originalHash);
	});

	it("keeps authored order while rejecting normalized later imports", async () => {
		const first = await makePackage("Alpha_pkg");
		const later = await makePackage("alpha_pkg");
		const result = await resolvePythonSkillPackages([first, later]);
		expect(result.packages.map(pkg => pkg.importName)).toEqual(["Alpha_pkg"]);
		expect(result.warnings[0]?.message).toContain("collision");
	});

	it("validates callable identifiers and rejects normalized project-name collisions", async () => {
		const invalid = await makePackage("callable_invalid", { callableName: "class" });
		const first = await makePackage("project_first", { projectName: "Acme.Tools" });
		const later = await makePackage("project_later", { projectName: "acme-tools" });
		const result = await resolvePythonSkillPackages([invalid, first, later]);
		expect(result.packages.map(pkg => pkg.importName)).toEqual(["project_first"]);
		expect(result.warnings.map(item => item.message)).toEqual([
			"invalid Python callable identifier: class",
			"Python project-name collision: acme-tools",
		]);
	});

	it("treats fixed imports as base assets and rejects reserved imports", async () => {
		const fixed = await makePackage("websearch");
		const reserved = await makePackage("rlm");
		const result = await resolvePythonSkillPackages([fixed, reserved]);
		expect(FIXED_PYTHON_IMPORTS.has("websearch")).toBe(true);
		expect(result.packages).toEqual([]);
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings.every(item => item.message.includes("reserved or fixed"))).toBe(true);
	});

	it("warns on missing or stale structural inputs without rejecting the Skill", async () => {
		const missingLock = await makePackage("missing_lock", { lock: false });
		const malformed = await makePackage("malformed");
		await fs.writeFile(path.join(malformed.baseDir, "pyproject.toml"), "[tool.other]\nname = 'not-project'\n");
		const result = await resolvePythonSkillPackages([missingLock, malformed]);
		expect(result.packages).toEqual([]);
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings.map(item => item.skillPath)).toEqual([missingLock.filePath, malformed.filePath]);
	});

	it("rejects path escapes and symlinks", async () => {
		const escaped = await makePackage("escaped");
		escaped.pythonPath = path.join(await root(), "outside");
		const linked = await makePackage("linked");
		await fs.rm(path.join(linked.baseDir, "src", "linked", "z.py"));
		await fs.symlink(path.join(linked.baseDir, "SKILL.md"), path.join(linked.baseDir, "src", "linked", "z.py"));
		const result = await resolvePythonSkillPackages([escaped, linked]);
		expect(result.packages).toEqual([]);
		expect(result.warnings).toHaveLength(2);
	});

	it("enforces bounded inventory and bytes", async () => {
		const many = await makePackage("many");
		const oversized = await makePackage("oversized");
		await fs.writeFile(path.join(oversized.baseDir, "src", "oversized", "large.py"), "x".repeat(128));
		const fileBound = await resolvePythonSkillPackages([many], { maxFiles: 2 });
		const byteBound = await resolvePythonSkillPackages([oversized], { maxBytes: 2 });
		expect(fileBound.packages).toEqual([]);
		expect(byteBound.packages).toEqual([]);
		expect(MAX_PYTHON_PACKAGE_FILES).toBe(4096);
		expect(MAX_PYTHON_PACKAGE_BYTES).toBe(32 * 1024 * 1024);
	});
});
