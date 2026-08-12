import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { escapeXmlText, sanitizeText } from "@oh-my-pi/pi-utils";
import {
	allocateIpythonHostArtifact,
	finalizeIpythonHostArtifacts,
	spillIpythonCellArtifacts,
} from "../ipython/artifacts";
import { type IpythonCellRequest, type IpythonCellResult, IpythonCellService } from "../ipython/cell";
import type {
	IpythonExtensionHostHandlerResolver,
	IpythonHostHandlers,
	IpythonProcessIds,
	IpythonRestoreResult,
	IpythonSnapshotResult,
} from "../ipython/controller";
import { createIpythonCellText } from "../ipython/projection";
import { IpythonKernelProvisioner, type IpythonReadyStatus, ipythonSnapshotPath } from "../ipython/provisioner";
import type { PythonSkillPackage } from "../ipython/python-packages";
import { snapshotManifestPath } from "../ipython/state-snapshot";
import { sessionSidecarDir } from "./session-paths";

export const IPYTHON_STATE_MESSAGE_TYPE = "ipython-state";

const STATE_NOTICE_MAX_BYTES = 2 * 1024;
const STATE_NOTICE_MAX_NAMES = 100;

export type IpythonRestoreStatus = "complete" | "partial" | "missing" | "failed";

export interface IpythonSessionIdentity {
	readonly sessionId: string;
	readonly cwd: string;
	readonly sessionFile: string | undefined;
	readonly sessionDir: string;
}

export interface IpythonSessionGenerationOptions {
	readonly identity: IpythonSessionIdentity;
	readonly sidecarDir: string;
	readonly snapshotPath: string;
	readonly restorePath: string | null | undefined;
	readonly ephemeralSidecar: boolean;
	readonly pythonPackages: readonly PythonSkillPackage[];
	readonly hostHandlers: IpythonHostHandlers;
	readonly extensionHostHandlerResolver?: IpythonExtensionHostHandlerResolver;
	readonly extensionHostOperations?: () => readonly string[];
	readonly onRestore: (result: IpythonRestoreResult) => void;
	readonly onReady: (processIds: IpythonProcessIds, status: IpythonReadyStatus) => void;
}

export interface IpythonSessionGeneration {
	readonly service: IpythonCellService;
	readonly processIds: IpythonProcessIds | undefined;
	prewarm(): void;
	ready(): Promise<void>;
	flushSnapshot(pathOverride?: string): Promise<IpythonSnapshotResult | undefined>;
	reloadPythonPackages?(packages: readonly PythonSkillPackage[]): Promise<void>;
	dispose(): Promise<void>;
}

export type IpythonSessionGenerationFactory = (options: IpythonSessionGenerationOptions) => IpythonSessionGeneration;

export interface IpythonSessionRuntimeOptions {
	readonly snapshotDrainTimeoutMs?: number;
	readonly pythonPackages?: () => readonly PythonSkillPackage[];
	readonly hostHandlers?: () => IpythonHostHandlers;
	readonly extensionHostHandlerResolver?: IpythonExtensionHostHandlerResolver;
	readonly extensionHostOperations?: () => readonly string[];
}

export interface IpythonSessionRuntimeHost {
	currentIdentity(): IpythonSessionIdentity;
	onRestore(result: IpythonRestoreResult, status: IpythonRestoreStatus): void;
	onSnapshotFailure(message: string): void;
	onArtifactFailure(message: string): void;
	onReady(processIds: IpythonProcessIds, status: IpythonReadyStatus): void;
}

interface ActiveGeneration {
	readonly generation: IpythonSessionGeneration;
	readonly identity: IpythonSessionIdentity;
	readonly sidecarDir: string;
	readonly ephemeralSidecar: boolean;
	requestedSnapshot: number;
	flushedSnapshot: number;
	snapshotTask: Promise<void> | undefined;
	lastSnapshot: IpythonSnapshotResult | undefined;
	lastSnapshotError: string | undefined;
}

class DefaultIpythonSessionGeneration implements IpythonSessionGeneration {
	readonly #provisioner: IpythonKernelProvisioner;
	readonly service: IpythonCellService;

