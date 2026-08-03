import { describe, expect, test } from "bun:test";
import {
	DEFAULT_LOOKUP_TIMEOUT_MS,
	MAX_SESSION_PAGE,
	WorldClient,
	type WorldEndpoint,
	type WorldService,
} from "../client.js";
import { WORLD_SOCKET_ENV } from "../config.js";
import type { LookupDispatchIntentResponse, SessionSummary } from "../generated/llmsession.pb.js";
import type { DialFn } from "../transport.js";

const SOCKET = "/run/glados/console.sock";

/** A dial seam that records every call and never opens anything. */
function recordingDial(): { dial: DialFn; calls: string[] } {
	const calls: string[] = [];
	const dial: DialFn = async socketPath => {
		calls.push(socketPath);
		throw new Error("dial seam was reached");
	};
	return { dial, calls };
}

interface FakeEndpointOptions {
	sessions?: SessionSummary[];
	intents?: Record<string, LookupDispatchIntentResponse>;
	/** Never settles, so the caller's abort is the only way out. */
	hang?: boolean;
	/** Consulted per call, so one fake can answer first and hang later. */
	hangNow?: () => boolean;
	/** Fail the next call with this error, retiring the endpoint. */
	failWith?: Error;
	/** Consulted per call, so one fake can fail once and then serve. */
	failNow?: () => Error | undefined;
	/** Called after the lookup has entered the endpoint seam. */
	lookupStarted?: () => void;
}

/** The rejection an aborted operation produces. */
function abortLike(): Error {
	const error = new Error("World client operation aborted");
	error.name = "AbortError";
	return error;
}

/**
 * Exactly what starpc throws when it cancels a call mid-flight.
 *
 * Constructed here rather than imported so the test pins the observable shape:
 * a plain Error whose name is "Error" and whose message is the sentinel. A
 * client matching on `name === "AbortError"` alone does not see this.
 */
function starpcAbortLike(): Error {
	return new Error("ERR_RPC_ABORT");
}

interface FakeEndpointLog {
	opens: number;
	limits: number[];
	lookups: string[];
	lookupWaits: boolean[];
	closes: number;
}

/**
 * Build the endpoint seam plus a log of what the client did through it. The
 * generated service is replaced wholesale, so these tests exercise the client's
 * own bounding, absence handling, and endpoint lifecycle without a daemon.
 */
function fakeEndpoints(options: FakeEndpointOptions = {}) {
	const log: FakeEndpointLog = { opens: 0, limits: [], lookups: [], lookupWaits: [], closes: 0 };
	const retire: Array<() => void> = [];
	const openEndpoint = async (): Promise<WorldEndpoint> => {
		log.opens++;
		let usable = true;
		retire.push(() => {
			usable = false;
		});
		const service: WorldService = {
			ListSessions: async req => {
				log.limits.push(req.limit);
				const failure = options.failWith ?? options.failNow?.();
				if (failure) throw failure;
				if (options.hang || options.hangNow?.()) return await new Promise(() => {});
				return { sessions: (options.sessions ?? []).slice(0, req.limit) };
			},
			LookupDispatchIntent: async req => {
				log.lookups.push(req.intentKey);
				log.lookupWaits.push(req.waitForCustody);
				options.lookupStarted?.();
				const failure = options.failWith ?? options.failNow?.();
				if (failure) throw failure;
				if (options.hang || options.hangNow?.()) return await new Promise(() => {});
				return options.intents?.[req.intentKey] ?? { found: false };
			},
		};
		const endpoint: WorldEndpoint = {
			service,
			get usable() {
				return usable;
			},
			// Mirrors the real endpoint: starpc scopes the cancellation to the one
			// call, so the session stays usable and the next call reuses it.
			call: async (pending, signal) => {
				if (!signal) return await pending;
				if (signal.aborted) throw abortLike();
				const aborted = Promise.withResolvers<never>();
				const onAbort = () => aborted.reject(abortLike());
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					return await Promise.race([pending, aborted.promise]);
				} finally {
					signal.removeEventListener("abort", onAbort);
					aborted.promise.catch(() => {});
				}
			},
			close: async () => {
				usable = false;
				log.closes++;
			},
		};
		return endpoint;
	};
	/** Retire every endpoint opened so far, as a daemon restart would. */
	const retireAll = () => {
		for (const stop of retire) stop();
	};
	return { openEndpoint, log, retireAll };
}

