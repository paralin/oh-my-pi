import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IpythonDisplayEvent, IpythonHostRequest } from "../../src/ipython/controller";
import {
	type IpythonSecurityCoordinator,
	IpythonSecurityService,
	type IpythonSecurityStore,
} from "../../src/ipython/security-service";
import type { SecurityFinding, SecurityScanPlan } from "../../src/security/contracts";
import type { SecurityOperationSnapshot } from "../../src/security/coordinator";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

const plan: SecurityScanPlan = {
	documentType: "omp-security.scan-plan",
	schemaVersion: "1.0",
	id: "plan-1",
	createdAt: "2026-08-06T00:00:00.000Z",
	repositoryRoot: "/repo",
	target: {
		kind: "repository",
		repositoryRoot: "/repo",
		displayName: "repo",
		includePaths: [],
		excludePaths: [],
		treeDigest: "tree",
	},
	knowledgeBases: [],
	output: { root: "/state/output", archiveExisting: false, existingState: "absent" },
	model: { provider: "test", modelId: "model" },
	account: {
		provider: "test",
		credentialId: 42,
		accountId: "account-secret",
		email: "person@example.test",
		organizationId: "org-secret",
	},
	configFingerprint: "config",
	workflowFingerprint: "workflow",
	fingerprint: "fingerprint",
};

const operation: SecurityOperationSnapshot = {
	operationId: "operation-1",
	planId: plan.id,
	scanId: "scan-1",
	phase: "queued",
	createdAt: plan.createdAt,
	updatedAt: plan.createdAt,
	findingCount: 0,
	jobId: "job-internal",
	sessionFile: "/private/session.jsonl",
};

function finding(summary = "summary"): SecurityFinding {
	return {
		id: "finding-1",
		scanId: operation.scanId,
		fingerprint: "finding-fingerprint",
		ruleId: "rule-1",
		title: "Finding",
		summary,
		severity: { level: "high" },
		confidence: { level: "high" },
		taxonomy: { category: "security", cwe: ["CWE-1"] },
		occurrences: [{ id: "occurrence-1", locations: [], evidenceIds: [] }],
		evidence: [],
		validation: { status: "unvalidated", evidenceIds: [] },
		disposition: { status: "open" },
		provenance: {
			producer: { kind: "omp-native", name: "OMP" },
			createdAt: plan.createdAt,
			metadata: { sessionId: "private-session", nested: { apiKey: "private-key", safe: "kept" } },
		},
	};
}

function owners(
	overrides: {
		preflight?: IpythonSecurityCoordinator["preflight"];
		findings?: readonly SecurityFinding[];
		updateValidation?: IpythonSecurityStore["updateValidation"];
	} = {},
): { coordinator: IpythonSecurityCoordinator; store: IpythonSecurityStore } {
	return {
		coordinator: {
			preflight: overrides.preflight ?? (async () => plan),
			start: async () => operation,
			status: async () => operation,
			listOperations: async () => [operation],
			cancel: async () => true,
		},
		store: {
			listScans: async () => [],
			getScan: async () => null,
			getBundle: async () => ({ scan: {} as never, findings: overrides.findings ?? [finding()] }),
			getFinding: async () => finding(),
			updateValidation:
				overrides.updateValidation ?? (async (_scanId, _findingId, validation) => ({ ...finding(), validation })),
			compare: async (beforeScanId, afterScanId) => ({
				beforeScanId,
				afterScanId,
				matches: [],
				unchanged: 0,
				introduced: 0,
				resolved: 0,
			}),
		},
	};
}

async function request(
	type: string,
	data: Readonly<Record<string, unknown>>,
	signal = new AbortController().signal,
): Promise<{
	request: IpythonHostRequest;
	progress: string[];
	displays: Array<Omit<IpythonDisplayEvent, "kind">>;
	artifacts: string[];
}> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-security-service-"));
	temporaryDirectories.push(directory);
	const progress: string[] = [];
	const displays: Array<Omit<IpythonDisplayEvent, "kind">> = [];
	const artifacts: string[] = [];
	return {
		request: {
			requestId: "request-1",
			commId: "comm-1",
			targetName: "host.request",
			data: { type, ...data },
			signal,
			executionId: "execution-1",
			sessionId: "active-session",
			cwd: "/active/cwd",
			cellId: "cell-1",
			sequence: 1,
			origin: "model",
			authority: "trusted-cell",
			publishProgress: async message => {
				progress.push(message);
			},
			publishDisplay: async display => {
				displays.push(display);
			},
			allocateArtifact: async artifact => {
				const artifactPath = path.join(directory, `${artifacts.length}${artifact.suffix}`);
				artifacts.push(artifactPath);
				return {
					id: `artifact-${artifacts.length}`,
					path: artifactPath,
					label: artifact.label,
					mimeType: artifact.mimeType,
				};
			},
		},
		progress,
		displays,
		artifacts,
	};
}

