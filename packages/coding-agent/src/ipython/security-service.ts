import * as fs from "node:fs/promises";
import type {
	SecurityComparisonReport,
	SecurityFinding,
	SecurityScan,
	SecurityScanPlan,
	SecurityTargetKind,
	SecurityValidation,
	SecurityValidationStatus,
} from "../security/contracts";
import type { SecurityOperationSnapshot, SecurityPreflightInput } from "../security/coordinator";
import {
	createPublicSecurityPlan,
	createPublicSecurityScan,
	redactPrivateSecurityMetadata,
} from "../security/provenance";
import { type SecurityPublisher, securityPublishSchema } from "../security/publication";
import type { SecurityScanSummary } from "../security/store";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_STRING_CHARS = 16_384;
const MAX_PATH_CHARS = 4_096;
const MAX_IDENTIFIER_CHARS = 512;
const MAX_LIST_ITEMS = 100;
const MAX_JSON_CHARS = 350_000;
const TARGET_KINDS: readonly SecurityTargetKind[] = ["repository", "scoped_path", "ref_diff", "working_tree"];

export interface IpythonSecurityCoordinator {
	preflight(input: SecurityPreflightInput): Promise<SecurityScanPlan>;
	start(input: { planId: string }): Promise<SecurityOperationSnapshot>;
	status(operationId: string): Promise<SecurityOperationSnapshot | null>;
	listOperations(): Promise<SecurityOperationSnapshot[]>;
	cancel(operationId: string): Promise<boolean>;
}

export interface IpythonSecurityStore {
	listScans(): Promise<SecurityScanSummary[]>;
	getScan(scanId: string): Promise<SecurityScan | null>;
	getBundle(scanId: string): Promise<{ scan: SecurityScan; findings: readonly SecurityFinding[] } | null>;
	getFinding(scanId: string, findingId: string): Promise<SecurityFinding | null>;
	updateValidation(scanId: string, findingId: string, validation: SecurityValidation): Promise<SecurityFinding>;
	compare(beforeScanId: string, afterScanId: string): Promise<SecurityComparisonReport>;
}

export interface IpythonSecurityServiceOptions {
	readonly coordinator: (request: IpythonHostRequest) => IpythonSecurityCoordinator;
	readonly store: (request: IpythonHostRequest) => Promise<IpythonSecurityStore>;
	readonly publisher?: SecurityPublisher;
}

function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function stringValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	options: { optional?: boolean; max?: number } = {},
): string | undefined {
	const value = data[name];
	if (value === undefined && options.optional) return undefined;
	if (typeof value !== "string" || (!options.optional && value.trim().length === 0)) {
		throw new TypeError(`${name} must be ${options.optional ? "a string" : "a nonempty string"}`);
	}
	if (value.length > (options.max ?? MAX_STRING_CHARS)) throw new RangeError(`${name} is too large`);
	return value;
}

function identifier(data: Readonly<Record<string, unknown>>, name: string): string {
	return stringValue(data, name, { max: MAX_IDENTIFIER_CHARS })!;
}

function stringList(
	data: Readonly<Record<string, unknown>>,
	name: string,
	maxChars = MAX_PATH_CHARS,
): string[] | undefined {
	const value = data[name];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
		throw new TypeError(`${name} must be a list of at most ${MAX_LIST_ITEMS} strings`);
	}
	return value.map((item, index) => {
		if (typeof item !== "string" || item.trim().length === 0) {
			throw new TypeError(`${name}[${index}] must be a nonempty string`);
		}
		if (item.length > maxChars) throw new RangeError(`${name}[${index}] is too large`);
		return item;
	});
}

function validationStatus(data: Readonly<Record<string, unknown>>): SecurityValidationStatus {
	const status = stringValue(data, "status", { max: 32 });
	switch (status) {
		case "unvalidated":
		case "validated":
		case "rejected":
		case "partial":
		case "error":
			return status;
		default:
			throw new RangeError("status is invalid");
	}
}

function optionalBoolean(data: Readonly<Record<string, unknown>>, name: string): boolean | undefined {
	const value = data[name];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
	return value;
}

function optionalCredentialId(data: Readonly<Record<string, unknown>>): number | undefined {
	const value = data.credential_id;
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new RangeError("credential_id must be a positive integer");
	}
	return value as number;
}