describe("unconfigured world client", () => {
	// The whole integration is opt-in. With no socket configured the runtime
	// must not construct a transport, and must never reach the dial seam.
	test("constructs nothing and never dials", () => {
		const { dial, calls } = recordingDial();
		const client = WorldClient.create({ env: {}, setting: undefined, dial });
		expect(client).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("still never dials when only a blank value is configured", () => {
		const { dial, calls } = recordingDial();
		expect(WorldClient.create({ env: { [WORLD_SOCKET_ENV]: "  " }, setting: "", dial })).toBeUndefined();
		expect(calls).toEqual([]);
	});

	// Construction is lazy on both sides: a configured client that is never used
	// also never dials.
	test("a configured client dials nothing until an operation runs", () => {
		const { dial, calls } = recordingDial();
		const client = WorldClient.create({ env: {}, setting: SOCKET, dial });
		expect(client?.socketPath).toBe(SOCKET);
		expect(client?.connected).toBe(false);
		expect(calls).toEqual([]);
	});
});

describe("bounded session listing", () => {
	const sessions: SessionSummary[] = Array.from({ length: 8 }, (_, index) => ({
		sessionObjectKey: `glados/live/omp/${index}/llm-session`,
	}));

	test("two configured clients receive the same bounded page", async () => {
		const first = fakeEndpoints({ sessions });
		const second = fakeEndpoints({ sessions });
		const clientA = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint: first.openEndpoint })!;
		const clientB = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint: second.openEndpoint })!;

		const pageA = await clientA.listSessions(3);
		const pageB = await clientB.listSessions(3);

		expect(pageA).toHaveLength(3);
		expect(pageA).toEqual(pageB);
		expect(first.log.limits).toEqual([3]);
		expect(second.log.limits).toEqual([3]);
	});

	test("requires a positive bound", async () => {
		const { openEndpoint, log } = fakeEndpoints({ sessions });
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		for (const limit of [0, -1, 1.5, Number.NaN]) {
			await expect(client.listSessions(limit)).rejects.toThrow(/positive integer/);
		}
		await expect(client.listSessions(MAX_SESSION_PAGE + 1)).rejects.toThrow(/page bound/);
		// A rejected bound must not reach the daemon at all.
		expect(log.opens).toBe(0);
		expect(log.limits).toEqual([]);
	});

	test("reuses one connection across calls", async () => {
		const { openEndpoint, log } = fakeEndpoints({ sessions });
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		await client.listSessions(2);
		await client.listSessions(2);
		expect(log.opens).toBe(1);
	});
});

