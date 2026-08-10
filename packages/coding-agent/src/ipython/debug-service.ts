import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	DapSessionManager,
	getAvailableAdapters,
	resolveLaunchOverrides,
	selectAttachAdapter,
	selectLaunchAdapter,
} from "../dap";
import type {
	DapAttachSessionOptions,
	DapCapabilities,
	DapEvaluateArguments,
	DapLaunchSessionOptions,
	DapResolvedAdapter,
	DapSessionSummary,
} from "../dap/types";
import type { IpythonHostArtifact, IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_DEBUG_JSON_CHARS = 1024 * 1024;
const MAX_DEBUG_STRING = 1024 * 1024;
const MAX_DEBUG_ARRAY = 1_000;

export interface IpythonDebugManager {
	getActiveSession(): DapSessionSummary | null;
	listSessions(): DapSessionSummary[];
	getCapabilities(): DapCapabilities | null;
	launch(options: DapLaunchSessionOptions, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	attach(options: DapAttachSessionOptions, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	setBreakpoint(
		file: string,
		line: number,
		condition?: string,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<unknown>;
	removeBreakpoint(file: string, line: number, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	setFunctionBreakpoint(name: string, condition?: string, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	removeFunctionBreakpoint(name: string, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	setInstructionBreakpoint(
		instructionReference: string,
		offset?: number,
		condition?: string,
		hitCondition?: string,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<unknown>;
	removeInstructionBreakpoint(
		instructionReference: string,
		offset?: number,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<unknown>;
	dataBreakpointInfo(
		name: string,
		variablesReference?: number,
		frameId?: number,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<unknown>;
	setDataBreakpoint(
		dataId: string,
		accessType?: "read" | "write" | "readWrite",
		condition?: string,
		hitCondition?: string,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<unknown>;
	removeDataBreakpoint(dataId: string, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	continue(signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	pause(signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	stepOver(signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	stepIn(signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	stepOut(signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	threads(signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	stackTrace(levels?: number, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	scopes(frameId?: number, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	variables(variableReference: number, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	evaluate(
		expression: string,
		context: DapEvaluateArguments["context"],
		frameId: number | undefined,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<unknown>;
	getOutput(limitBytes?: number): unknown;
	disassemble(
		memoryReference: string,
		instructionCount: number,
		offset?: number,
		instructionOffset?: number,
		resolveSymbols?: boolean,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<unknown>;
	readMemory(
		memoryReference: string,
		count: number,
		offset?: number,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<unknown>;
	writeMemory(
		memoryReference: string,
		data: string,
		offset?: number,
		allowPartial?: boolean,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<unknown>;
	modules(startModule?: number, moduleCount?: number, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	loadedSources(signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	terminate(signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	dispose?(): Promise<void>;
}

export interface IpythonDebugServiceOptions {
	readonly cwd: () => string;
	readonly manager?: IpythonDebugManager;
	readonly availableAdapters?: (cwd: string) => DapResolvedAdapter[];
	readonly launchAdapter?: typeof selectLaunchAdapter;
	readonly attachAdapter?: typeof selectAttachAdapter;
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
	return value as Readonly<Record<string, unknown>>;
}

function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function stringValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	options: { optional?: boolean; max?: number } = {},
): string {
	const value = data[name];
	if (value === undefined && options.optional) return "";
	if (typeof value !== "string" || (!options.optional && value.trim().length === 0)) {
		throw new TypeError(`${name} must be ${options.optional ? "a string" : "a nonempty string"}`);
	}
	if (value.length > (options.max ?? 16_384)) throw new RangeError(`${name} is too large`);
	return value;
}

interface IntegerValueOptions {
	fallback?: number;
	min?: number;
	max?: number;
}

function integerValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	options: IntegerValueOptions & { optional: true },
): number | undefined;
function integerValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	options?: IntegerValueOptions & { optional?: false },
): number;
function integerValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	options: IntegerValueOptions & { optional?: boolean } = {},
): number | undefined {
	const value = data[name] ?? options.fallback;
	if (value === undefined && options.optional) return undefined;
	const min = options.min ?? 0;
	const max = options.max ?? Number.MAX_SAFE_INTEGER;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new RangeError(`${name} must be an integer from ${min} through ${max}`);
	}
	return value;
}

function booleanValue(data: Readonly<Record<string, unknown>>, name: string): boolean | undefined {
	const value = data[name];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
	return value;
}

function stringArray(data: Readonly<Record<string, unknown>>, name: string): string[] | undefined {
	const value = data[name];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_DEBUG_ARRAY || value.some(item => typeof item !== "string")) {
		throw new TypeError(`${name} must be an array of at most ${MAX_DEBUG_ARRAY} strings`);
	}
	return value;
}

async function canonicalExisting(rootInput: string, input: string): Promise<string> {
	const root = await fs.realpath(rootInput);
	const absolute = await fs.realpath(path.resolve(rootInput, input));
	const relative = path.relative(root, absolute);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return absolute;
	throw new RangeError(`path is outside the active workspace: ${input}`);
}

async function boundedResult(
	request: IpythonHostRequest,
	label: string,
	result: unknown,
): Promise<Readonly<Record<string, unknown>>> {
	const normalized = Array.isArray(result)
		? { items: result }
		: result && typeof result === "object"
			? record(result, "debug result")
			: { value: result ?? null };
	const encoded = JSON.stringify(normalized, null, 2);
	if (encoded.length <= MAX_DEBUG_JSON_CHARS) return normalized;
	const artifact = await request.allocateArtifact({ label, mimeType: "application/json", suffix: ".json" });
	await fs.writeFile(artifact.path, encoded, "utf8");
	return {
		truncated: true,
		artifact: {
			...artifact,
			bytes: Buffer.byteLength(encoded),
			mime_type: "application/json",
		} satisfies IpythonHostArtifact & { mime_type: string },
	};
}

function timeoutMs(data: Readonly<Record<string, unknown>>): number {
	return (integerValue(data, "timeout", { fallback: 30, min: 1, max: 120 }) ?? 30) * 1_000;
}

function accessType(data: Readonly<Record<string, unknown>>): "read" | "write" | "readWrite" | undefined {
	const value = stringValue(data, "access_type", { optional: true, max: 16 });
	if (!value) return undefined;
	if (value !== "read" && value !== "write" && value !== "readWrite") {
		throw new TypeError("access_type must be read, write, or readWrite");
	}
	return value;
}

function evaluateContext(data: Readonly<Record<string, unknown>>): DapEvaluateArguments["context"] {
	const value = stringValue(data, "context", { optional: true, max: 32 }) || "repl";
	if (value === "watch" || value === "repl" || value === "hover" || value === "clipboard" || value === "variables") {
		return value;
	}
	throw new TypeError("context must be watch, repl, hover, clipboard, or variables");
}

const ADAPTER_UNAVAILABLE_MESSAGES: Readonly<Record<string, string>> = {
	debugpy: "adapter 'debugpy' is not available: python not found in PATH",
	dlv: "adapter 'dlv' is not available: install with 'go install github.com/go-delve/delve/cmd/dlv@latest'",
	rdbg: "adapter 'rdbg' is not available: install with 'gem install debug'",
	"js-debug-adapter":
		"adapter 'js-debug-adapter' is not available: install vscode-js-debug with Mason or set JS_DEBUG_DAP_SERVER to dapDebugServer.js",
};

const ADAPTER_CANONICAL_COMMANDS: Readonly<Record<string, string>> = {
	debugpy: "python",
	dlv: "dlv",
	rdbg: "rdbg",
	"js-debug-adapter": "js-debug-adapter",
};

function adapterUnavailable(adapterName: string, command: string, available: readonly DapResolvedAdapter[]): Error {
	const canonical = ADAPTER_CANONICAL_COMMANDS[adapterName] ?? adapterName;
	if (command !== canonical) {
		return new Error(
			`adapter '${adapterName}' is not available: configured command '${command}' did not resolve. Check the DAP adapter config for this workspace.`,
		);
	}
	const fallback = `adapter '${adapterName}' is not available. Installed adapters: ${available.map(item => item.name).join(", ") || "none"}`;
	return new Error(ADAPTER_UNAVAILABLE_MESSAGES[adapterName] ?? fallback);
}

function requireCapability(manager: IpythonDebugManager, capability: keyof DapCapabilities, description: string): void {
	if (manager.getCapabilities()?.[capability] !== true) {
		throw new Error(`Current adapter does not support ${description}`);
	}
}

function disassemblyReference(manager: IpythonDebugManager, data: Readonly<Record<string, unknown>>): string {
	const explicit = stringValue(data, "memory_reference", { optional: true, max: 4_096 });
	if (explicit) return explicit;
	const current = manager.getActiveSession()?.instructionPointerReference;
	if (current) return current;
	throw new TypeError(
		"disassemble requires memory_reference unless the current stop location has an instruction pointer reference",
	);
}

/** Adapts one session-private DAP manager to explicit Python host operations. */
export class IpythonDebugService {
	readonly #manager: IpythonDebugManager;
	readonly #availableAdapters: (cwd: string) => DapResolvedAdapter[];
	readonly #launchAdapter: typeof selectLaunchAdapter;
	readonly #attachAdapter: typeof selectAttachAdapter;
	readonly #cwd: () => string;
	#disposePromise?: Promise<void>;

	constructor(options: IpythonDebugServiceOptions) {
		this.#cwd = options.cwd;
		this.#manager = options.manager ?? new DapSessionManager();
		this.#availableAdapters = options.availableAdapters ?? getAvailableAdapters;
		this.#launchAdapter = options.launchAdapter ?? selectLaunchAdapter;
		this.#attachAdapter = options.attachAdapter ?? selectAttachAdapter;
	}

	get handlers(): IpythonHostHandlers {
		const call =
			(
				name: string,
				allowed: readonly string[],
				run: (data: Readonly<Record<string, unknown>>, request: IpythonHostRequest) => unknown | Promise<unknown>,
			) =>
			async (request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> => {
				request.signal.throwIfAborted();
				strict(request.data, allowed);
				await request.publishProgress(`Debug operation started: ${name}`);
				const result = await run(request.data, request);
				await request.publishProgress(`Debug operation completed: ${name}`);
				return await boundedResult(request, `Debug ${name} result`, result);
			};
		const manager = this.#manager;
		return {
			"debug.adapters": call("adapters", [], () =>
				this.#availableAdapters(this.#cwd()).map(adapter => ({
					name: adapter.name,
					command: adapter.command,
					file_types: adapter.fileTypes,
					root_markers: adapter.rootMarkers,
				})),
			),
			"debug.sessions": call("sessions", [], () => ({
				active: manager.getActiveSession(),
				sessions: manager.listSessions(),
				capabilities: manager.getCapabilities(),
			})),
			"debug.launch": call("launch", ["program", "args", "adapter", "cwd", "timeout"], async (data, request) => {
				const root = this.#cwd();
				const cwdInput = stringValue(data, "cwd", { optional: true, max: 4_096 }) || ".";
				const cwd = await canonicalExisting(root, cwdInput);
				if (!(await fs.stat(cwd)).isDirectory()) throw new TypeError("debug cwd must be a directory");
				const programInput = stringValue(data, "program", { max: 4_096 });
				const program = await canonicalExisting(cwd, programInput);
				const programKind = (await fs.stat(program)).isDirectory() ? "directory" : "file";
				const adapterName = stringValue(data, "adapter", { optional: true, max: 128 });
				const selected = this.#launchAdapter(program, cwd, adapterName || undefined, programKind);
				if (selected.kind === "none") {
					const installed =
						this.#availableAdapters(cwd)
							.map(item => item.name)
							.join(", ") || "none";
					throw new Error(`No debugger adapter available. Installed adapters: ${installed}`);
				}
				if (selected.kind === "unavailable") {
					throw adapterUnavailable(selected.adapterName, selected.command, this.#availableAdapters(cwd));
				}
				if (programKind === "directory" && !selected.adapter.acceptsDirectoryProgram) {
					throw new TypeError(
						`launch program resolves to a directory: ${programInput}. Pass an executable file path or choose an adapter that supports package directories.`,
					);
				}
				return await manager.launch(
					{
						adapter: selected.adapter,
						program,
						cwd,
						args: stringArray(data, "args"),
						extraLaunchArguments: resolveLaunchOverrides(selected.adapter, program, programKind),
					},
					request.signal,
					timeoutMs(data),
				);
			}),
			"debug.attach": call("attach", ["adapter", "cwd", "pid", "port", "host", "timeout"], async (data, request) => {
				const root = this.#cwd();
				const cwdInput = stringValue(data, "cwd", { optional: true, max: 4_096 }) || ".";
				const cwd = await canonicalExisting(root, cwdInput);
				const adapterName = stringValue(data, "adapter", { optional: true, max: 128 });
				const port = integerValue(data, "port", { optional: true, min: 1, max: 65_535 });
				const pid = integerValue(data, "pid", { optional: true, min: 1 });
				if (pid === undefined && port === undefined) throw new TypeError("attach requires pid or port");
				const adapter = this.#attachAdapter(cwd, adapterName || undefined, port);
				if (!adapter) {
					if (adapterName) throw adapterUnavailable(adapterName, adapterName, this.#availableAdapters(cwd));
					const installed =
						this.#availableAdapters(cwd)
							.map(item => item.name)
							.join(", ") || "none";
					throw new Error(`No debugger adapter available. Installed adapters: ${installed}`);
				}
				return await manager.attach(
					{
						adapter,
						cwd,
						pid,
						port,
						host: stringValue(data, "host", { optional: true, max: 1_024 }) || undefined,
					},
					request.signal,
					timeoutMs(data),
				);
			}),
			"debug.set_breakpoint": call(
				"set breakpoint",
				["file", "line", "condition", "timeout"],
				async (data, request) =>
					await manager.setBreakpoint(
						await canonicalExisting(this.#cwd(), stringValue(data, "file", { max: 4_096 })),
						integerValue(data, "line", { min: 1 }),
						stringValue(data, "condition", { optional: true, max: 4_096 }) || undefined,
						request.signal,
						timeoutMs(data),
					),
			),
			"debug.remove_breakpoint": call(
				"remove breakpoint",
				["file", "line", "timeout"],
				async (data, request) =>
					await manager.removeBreakpoint(
						await canonicalExisting(this.#cwd(), stringValue(data, "file", { max: 4_096 })),
						integerValue(data, "line", { min: 1 }),
						request.signal,
						timeoutMs(data),
					),
			),
			"debug.set_function_breakpoint": call(
				"set function breakpoint",
				["name", "condition", "timeout"],
				async (data, request) =>
					await manager.setFunctionBreakpoint(
						stringValue(data, "name", { max: 4_096 }),
						stringValue(data, "condition", { optional: true, max: 4_096 }) || undefined,
						request.signal,
						timeoutMs(data),
					),
			),
			"debug.remove_function_breakpoint": call(
				"remove function breakpoint",
				["name", "timeout"],
				async (data, request) =>
					await manager.removeFunctionBreakpoint(
						stringValue(data, "name", { max: 4_096 }),
						request.signal,
						timeoutMs(data),
					),
			),
			"debug.set_instruction_breakpoint": call(
				"set instruction breakpoint",
				["instruction_reference", "offset", "condition", "hit_condition", "timeout"],
				async (data, request) =>
					await manager.setInstructionBreakpoint(
						stringValue(data, "instruction_reference", { max: 4_096 }),
						integerValue(data, "offset", { optional: true, min: -Number.MAX_SAFE_INTEGER }),
						stringValue(data, "condition", { optional: true, max: 4_096 }) || undefined,
						stringValue(data, "hit_condition", { optional: true, max: 4_096 }) || undefined,
						request.signal,
						timeoutMs(data),
					),
			),
			"debug.remove_instruction_breakpoint": call(
				"remove instruction breakpoint",
				["instruction_reference", "offset", "timeout"],
				async (data, request) =>
					await manager.removeInstructionBreakpoint(
						stringValue(data, "instruction_reference", { max: 4_096 }),
						integerValue(data, "offset", { optional: true, min: -Number.MAX_SAFE_INTEGER }),
						request.signal,
						timeoutMs(data),
					),
			),
			"debug.data_breakpoint_info": call(
				"data breakpoint info",
				["name", "variable_ref", "frame_id", "timeout"],
				async (data, request) =>
					await manager.dataBreakpointInfo(
						stringValue(data, "name", { max: 4_096 }),
						integerValue(data, "variable_ref", { optional: true, min: 0 }),
						integerValue(data, "frame_id", { optional: true, min: 0 }),
						request.signal,
						timeoutMs(data),
					),
			),
			"debug.set_data_breakpoint": call(
				"set data breakpoint",
				["data_id", "access_type", "condition", "hit_condition", "timeout"],
				async (data, request) =>
					await manager.setDataBreakpoint(
						stringValue(data, "data_id", { max: 4_096 }),
						accessType(data),
						stringValue(data, "condition", { optional: true, max: 4_096 }) || undefined,
						stringValue(data, "hit_condition", { optional: true, max: 4_096 }) || undefined,
						request.signal,
						timeoutMs(data),
					),
			),
			"debug.remove_data_breakpoint": call(
				"remove data breakpoint",
				["data_id", "timeout"],
				async (data, request) =>
					await manager.removeDataBreakpoint(
						stringValue(data, "data_id", { max: 4_096 }),
						request.signal,
						timeoutMs(data),
					),
			),
			"debug.continue": call("continue", ["timeout"], (data, request) =>
				manager.continue(request.signal, timeoutMs(data)),
			),
			"debug.pause": call("pause", ["timeout"], (data, request) => manager.pause(request.signal, timeoutMs(data))),
			"debug.step_over": call("step over", ["timeout"], (data, request) =>
				manager.stepOver(request.signal, timeoutMs(data)),
			),
			"debug.step_in": call("step in", ["timeout"], (data, request) =>
				manager.stepIn(request.signal, timeoutMs(data)),
			),
			"debug.step_out": call("step out", ["timeout"], (data, request) =>
				manager.stepOut(request.signal, timeoutMs(data)),
			),
			"debug.threads": call("threads", ["timeout"], (data, request) =>
				manager.threads(request.signal, timeoutMs(data)),
			),
			"debug.stack": call("stack", ["levels", "timeout"], (data, request) =>
				manager.stackTrace(
					integerValue(data, "levels", { optional: true, min: 1, max: 1_000 }),
					request.signal,
					timeoutMs(data),
				),
			),
			"debug.scopes": call("scopes", ["frame_id", "timeout"], (data, request) =>
				manager.scopes(integerValue(data, "frame_id", { optional: true, min: 0 }), request.signal, timeoutMs(data)),
			),
			"debug.variables": call("variables", ["variable_ref", "timeout"], (data, request) =>
				manager.variables(integerValue(data, "variable_ref", { min: 0 }), request.signal, timeoutMs(data)),
			),
			"debug.evaluate": call("evaluate", ["expression", "context", "frame_id", "timeout"], (data, request) => {
				return manager.evaluate(
					stringValue(data, "expression", { max: MAX_DEBUG_STRING }),
					evaluateContext(data),
					integerValue(data, "frame_id", { optional: true, min: 0 }),
					request.signal,
					timeoutMs(data),
				);
			}),
			"debug.output": call("output", ["limit"], data =>
				manager.getOutput(
					integerValue(data, "limit", { fallback: MAX_DEBUG_JSON_CHARS, min: 1, max: 8 * 1024 * 1024 }),
				),
			),
			"debug.disassemble": call(
				"disassemble",
				["memory_reference", "instruction_count", "offset", "instruction_offset", "resolve_symbols", "timeout"],
				(data, request) => {
					requireCapability(manager, "supportsDisassembleRequest", "disassembly");
					return manager.disassemble(
						disassemblyReference(manager, data),
						integerValue(data, "instruction_count", { min: 1, max: 10_000 }),
						integerValue(data, "offset", { optional: true, min: -Number.MAX_SAFE_INTEGER }),
						integerValue(data, "instruction_offset", { optional: true, min: -Number.MAX_SAFE_INTEGER }),
						booleanValue(data, "resolve_symbols"),
						request.signal,
						timeoutMs(data),
					);
				},
			),
			"debug.read_memory": call(
				"read memory",
				["memory_reference", "count", "offset", "timeout"],
				(data, request) => {
					requireCapability(manager, "supportsReadMemoryRequest", "memory reads");
					return manager.readMemory(
						stringValue(data, "memory_reference", { max: 4_096 }),
						integerValue(data, "count", { min: 1, max: 8 * 1024 * 1024 }),
						integerValue(data, "offset", { optional: true, min: -Number.MAX_SAFE_INTEGER }),
						request.signal,
						timeoutMs(data),
					);
				},
			),
			"debug.write_memory": call(
				"write memory",
				["memory_reference", "data", "offset", "allow_partial", "timeout"],
				(data, request) => {
					requireCapability(manager, "supportsWriteMemoryRequest", "memory writes");
					return manager.writeMemory(
						stringValue(data, "memory_reference", { max: 4_096 }),
						stringValue(data, "data", { max: 8 * 1024 * 1024 }),
						integerValue(data, "offset", { optional: true, min: -Number.MAX_SAFE_INTEGER }),
						booleanValue(data, "allow_partial"),
						request.signal,
						timeoutMs(data),
					);
				},
			),
			"debug.modules": call("modules", ["start", "count", "timeout"], (data, request) => {
				requireCapability(manager, "supportsModulesRequest", "module introspection");
				return manager.modules(
					integerValue(data, "start", { optional: true, min: 0 }),
					integerValue(data, "count", { optional: true, min: 1, max: 10_000 }),
					request.signal,
					timeoutMs(data),
				);
			}),
			"debug.loaded_sources": call("loaded sources", ["timeout"], (data, request) => {
				requireCapability(manager, "supportsLoadedSourcesRequest", "loaded-source enumeration");
				return manager.loadedSources(request.signal, timeoutMs(data));
			}),
		};
	}

	async suspend(): Promise<void> {
		await this.#manager.terminate(AbortSignal.timeout(5_000), 4_000).catch(() => undefined);
	}

	async dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposePromise = this.#manager.dispose?.() ?? this.suspend();
		return this.#disposePromise;
	}
}