function target(data: Readonly<Record<string, unknown>>): SecurityPreflightInput["target"] {
	const kind = stringValue(data, "target_kind", { optional: true, max: 32 }) ?? "repository";
	if (!TARGET_KINDS.includes(kind as SecurityTargetKind)) throw new RangeError("target_kind is invalid");
	const includePaths = stringList(data, "include_paths");
	const excludePaths = stringList(data, "exclude_paths");
	const baseRevision = stringValue(data, "base_revision", { optional: true, max: MAX_PATH_CHARS });
	const headRevision = stringValue(data, "head_revision", { optional: true, max: MAX_PATH_CHARS });
	if (kind === "ref_diff") {
		if (!baseRevision || !headRevision) throw new TypeError("ref_diff requires base_revision and head_revision");
		return { kind, baseRevision, headRevision, includePaths, excludePaths };
	}
	if (baseRevision !== undefined || headRevision !== undefined) {
		throw new TypeError("base_revision and head_revision are only valid for ref_diff");
	}
	if (kind === "scoped_path") {
		if (!includePaths || includePaths.length === 0) throw new TypeError("scoped_path requires include_paths");
		return { kind, includePaths, excludePaths };
	}
	return { kind: kind as "repository" | "working_tree", includePaths, excludePaths };
}

function planInput(data: Readonly<Record<string, unknown>>, signal: AbortSignal): SecurityPreflightInput {
	strict(data, [
		"target_kind",
		"include_paths",
		"exclude_paths",
		"knowledge_base_paths",
		"base_revision",
		"head_revision",
		"output_root",
		"archive_existing",
		"credential_id",
		"thinking_level",
	]);
	return {
		target: target(data),
		knowledgeBasePaths: stringList(data, "knowledge_base_paths"),
		outputRoot: stringValue(data, "output_root", { optional: true, max: MAX_PATH_CHARS }),
		archiveExisting: optionalBoolean(data, "archive_existing"),
		credentialId: optionalCredentialId(data),
		thinkingLevel: stringValue(data, "thinking_level", { optional: true, max: 128 }),
		signal,
	};
}

function publicOperation(operation: SecurityOperationSnapshot): Readonly<Record<string, unknown>> {
	return redactPrivateSecurityMetadata({
		operationId: operation.operationId,
		planId: operation.planId,
		scanId: operation.scanId,
		phase: operation.phase,
		createdAt: operation.createdAt,
		updatedAt: operation.updatedAt,
		findingCount: operation.findingCount,
		error: operation.error,
	}) as Readonly<Record<string, unknown>>;
}

function normalize(value: unknown): Readonly<Record<string, unknown>> {
	if (Array.isArray(value)) return { items: value };
	if (value && typeof value === "object") return value as Readonly<Record<string, unknown>>;
	return { value: value ?? null };
}

async function boundedResult(
	request: IpythonHostRequest,
	label: string,
	value: unknown,
): Promise<Readonly<Record<string, unknown>>> {
	request.signal.throwIfAborted();
	const safe = normalize(redactPrivateSecurityMetadata(value));
	const encoded = JSON.stringify(safe, null, 2);
	if (encoded.length <= MAX_JSON_CHARS) {
		await request.publishDisplay({
			data: { "application/json": safe, "text/plain": encoded },
			metadata: {},
			transient: {},
			update: false,
			text: encoded,
		});
		return safe;
	}
	const artifact = await request.allocateArtifact({ label, mimeType: "application/json", suffix: ".json" });
	request.signal.throwIfAborted();
	await fs.writeFile(artifact.path, encoded, "utf8");
	request.signal.throwIfAborted();
	return {
		truncated: true,
		artifact: {
			...artifact,
			bytes: Buffer.byteLength(encoded),
			mime_type: "application/json",
		},
	};
}

/** Exposes native security coordination and public provenance without crossing authentication boundaries. */
export class IpythonSecurityService {
	readonly handlers: IpythonHostHandlers;

