import * as fs from "node:fs";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { buildNonInteractiveEnv } from "../exec/non-interactive-env";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "../session/streaming-output";
import { resolveWorkerSpawnCmd } from "../subprocess/worker-client";

const DURABLE_BASH_VERSION = 1;
const JOB_ID_PATTERN = /^bg_[1-9]\d*$/;

export interface DurableBashMetadata {
	version: 1;
	id: string;
	ownerId?: string;
	command: string;
	cwd: string;
	pid: number;
	startTime: number;
	outputPath: string;
	artifactId?: string;
	statusPath: string;
	launchPath: string;
	token: string;
	timeoutMs?: number;
	requestedTimeoutSec?: number;
	notices?: string[];
}

export interface DurableBashStatus {
	exitCode?: number;
	cancelled?: boolean;
	timedOut?: boolean;
	error?: string;
	finishedAt: number;
}

export interface DurableBashOutput {
	output: string;
	truncated: boolean;
	totalBytes: number;
	totalLines: number;
}

interface DurableBashStartOptions {
	id: string;
	ownerId?: string;
	command: string;
	cwd: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	requestedTimeoutSec?: number;
	notices?: readonly string[];
	outputPath?: string;
	artifactId?: string;
	shellConfig: {
		shell: string;
		args: string[];
		env: Record<string, string>;
		prefix?: string;
	};
}

interface DurableBashLaunch {
	command: string;
	sourceCommand: string;
	cwd: string;
	shell: string;
	shellArgs: string[];
	outputPath: string;
	statusPath: string;
	startTime: number;
	timeoutMs?: number;
	token: string;
}

/** DurableBashJobStore owns detached bash process state for one persisted session. */
export class DurableBashJobStore {
	readonly #jobsDir: string;

	constructor(sessionFile: string) {
		this.#jobsDir = path.join(sessionFile.slice(0, -".jsonl".length), "jobs");
	}

