import type { IpythonDisplayEvent, IpythonHostHandler, IpythonHostHandlers, IpythonHostRequest } from "./controller";

const RESERVED_HOST_OPERATIONS = new Set(["tool.call"]);

function objectValue(value: unknown, name: string): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${name} must be an object`);
	}
	return Object.fromEntries(Object.entries(value));
}

function requiredString(data: Readonly<Record<string, unknown>>, name: string): string {
	const value = data[name];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${name} must be a nonempty string`);
	}
	return value;
}

function optionalString(data: Readonly<Record<string, unknown>>, name: string): string {
	const value = data[name];
	if (value === undefined) return "";
	if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
	return value;
}

function optionalObject(data: Readonly<Record<string, unknown>>, name: string): Readonly<Record<string, unknown>> {
	const value = data[name];
	return value === undefined ? {} : objectValue(value, name);
}

function displayText(data: Readonly<Record<string, unknown>>): string {
	const plain = data["text/plain"];
	if (typeof plain === "string") return plain;
	const mimeTypes = Object.keys(data).sort();
	return mimeTypes.length > 0 ? `[displayed MIME types: ${mimeTypes.join(", ")}]` : "[displayed data]";
}

function requestDisplay(request: IpythonHostRequest): IpythonDisplayEvent {
	const payload = request.data;
	const data = objectValue(payload.data, "data");
	const update = payload.update === undefined ? false : payload.update;
	if (typeof update !== "boolean") throw new TypeError("update must be a boolean");
	return {
		kind: "display",
		data,
		metadata: optionalObject(payload, "metadata"),
		transient: optionalObject(payload, "transient"),
		update,
		text: displayText(data),
	};
}

export function composeIpythonHostHandlers(...sets: readonly (IpythonHostHandlers | undefined)[]): IpythonHostHandlers {
	const handlers: Record<string, IpythonHostHandler> = Object.create(null) as Record<string, IpythonHostHandler>;
	for (const set of sets) {
		if (!set) continue;
		for (const [rawOperation, handler] of Object.entries(set)) {
			const operation = rawOperation.trim();
			if (!operation || operation !== rawOperation) {
				throw new TypeError("IPython host operation names must be nonempty and trimmed");
			}
			if (RESERVED_HOST_OPERATIONS.has(operation)) {
				throw new TypeError(`IPython host operation is reserved: ${operation}`);
			}
			if (typeof handler !== "function") throw new TypeError(`IPython host handler must be callable: ${operation}`);
			if (handlers[operation]) throw new TypeError(`duplicate IPython host operation: ${operation}`);
			handlers[operation] = handler;
		}
	}
	return Object.freeze(handlers);
}

export function createFoundationalIpythonHostHandlers(): IpythonHostHandlers {
	return composeIpythonHostHandlers({
		"session.info": request => ({
			sessionId: request.sessionId,
			cwd: request.cwd,
			cellId: request.cellId,
			sequence: request.sequence,
			origin: request.origin,
			authority: request.authority,
		}),
		"cell.progress": async request => {
			const message = requiredString(request.data, "message");
			await request.publishProgress(message, optionalObject(request.data, "data"));
			return {};
		},
		"cell.display": async request => {
			await request.publishDisplay(requestDisplay(request));
			return {};
		},
		"artifact.allocate": async request => ({
			artifact: await request.allocateArtifact({
				label: requiredString(request.data, "label"),
				mimeType: requiredString(request.data, "mimeType"),
				suffix: optionalString(request.data, "suffix"),
			}),
		}),
	});
}
