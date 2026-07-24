import * as fs from "node:fs";
import * as path from "node:path";

export const SESSION_STEERING_FILE_NAME = "steer.jsonl";
export const SESSION_STEERING_OFFSET_FILE_NAME = "steer.offset";

export interface SessionSteeringRecord {
	message: string;
	timestamp?: string;
	/** Start a turn when the session is idle, matching cron injection semantics.
	 *  Without it a drained record waits in the steering queue for the next
	 *  externally started turn. */
	triggerTurn?: boolean;
}

export interface DrainedSteeringRecord {
	message: string;
	offset: number;
	bytes: number;
	triggerTurn: boolean;
}

export interface SessionSteeringDrainResult {
	file: string;
	offset: number;
	records: DrainedSteeringRecord[];
}

export interface SessionSteeringWatcherOptions {
	sessionFile: string;
	onRecords: (records: DrainedSteeringRecord[], result: SessionSteeringDrainResult) => Promise<void> | void;
	onError?: (error: unknown) => void;
}

const textEncoder = new TextEncoder();

function parseOffset(value: string): number {
	const offset = Number.parseInt(value.trim(), 10);
	return Number.isFinite(offset) && offset >= 0 ? offset : 0;
}

function parseRecord(line: string): { message: string; triggerTurn: boolean } | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	const value = JSON.parse(trimmed) as SessionSteeringRecord;
	if (!value || typeof value !== "object" || typeof value.message !== "string") {
		throw new Error("steering entry must be a JSON object with a string message");
	}
	const message = value.message.trim();
	if (!message) return undefined;
	return { message, triggerTurn: value.triggerTurn === true };
}

export function sessionSteeringDirForSessionFile(sessionFile: string): string {
	return sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : `${sessionFile}.d`;
}

export function sessionSteeringFileForSessionFile(sessionFile: string): string {
	return path.join(sessionSteeringDirForSessionFile(sessionFile), SESSION_STEERING_FILE_NAME);
}

export function sessionSteeringOffsetFileForSessionFile(sessionFile: string): string {
	return path.join(sessionSteeringDirForSessionFile(sessionFile), SESSION_STEERING_OFFSET_FILE_NAME);
}

export function readSessionSteeringOffset(offsetFile: string): number {
	try {
		return parseOffset(fs.readFileSync(offsetFile, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

export function writeSessionSteeringOffset(offsetFile: string, offset: number): void {
	fs.mkdirSync(path.dirname(offsetFile), { recursive: true });
	fs.writeFileSync(offsetFile, `${Math.max(0, Math.trunc(offset))}\n`);
}

export function drainSessionSteeringFile(sessionFile: string): SessionSteeringDrainResult {
	const steeringFile = sessionSteeringFileForSessionFile(sessionFile);
	const offsetFile = sessionSteeringOffsetFileForSessionFile(sessionFile);
	let offset = readSessionSteeringOffset(offsetFile);
	let content: string;
	try {
		const stat = fs.statSync(steeringFile);
		if (!stat.isFile()) return { file: steeringFile, offset, records: [] };
		if (offset > stat.size) offset = 0;
		const fd = fs.openSync(steeringFile, "r");
		try {
			const bytesToRead = stat.size - offset;
			if (bytesToRead <= 0) return { file: steeringFile, offset, records: [] };
			const buffer = Buffer.allocUnsafe(bytesToRead);
			const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
			content = buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: steeringFile, offset, records: [] };
		throw error;
	}

	const lineEndIndex = content.lastIndexOf("\n");
	if (lineEndIndex < 0) return { file: steeringFile, offset, records: [] };
	const completeContent = content.slice(0, lineEndIndex + 1);
	const records: DrainedSteeringRecord[] = [];
	let cursor = offset;
	let start = 0;
	while (start < completeContent.length) {
		const newline = completeContent.indexOf("\n", start);
		const line = completeContent.slice(start, newline);
		const bytes = textEncoder.encode(completeContent.slice(start, newline + 1)).byteLength;
		const parsed = parseRecord(line);
		if (parsed) records.push({ message: parsed.message, triggerTurn: parsed.triggerTurn, offset: cursor, bytes });
		cursor += bytes;
		start = newline + 1;
	}
	return { file: steeringFile, offset: cursor, records };
}

export class SessionSteeringWatcher {
	#watcher: fs.FSWatcher | undefined;
	#disposed = false;
	#drainTail: Promise<void> = Promise.resolve();
	readonly #sessionFile: string;
	readonly #onRecords: SessionSteeringWatcherOptions["onRecords"];
	readonly #onError: ((error: unknown) => void) | undefined;

	constructor(options: SessionSteeringWatcherOptions) {
		this.#sessionFile = options.sessionFile;
		this.#onRecords = options.onRecords;
		this.#onError = options.onError;
	}

	start(): void {
		const steeringDir = sessionSteeringDirForSessionFile(this.#sessionFile);
		fs.mkdirSync(steeringDir, { recursive: true });
		this.#scheduleDrain();
		this.#watcher = fs.watch(steeringDir, (_event, filename) => {
			if (this.#disposed) return;
			if (filename && filename.toString() !== SESSION_STEERING_FILE_NAME) return;
			this.#scheduleDrain();
		});
	}

	dispose(): void {
		this.#disposed = true;
		this.#watcher?.close();
		this.#watcher = undefined;
	}

	drain(): Promise<void> {
		this.#scheduleDrain();
		return this.flush();
	}
	flush(): Promise<void> {
		return this.#drainTail;
	}

	#scheduleDrain(): void {
		const run = async () => {
			if (this.#disposed) return;
			const result = drainSessionSteeringFile(this.#sessionFile);
			if (result.records.length === 0) return;
			await this.#onRecords(result.records, result);
			if (!this.#disposed)
				writeSessionSteeringOffset(sessionSteeringOffsetFileForSessionFile(this.#sessionFile), result.offset);
		};
		const scheduled = this.#drainTail.then(run, run).catch(error => this.#onError?.(error));
		this.#drainTail = scheduled.then(
			() => undefined,
			() => undefined,
		);
	}
}
