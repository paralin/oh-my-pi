import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Skill } from "../extensibility/skills";

export const MAX_PYTHON_PACKAGE_FILES = 4096;
export const MAX_PYTHON_PACKAGE_BYTES = 32 * 1024 * 1024;

const PYTHON_IMPORT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PYTHON_KEYWORDS = new Set([
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"case",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"False",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"match",
	"None",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"True",
	"try",
	"type",
	"while",
	"with",
	"yield",
]);

/** Imports installed with the managed runtime and therefore never dynamic. */
export const FIXED_PYTHON_IMPORTS: ReadonlySet<string> = new Set([
	"agent_message",
	"agent_observe",
	"attach_image",
	"compact",
	"edit",
	"goal",
	"refine",
	"rlm_heartbeat",
	"websearch",
	"linear",
	"notion",
]);

export interface PythonPackageFile {
	readonly path: string;
	readonly bytes: number;
}

export interface PythonSkillPackage {
	readonly importName: string;
	readonly callableName: string;
	readonly projectName: string;
	readonly packageRoot: string;
	readonly sourceRoot: string;
	readonly skillPath: string;
	readonly files: readonly PythonPackageFile[];
	readonly contentHash: string;
	readonly skill: Skill;
}

export interface PythonSkillPackageWarning {
	readonly skillPath: string;
	readonly message: string;
}

export interface ResolvePythonSkillPackagesResult {
	readonly packages: readonly PythonSkillPackage[];
	readonly warnings: readonly PythonSkillPackageWarning[];
}

export interface ResolvePythonSkillPackagesOptions {
	readonly maxFiles?: number;
	readonly maxBytes?: number;
}

interface ParsedProject {
	readonly project?: { readonly name?: unknown };
}

function warning(skill: Skill, message: string): PythonSkillPackageWarning {
	return { skillPath: skill.filePath, message };
}

function normalizeImportName(name: string): string {
	return name.normalize("NFKC").toLowerCase();
}

function normalizeProjectName(name: string): string {
	return name
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/[-_.]+/gu, "-");
}

function isBundledFixedSkill(skill: Skill): boolean {
	if (!skill.pythonImport || !FIXED_PYTHON_IMPORTS.has(skill.pythonImport)) return false;
	const expected = path.join(import.meta.dir, "python", "skills", skill.pythonImport.replaceAll("_", "-"));
	return path.resolve(skill.baseDir) === expected;
}

