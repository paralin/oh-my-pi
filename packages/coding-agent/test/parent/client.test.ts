import { describe, expect, test } from "bun:test";
import { ParentClient, type ParentEndpoint } from "@oh-my-pi/pi-coding-agent/parent/client";
import type {
	OpenEnvironmentRequest,
	OpenEnvironmentResponse,
} from "@oh-my-pi/pi-coding-agent/parent/generated/parent-environment.pb";
import type { ParentEnvironmentServiceClient } from "@oh-my-pi/pi-coding-agent/parent/generated/parent-environment_srpc.pb";

function lease(response: OpenEnvironmentResponse): AsyncIterable<OpenEnvironmentResponse> {
	return {
		async *[Symbol.asyncIterator]() {
			yield response;
			await new Promise(() => {});
		},
	};
}
function endpoint(service: Partial<ParentEnvironmentServiceClient>, close = () => Promise.resolve()): ParentEndpoint {
	return { service: service as ParentEnvironmentServiceClient, usable: true, close };
}

describe("ParentClient", () => {
	test("binds a managed session once and adds the opaque environment ID to calls", async () => {
		const opens: OpenEnvironmentRequest[] = [];
		const lists: unknown[] = [];
		const service = {
			OpenEnvironment(request: OpenEnvironmentRequest) {
				opens.push(request);
				return lease({ environmentId: "env-1" });
			},
			async ListSessions(request: unknown) {
				lists.push(request);
				return { sessions: [{ sessionId: "session-2" }] };
			},
		};
		let endpointOpens = 0;
		const client = ParentClient.create({
			env: { OMP_PARENT_SOCKET: "/tmp/parent.sock", OMP_PARENT_SESSION: "session-1" },
			openEndpoint: async () => {
				endpointOpens++;
				return endpoint(service);
			},
		});
		expect(client).toBeDefined();
		expect(await client!.listSessions(7)).toEqual([{ sessionId: "session-2" }]);
		expect(await client!.listSessions(8)).toEqual([{ sessionId: "session-2" }]);
		expect(endpointOpens).toBe(1);
		expect(opens).toEqual([{ root: { case: "managedSessionId", value: "session-1" } }]);
		expect(lists).toEqual([
			{ environmentId: "env-1", limit: 7 },
			{ environmentId: "env-1", limit: 8 },
		]);
		await client!.close();
	});

	test("retires a failed configured endpoint without reconnecting or falling back", async () => {
		const failure = new Error("configured parent failed");
		let opens = 0;
		const service = {
			OpenEnvironment() {
				return lease({ environmentId: "env-1" });
			},
			async ListSessions() {
				throw failure;
			},
		};
		const client = ParentClient.create({
			env: { OMP_PARENT_SOCKET: "/tmp/parent.sock", OMP_PARENT_SESSION: "session-1" },
			openEndpoint: async () => {
				opens++;
				return endpoint(service);
			},
		})!;
		await expect(client.listSessions(1)).rejects.toBe(failure);
		await expect(client.listSessions(1)).rejects.toBe(failure);
		expect(opens).toBe(1);
	});

	test("does not retire the shared endpoint for one canceled call", async () => {
		let calls = 0;
		let opens = 0;
		const service = {
			OpenEnvironment() {
				return lease({ environmentId: "env-1" });
			},
			async ListSessions() {
				calls++;
				if (calls === 1) {
					const error = new Error("cancelled");
					error.name = "AbortError";
					throw error;
				}
				return { sessions: [] };
			},
		};
		const client = ParentClient.create({
			env: { OMP_PARENT_SOCKET: "/tmp/parent.sock", OMP_PARENT_SESSION: "session-1" },
			openEndpoint: async () => {
				opens++;
				return endpoint(service);
			},
		})!;
		await expect(client.listSessions(1)).rejects.toHaveProperty("name", "AbortError");
		expect(await client.listSessions(1)).toEqual([]);
		expect(opens).toBe(1);
		await client.close();
	});
});