describe("direct dispatch intent lookup", () => {
	const key = "di:yom4a33uzh2gx5u2y5lhhjtxex6vtvxfqljzcmyavhj4zwyzywra";
	const known: LookupDispatchIntentResponse = {
		found: true,
		intentState: "DISPATCH_INTENT_STATE_CLAIMED",
		activeAttemptKey: `${key}#1`,
		attemptState: "DISPATCH_ATTEMPT_STATE_RUNNING",
		session: { sessionObjectKey: "glados/live/omp/recovered/llm-session" },
		custody: { dispatchKey: `${key}#1/dispatch` },
	};

	test("resolves a known key to its active attempt and session", async () => {
		const { openEndpoint, log } = fakeEndpoints({ intents: { [key]: known } });
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		const lookup = await client.lookupDispatchIntent(key);
		expect(lookup.found).toBe(true);
		if (!lookup.found) throw new Error("unreachable");
		expect(lookup.activeAttemptKey).toBe(`${key}#1`);
		expect(lookup.attemptState).toBe("DISPATCH_ATTEMPT_STATE_RUNNING");
		expect(lookup.session?.sessionObjectKey).toBe("glados/live/omp/recovered/llm-session");
		expect(log.lookups).toEqual([key]);
		expect(log.lookupWaits).toEqual([true]);
		expect(lookup.awaitingCustody).toBe(false);
	});

	test("surfaces a non-waiting custody observation", async () => {
		const awaiting = { ...known, awaitingCustody: true };
		const { openEndpoint, log } = fakeEndpoints({ intents: { [key]: awaiting } });
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		const lookup = await client.lookupDispatchIntent(key, undefined, DEFAULT_LOOKUP_TIMEOUT_MS, false);
		expect(lookup.found).toBe(true);
		if (!lookup.found) throw new Error("unreachable");
		expect(lookup.awaitingCustody).toBe(true);
		expect(log.lookupWaits).toEqual([false]);
	});

	// Absence is typed, not an error: a client recovering a lost submit needs to
	// distinguish "the daemon never took this work" from "the lookup failed".
	test("reports an absent key as a typed absence", async () => {
		const { openEndpoint, log } = fakeEndpoints({ intents: { [key]: known } });
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		const lookup = await client.lookupDispatchIntent("di:absent");
		expect(lookup).toEqual({ found: false });
		expect(log.lookups).toEqual(["di:absent"]);
	});

	// The daemon deliberately holds this read open while an attempt binds, which
	// is what removes client polling. An attempt that never binds would then
	// hold an unbounded caller forever, so the client brings its own deadline.
	test("bounds a lookup that the daemon never answers", async () => {
		const { openEndpoint } = fakeEndpoints({ hang: true });
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		await expect(client.lookupDispatchIntent("di:never-binds", undefined, 10)).rejects.toThrow(
			/exceeded 10ms for di:never-binds/,
		);
	});

	test("documents a default deadline and lets a caller opt out", async () => {
		expect(DEFAULT_LOOKUP_TIMEOUT_MS).toBeGreaterThan(0);
		const lookupStarted = Promise.withResolvers<void>();
		const { openEndpoint, log } = fakeEndpoints({ hang: true, lookupStarted: lookupStarted.resolve });
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		// A non-positive timeout opts out; the caller's own signal still governs.
		const controller = new AbortController();
		const pending = client.lookupDispatchIntent("di:unbounded", controller.signal, 0);
		await lookupStarted.promise;
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/);
		expect(log.lookups).toEqual(["di:unbounded"]);
	});

	// The caller's own cancellation must stay distinguishable from the deadline.
	test("reports a caller abort as an abort, not as the deadline", async () => {
		const lookupStarted = Promise.withResolvers<void>();
		const { openEndpoint } = fakeEndpoints({ hang: true, lookupStarted: lookupStarted.resolve });
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		const controller = new AbortController();
		const pending = client.lookupDispatchIntent("di:caller-aborts", controller.signal, 60_000);
		await lookupStarted.promise;
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/);
		await expect(pending).rejects.not.toThrow(/exceeded/);
	});

	test("rejects an empty key without contacting the daemon", async () => {
		const { openEndpoint, log } = fakeEndpoints();
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		await expect(client.lookupDispatchIntent("   ")).rejects.toThrow(/dispatch intent key is required/);
		expect(log.opens).toBe(0);
	});

	test("derives the key it looks up without touching a transport", () => {
		const { openEndpoint, log } = fakeEndpoints();
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		const derived = client.deriveIntentKey({
			ownerArtifact: "plans/dispatch.org::*Structures",
			objective: "  Implement   dispatch identity ",
			repository: "github.com/aperturerobotics/glados",
			checkoutIdentity: "glados",
			worktreeIdentity: "wt/glados-dispatch",
			workingDirectory: "repos/glados",
			deliverablePaths: ["plans/dispatch-report.org"],
			writeSurfaces: ["repos/glados/core", "plans/dispatch.org"],
		});
		expect(derived.intentKey).toBe(key);
		expect(log.opens).toBe(0);
	});
});