function isContained(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function realPathContained(root: string, candidate: string): Promise<boolean> {
	const realRoot = await fs.realpath(root);
	const realCandidate = await fs.realpath(candidate);
	return isContained(realRoot, realCandidate);
}

async function assertNoSymlink(target: string): Promise<void> {
	const stat = await fs.lstat(target);
	if (stat.isSymbolicLink()) throw new Error(`symlinks are not allowed: ${target}`);
}

async function inventoryPackage(root: string, maxFiles: number, maxBytes: number): Promise<PythonPackageFile[]> {
	const files: PythonPackageFile[] = [];
	let totalBytes = 0;
	const visit = async (directory: string): Promise<void> => {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
		for (const entry of entries) {
			const absolute = path.join(directory, entry.name);
			await assertNoSymlink(absolute);
			if (entry.name === ".git" || entry.name === ".venv" || entry.name === "__pycache__") continue;
			if (entry.isDirectory()) {
				await visit(absolute);
				continue;
			}
			if (!entry.isFile()) throw new Error(`unsupported package entry: ${absolute}`);
			if (entry.name.endsWith(".pyc")) continue;
			const stat = await fs.stat(absolute);
			if (files.length >= maxFiles) throw new Error(`package exceeds ${maxFiles} files`);
			if (totalBytes > maxBytes - stat.size) throw new Error(`package exceeds ${maxBytes} bytes`);
			files.push({ path: path.relative(root, absolute), bytes: stat.size });
			totalBytes += stat.size;
		}
	};
	await visit(root);
	return files;
}

async function resolveOne(skill: Skill, maxFiles: number, maxBytes: number): Promise<PythonSkillPackage> {
	const importName = skill.pythonImport;
	const callableName = skill.pythonCallable;
	const declaredSourceRoot = skill.pythonPath;
	if (!importName || !callableName || !declaredSourceRoot) throw new Error("incomplete Python package metadata");
	if (!PYTHON_IMPORT_RE.test(callableName) || PYTHON_KEYWORDS.has(callableName)) {
		throw new Error(`invalid Python callable identifier: ${callableName}`);
	}
	if (!PYTHON_IMPORT_RE.test(importName) || PYTHON_KEYWORDS.has(importName)) {
		throw new Error(`invalid Python import identifier: ${importName}`);
	}
	if (importName === "rlm" || importName === "omp" || FIXED_PYTHON_IMPORTS.has(importName)) {
		throw new Error(`reserved or fixed Python import: ${importName}`);
	}
	const packageRoot = path.resolve(skill.baseDir);
	const sourceRoot = path.resolve(declaredSourceRoot);
	if (sourceRoot !== path.join(packageRoot, "src")) throw new Error("pythonPath must be packageRoot/src");
	if (!(await realPathContained(packageRoot, sourceRoot))) throw new Error("Python source root escapes package root");
	await assertNoSymlink(packageRoot);
	const skillPath = path.resolve(skill.filePath);
	if (!isContained(packageRoot, skillPath)) throw new Error("SKILL.md escapes package root");
	await assertNoSymlink(skillPath);
	if (!(await realPathContained(packageRoot, skillPath))) throw new Error("SKILL.md realpath escapes package root");
	const manifestPath = path.join(packageRoot, "pyproject.toml");
	const lockPath = path.join(packageRoot, "uv.lock");
	for (const required of [manifestPath, lockPath, sourceRoot, path.join(sourceRoot, importName)]) {
		const requiredStat = await fs.stat(required);
		await assertNoSymlink(required);
		if (!(await realPathContained(packageRoot, required))) throw new Error(`path escapes package root: ${required}`);
		if ((required === manifestPath || required === lockPath) && !requiredStat.isFile()) {
			throw new Error(`required manifest is not a file: ${required}`);
		}
	}
	const moduleRoot = path.join(sourceRoot, importName);
	const moduleStat = await fs.stat(moduleRoot);
	if (!moduleStat.isDirectory()) throw new Error(`Python package source is not a directory: ${moduleRoot}`);
	const manifest = Bun.TOML.parse(await fs.readFile(manifestPath, "utf8")) as ParsedProject;
	const projectName = manifest.project?.name;
	if (typeof projectName !== "string" || projectName.trim() === "")
		throw new Error("pyproject.toml requires [project].name");
	const files = await inventoryPackage(packageRoot, maxFiles, maxBytes);
	const hasher = new Bun.CryptoHasher("sha256");
	for (const file of files) {
		hasher.update(`${file.path.length}:${file.path}\0${file.bytes}:`);
		hasher.update(await fs.readFile(path.join(packageRoot, file.path)));
	}
	return {
		importName,
		callableName,
		projectName,
		packageRoot,
		sourceRoot,
		skillPath,
		files,
		contentHash: hasher.digest("hex"),
		skill,
	};
}

/** Resolve authored Python skill packages without changing Markdown skill selection. */
export async function resolvePythonSkillPackages(
	skills: readonly Skill[],
	options: ResolvePythonSkillPackagesOptions = {},
): Promise<ResolvePythonSkillPackagesResult> {
	const maxFiles = Math.max(0, Math.min(options.maxFiles ?? MAX_PYTHON_PACKAGE_FILES, MAX_PYTHON_PACKAGE_FILES));
	const maxBytes = Math.max(0, Math.min(options.maxBytes ?? MAX_PYTHON_PACKAGE_BYTES, MAX_PYTHON_PACKAGE_BYTES));
	const packages: PythonSkillPackage[] = [];
	const warnings: PythonSkillPackageWarning[] = [];
	const seenImports = new Set<string>();
	const seenProjects = new Set<string>();
	for (const skill of skills) {
		const hasMetadata =
			skill.pythonImport !== undefined || skill.pythonCallable !== undefined || skill.pythonPath !== undefined;
		if (!hasMetadata) continue;
		if (skill.pythonImport && FIXED_PYTHON_IMPORTS.has(skill.pythonImport)) {
			if (isBundledFixedSkill(skill)) continue;
		}
		try {
			const resolved = await resolveOne(skill, maxFiles, maxBytes);
			const normalized = normalizeImportName(resolved.importName);
			if (seenImports.has(normalized)) {
				warnings.push(warning(skill, `Python import collision: ${resolved.importName}`));
				continue;
			}
			const normalizedProject = normalizeProjectName(resolved.projectName);
			if (seenProjects.has(normalizedProject)) {
				warnings.push(warning(skill, `Python project-name collision: ${resolved.projectName}`));
				continue;
			}
			seenImports.add(normalized);
			seenProjects.add(normalizedProject);
			packages.push(resolved);
		} catch (error) {
			warnings.push(warning(skill, error instanceof Error ? error.message : String(error)));
		}
	}
	return { packages, warnings };
}