describe("IPython security service", () => {
	test("plans through the active request and returns only public account affinity", async () => {
		let received: Parameters<IpythonSecurityCoordinator["preflight"]>[0] | undefined;
		let identity: { cwd: string; sessionId: string } | undefined;
		const resolved = owners({
			preflight: async input => {
				received = input;
				return plan;
			},
		});
		const service = new IpythonSecurityService({
			coordinator: active => {
				identity = { cwd: active.cwd, sessionId: active.sessionId };
				return resolved.coordinator;
			},
			store: async () => resolved.store,
		});
		const active = await request("security.plan", {
			target_kind: "ref_diff",
			base_revision: "main",
			head_revision: "HEAD",
			include_paths: ["src"],
			credential_id: 7,
		});
		const result = await service.handlers["security.plan"]!(active.request);
		expect(identity).toEqual({ cwd: "/active/cwd", sessionId: "active-session" });
		expect(received?.target).toEqual({
			kind: "ref_diff",
			baseRevision: "main",
			headRevision: "HEAD",
			includePaths: ["src"],
			excludePaths: undefined,
		});
		expect(received?.credentialId).toBe(7);
		expect(received?.signal).toBe(active.request.signal);
		expect(JSON.stringify(result)).not.toContain("account-secret");
		expect(JSON.stringify(result)).not.toContain("person@example.test");
		expect(JSON.stringify(result)).not.toContain("credentialId");
		expect(JSON.stringify(result)).toContain("credentialAffinity");
		expect(active.progress).toEqual(["Security plan started", "Security plan completed"]);
	});

	test("validates target invariants and unknown fields before resolving an owner", async () => {
		let calls = 0;
		const resolved = owners();
		const service = new IpythonSecurityService({
			coordinator: () => {
				calls++;
				return resolved.coordinator;
			},
			store: async () => resolved.store,
		});
		const missingRef = await request("security.plan", { target_kind: "ref_diff" });
		await expect(service.handlers["security.plan"]!(missingRef.request)).rejects.toThrow("requires base_revision");
		const unknown = await request("security.plan", { surprise: true });
		await expect(service.handlers["security.plan"]!(unknown.request)).rejects.toThrow("unknown field: surprise");
		expect(calls).toBe(0);
	});

	test("returns public operation snapshots and exact cancellation", async () => {
		const resolved = owners();
		const service = new IpythonSecurityService({
			coordinator: () => resolved.coordinator,
			store: async () => resolved.store,
		});
		const statusRequest = await request("security.status", { operation_id: operation.operationId });
		const status = await service.handlers["security.status"]!(statusRequest.request);
		expect(status).toEqual({
			operation: {
				operationId: operation.operationId,
				planId: plan.id,
				scanId: operation.scanId,
				phase: "queued",
				createdAt: plan.createdAt,
				updatedAt: plan.createdAt,
				findingCount: 0,
				error: undefined,
			},
		});
		expect(JSON.stringify(status)).not.toContain("session.jsonl");
		expect(JSON.stringify(status)).not.toContain("job-internal");
		const cancelRequest = await request("security.cancel", { operation_id: operation.operationId });
		expect(await service.handlers["security.cancel"]!(cancelRequest.request)).toEqual({ cancelled: true });
	});

	test("persists a bounded validation that cites existing evidence", async () => {
		let calls = 0;
		let persisted: Parameters<IpythonSecurityStore["updateValidation"]>[2] | undefined;
		const resolved = owners({
			updateValidation: async (scanId, findingId, validation) => {
				calls++;
				expect(scanId).toBe(operation.scanId);
				expect(findingId).toBe("finding-1");
				expect(validation.evidenceIds).toEqual(["evidence-1"]);
				persisted = validation;
				return {
					...finding(),
					evidence: [{ id: "evidence-1", kind: "code", label: "source", explanation: "Cited source." }],
					validation,
				};
			},
		});
		const service = new IpythonSecurityService({
			coordinator: () => resolved.coordinator,
			store: async () => resolved.store,
		});
		const active = await request("security.validate", {
			scan_id: operation.scanId,
			finding_id: "finding-1",
			status: "validated",
			summary: "The cited source reproduces the issue.",
			evidence_ids: ["evidence-1"],
		});
		expect(await service.handlers["security.validate"]!(active.request)).toMatchObject({
			finding: {
				id: "finding-1",
				validation: {
					status: "validated",
					summary: "The cited source reproduces the issue.",
					evidenceIds: ["evidence-1"],
				},
			},
		});
		expect(persisted?.validatedAt).toSatisfy(value => !Number.isNaN(Date.parse(value ?? "")));

		const unknown = await request("security.validate", {
			scan_id: operation.scanId,
			finding_id: "finding-1",
			status: "validated",
			summary: "The cited source reproduces the issue.",
			evidence_ids: ["evidence-1"],
			validation_evidence: [],
		});
		await expect(service.handlers["security.validate"]!(unknown.request)).rejects.toThrow(
			"unknown field: validation_evidence",
		);
		const missingEvidence = await request("security.validate", {
			scan_id: operation.scanId,
			finding_id: "finding-1",
			status: "validated",
			summary: "The cited source reproduces the issue.",
			evidence_ids: [],
		});
		await expect(service.handlers["security.validate"]!(missingEvidence.request)).rejects.toThrow(
			"evidence_ids must be a nonempty list of existing evidence ids",
		);
		expect(calls).toBe(1);
	});

	test("publishes bounded findings with recursively private provenance removed", async () => {
		const resolved = owners();
		const service = new IpythonSecurityService({
			coordinator: () => resolved.coordinator,
			store: async active => {
				expect(active.cwd).toBe("/active/cwd");
				return resolved.store;
			},
		});
		const active = await request("security.findings", { scan_id: operation.scanId });
		const result = await service.handlers["security.findings"]!(active.request);
		expect(JSON.stringify(result)).toContain('"safe":"kept"');
		expect(JSON.stringify(result)).not.toContain("private-session");
		expect(JSON.stringify(result)).not.toContain("private-key");
		expect(active.displays).toHaveLength(1);
		expect(active.artifacts).toHaveLength(0);
	});

	test("spills oversized findings to an active-cell JSON artifact", async () => {
		const resolved = owners({ findings: [finding("x".repeat(360_000))] });
		const service = new IpythonSecurityService({
			coordinator: () => resolved.coordinator,
			store: async () => resolved.store,
		});
		const active = await request("security.findings", { scan_id: operation.scanId });
		const result = await service.handlers["security.findings"]!(active.request);
		expect(result.truncated).toBe(true);
		expect(active.displays).toHaveLength(0);
		expect(active.artifacts).toHaveLength(1);
		expect((await fs.stat(active.artifacts[0]!)).size).toBeGreaterThan(350_000);
	});

	test("rejects a cancelled request before resolving host owners", async () => {
		let calls = 0;
		const resolved = owners();
		const service = new IpythonSecurityService({
			coordinator: () => {
				calls++;
				return resolved.coordinator;
			},
			store: async () => resolved.store,
		});
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const active = await request("security.start", { plan_id: plan.id }, controller.signal);
		await expect(service.handlers["security.start"]!(active.request)).rejects.toThrow("cancelled");
		expect(calls).toBe(0);
	});

	test("exposes publication only to the bound scan session and validates before publishing", async () => {
		const resolved = owners();
		const ordinary = new IpythonSecurityService({
			coordinator: () => resolved.coordinator,
			store: async () => resolved.store,
		});
		expect(ordinary.handlers["security.publish"]).toBeUndefined();

		let calls = 0;
		let received: unknown;
		const scan = new IpythonSecurityService({
			coordinator: () => resolved.coordinator,
			store: async () => resolved.store,
			publisher: async input => {
				calls++;
				received = input;
				return { scanId: "scan-1", findingCount: 0, status: "completed" };
			},
		});
		const invalid = await request("security.publish", {
			findings: [{ title: "missing required fields" }],
			coverage: { completeness: "complete" },
			report: "# Invalid\n",
		});
		await expect(scan.handlers["security.publish"]!(invalid.request)).rejects.toThrow();
		expect(calls).toBe(0);

		const validPayload = {
			findings: [],
			coverage: { completeness: "complete" },
			report: "# Complete\n",
		};
		const valid = await request("security.publish", validPayload);
		expect(await scan.handlers["security.publish"]!(valid.request)).toEqual({
			publication: { scanId: "scan-1", findingCount: 0, status: "completed" },
		});
		expect(received).toEqual(validPayload);
		expect(calls).toBe(1);
	});

	test("does not publish after the active cell is cancelled", async () => {
		const resolved = owners();
		let calls = 0;
		const service = new IpythonSecurityService({
			coordinator: () => resolved.coordinator,
			store: async () => resolved.store,
			publisher: async () => {
				calls++;
				return { scanId: "scan-1", findingCount: 0, status: "completed" };
			},
		});
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const active = await request(
			"security.publish",
			{ findings: [], coverage: { completeness: "complete" }, report: "# Cancelled\n" },
			controller.signal,
		);
		await expect(service.handlers["security.publish"]!(active.request)).rejects.toThrow("cancelled");
		expect(calls).toBe(0);
	});
});