	constructor(options: IpythonSessionGenerationOptions) {
		this.#provisioner = new IpythonKernelProvisioner({
			cwd: options.identity.cwd,
			sessionId: options.identity.sessionId,
			sidecarDir: options.sidecarDir,
			snapshotPath: options.snapshotPath,
			restorePath: options.restorePath,
			pythonPackages: options.pythonPackages,
			hostHandlers: options.hostHandlers,
			extensionHostHandlerResolver: options.extensionHostHandlerResolver,
			extensionHostOperations: options.extensionHostOperations,
			onRestore: options.onRestore,
			onReady: options.onReady,
		});
		this.service = new IpythonCellService(this.#provisioner, {
			sessionId: options.identity.sessionId,
			cwd: options.identity.cwd,
			allocateArtifact: (request, signal, cellId) =>
				allocateIpythonHostArtifact(options.sidecarDir, cellId, request, signal),
		});
	}

	get processIds(): IpythonProcessIds | undefined {
		return this.#provisioner.processIds;
	}

	prewarm(): void {
		this.#provisioner.prewarm();
	}

	async ready(): Promise<void> {
		await this.#provisioner.ensure();
	}

	flushSnapshot(pathOverride?: string): Promise<IpythonSnapshotResult | undefined> {
		return this.#provisioner.flushSnapshot(pathOverride);
	}

	reloadPythonPackages(packages: readonly PythonSkillPackage[]): Promise<void> {
		return this.#provisioner.reloadPythonPackages(packages);
	}

	dispose(): Promise<void> {
		return this.service.dispose();
	}
}

export function classifyIpythonRestore(result: IpythonRestoreResult): IpythonRestoreStatus {
	if (result.missing) return "missing";
	if (result.failed.length === 0) return "complete";
	return result.restored.length > 0 ? "partial" : "failed";
}

export function formatIpythonRestoreNotice(result: IpythonRestoreResult): {
	readonly level: "info" | "warning";
	readonly message: string;
} {
	const status = classifyIpythonRestore(result);
	if (status === "missing")
		return { level: "info", message: "IPython state was not present; the session started fresh." };
	if (status === "complete") {
		return {
			level: "info",
			message: `IPython state restored ${result.restored.length} admitted name${result.restored.length === 1 ? "" : "s"}.`,
		};
	}
	if (status === "partial") {
		return {
			level: "warning",
			message: `IPython state restored ${result.restored.length} admitted name${result.restored.length === 1 ? "" : "s"}; ${result.failed.length} failed.`,
		};
	}
	return {
		level: "warning",
		message: `IPython state could not be restored (${result.failed.length} failure${result.failed.length === 1 ? "" : "s"}); the session started fresh.`,
	};
}

function sidecarFor(identity: IpythonSessionIdentity): { sidecarDir: string; ephemeral: boolean } {
	if (identity.sessionFile) return { sidecarDir: sessionSidecarDir(identity.sessionFile), ephemeral: false };
	return {
		sidecarDir: path.join(os.tmpdir(), "omp-ipython-sessions", identity.sessionId),
		ephemeral: true,
	};
}

export function ipythonCheckpointSnapshotPath(sidecarDir: string, checkpointId: string): string {
	const digest = new Bun.CryptoHasher("sha256").update(checkpointId).digest("hex");
	return path.join(sidecarDir, "ipython", "checkpoints", `${digest}.dill`);
}

async function removeSnapshot(snapshotPath: string): Promise<void> {
	const manifestPath = snapshotManifestPath(snapshotPath);
	await Promise.all(
		[snapshotPath, manifestPath, `${snapshotPath}.tmp`, `${manifestPath}.tmp`].map(candidate =>
			fsp.rm(candidate, { force: true }),
		),
	);
}

