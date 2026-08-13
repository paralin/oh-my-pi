import type {
	TaskAdmissionRequest,
	TaskAdmissionService,
	TaskChildProjection,
	TaskIsolationControls,
} from "../task/admission";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const RLM_NAME_MAX = 64;
const RLM_MODEL_LIMIT_DEFAULT = 8;
const RLM_MODEL_LIMIT_MAX = 20;
const RLM_RUN_KEYS = new Set(["name", "model", "service_tier", "isolated", "apply", "merge"]);
const RLM_SERVICE_TIERS = new Set(["auto", "default", "flex", "scale", "priority"]);

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
	return value as Readonly<Record<string, unknown>>;
}

function requiredString(data: Readonly<Record<string, unknown>>, key: string): string {
	const value = data[key];
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${key} must be a nonempty string`);
	return value.trim();
}

function optionalString(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const value = data[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${key} must be a nonempty string`);
	return value.trim();
}

function optionalBoolean(data: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
	const value = data[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new TypeError(`${key} must be a boolean`);
	return value;
}

function service(value: TaskAdmissionService | undefined): TaskAdmissionService {
	if (!value) throw new Error("RLM Task admission is unavailable in this session");
	return value;
}

function isolation(kwargs: Readonly<Record<string, unknown>>): TaskIsolationControls | undefined {
	const requested = optionalBoolean(kwargs, "isolated");
	const apply = optionalBoolean(kwargs, "apply");
	const mergeValue = kwargs.merge;
	if (mergeValue !== undefined && mergeValue !== "patch" && mergeValue !== "branch") {
		throw new TypeError('merge must be "patch" or "branch"');
	}
	if ((apply !== undefined || mergeValue !== undefined) && requested !== true) {
		throw new TypeError("apply and merge require isolated=True");
	}
	if (requested === undefined && apply === undefined && mergeValue === undefined) return undefined;
	return {
		...(requested !== undefined ? { requested } : {}),
		...(apply !== undefined ? { apply } : {}),
		...(mergeValue !== undefined ? { merge: mergeValue } : {}),
	};
}

function validateRun(request: IpythonHostRequest): TaskAdmissionRequest {
	const promptValue = request.data.prompt;
	if (typeof promptValue !== "string" || promptValue.trim().length === 0) {
		throw new TypeError("prompt must be a nonempty string");
	}
	const prompt = promptValue;
	const kwargs = request.data.kwargs === undefined ? {} : record(request.data.kwargs, "kwargs");
	for (const key of Object.keys(kwargs)) {
		if (!RLM_RUN_KEYS.has(key)) throw new TypeError(`unsupported rlm() keyword: ${key}`);
	}
	const name = optionalString(kwargs, "name");
	if (name && name.length > RLM_NAME_MAX) {
		throw new TypeError(`name must be at most ${RLM_NAME_MAX} characters`);
	}
	const model = optionalString(kwargs, "model");
	let serviceTier: "auto" | "default" | "flex" | "scale" | "priority" | null | undefined;
	if (kwargs.service_tier !== undefined) {
		const value = kwargs.service_tier;
		if (value === null || (typeof value === "string" && RLM_SERVICE_TIERS.has(value))) {
			serviceTier = value as "auto" | "default" | "flex" | "scale" | "priority" | null;
		} else {
			throw new TypeError("service_tier must be one of auto, default, flex, scale, priority, or null");
		}
	}
	const isolationControls = isolation(kwargs);
	return {
		assignment: prompt,
		...(name ? { name } : {}),
		...(model ? { model } : {}),
		...(serviceTier !== undefined ? { serviceTier } : {}),
		...(isolationControls ? { isolation: isolationControls } : {}),
		sourceId: `ipython:${request.sessionId}:${request.cellId}:${request.sequence}`,
		signal: request.signal,
		onProgress: message => request.publishProgress(message, { operation: "rlm.run" }),
	};
}

function subagent(child: TaskChildProjection): Record<string, unknown> {
	return {
		rlm_child_id: child.id,
		active_session_id: child.activeSessionId ?? null,
		session_id: child.sessionId ?? null,
		session_name: child.name,
		session_dir: child.sessionDir,
		status: child.status,
		lifecycle_status: child.lifecycleStatus,
		...(child.model ? { model: child.model } : {}),
	};
}

export function createRlmIpythonHostHandlers(task: TaskAdmissionService | undefined): IpythonHostHandlers {
	return {
		"rlm.run": async request => {
			const admitted = await service(task).admit(validateRun(request));
			return {
				rlm_child_id: admitted.id,
				name: admitted.name,
				...(admitted.sessionDir ? { session_dir: admitted.sessionDir } : {}),
				...(admitted.model ? { model: admitted.model } : {}),
			};
		},
		"rlm.find_models": request => {
			const queryValue = request.data.query;
			if (queryValue !== undefined && typeof queryValue !== "string") throw new TypeError("query must be a string");
			const limitValue = request.data.limit ?? RLM_MODEL_LIMIT_DEFAULT;
			if (
				typeof limitValue !== "number" ||
				!Number.isInteger(limitValue) ||
				limitValue < 1 ||
				limitValue > RLM_MODEL_LIMIT_MAX
			) {
				throw new TypeError(`limit must be an integer from 1 through ${RLM_MODEL_LIMIT_MAX}`);
			}
			return {
				models: service(task)
					.findModels((queryValue ?? "").trim(), limitValue)
					.map(model => ({
						...model,
						concreteSelector: model.concreteSelector ?? model.selector,
						available: model.available ?? true,
					})),
			};
		},
		"rlm.list_subagents": async request => ({
			subagents: (await service(task).listDirectChildren(request.signal)).map(subagent),
		}),
		"rlm.delete_subagent": async request => ({
			subagent: subagent(
				await service(task).deleteDirectChild(requiredString(request.data, "target"), request.signal),
			),
		}),
	};
}
