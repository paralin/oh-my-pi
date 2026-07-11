import * as fs from "node:fs";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BashTool, JobTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const [mode, root] = process.argv.slice(2);
if (!mode || !root) throw new Error("usage: durable-bash-job-process.ts <start|start-short|list|cancel> <root>");

const sessionFile = path.join(root, "session.jsonl");
const sessionDir = path.join(root, "session");
fs.mkdirSync(sessionDir, { recursive: true });
fs.closeSync(fs.openSync(sessionFile, "a"));

await Settings.init({ cwd: root, inMemory: true });
const settings = Settings.isolated({
	"async.enabled": true,
	"async.pollWaitDuration": "5s",
	"bash.autoBackground.enabled": false,
});
let manager: AsyncJobManager;
const session: ToolSession = {
	cwd: root,
	hasUI: false,
	settings,
	getSessionFile: () => sessionFile,
	getSessionId: () => "durable-bash-test-session",
	getAgentId: () => "Main",
	getSessionSpawns: () => "*",
	getArtifactsDir: () => sessionDir,
	allocateOutputArtifact: async () => ({
		id: "durable-bash-output",
		path: path.join(sessionDir, "durable-bash-output.log"),
	}),
	get asyncJobManager() {
		return manager;
	},
};

manager = new AsyncJobManager({ onJobComplete: async () => {} });
const bash = new BashTool(session);
const jobs = new JobTool(session);

if (mode === "start" || mode === "start-short") {
	const command =
		mode === "start"
			? "printf 'started\\n'; sleep 30; printf 'finished\\n'"
			: "printf 'started\\n'; sleep 0.1; printf 'finished\\n'";
	const result = await bash.execute(
		"start",
		{
			command,
			timeout: 0,
			async: true,
		},
		undefined,
	);
	console.log(JSON.stringify(result.details));
	await manager.dispose({ timeoutMs: 100 });
} else if (mode === "list") {
	const result = await jobs.execute("list", { list: true });
	console.log(
		JSON.stringify({
			text: result.content[0]?.type === "text" ? result.content[0].text : "",
			details: result.details,
		}),
	);
	await manager.dispose({ timeoutMs: 100 });
} else if (mode === "cancel") {
	const result = await jobs.execute("cancel", { cancel: ["bg_1"] });
	console.log(
		JSON.stringify({
			text: result.content[0]?.type === "text" ? result.content[0].text : "",
			details: result.details,
		}),
	);
	await manager.dispose({ timeoutMs: 100 });
} else {
	throw new Error(`unknown mode: ${mode}`);
}
