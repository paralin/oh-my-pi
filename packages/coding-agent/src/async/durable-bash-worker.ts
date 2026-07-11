import * as fs from "node:fs";
import { Process } from "@oh-my-pi/pi-natives";

interface DurableBashLaunch {
	command: string;
	cwd: string;
	shell: string;
	shellArgs: string[];
	outputPath: string;
	statusPath: string;
	startTime: number;
	timeoutMs?: number;
	token: string;
}

interface DurableBashStatus {
	exitCode?: number;
	cancelled?: boolean;
	timedOut?: boolean;
	finishedAt: number;
}

/** Run one detached durable bash command and persist its terminal status. */
export async function runDurableBashWorker(args: readonly string[]): Promise<void> {
	const [launchPath, token] = args;
	if (!launchPath || !token) throw new Error("missing durable bash launch identity");

	const launch = JSON.parse(fs.readFileSync(launchPath, "utf8")) as DurableBashLaunch;
	if (launch.token !== token) throw new Error("durable bash launch identity mismatch");
	const writeStatus = (status: DurableBashStatus): void => {
		const tempPath = `${launch.statusPath}.${process.pid}.tmp`;
		fs.writeFileSync(tempPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
		fs.renameSync(tempPath, launch.statusPath);
	};

	const output = fs.openSync(launch.outputPath, "a", 0o600);
	const child = Bun.spawn([launch.shell, ...launch.shellArgs, launch.command], {
		cwd: launch.cwd,
		env: process.env,
		stdin: "ignore",
		stdout: output,
		stderr: output,
	});
	fs.closeSync(output);

	let terminal: "cancelled" | "timedOut" | undefined;
	let stopping: Promise<void> | undefined;
	const stop = (reason: "cancelled" | "timedOut"): Promise<void> => {
		if (stopping) return stopping;
		terminal = reason;
		stopping = (async () => {
			const processRef = Process.fromPid(child.pid);
			await processRef?.terminate({ gracefulMs: 1_000, timeoutMs: 2_000 });
		})();
		return stopping;
	};
	const onSignal = (): void => {
		void stop("cancelled");
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const timeout =
		launch.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					void stop("timedOut");
				}, launch.timeoutMs);
	timeout?.unref();

	const exitCode = await child.exited;
	if (stopping) await stopping;
	clearTimeout(timeout);
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
	writeStatus({
		...(terminal === "cancelled" ? { cancelled: true } : {}),
		...(terminal === "timedOut" ? { timedOut: true } : {}),
		...(terminal === undefined ? { exitCode } : {}),
		finishedAt: Date.now(),
	});
}
