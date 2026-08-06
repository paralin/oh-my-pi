import * as fs from "node:fs/promises";
import * as path from "node:path";
import { capturePreIpythonPromptBaseline } from "../test/ipython/prompt-baseline-fixture";

const report = await capturePreIpythonPromptBaseline();
const json = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes("--write")) {
	const target = path.resolve(import.meta.dir, "../test/ipython/fixtures/pre-ipython-provider-baseline.json");
	await fs.mkdir(path.dirname(target), { recursive: true });
	await Bun.write(target, json);
	console.error(`Wrote ${target}`);
} else {
	process.stdout.write(json);
}