	start(options: DurableBashStartOptions): DurableBashMetadata {
		fs.mkdirSync(this.#jobsDir, { recursive: true, mode: 0o700 });
		const startTime = Date.now();
		const token = crypto.randomUUID();
		const statusPath = path.join(this.#jobsDir, `${options.id}.status.json`);
		const launchPath = path.join(this.#jobsDir, `${options.id}.launch.json`);
		const outputPath = options.outputPath ?? path.join(this.#jobsDir, `${options.id}.output.log`);
		const command = options.shellConfig.prefix ? `${options.shellConfig.prefix} ${options.command}` : options.command;
		const launch: DurableBashLaunch = {
			command,
			sourceCommand: options.command,
			cwd: options.cwd,
			shell: options.shellConfig.shell,
			shellArgs: options.shellConfig.args,
			outputPath,
			statusPath,
			startTime,
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			token,
		};
		this.#writeJson(launchPath, launch);
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		fs.closeSync(fs.openSync(outputPath, "a", 0o600));

		const spawnCommand = resolveWorkerSpawnCmd("__omp_worker_durable_bash");
		const worker = Bun.spawn([...spawnCommand.cmd, launchPath, token], {
			cwd: spawnCommand.cwd ?? options.cwd,
			env: {
				...options.shellConfig.env,
				...buildNonInteractiveEnv(options.env, options.shellConfig.env),
			},
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});
		worker.unref();

		const metadata: DurableBashMetadata = {
			version: DURABLE_BASH_VERSION,
			id: options.id,
			...(options.ownerId ? { ownerId: options.ownerId } : {}),
			command: options.command,
			cwd: options.cwd,
			pid: worker.pid,
			startTime,
			outputPath,
			...(options.artifactId ? { artifactId: options.artifactId } : {}),
			statusPath,
			launchPath,
			token,
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			...(options.requestedTimeoutSec === undefined ? {} : { requestedTimeoutSec: options.requestedTimeoutSec }),
			...(options.notices?.length ? { notices: [...options.notices] } : {}),
		};
		this.#writeJson(path.join(this.#jobsDir, `${options.id}.json`), metadata);
		return metadata;
	}

	list(): DurableBashMetadata[] {
		let entries: string[];
		try {
			entries = fs.readdirSync(this.#jobsDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const jobs: DurableBashMetadata[] = [];
		for (const entry of entries.sort()) {
			if (!entry.endsWith(".json") || entry.endsWith(".status.json") || entry.endsWith(".launch.json")) continue;
			const metadata = this.#readJson<DurableBashMetadata>(path.join(this.#jobsDir, entry));
			if (!metadata || metadata.version !== DURABLE_BASH_VERSION || !JOB_ID_PATTERN.test(metadata.id)) continue;
			jobs.push(metadata);
		}
		return jobs;
	}

	readStatus(metadata: DurableBashMetadata): DurableBashStatus | undefined {
		return this.#readJson<DurableBashStatus>(metadata.statusPath);
	}

	readOutput(metadata: DurableBashMetadata): DurableBashOutput {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(metadata.outputPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { output: "", truncated: false, totalBytes: 0, totalLines: 0 };
			}
			throw error;
		}
		const readBytes = Math.min(stat.size, DEFAULT_MAX_BYTES * 2);
		const buffer = Buffer.allocUnsafe(readBytes);
		const fd = fs.openSync(metadata.outputPath, "r");
		try {
			fs.readSync(fd, buffer, 0, readBytes, stat.size - readBytes);
		} finally {
			fs.closeSync(fd);
		}
		const tail = truncateTail(buffer.toString("utf8"), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
		const truncated = stat.size > readBytes || tail.truncated === true;
		const artifactNotice =
			truncated && metadata.artifactId ? `\n\n[raw output: artifact://${metadata.artifactId}]` : "";
		return {
			output: `${tail.content}${artifactNotice}`,
			truncated,
			totalBytes: stat.size,
			totalLines: tail.totalLines,
		};
	}

	async wait(
		metadata: DurableBashMetadata,
		signal: AbortSignal,
		lifecycleSignal?: AbortSignal,
	): Promise<DurableBashStatus> {
		const completed = this.readStatus(metadata);
		if (completed) return completed;
		const processRef = this.#verifiedProcess(metadata);
		if (!processRef) {
			const status = {
				error: "Durable bash worker exited without recording status",
				finishedAt: Date.now(),
			} satisfies DurableBashStatus;
			this.#writeJson(metadata.statusPath, status);
			return status;
		}

		let cancellation: Promise<boolean> | undefined;
		const onAbort = (): void => {
			cancellation ??= this.cancel(metadata);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		try {
			const exited = await processRef.waitForExit({ signal: lifecycleSignal });
			if (!exited) throw new Error("Durable bash monitor detached");
			if (cancellation) await cancellation;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
		return this.readStatus(metadata) ?? { cancelled: true, finishedAt: Date.now() };
	}

	async cancel(metadata: DurableBashMetadata): Promise<boolean> {
		if (this.readStatus(metadata)) return false;
		const processRef = this.#verifiedProcess(metadata);
		if (!processRef) return false;
		await processRef.terminate({ gracefulMs: 1_000, timeoutMs: 3_000 });
		if (!this.readStatus(metadata)) {
			this.#writeJson(metadata.statusPath, { cancelled: true, finishedAt: Date.now() } satisfies DurableBashStatus);
		}
		return true;
	}

	#verifiedProcess(metadata: DurableBashMetadata): Process | undefined {
		const launch = this.#readJson<DurableBashLaunch>(metadata.launchPath);
		if (
			!launch ||
			launch.startTime !== metadata.startTime ||
			launch.token !== metadata.token ||
			launch.sourceCommand !== metadata.command
		) {
			return undefined;
		}
		const processRef = Process.fromPid(metadata.pid);
		if (!processRef || processRef.status() !== ProcessStatus.Running) return undefined;
		const args = processRef.args();
		if (!args.includes(metadata.token) || !args.includes(metadata.launchPath)) return undefined;
		return processRef;
	}

	#readJson<T>(filePath: string): T | undefined {
		try {
			return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			return undefined;
		}
	}

	#writeJson(filePath: string, value: unknown): void {
		const tempPath = `${filePath}.${process.pid}.tmp`;
		fs.writeFileSync(tempPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		fs.renameSync(tempPath, filePath);
	}
}