describe("cancellation, close, and reconnect", () => {
	// starpc cancels the one call on the signal it is already handed, so an
	// abort must not cost the session. Retiring the transport per abort would
	// make every cancelled operation charge the next caller a full re-dial and
	// re-handshake.
	test("aborting a call keeps the same endpoint serving", async () => {
		let hanging = false;
		const { openEndpoint, log } = fakeEndpoints({
			sessions: [{ sessionObjectKey: "glados/live/omp/after-abort/llm-session" }],
			hangNow: () => hanging,
		});
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;

		await client.listSessions(1);
		expect(log.opens).toBe(1);

		hanging = true;
		const controller = new AbortController();
		const pending = client.listSessions(5, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/);

		// The session survived: nothing was closed and nothing was reopened.
		expect(log.closes).toBe(0);
		expect(client.connected).toBe(true);

		hanging = false;
		const recovered = await client.listSessions(1);
		expect(recovered).toHaveLength(1);
		expect(log.opens).toBe(1);
	});

	// starpc raises a plain Error("ERR_RPC_ABORT") when it cancels a call
	// mid-flight, not a DOMException-shaped AbortError. On a shared Yamux
	// connection, reading that as a dead transport would tear down the session
	// and every concurrent call on it because one caller aborted.
	test("treats starpc's mid-call abort as scoped cancellation", async () => {
		const { openEndpoint, log } = fakeEndpoints({
			sessions: [{ sessionObjectKey: "glados/live/omp/shared/llm-session" }],
			failWith: starpcAbortLike(),
		});
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;

		await expect(client.listSessions(1)).rejects.toThrow(/ERR_RPC_ABORT/);

		// The shared endpoint survives, so concurrent work on it is untouched.
		expect(log.closes).toBe(0);
		expect(client.connected).toBe(true);
		expect(log.opens).toBe(1);
	});

	test("retires an endpoint when a non-Error rejection escapes the service", async () => {
		let closes = 0;
		const endpoint: WorldEndpoint = {
			usable: true,
			service: {
				ListSessions: async () => await Promise.reject(null),
				LookupDispatchIntent: async () => ({ found: false }),
			},
			call: async pending => await pending,
			close: async () => {
				closes++;
			},
		};
		const client = WorldClient.create({
			env: {},
			setting: SOCKET,
			openEndpoint: async () => endpoint,
		})!;
		let rejection: unknown;
		try {
			await client.listSessions(1);
		} catch (error) {
			rejection = error;
		}
		expect(rejection).toBeNull();
		expect(closes).toBe(1);
		expect(client.connected).toBe(false);
	});

	// The same plain Error must not retire the endpoint for a concurrent caller
	// either: one cancelled call cannot cancel its neighbours.
	test("keeps concurrent calls alive when one is cancelled mid-flight", async () => {
		let cancelNext = true;
		const { openEndpoint, log } = fakeEndpoints({
			sessions: [{ sessionObjectKey: "glados/live/omp/neighbour/llm-session" }],
			failNow: () => {
				const fail = cancelNext;
				cancelNext = false;
				return fail ? starpcAbortLike() : undefined;
			},
		});
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;

		const [cancelled, neighbour] = await Promise.allSettled([client.listSessions(1), client.listSessions(1)]);
		expect(cancelled.status).toBe("rejected");
		expect(neighbour.status).toBe("fulfilled");
		expect(log.closes).toBe(0);
		expect(log.opens).toBe(1);
		expect(client.connected).toBe(true);
	});

	// A transport that actually failed is a different case from a cancelled
	// call, and must not be reused.
	test("a failed call retires the endpoint and the next call reconnects", async () => {
		let attempt = 0;
		const failing = fakeEndpoints({ failWith: new Error("daemon restarted") });
		const healthy = fakeEndpoints({ sessions: [{ sessionObjectKey: "glados/live/omp/after/llm-session" }] });
		const client = WorldClient.create({
			env: {},
			setting: SOCKET,
			openEndpoint: async () => {
				attempt++;
				return attempt === 1 ? await failing.openEndpoint() : await healthy.openEndpoint();
			},
		})!;

		await expect(client.listSessions(4)).rejects.toThrow(/daemon restarted/);
		expect(failing.log.closes).toBe(1);
		expect(client.connected).toBe(false);

		const recovered = await client.listSessions(4);
		expect(recovered).toHaveLength(1);
		expect(attempt).toBe(2);
		expect(healthy.log.opens).toBe(1);
	});

	// A daemon restart retires the session without any call failing. The next
	// operation must notice and rebuild rather than replay a handle the daemon
	// has forgotten.
	test("a stale endpoint is rejected and replaced on the next call", async () => {
		const { openEndpoint, log, retireAll } = fakeEndpoints({
			sessions: [{ sessionObjectKey: "glados/live/omp/stale/llm-session" }],
		});
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;

		await client.listSessions(1);
		expect(log.opens).toBe(1);
		expect(client.connected).toBe(true);

		retireAll();
		expect(client.connected).toBe(false);

		await client.listSessions(1);
		expect(log.opens).toBe(2);
		expect(log.closes).toBe(1);
	});

	// Two operations can share one endpoint. If the first fails and reconnects,
	// the second's later failure must not close the healthy replacement the
	// first just established, nor break calls already running on it.
	test("a late failure does not discard the endpoint that replaced it", async () => {
		const stalled = Promise.withResolvers<{ sessions?: SessionSummary[] }>();
		const closed: number[] = [];
		const retire: Array<() => void> = [];
		let opened = 0;
		const openEndpoint = async (): Promise<WorldEndpoint> => {
			const id = ++opened;
			let usable = true;
			retire.push(() => {
				usable = false;
			});
			const service: WorldService = {
				ListSessions: async () =>
					id === 1
						? await stalled.promise
						: { sessions: [{ sessionObjectKey: "glados/live/omp/replacement/llm-session" }] },
				LookupDispatchIntent: async () => ({ found: false }),
			};
			return {
				service,
				get usable() {
					return usable;
				},
				call: async pending => await pending,
				close: async () => {
					usable = false;
					closed.push(id);
				},
			};
		};
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;

		// One call is in flight on endpoint 1 and has not failed yet.
		const inFlight = client.listSessions(1);
		const settled = inFlight.then(
			() => "resolved" as const,
			() => "rejected" as const,
		);
		await Promise.resolve();

		// Endpoint 1 goes stale, so the next call discards it and opens endpoint 2.
		retire[0]();
		const replacement = await client.listSessions(1);
		expect(replacement).toHaveLength(1);
		expect(opened).toBe(2);
		expect(closed).toEqual([1]);

		// Only now does the first call fail. Its discard names endpoint 1, which
		// is no longer current, so endpoint 2 must survive untouched.
		stalled.reject(new Error("first call failed late"));
		expect(await settled).toBe("rejected");
		expect(closed).toEqual([1]);
		expect(client.connected).toBe(true);
	});

	// Without a caller signal there is nothing but the client's own lifetime to
	// cancel a connect. Close has to settle it, or closing during startup hangs
	// forever on a daemon that never answers.
	test("close settles a connect that is still opening", async () => {
		let opens = 0;
		let aborts = 0;
		const openEndpoint = (_socketPath: string, signal: AbortSignal): Promise<WorldEndpoint> => {
			opens++;
			return new Promise<WorldEndpoint>((_resolve, reject) => {
				if (signal.aborted) {
					aborts++;
					reject(abortLike());
					return;
				}
				signal.addEventListener(
					"abort",
					() => {
						aborts++;
						reject(abortLike());
					},
					{ once: true },
				);
			});
		};
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;

		const pending = client.listSessions(1);
		const settled = pending.then(
			() => "resolved" as const,
			() => "rejected" as const,
		);

		await client.close();

		expect(opens).toBe(1);
		expect(aborts).toBe(1);
		expect(await settled).toBe("rejected");
		expect(client.connected).toBe(false);
	});

	test("closing releases the endpoint and refuses further work", async () => {
		const { openEndpoint, log } = fakeEndpoints({ sessions: [] });
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		await client.listSessions(1);
		await client.close();
		expect(log.closes).toBe(1);

		await client.close();
		expect(log.closes).toBe(1);

		await expect(client.listSessions(1)).rejects.toThrow(/World client is closed/);
		await expect(client.lookupDispatchIntent("di:anything")).rejects.toThrow(/World client is closed/);
		expect(log.opens).toBe(1);
	});

	test("an already-aborted signal fails before opening a connection", async () => {
		const { openEndpoint, log } = fakeEndpoints();
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		await expect(client.listSessions(1, AbortSignal.abort())).rejects.toThrow(/aborted/);
		expect(log.opens).toBe(0);
	});
});