	constructor(private readonly options: IpythonSecurityServiceOptions) {
		this.handlers = {
			"security.plan": request => this.#plan(request),
			"security.start": request => this.#start(request),
			"security.status": request => this.#status(request),
			"security.operations": request => this.#operations(request),
			"security.cancel": request => this.#cancel(request),
			...(this.options.publisher ? { "security.publish": request => this.#publish(request) } : {}),
			"security.scans": request => this.#scans(request),
			"security.scan": request => this.#scan(request),
			"security.findings": request => this.#findings(request),
			"security.finding": request => this.#finding(request),
			"security.validate": request => this.#validate(request),
			"security.compare": request => this.#compare(request),
		};
	}

	#coordinator(request: IpythonHostRequest): IpythonSecurityCoordinator {
		return this.options.coordinator(request);
	}

	async #plan(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		const input = planInput(request.data, request.signal);
		request.signal.throwIfAborted();
		await request.publishProgress("Security plan started");
		const plan = await this.#coordinator(request).preflight(input);
		request.signal.throwIfAborted();
		await request.publishProgress("Security plan completed");
		return { plan: createPublicSecurityPlan(plan) };
	}

	async #start(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["plan_id"]);
		const planId = identifier(request.data, "plan_id");
		request.signal.throwIfAborted();
		await request.publishProgress("Security scan start requested");
		const operation = await this.#coordinator(request).start({ planId });
		request.signal.throwIfAborted();
		return { operation: publicOperation(operation) };
	}

	async #status(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["operation_id"]);
		const operation = await this.#coordinator(request).status(identifier(request.data, "operation_id"));
		request.signal.throwIfAborted();
		return { operation: operation ? publicOperation(operation) : null };
	}

	async #operations(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, []);
		const operations = await this.#coordinator(request).listOperations();
		request.signal.throwIfAborted();
		return { operations: operations.map(publicOperation) };
	}

	async #cancel(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["operation_id"]);
		request.signal.throwIfAborted();
		return { cancelled: await this.#coordinator(request).cancel(identifier(request.data, "operation_id")) };
	}

	async #publish(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		request.signal.throwIfAborted();
		const { type: _type, ...input } = request.data;
		const params = securityPublishSchema.assert(input);
		const publication = await this.options.publisher!(params);
		request.signal.throwIfAborted();
		return { publication };
	}

	async #scans(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, []);
		return boundedResult(request, "security-scans", { scans: await (await this.options.store(request)).listScans() });
	}

	async #scan(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["scan_id"]);
		const scan = await (await this.options.store(request)).getScan(identifier(request.data, "scan_id"));
		return boundedResult(request, "security-scan", {
			scan: scan ? createPublicSecurityScan(scan, { includePlan: true }) : null,
		});
	}

	async #findings(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["scan_id"]);
		const bundle = await (await this.options.store(request)).getBundle(identifier(request.data, "scan_id"));
		return boundedResult(request, "security-findings", { findings: bundle?.findings ?? null });
	}

	async #finding(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["scan_id", "finding_id"]);
		const store = await this.options.store(request);
		const finding = await store.getFinding(
			identifier(request.data, "scan_id"),
			identifier(request.data, "finding_id"),
		);
		return boundedResult(request, "security-finding", { finding });
	}

	async #validate(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["scan_id", "finding_id", "status", "summary", "evidence_ids"]);
		const scanId = identifier(request.data, "scan_id");
		const findingId = identifier(request.data, "finding_id");
		const status = validationStatus(request.data);
		const summary = stringValue(request.data, "summary", { max: MAX_STRING_CHARS })!;
		const evidenceIds = stringList(request.data, "evidence_ids", MAX_IDENTIFIER_CHARS);
		if (!evidenceIds || evidenceIds.length === 0) {
			throw new TypeError("evidence_ids must be a nonempty list of existing evidence ids");
		}
		request.signal.throwIfAborted();
		const finding = await (await this.options.store(request)).updateValidation(scanId, findingId, {
			status,
			summary,
			evidenceIds,
			validatedAt: new Date().toISOString(),
		});
		request.signal.throwIfAborted();
		return boundedResult(request, "security-validation", { finding });
	}

	async #compare(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["before_scan_id", "after_scan_id"]);
		const comparison = await (await this.options.store(request)).compare(
			identifier(request.data, "before_scan_id"),
			identifier(request.data, "after_scan_id"),
		);
		return boundedResult(request, "security-comparison", { comparison });
	}
}
