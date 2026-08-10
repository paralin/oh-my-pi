/** Typed admission boundary shared by OMP Task and the Python RLM host bridge. */

export interface TaskIsolationControls {
	requested?: boolean;
	apply?: boolean;
	merge?: "patch" | "branch";
}

export interface TaskAdmissionRequest {
	assignment: string;
	name?: string;
	model?: string;
	serviceTier?: "auto" | "default" | "flex" | "scale" | "priority" | null;
	isolation?: TaskIsolationControls;
	sourceId: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void | Promise<void>;
}

/** Child identity published after Task has constructed and registered its runtime. */
export interface SubagentRuntimeAdmission {
	id: string;
	name: string;
	sessionId?: string;
	sessionDir: string;
	sessionFile?: string;
	model: string;
	cwd: string;
}

export interface TaskChildAdmission extends SubagentRuntimeAdmission {
	jobId: string;
}

export type TaskChildStatus = "running" | "completed" | "error";

/** Read-only projection of one direct Task child retained by the existing roster. */
export interface TaskChildProjection {
	id: string;
	name: string;
	activeSessionId?: string;
	sessionId?: string;
	sessionDir: string;
	status: TaskChildStatus;
	lifecycleStatus: "running" | "idle" | "parked" | "aborted";
	model?: string;
}

export interface TaskModelProjection {
	provider: string;
	id: string;
	name: string;
	selector: string;
	concreteSelector?: string;
	available?: boolean;
}

/** Direct service API; callers never dispatch through a provider tool wrapper. */
export interface TaskAdmissionService {
	admit(request: TaskAdmissionRequest): Promise<TaskChildAdmission>;
	findModels(query: string, limit: number): TaskModelProjection[];
	listDirectChildren(signal?: AbortSignal): Promise<TaskChildProjection[]>;
	deleteDirectChild(target: string, signal?: AbortSignal): Promise<TaskChildProjection>;
}

export function isTaskAdmissionService(value: unknown): value is TaskAdmissionService {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<TaskAdmissionService>;
	return (
		typeof candidate.admit === "function" &&
		typeof candidate.findModels === "function" &&
		typeof candidate.listDirectChildren === "function" &&
		typeof candidate.deleteDirectChild === "function"
	);
}
