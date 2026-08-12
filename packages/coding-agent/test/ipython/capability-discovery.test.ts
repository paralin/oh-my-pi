import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IPYTHON_PYTHON_ASSETS } from "../../src/ipython/python-assets.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

test("cold bundled Python assets search and describe indexed capabilities without a model", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-capability-discovery-"));
	roots.push(root);
	for (const asset of IPYTHON_PYTHON_ASSETS) {
		await Bun.write(path.join(root, asset.path), asset.content);
	}
	await fs.rm(path.join(root, "rlm"), { recursive: true, force: true });
	await Bun.write(
		path.join(root, "rlm.py"),
		"async def host_request(kind, data=None):\n    return {}\nharness = object()\n",
	);
	const python = Bun.which("python3");
	if (!python) throw new Error("python3 is required for bundled capability discovery");
	const child = Bun.spawn(
		[
			python,
			"-c",
			[
				"import json",
				"import omp",
				"assert omp.capabilities() == omp.capabilities('')",
				"assert [item.name for item in omp.capabilities('WeB')] == ['websearch', 'omp.web']",
				"detail = omp.describe('omp.web')",
				"assert detail is not None",
				"calls = {call.name: call for call in detail.calls}",
				"assert detail.category == 'host'",
				"assert detail.summary == 'Search and extract web resources through host-owned providers.'",
				"assert calls['search'].is_async",
				"assert 'query' in calls['search'].signature",
				"assert calls['search'].documentation == \"Search through the session's configured provider chain.\"",
				"skill = omp.describe('edit')",
				"assert skill is not None and skill.category == 'skill' and skill.skill_path and skill.skill_path.is_file()",
				"assert any(call.name == 'run' and call.is_async for call in skill.calls)",
				"debug = omp.describe('omp.debug')",
				"assert debug is not None and len(debug.calls) == 16 and debug.omitted_calls > 0",
				"assert omp.describe('missing') is None",
				"assert not hasattr(omp.process, 'run')",
				"print(json.dumps({'web': [call.name for call in detail.calls], 'skill_path': str(skill.skill_path), 'debug_omitted': debug.omitted_calls}))",
			].join("\n"),
		],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	expect(JSON.parse(stdout)).toEqual({
		web: ["fetch", "scrape", "search"],
		skill_path: await fs.realpath(path.join(root, "skills", "edit", "SKILL.md")),
		debug_omitted: 15,
	});
});
