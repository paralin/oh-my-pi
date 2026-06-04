import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { filterProcessEnv, parseEnvFile } from "../src/env";

const tempDirs: string[] = [];
const envModulePath = path.resolve(import.meta.dir, "../src/env.ts");
const canReadInitialProcessEnv = fs.existsSync("/proc/self/environ");

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

function makeTempProjectEnv(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-"));
	tempDirs.push(dir);
	fs.writeFileSync(path.join(dir, ".env"), content);
	return dir;
}

function writeTempEnv(content: string): string {
	return path.join(makeTempProjectEnv(content), ".env");
}

function runEnvProbe(
	cwd: string,
	env: Record<string, string>,
	useBunAutoload: boolean,
	homeEnvContent?: string,
): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
	tempDirs.push(home);
	if (homeEnvContent !== undefined) {
		fs.writeFileSync(path.join(home, ".env"), homeEnvContent);
	}
	const script = [
		`import ${JSON.stringify(envModulePath)};`,
		`const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", "console.log(process.env.PROJECT_ONLY ?? 'missing')"], { env: Bun.env, stdout: "pipe", stderr: "pipe" });`,
		`console.log("process=" + (Bun.env.PROJECT_ONLY ?? "missing"));`,
		`console.log("child=" + child.stdout.toString().trim());`,
		`console.log("alias=" + (Bun.env.PI_PROJECT_ALIAS ?? "missing"));`,
	].join("");
	const result = Bun.spawnSync([process.execPath, ...(useBunAutoload ? [] : ["--no-env-file"]), "-e", script], {
		cwd,
		env: {
			HOME: home,
			PATH: Bun.env.PATH ?? "",
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString());
	}
	return result.stdout.toString();
}

describe("parseEnvFile", () => {
	it("ignores malformed names and nul-containing values", () => {
		const filePath = writeTempEnv(
			[
				"GOOD=value",
				"_ALSO_GOOD='quoted value'",
				"1BAD=value",
				"BAD-NAME=value",
				"BAD NAME=value",
				"BAD_VALUE=before\0after",
				"# comment",
				"NO_EQUALS",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			GOOD: "value",
			_ALSO_GOOD: "quoted value",
		});
	});

	it("mirrors valid OMP_ variables to PI_ variables", () => {
		const filePath = writeTempEnv("OMP_FEATURE=enabled\nOMP_BAD=before\0after\n");

		expect(parseEnvFile(filePath)).toEqual({
			OMP_FEATURE: "enabled",
			PI_FEATURE: "enabled",
		});
	});
});

describe("project .env loading", () => {
	it("loads project variables into the process and subprocess environment by default", () => {
		const cwd = makeTempProjectEnv("PROJECT_ONLY=from-project\nOMP_PROJECT_ALIAS=from-project\n");

		expect(runEnvProbe(cwd, {}, false)).toBe("process=from-project\nchild=from-project\nalias=from-project\n");
	});

	it("omits project variables from the process and subprocess environment when opted out", () => {
		const cwd = makeTempProjectEnv("PROJECT_ONLY=from-project\n");

		expect(runEnvProbe(cwd, { OMP_NO_PROJECT_ENV: "1" }, false)).toBe(
			"process=missing\nchild=missing\nalias=missing\n",
		);
	});

	it("honors project env opt-out from user env files", () => {
		const cwd = makeTempProjectEnv("PROJECT_ONLY=from-project\n");

		expect(runEnvProbe(cwd, {}, false, "OMP_NO_PROJECT_ENV=1\n")).toBe(
			"process=missing\nchild=missing\nalias=missing\n",
		);
	});

	it.skipIf(!canReadInitialProcessEnv)("scrubs Bun-autoloaded project variables when opted out", () => {
		const cwd = makeTempProjectEnv("PROJECT_ONLY=from-project\n");

		expect(runEnvProbe(cwd, { OMP_NO_PROJECT_ENV: "1" }, true)).toBe(
			"process=missing\nchild=missing\nalias=missing\n",
		);
	});

	it.skipIf(!canReadInitialProcessEnv)(
		"honors user env file opt-out when scrubbing Bun-autoloaded project env",
		() => {
			const cwd = makeTempProjectEnv("PROJECT_ONLY=from-project\n");

			expect(runEnvProbe(cwd, {}, true, "OMP_NO_PROJECT_ENV=1\n")).toBe(
				"process=missing\nchild=missing\nalias=missing\n",
			);
		},
	);

	it.skipIf(!canReadInitialProcessEnv)(
		"preserves matching explicit values when scrubbing Bun-autoloaded project env",
		() => {
			const cwd = makeTempProjectEnv("PROJECT_ONLY=same-value\n");

			expect(runEnvProbe(cwd, { OMP_NO_PROJECT_ENV: "1", PROJECT_ONLY: "same-value" }, true)).toBe(
				"process=same-value\nchild=same-value\nalias=missing\n",
			);
		},
	);

	it("keeps explicit environment values when project loading is opted out", () => {
		const cwd = makeTempProjectEnv("PROJECT_ONLY=from-project\n");

		expect(runEnvProbe(cwd, { OMP_NO_PROJECT_ENV: "1", PROJECT_ONLY: "from-real-env" }, true)).toBe(
			"process=from-real-env\nchild=from-real-env\nalias=missing\n",
		);
	});
});

describe("filterProcessEnv", () => {
	it("drops entries that cannot be passed to process spawn env", () => {
		expect(
			filterProcessEnv({
				GOOD: "value",
				EMPTY: "",
				"BAD=NAME": "value",
				BAD_VALUE: "before\0after",
				MISSING: undefined,
			}),
		).toEqual({
			GOOD: "value",
			EMPTY: "",
		});
	});

	it("preserves Windows-style variable names containing parentheses", () => {
		// `ProgramFiles(x86)` and friends are standard on Windows and must
		// survive the scrub so Git Bash discovery in procmgr.ts can resolve
		// 32-bit Program Files installations.
		expect(
			filterProcessEnv({
				"ProgramFiles(x86)": "C:\\Program Files (x86)",
				"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
			}),
		).toEqual({
			"ProgramFiles(x86)": "C:\\Program Files (x86)",
			"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
		});
	});
});