export function formatIpythonStateNotice(snapshot: IpythonSnapshotResult, maxBytes = STATE_NOTICE_MAX_BYTES): string {
	const sanitizeName = (name: string) =>
		escapeXmlText(sanitizeText(name).replaceAll("\n", "\\n").replaceAll("\t", "\\t"));
	const saved = new Set(snapshot.saved);
	const pins = [...(snapshot.pins ?? [])].filter(name => saved.has(name)).sort();
	const pinned = new Set(pins);
	const latest = [...(snapshot.latestScratch ?? [])].filter(name => saved.has(name) && !pinned.has(name)).sort();
	const latestNames = new Set(latest);
	const otherSaved = snapshot.saved.filter(name => !pinned.has(name) && !latestNames.has(name)).length;
	const omittedValues = snapshot.skipped.length + snapshot.oversized.length;
	const failures = snapshot.failed.length;
	const partial = omittedValues > 0 || failures > 0;
	const header = partial ? '<ipython_state status="partial">' : "<ipython_state>";
	const footer = "</ipython_state>";
	const summary = `Other saved: ${otherSaved}; omitted: ${omittedValues}; failures: ${failures}.`;
	const includedPins: string[] = [];
	const includedLatest: string[] = [];
	const render = (): string => {
		const pinOmitted = pins.length - includedPins.length;
		const latestOmitted = latest.length - includedLatest.length;
		const pinText = includedPins.length > 0 ? includedPins.join(", ") : "(none)";
		const latestText = includedLatest.length > 0 ? includedLatest.join(", ") : "(none)";
		return [
			header,
			`Pins: ${pinText}${pinOmitted > 0 ? ` (${pinOmitted} omitted)` : ""}`,
			`Latest delta: ${latestText}${latestOmitted > 0 ? ` (${latestOmitted} omitted)` : ""}`,
			summary,
			footer,
		].join("\n");
	};
	for (const name of pins.slice(0, STATE_NOTICE_MAX_NAMES)) {
		includedPins.push(sanitizeName(name));
		if (Buffer.byteLength(render(), "utf-8") > maxBytes) includedPins.pop();
	}
	for (const name of latest.slice(0, STATE_NOTICE_MAX_NAMES)) {
		includedLatest.push(sanitizeName(name));
		if (Buffer.byteLength(render(), "utf-8") > maxBytes) includedLatest.pop();
	}
	return render();
}

