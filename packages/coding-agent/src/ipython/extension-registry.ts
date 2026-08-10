import type {
	IpythonExtensionCellMetadata,
	IpythonExtensionHostHandler,
	IpythonExtensionHostRequest,
	IpythonMimeItem,
	IpythonMimeRenderer,
	RegisteredIpythonExtensionHostHandler,
	RegisteredIpythonMimeRenderer,
} from "../extensibility/extensions/types";
import type { IpythonCellPresentation } from "./projection";

const IDENTIFIER_SEGMENT = /^[a-z][a-z0-9_-]{0,47}$/u;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/u;
const RESERVED_NAMESPACES = new Set(["artifact", "cell", "omp", "rlm", "session", "tool"]);
const RESERVED_OPERATIONS = new Set([
	"artifact.allocate",
	"cell.display",
	"cell.progress",
	"session.info",
	"tool.call",
]);

interface IpythonExtensionRegistrySnapshot {
	readonly handlers: ReadonlyMap<string, IpythonExtensionHostHandler>;
	readonly renderers: ReadonlyMap<string, IpythonMimeRenderer>;
}

function qualifiedOperation(namespace: string, operation: string, extensionPath: string): string {
	if (!IDENTIFIER_SEGMENT.test(namespace)) {
		throw new TypeError(`invalid IPython extension namespace from ${extensionPath}: ${namespace}`);
	}
	if (RESERVED_NAMESPACES.has(namespace)) {
		throw new TypeError(`reserved IPython extension namespace from ${extensionPath}: ${namespace}`);
	}
	if (!IDENTIFIER_SEGMENT.test(operation)) {
		throw new TypeError(`invalid IPython extension operation from ${extensionPath}: ${operation}`);
	}
	const qualified = `extension.${namespace}.${operation}`;
	if (RESERVED_OPERATIONS.has(qualified) || RESERVED_OPERATIONS.has(`${namespace}.${operation}`)) {
		throw new TypeError(`reserved IPython extension operation from ${extensionPath}: ${qualified}`);
	}
	return qualified;
}

function narrowRequest(request: IpythonExtensionHostRequest): IpythonExtensionHostRequest {
	const cell: IpythonExtensionCellMetadata = Object.freeze({
		id: request.cell.id,
		sequence: request.cell.sequence,
		origin: request.cell.origin,
		authority: request.cell.authority,
	});
	return Object.freeze({
		data: Object.freeze(Object.fromEntries(Object.entries(request.data))),
		requestId: request.requestId,
		executionId: request.executionId,
		commId: request.commId,
		sessionId: request.sessionId,
		cwd: request.cwd,
		cell,
		signal: request.signal,
		publishProgress: request.publishProgress,
		allocateArtifact: request.allocateArtifact,
	});
}

function narrowHandler(handler: IpythonExtensionHostHandler): IpythonExtensionHostHandler {
	return async request => await handler(narrowRequest(request));
}

function buildSnapshot(
	hostHandlers: readonly RegisteredIpythonExtensionHostHandler[],
	renderers: readonly RegisteredIpythonMimeRenderer[],
): IpythonExtensionRegistrySnapshot {
	const handlers = new Map<string, IpythonExtensionHostHandler>();
	for (const registration of hostHandlers) {
		if (typeof registration.handler !== "function") {
			throw new TypeError(`IPython extension host handler must be callable: ${registration.extensionPath}`);
		}
		const operation = qualifiedOperation(registration.namespace, registration.operation, registration.extensionPath);
		if (handlers.has(operation)) throw new TypeError(`duplicate IPython extension operation: ${operation}`);
		handlers.set(operation, narrowHandler(registration.handler));
	}
	const mimeRenderers = new Map<string, IpythonMimeRenderer>();
	for (const registration of renderers) {
		if (!MIME_TYPE.test(registration.mimeType) || registration.mimeType === "text/plain") {
			throw new TypeError(
				`invalid IPython MIME renderer type from ${registration.extensionPath}: ${registration.mimeType}`,
			);
		}
		if (typeof registration.renderer !== "function") {
			throw new TypeError(`IPython MIME renderer must be callable: ${registration.extensionPath}`);
		}
		if (mimeRenderers.has(registration.mimeType)) {
			throw new TypeError(`duplicate IPython MIME renderer: ${registration.mimeType}`);
		}
		mimeRenderers.set(registration.mimeType, registration.renderer);
	}
	return { handlers, renderers: mimeRenderers };
}

/** Owns the atomic extension snapshot used by a live IPython host resolver. */
export class IpythonExtensionRegistry {
	#snapshot: IpythonExtensionRegistrySnapshot = { handlers: new Map(), renderers: new Map() };
	#accepting = true;
	#disposed = false;

	replace(
		hostHandlers: readonly RegisteredIpythonExtensionHostHandler[],
		renderers: readonly RegisteredIpythonMimeRenderer[],
	): void {
		if (this.#disposed) throw new Error("IPython extension registry is disposed");
		if (!this.#accepting) throw new Error("IPython extension registry rejects new registrations");
		this.#snapshot = buildSnapshot(hostHandlers, renderers);
	}

	rejectNew(): void {
		this.#accepting = false;
	}

	getHostHandler(operation: string): IpythonExtensionHostHandler | undefined {
		return this.#disposed ? undefined : this.#snapshot.handlers.get(operation);
	}

	getMimeRenderer(mimeType: string): IpythonMimeRenderer | undefined {
		return this.#disposed ? undefined : this.#snapshot.renderers.get(mimeType);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#accepting = false;
		this.#snapshot = { handlers: new Map(), renderers: new Map() };
	}
}

/** Projects rich display and result values without changing the shared safe-text fallback. */
export function collectIpythonMimeItems(presentation: IpythonCellPresentation): IpythonMimeItem[] {
	const items: IpythonMimeItem[] = [];
	for (const event of presentation.events) {
		if (event.kind !== "display" && event.kind !== "result") continue;
		for (const [mimeType, value] of Object.entries(event.data)) {
			if (mimeType === "text/plain") continue;
			items.push(
				event.kind === "display"
					? {
							kind: "display",
							mimeType,
							value,
							metadata: event.metadata,
							transient: event.transient,
							update: event.update,
						}
					: { kind: "result", mimeType, value },
			);
		}
	}
	return items;
}