/** Owns the lazy IPython generation that follows one AgentSession identity at a time. */
export class IpythonSessionRuntime {
	readonly #host: IpythonSessionRuntimeHost;
	readonly #createGeneration: IpythonSessionGenerationFactory;
	readonly #snapshotDrainTimeoutMs: number;
	#pythonPackages: readonly PythonSkillPackage[];
	readonly #hostHandlers: () => IpythonHostHandlers;
	readonly #extensionHostHandlerResolver: IpythonExtensionHostHandlerResolver;
	readonly #extensionHostOperations: () => readonly string[];
	readonly #checkpointTasks = new Map<string, Promise<IpythonSnapshotResult | undefined>>();
	readonly #availableCheckpoints = new Set<string>();
	#active: ActiveGeneration | undefined;
	#nextRestorePath: string | null | undefined;
	#suspended = false;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(
		host: IpythonSessionRuntimeHost,
		createGeneration?: IpythonSessionGenerationFactory,
		options: IpythonSessionRuntimeOptions = {},
	) {
		this.#host = host;
		this.#createGeneration =
			createGeneration ?? (generationOptions => new DefaultIpythonSessionGeneration(generationOptions));
		this.#snapshotDrainTimeoutMs = options.snapshotDrainTimeoutMs ?? 5_000;
		this.#pythonPackages = [...(options.pythonPackages?.() ?? [])];
		this.#hostHandlers = options.hostHandlers ?? (() => ({}));
		this.#extensionHostHandlerResolver = options.extensionHostHandlerResolver ?? (() => undefined);
		this.#extensionHostOperations = options.extensionHostOperations ?? (() => []);
		if (!Number.isSafeInteger(this.#snapshotDrainTimeoutMs) || this.#snapshotDrainTimeoutMs < 0) {
			throw new RangeError("IPython snapshot drain timeout must be a non-negative integer");
		}
	}

	get processIds(): IpythonProcessIds | undefined {
		return this.#active?.generation.processIds;
	}

	get sessionId(): string | undefined {
		return this.#active?.identity.sessionId;
	}

	get sidecarDir(): string | undefined {
		return this.#active?.sidecarDir;
	}

	prewarm(): void {
		if (this.#disposed || this.#suspended) return;
		const identity = this.#host.currentIdentity();
		const { sidecarDir } = sidecarFor(identity);
		const restorePath = this.#nextRestorePath === undefined ? ipythonSnapshotPath(sidecarDir) : this.#nextRestorePath;
		if (restorePath === null || !fs.existsSync(restorePath)) return;
		this.#getOrCreate(identity).generation.prewarm();
	}

	async execute(request: IpythonCellRequest): Promise<IpythonCellResult> {
		if (this.#disposed) throw new Error("Session IPython runtime is disposed");
		if (this.#suspended) throw new Error("Session IPython runtime is suspended for a session transition");
		const active = this.#getOrCreate(this.#host.currentIdentity());
		const result = await active.generation.service.execute(request);
		if (result.status === "ok") this.#requestSnapshot(active);
		try {
			const hostArtifacts = await finalizeIpythonHostArtifacts(result.artifacts, active.sidecarDir);
			const finalized = { ...result, artifacts: hostArtifacts };
			const artifacts = await spillIpythonCellArtifacts(finalized, active.sidecarDir);
			const fullResult = [...hostArtifacts, ...artifacts].find(artifact => artifact.label === "Full IPython result");
			const modelText =
				fullResult && !finalized.modelText.text.startsWith("[Full IPython output:")
					? createIpythonCellText(
							finalized.events,
							finalized.errors,
							finalized.status,
							finalized.modelText.outputBytes,
							fullResult.path,
						)
					: finalized.modelText;
			const projected = {
				...finalized,
				artifacts: [...hostArtifacts, ...artifacts],
				modelText,
			};
			if (!modelText.truncated) return projected;
			return {
				...projected,
				stdout: "",
				stderr: "",
				result: undefined,
				events: projected.events.filter(event => event.kind === "host_operation" || event.kind === "host_progress"),
				errors: [],
				updates: projected.updates.filter(
					update =>
						update.kind !== "execution" ||
						update.event.kind === "host_operation" ||
						update.event.kind === "host_progress",
				),
			};
		} catch (error) {
			const detail = sanitizeText(error instanceof Error ? error.message : String(error)).slice(0, 1_024);
			this.#host.onArtifactFailure(detail);
			const removals = await Promise.allSettled(
				result.artifacts.map(artifact => fsp.rm(artifact.path, { force: true })),
			);
			const removalFailed = removals.some(removal => removal.status === "rejected");
			const text = `IPython output artifact failed${removalFailed ? "; cleanup also failed" : ""}.\n`;
			const structured = {
				kind: "error" as const,
				ename: "ArtifactError",
				evalue: text.trim(),
				traceback: [] as string[],
			};
			const events = result.events.filter(
				event => event.kind === "host_operation" || event.kind === "host_progress",
			);
			const updates = result.updates.filter(
				update =>
					update.kind !== "execution" ||
					update.event.kind === "host_operation" ||
					update.event.kind === "host_progress",
			);
			return {
				...result,
				status: "error",
				stdout: "",
				stderr: "",
				result: undefined,
				events: [...events, structured],
				errors: [structured],
				updates,
				artifacts: [],
				modelText: {
					text,
					truncated: false,
					totalLines: 1,
					totalBytes: Buffer.byteLength(text, "utf8"),
					outputBytes: Buffer.byteLength(text, "utf8"),
				},
			};
		}
	}

	async reloadPythonPackages(packages: readonly PythonSkillPackage[]): Promise<void> {
		if (this.#disposed) throw new Error("Session IPython runtime is disposed");
		const nextPackages = [...packages];
		const active = this.#active;
		if (!active) {
			this.#pythonPackages = nextPackages;
			return;
		}
		if (!active.generation.reloadPythonPackages)
			throw new Error("IPython generation does not support Python package reload");
		await active.generation.reloadPythonPackages(nextPackages);
		this.#pythonPackages = nextPackages;
	}

	async waitForIdle(): Promise<void> {
		await this.#active?.generation.service.waitForIdle();
	}

	abort(reason: unknown = new Error("Session IPython cells aborted")): void {
		this.#active?.generation.service.abort(reason);
	}

	async flushSnapshot(): Promise<IpythonSnapshotResult | undefined> {
		const active = this.#active;
		if (!active) return undefined;
		this.#requestSnapshot(active);
		await this.#waitForSnapshots(active);
		return active.lastSnapshot;
	}

	async stateNotice(): Promise<string | undefined> {
		const active = this.#active;
		const snapshot = await this.flushSnapshot();
		if (active?.lastSnapshotError) {
			return '<ipython_state status="failed">\nThe live kernel remains active, but admitted names could not be listed.\n</ipython_state>';
		}
		return snapshot ? formatIpythonStateNotice(snapshot) : undefined;
	}

	createCheckpoint(checkpointId: string): Promise<IpythonSnapshotResult | undefined> {
		if (this.#disposed || this.#suspended) return Promise.resolve(undefined);
		const existing = this.#checkpointTasks.get(checkpointId);
		if (existing) return existing;
		const task = this.#createCheckpoint(checkpointId);
		this.#checkpointTasks.set(checkpointId, task);
		const settled = () => {
			if (this.#checkpointTasks.get(checkpointId) === task) this.#checkpointTasks.delete(checkpointId);
		};
		void task.then(settled, settled);
		return task;
	}

	async rewindCheckpoint(checkpointId: string): Promise<void> {
		await this.#checkpointTasks.get(checkpointId)?.catch(() => undefined);
		const identity = this.#host.currentIdentity();
		const { sidecarDir } = sidecarFor(identity);
		const checkpointPath = ipythonCheckpointSnapshotPath(sidecarDir, checkpointId);
		const available = this.#availableCheckpoints.has(checkpointId) || fs.existsSync(checkpointPath);
		await this.suspend();
		this.#nextRestorePath = available ? checkpointPath : null;
		this.resume();
		if (!available) return;
		await this.#getOrCreate(this.#host.currentIdentity()).generation.ready();
		this.#availableCheckpoints.delete(checkpointId);
	}

	async abandonHistoricalState(): Promise<void> {
		if (!this.#suspended) throw new Error("Historical IPython state can only be abandoned while suspended");
		this.#nextRestorePath = null;
		this.#availableCheckpoints.clear();
		const { sidecarDir } = sidecarFor(this.#host.currentIdentity());
		await Promise.all([
			removeSnapshot(ipythonSnapshotPath(sidecarDir)),
			fsp.rm(path.join(sidecarDir, "ipython", "checkpoints"), { recursive: true, force: true }),
		]);
	}

	async suspend(): Promise<void> {
		if (this.#suspended) return;
		this.#suspended = true;
		const active = this.#active;
		this.#active = undefined;
		this.#availableCheckpoints.clear();
		active?.generation.service.abort(new Error("Session transition interrupted IPython cells"));
		await this.#drainSnapshotWork(active);
		if (!active) return;
		await active.generation.dispose();
		if (active.ephemeralSidecar) await fsp.rm(active.sidecarDir, { recursive: true, force: true });
	}

	resume(): void {
		if (!this.#disposed) {
			this.#suspended = false;
			this.prewarm();
		}
	}

	beginDispose(): void {
		this.#disposed = true;
		this.abort(new Error("Session IPython runtime disposed"));
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.beginDispose();
		this.#disposePromise = this.#disposeInternal();
		return this.#disposePromise;
	}

	async #drainSnapshotWork(active: ActiveGeneration | undefined): Promise<void> {
		const work = Promise.allSettled([
			this.#waitForCheckpointTasks(),
			active ? this.#waitForSnapshots(active) : Promise.resolve(),
		]);
		const timeout = Promise.withResolvers<false>();
		const timer = setTimeout(() => timeout.resolve(false), this.#snapshotDrainTimeoutMs);
		timer.unref();
		const completed = await Promise.race([work.then(() => true as const), timeout.promise]);
		clearTimeout(timer);
		if (!completed) {
			this.#host.onSnapshotFailure(
				`Timed out draining IPython snapshots after ${this.#snapshotDrainTimeoutMs}ms; continuing shutdown.`,
			);
		}
	}

	async #createCheckpoint(checkpointId: string): Promise<IpythonSnapshotResult | undefined> {
		const active = this.#active;
		if (!active) return undefined;
		await this.#waitForSnapshots(active);
		const checkpointPath = ipythonCheckpointSnapshotPath(active.sidecarDir, checkpointId);
		try {
			const snapshot = await active.generation.flushSnapshot(checkpointPath);
			const rootFailure = snapshot?.failed.find(issue => issue.name === "<snapshot>");
			if (rootFailure) this.#host.onSnapshotFailure(`Checkpoint ${checkpointId}: ${rootFailure.reason}`);
			else if (snapshot) this.#availableCheckpoints.add(checkpointId);
			return snapshot;
		} catch (error) {
			const failure = error instanceof Error ? error.message : String(error);
			this.#host.onSnapshotFailure(`Checkpoint ${checkpointId}: ${failure}`);
			throw error;
		}
	}

	async #waitForCheckpointTasks(): Promise<void> {
		while (this.#checkpointTasks.size > 0) {
			await Promise.allSettled([...this.#checkpointTasks.values()]);
		}
	}

	async #disposeInternal(): Promise<void> {
		const active = this.#active;
		this.#active = undefined;
		this.#availableCheckpoints.clear();
		active?.generation.service.abort(new Error("Session IPython runtime disposed"));
		await this.#drainSnapshotWork(active);
		if (!active) return;
		await active.generation.dispose();
		if (active.ephemeralSidecar) await fsp.rm(active.sidecarDir, { recursive: true, force: true });
	}

	#getOrCreate(identity: IpythonSessionIdentity): ActiveGeneration {
		const current = this.#active;
		if (current) {
			if (
				current.identity.sessionId !== identity.sessionId ||
				current.identity.cwd !== identity.cwd ||
				current.identity.sessionFile !== identity.sessionFile ||
				current.identity.sessionDir !== identity.sessionDir
			) {
				throw new Error("Session IPython identity changed without suspending its previous generation");
			}
			return current;
		}
		const { sidecarDir, ephemeral } = sidecarFor(identity);
		const restorePath = this.#nextRestorePath;
		const options: IpythonSessionGenerationOptions = {
			identity,
			sidecarDir,
			snapshotPath: ipythonSnapshotPath(sidecarDir),
			restorePath,
			ephemeralSidecar: ephemeral,
			pythonPackages: this.#pythonPackages,
			hostHandlers: this.#hostHandlers(),
			extensionHostHandlerResolver: this.#extensionHostHandlerResolver,
			extensionHostOperations: this.#extensionHostOperations,
			onRestore: result => this.#host.onRestore(result, classifyIpythonRestore(result)),
			onReady: (processIds, status) => this.#host.onReady(processIds, status),
		};
		const generation = this.#createGeneration(options);
		this.#nextRestorePath = undefined;
		const active: ActiveGeneration = {
			generation,
			identity,
			sidecarDir,
			ephemeralSidecar: ephemeral,
			requestedSnapshot: 0,
			flushedSnapshot: 0,
			snapshotTask: undefined,
			lastSnapshot: undefined,
			lastSnapshotError: undefined,
		};
		this.#active = active;
		return active;
	}

	#requestSnapshot(active: ActiveGeneration): void {
		active.requestedSnapshot += 1;
		this.#startSnapshotTask(active);
	}

	#startSnapshotTask(active: ActiveGeneration): void {
		if (active.snapshotTask) return;
		const task = this.#drainSnapshots(active);
		active.snapshotTask = task;
		const settled = () => {
			if (active.snapshotTask === task) active.snapshotTask = undefined;
			if (active.requestedSnapshot > active.flushedSnapshot) this.#startSnapshotTask(active);
		};
		void task.then(settled, settled);
	}

	async #waitForSnapshots(active: ActiveGeneration, target = active.requestedSnapshot): Promise<void> {
		while (active.flushedSnapshot < target) {
			this.#startSnapshotTask(active);
			await active.snapshotTask;
		}
	}

	async #drainSnapshots(active: ActiveGeneration): Promise<void> {
		while (active.flushedSnapshot < active.requestedSnapshot) {
			const target = active.requestedSnapshot;
			try {
				const snapshot = await active.generation.flushSnapshot();
				if (snapshot) {
					active.lastSnapshot = snapshot;
					const rootFailure = snapshot.failed.find(issue => issue.name === "<snapshot>");
					const failure = rootFailure?.reason;
					if (failure && failure !== active.lastSnapshotError) this.#host.onSnapshotFailure(failure);
					active.lastSnapshotError = failure;
				}
			} catch (error) {
				const failure = error instanceof Error ? error.message : String(error);
				if (failure !== active.lastSnapshotError) this.#host.onSnapshotFailure(failure);
				active.lastSnapshotError = failure;
			}
			active.flushedSnapshot = target;
		}
	}
}
