import { describe, expect, test } from "bun:test";
import {
	assertWorldRequestId,
	DEFAULT_LOOKUP_TIMEOUT_MS,
	formatWorldURI,
	type InteractiveRootSpec,
	MAX_SESSION_PAGE,
	MAX_WORLD_READ_PAGE,
	WORLD_LISTING_SELECTOR,
	WORLD_OPERATION_PERMISSIONS,
	WorldAuthorityError,
	WorldClient,
	type WorldEndpoint,
	WorldEndpointError,
	WorldOperationError,
	type WorldService,
} from "@oh-my-pi/pi-coding-agent/world/client";
import type { DialFn } from "@oh-my-pi/pi-coding-agent/world/transport";
import { WORLD_SESSION_ENV, WORLD_SOCKET_ENV } from "../../src/world/config.js";
import type {
	AccessInteractiveRootResponse,
	LookupDispatchIntentResponse,
	ReadWorldURIResponse,
	ResolveAgentPeerResponse,
	SessionSummary,
	WatchAgentTreeResponse,
	WatchPeerMailboxResponse,
	WatchSessionResponse,
	WorldRuntimeMutationRequest,
	WorldRuntimeMutationResponse,
	WorldRuntimeWatchRequest,
	WorldRuntimeWatchResponse,
} from "../../src/world/generated/llmsession.pb.js";
import {
	PeerMessageAckOutcome,
	PeerMessageOutcome,
	WorldAuthorityDenialCode,
	WorldOperationFailureCode,
	WorldRuntimeOperation,
	WorldTaskAgentSource,
	WorldWatchCompletion,
} from "../../src/world/generated/llmsession.pb.js";

const SOCKET = "/run/glados/console.sock";
const CALLER = "glados/llm-session/caller";

/** A complete portable identity tuple, so tests vary one field at a time. */
const IDENTITY = {
	ownerArtifact: "repos/glados",
	objective: "Fix the flaky auth test",
	repository: "github.com/aperturerobotics/glados",
	checkoutIdentity: "glados",
	worktreeIdentity: "fix-auth",
	workingDirectory: ".",
	deliverablePaths: ["notes/2026/20260803.org"],
	writeSurfaces: ["src/auth"],
};

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
	/** Response the ReadWorldURI fake returns. */
	read?: ReadWorldURIResponse;
	/** Fail the next call with this error, retiring the endpoint. */
	failWith?: Error;
	/** Consulted per call, so one fake can fail once and then serve. */
	failNow?: () => Error | undefined;
	/** Called after the lookup has entered the endpoint seam. */
	lookupStarted?: () => void;
	/** Child resource id `AccessWorldRuntime` hands back. Zero means "none". */
	runtimeResourceId?: number;
	/** Answer for one `Mutate` call, consulted per call. */
	mutate?: (req: WorldRuntimeMutationRequest) => WorldRuntimeMutationResponse;
	/** Snapshots one `WatchDispatch` stream yields before closing. */
	watch?: (req: WorldRuntimeWatchRequest) => WorldRuntimeWatchResponse[];
	/** Exact response for one durable peer resolution. */
	resolvePeer?: (peerId: string) => ResolveAgentPeerResponse;
	/** Child resource id `AccessSession` hands back. */
	sessionResourceId?: number;
	/** Complete snapshots one bound session watch yields before closing. */
	sessionWatch?: WatchSessionResponse[];
	/** Complete root Agent-tree snapshots before the stream closes. */
	agentTreeWatch?: WatchAgentTreeResponse[];
	/** Durable caller mailbox records before the stream closes. */
	mailboxWatch?: WatchPeerMailboxResponse[];
	/** Failure raised by the caller mailbox stream. */
	mailboxFailure?: Error;
	/** Response held by one interactive-root admission call. */
	interactiveResponse?: AccessInteractiveRootResponse;
	/** Failure from adopting the admitted interactive child. */
	adoptFailure?: Error;
}

/**
 * The runtime seams the endpoint-lifetime fakes never reach.
 *
 * They throw rather than returning a stub so a test that starts depending on a
 * caller binding fails loudly instead of silently exercising an empty one.
 */
const unusedBinding: WorldService["AccessWorldRuntime"] = async () => {
	throw new Error("this endpoint binds no caller");
};

const unusedRuntime: WorldEndpoint["accessRuntime"] = () => {
	throw new Error("this endpoint has no runtime binding");
};

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

interface FakeWorldRead {
	uri: string;
	limit: number;
}

interface FakeEndpointLog {
	reads: FakeWorldRead[];
	opens: number;
	limits: number[];
	lookups: string[];
	lookupWaits: boolean[];
	closes: number;
	/** Caller keys `AccessWorldRuntime` was asked to bind, one per bind. */
	binds: string[];
	/** Child resource ids the client bound a runtime service to. */
	boundResources: number[];
	resolvedPeers: string[];
	accessedSessions: string[];
	agentTreeWatches: number;
	mailboxWatches: number;
	boundSessionResources: number[];
	mutations: WorldRuntimeMutationRequest[];
	watches: WorldRuntimeWatchRequest[];
	runtimeReleases: number;
	sessionReleases: number;
	interactiveEvents: string[];
}

/**
 * Build the endpoint seam plus a log of what the client did through it. The
 * generated service is replaced wholesale, so these tests exercise the client's
 * own bounding, absence handling, and endpoint lifecycle without a daemon.
 */
function fakeEndpoints(options: FakeEndpointOptions = {}) {
	const log: FakeEndpointLog = {
		reads: [],
		opens: 0,
		limits: [],
		lookups: [],
		lookupWaits: [],
		closes: 0,
		binds: [],
		boundResources: [],
		resolvedPeers: [],
		accessedSessions: [],
		agentTreeWatches: 0,
		mailboxWatches: 0,
		boundSessionResources: [],
		mutations: [],
		watches: [],
		runtimeReleases: 0,
		sessionReleases: 0,
		interactiveEvents: [],
	};
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
			ReadWorldURI: async req => {
				log.reads.push({ uri: req.uri, limit: req.limit });
				const failure = options.failWith ?? options.failNow?.();
				if (failure) throw failure;
				if (options.hang || options.hangNow?.()) return await new Promise(() => {});
				return options.read ?? { objectKey: req.uri, found: false };
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
			AccessWorldRuntime: async req => {
				log.binds.push(req.callerSessionObjectKey);
				const failure = options.failWith ?? options.failNow?.();
				if (failure) throw failure;
				return { resourceId: options.runtimeResourceId ?? 7 };
			},
			AccessSession: async req => {
				log.accessedSessions.push(req.sessionObjectKey);
				return { resourceId: options.sessionResourceId ?? 9 };
			},
			WatchAgentTree: () => {
				log.agentTreeWatches += 1;
				return (async function* () {
					for (const response of options.agentTreeWatch ?? []) yield response;
				})();
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
			callInteractiveRootWithReceipt: async () => {
				log.interactiveEvents.push("access");
				return {
					response: options.interactiveResponse ?? {},
					commit: async () => {
						log.interactiveEvents.push("commit");
					},
					abort: async () => {
						log.interactiveEvents.push("abort");
					},
				};
			},
			adoptResource: async () => {
				log.interactiveEvents.push("adopt");
				if (options.adoptFailure) throw options.adoptFailure;
			},
			accessInteractiveRoot: resourceId => {
				log.interactiveEvents.push(`bind:${resourceId}`);
				return {
					service: {
						Rotate: async () => options.interactiveResponse?.binding ?? {},
						Reconfigure: async () => options.interactiveResponse?.binding ?? {},
					},
					runtime: {
						Mutate: async () => {
							throw new Error("interactive runtime fake is unused");
						},
						WatchDispatch: () =>
							(async function* () {
								yield* [] as WorldRuntimeWatchResponse[];
							})(),
					},
					release: async () => {
						log.interactiveEvents.push("release");
					},
				};
			},
			accessRuntime: resourceId => {
				log.boundResources.push(resourceId);
				return {
					service: {
						Mutate: async req => {
							log.mutations.push(req);
							const failure = options.failWith ?? options.failNow?.();
							if (failure) throw failure;
							if (options.hang || options.hangNow?.()) return await new Promise(() => {});
							if (!options.mutate) throw new Error("fake endpoint has no mutation answer");
							return options.mutate(req);
						},
						WatchDispatch: req => {
							log.watches.push(req);
							const responses = options.watch?.(req) ?? [];
							return (async function* () {
								const failure = options.failWith ?? options.failNow?.();
								if (failure) throw failure;
								for (const response of responses) yield response;
								if (options.hang || options.hangNow?.()) await new Promise(() => {});
							})();
						},
						ResolveAgentPeer: async req => {
							log.resolvedPeers.push(req.peerId);
							return options.resolvePeer?.(req.peerId) ?? { found: false };
						},
						WatchPeerMailbox: () => {
							log.mailboxWatches += 1;
							return (async function* () {
								if (options.mailboxFailure) throw options.mailboxFailure;
								for (const response of options.mailboxWatch ?? []) yield response;
							})();
						},
					},
					release: async () => {
						log.runtimeReleases++;
					},
				};
			},
			accessSession: resourceId => {
				log.boundSessionResources.push(resourceId);
				return {
					service: {
						WatchSession: () =>
							(async function* () {
								for (const response of options.sessionWatch ?? []) yield response;
							})(),
					},
					release: async () => {
						log.sessionReleases++;
					},
				};
			},
			close: async () => {
				usable = false;
				log.closes++;
				log.interactiveEvents.push("close");
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
const INTERACTIVE_SPEC: InteractiveRootSpec = {
	ompSessionId: "omp-session-1",
	processInstanceId: "process-1",
	workingDirectory: "/worktree",
	workspaceRoots: ["/worktree"],
	provider: "openai",
	model: "gpt-5",
	transitionReason: "STARTUP",
	protocolVersion: "omp-w5",
	buildIdentity: "test-build",
};

const INTERACTIVE_RESPONSE: AccessInteractiveRootResponse = {
	resourceId: 23,
	binding: {
		ompSessionId: "omp-session-1",
		llmSessionObjectKey: "glados/llm-session/root",
		dispatchIntentKey: "glados/dispatch/intent-1",
		dispatchAttemptKey: "glados/dispatch/attempt-1",
		claimGeneration: 1n,
		manifestDigest: "manifest-1",
		bindingGeneration: 1n,
		configurationDigest: "config-1",
		provider: "openai",
		model: "gpt-5",
	},
};

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

	test("keeps reads and disables mutations when the optional caller is malformed", () => {
		const { dial, calls } = recordingDial();
		const client = WorldClient.create({
			env: {
				[WORLD_SOCKET_ENV]: SOCKET,
				[WORLD_SESSION_ENV]: "glados//caller",
			},
			dial,
		});
		expect(client?.socketPath).toBe(SOCKET);
		expect(client?.canMutate).toBe(false);
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
	// The endpoint is opened against the client's lifetime signal, so releasing
	// it has to happen while that scope is still live. Cancelling the lifetime
	// first would abort the courtesy resource release mid-call and reject it as
	// ERR_RPC_ABORT — a failure the shutdown invented, surfacing to whoever
	// called close and, from a fire-and-forget abort handler, as an unhandled
	// rejection that fails the process.
	test("releases the endpoint before cancelling its own lifetime", async () => {
		let released = 0;
		let releasedAfterAbort = false;
		let lifetime: AbortSignal | undefined;
		const openEndpoint = async (_socketPath: string, signal: AbortSignal): Promise<WorldEndpoint> => {
			lifetime = signal;
			return {
				service: {
					ListSessions: async () => ({ sessions: [] }),
					LookupDispatchIntent: async () => ({ found: false }),
					ReadWorldURI: async req => ({ objectKey: req.uri, found: false }),
					AccessWorldRuntime: unusedBinding,
				},
				usable: true,
				call: async pending => await pending,
				accessRuntime: unusedRuntime,
				close: async () => {
					released++;
					if (signal.aborted) {
						// Exactly what starpc does to a call whose scope is gone.
						releasedAfterAbort = true;
						throw starpcAbortLike();
					}
				},
			};
		};
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		await client.listSessions(1);

		// Rejecting here is the regression: close is the caller's clean shutdown.
		await client.close();

		expect(released).toBe(1);
		expect(releasedAfterAbort).toBe(false);
		// The lifetime is still cancelled, just after the release rather than before.
		expect(lifetime?.aborted).toBe(true);
	});

	test("cancels its lifetime when endpoint release fails", async () => {
		let lifetime: AbortSignal | undefined;
		const openEndpoint = async (_socketPath: string, signal: AbortSignal): Promise<WorldEndpoint> => {
			lifetime = signal;
			return {
				service: {
					ListSessions: async () => ({ sessions: [] }),
					LookupDispatchIntent: async () => ({ found: false }),
					ReadWorldURI: async req => ({ objectKey: req.uri, found: false }),
					AccessWorldRuntime: unusedBinding,
				},
				usable: true,
				call: async pending => await pending,
				accessRuntime: unusedRuntime,
				close: async () => {
					throw new Error("release failed");
				},
			};
		};
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		await client.listSessions(1);

		await expect(client.close()).rejects.toThrow("release failed");

		expect(lifetime?.aborted).toBe(true);
	});

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
				ReadWorldURI: async () => ({ objectKey: "", found: false }),
				AccessWorldRuntime: unusedBinding,
			},
			call: async pending => await pending,
			accessRuntime: unusedRuntime,
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
				// Unused here; this test is about endpoint lifetime, not reads.
				ReadWorldURI: async req => ({ objectKey: req.uri, found: false }),
				AccessWorldRuntime: unusedBinding,
			};
			return {
				service,
				get usable() {
					return usable;
				},
				call: async pending => await pending,
				accessRuntime: unusedRuntime,
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

// The World read seen from the client. Its contract is that
// a malformed or unconfigured read costs nothing: no socket, no daemon round
// trip. Everything rejected below is rejected before #connect runs.
describe("canonical world read", () => {
	const SPACE = "sp1";
	const KEY = "glados/live/omp/abc/llm-session";
	const URI = `/u/1/so/${SPACE}/-/${KEY}`;

	test("an unconfigured root performs no read and no dial", () => {
		const { dial, calls } = recordingDial();
		expect(WorldClient.create({ env: {}, setting: undefined, dial })).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("a malformed uri never dials", async () => {
		const { dial, calls } = recordingDial();
		const client = WorldClient.create({ env: {}, setting: SOCKET, dial })!;
		const malformed = [
			"",
			`${URI}#1`,
			`${URI}?x=1`,
			`/u/1/so/${SPACE}/-/glados/thi%2Fng`,
			`/u/1/so/${SPACE}/-/glados/some thing`,
			`/u/1/so/${SPACE}/-/glados/na\u00efve`,
			`/u/1/so/${SPACE}/-/glados/./thing`,
			`/u/1/so/${SPACE}/-/glados/../thing`,
			`/u/1/so/${SPACE}/-/glados//thing`,
			`/u/1/so/${SPACE}/-/glados/thing/`,
			// An empty Space collapses under path cleaning, so it is not canonical.
			`/u/1/so//-/${KEY}`,
			// Short forms the Spacewave parser would silently default.
			KEY,
			`/${KEY}`,
			`/u/1/${KEY}`,
			`/u/1/so/${SPACE}`,
		];
		for (const uri of malformed) {
			await expect(client.readWorldURI(uri)).rejects.toThrow();
		}
		// The whole point: not one of those reached a socket.
		expect(calls).toEqual([]);
		expect(client.connected).toBe(false);
	});

	test("rejects a non-positive or oversized bound before dialing", async () => {
		const { dial, calls } = recordingDial();
		const client = WorldClient.create({ env: {}, setting: SOCKET, dial })!;
		for (const limit of [0, -1, 1.5, Number.NaN]) {
			await expect(client.readWorldURI(URI, { limit })).rejects.toThrow(/positive integer/);
		}
		await expect(client.readWorldURI(URI, { limit: MAX_WORLD_READ_PAGE + 1 })).rejects.toThrow(/page bound/);
		expect(calls).toEqual([]);
	});

	test("sends the uri unchanged with its bound", async () => {
		const { openEndpoint, log } = fakeEndpoints({ read: { objectKey: KEY, found: false } });
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		await client.readWorldURI(URI, { limit: 25 });
		// Unchanged: no encode, no normalization, no decoration.
		expect(log.reads).toEqual([{ uri: URI, limit: 25 }]);
	});

	test("maps a typed absence", async () => {
		const { openEndpoint } = fakeEndpoints({ read: { objectKey: KEY, found: false } });
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		const read = await client.readWorldURI(URI);
		expect(read).toEqual({ found: false, objectKey: KEY });
	});

	test("maps the projection arm", async () => {
		const { openEndpoint } = fakeEndpoints({
			read: {
				objectKey: KEY,
				found: true,
				read: { case: "snapshot", value: { objectKey: KEY, rows: [{ objectKey: KEY, title: "one" }] } },
			},
		});
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		const read = await client.readWorldURI(URI);
		expect(read.found).toBe(true);
		if (!read.found || read.kind !== "snapshot") throw new Error("expected the snapshot arm");
		expect(read.snapshot.rows?.[0]?.title).toBe("one");
	});

	test("maps the agent-tree arm without flattening it", async () => {
		const { openEndpoint } = fakeEndpoints({
			read: {
				objectKey: "glados/projections/agent-tree",
				found: true,
				read: { case: "agentTree", value: { revision: 7n, agents: [{ agentObjectKey: "glados/agents/root" }] } },
			},
		});
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		const read = await client.readWorldURI(`/u/1/so/${SPACE}/-/glados/projections/agent-tree`);
		if (!read.found || read.kind !== "agentTree") throw new Error("expected the agent-tree arm");
		expect(read.agentTree.agents?.[0]?.agentObjectKey).toBe("glados/agents/root");
	});

	// The listing is selected by the address alone. There is no mode option to
	// disagree with the URI, so the same string always means the same read.
	test("maps the listing arm and carries truncation", async () => {
		const { openEndpoint, log } = fakeEndpoints({
			read: {
				objectKey: "glados/live",
				found: true,
				read: { case: "listing", value: { keys: [KEY], truncated: true } },
			},
		});
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		const listingUri = `/u/1/so/${SPACE}/-/glados/live${WORLD_LISTING_SELECTOR}`;
		const read = await client.readWorldURI(listingUri, { limit: 1 });
		if (!read.found || read.kind !== "listing") throw new Error("expected the listing arm");
		expect(read.keys).toEqual([KEY]);
		// Truncation is carried, not inferred from a short page.
		expect(read.truncated).toBe(true);
		// The selector travels in the address, untouched.
		expect(log.reads[0]?.uri).toBe(listingUri);
	});

	test("formats the canonical address one way", () => {
		expect(formatWorldURI({ sessionIdx: 1, spaceId: SPACE, objectKey: KEY })).toBe(URI);
		expect(formatWorldURI({ sessionIdx: 1, spaceId: SPACE, objectKey: "glados/live", listing: true })).toBe(
			`/u/1/so/${SPACE}/-/glados/live${WORLD_LISTING_SELECTOR}`,
		);
	});

	test("rejects a response carrying no arm", async () => {
		const { openEndpoint } = fakeEndpoints({ read: { objectKey: KEY, found: true } });
		const client = WorldClient.create({ env: {}, setting: SOCKET, openEndpoint })!;
		await expect(client.readWorldURI(URI)).rejects.toThrow(/no arm/);
	});
});

/** One denial, in the shape GLaDOS returns it. */
function denial(
	code: WorldAuthorityDenialCode,
	operation: WorldRuntimeOperation,
	requiredPermission: string,
): WorldRuntimeMutationResponse {
	return {
		operation,
		result: {
			case: "authorityDenial",
			value: {
				operation,
				callerSessionObjectKey: CALLER,
				capabilityDigest: "sha256:cap",
				code,
				requiredPermission,
				detail: "the caller manifest does not allow it",
			},
		},
	};
}

function failure(
	code: WorldOperationFailureCode,
	operation: WorldRuntimeOperation,
	targetObjectKey = "",
): WorldRuntimeMutationResponse {
	return {
		operation,
		result: {
			case: "operationFailure",
			value: { operation, code, targetObjectKey, detail: "stored content differs" },
		},
	};
}

/** A client bound to a caller session, with the runtime seam substituted. */
function runtimeClient(options: Parameters<typeof fakeEndpoints>[0] = {}) {
	const fake = fakeEndpoints(options);
	const client = WorldClient.create({
		env: {},
		setting: SOCKET,
		sessionSetting: CALLER,
		openEndpoint: fake.openEndpoint,
	})!;
	return { client, ...fake };
}

describe("interactive world attachment", () => {
	test("advertises mutation capability before the root binding is adopted", () => {
		const client = WorldClient.create({
			env: {},
			setting: SOCKET,
			interactiveRoot: true,
		})!;
		expect(client.sessionKey).toBeUndefined();
		expect(client.canMutate).toBe(true);
		expect(client.interactiveBinding).toBeUndefined();
	});

	test("adopts the held root resource before committing its admission", async () => {
		const fake = fakeEndpoints({ interactiveResponse: INTERACTIVE_RESPONSE });
		const client = WorldClient.create({
			env: {},
			setting: SOCKET,
			interactiveRoot: true,
			openEndpoint: fake.openEndpoint,
		})!;

		const binding = await client.attachInteractiveRoot(INTERACTIVE_SPEC);

		expect(binding.llmSessionObjectKey).toBe("glados/llm-session/root");
		expect(client.sessionKey).toBe("glados/llm-session/root");
		expect(fake.log.interactiveEvents).toEqual(["access", "adopt", "bind:23", "commit"]);
	});

	test("shares one held admission across concurrent interactive operations", async () => {
		const fake = fakeEndpoints({ interactiveResponse: INTERACTIVE_RESPONSE });
		const client = WorldClient.create({
			env: {},
			setting: SOCKET,
			interactiveRoot: true,
			openEndpoint: fake.openEndpoint,
		})!;

		const [first, second] = await Promise.all([
			client.attachInteractiveRoot(INTERACTIVE_SPEC),
			client.attachInteractiveRoot(INTERACTIVE_SPEC),
		]);

		expect(second).toEqual(first);
		expect(fake.log.interactiveEvents).toEqual(["access", "adopt", "bind:23", "commit"]);
	});

	test("aborts the held root and closes the endpoint when adoption fails", async () => {
		const fake = fakeEndpoints({
			interactiveResponse: INTERACTIVE_RESPONSE,
			adoptFailure: new Error("adoption rejected"),
		});
		const client = WorldClient.create({
			env: {},
			setting: SOCKET,
			interactiveRoot: true,
			openEndpoint: fake.openEndpoint,
		})!;

		await expect(client.attachInteractiveRoot(INTERACTIVE_SPEC)).rejects.toThrow("adoption rejected");

		expect(fake.log.interactiveEvents).toEqual(["access", "adopt", "abort", "close"]);
		expect(fake.log.closes).toBe(1);
	});

	test("aborts a held admission when the response has no resource binding", async () => {
		const fake = fakeEndpoints();
		const client = WorldClient.create({
			env: {},
			setting: SOCKET,
			interactiveRoot: true,
			openEndpoint: fake.openEndpoint,
		})!;

		await expect(client.attachInteractiveRoot(INTERACTIVE_SPEC)).rejects.toThrow(
			"interactive root access returned no resource binding",
		);

		expect(fake.log.interactiveEvents).toEqual(["access", "abort"]);
	});
});

describe("world runtime configuration", () => {
	test("a socket without a caller session cannot mutate and dials nothing", async () => {
		const { dial, calls } = recordingDial();
		const client = WorldClient.create({ env: {}, setting: SOCKET, dial })!;
		expect(client.canMutate).toBe(false);
		expect(client.sessionKey).toBeUndefined();
		// The refusal is local: a caller-less client must not spend a connection
		// discovering it has no identity to be charged.
		await expect(
			client.answerQuestion({ requestId: "r1", questionObjectKey: "glados/questions/q", summary: "yes" }),
		).rejects.toThrow(new RegExp(WORLD_SESSION_ENV));
		expect(calls).toEqual([]);
	});

	test("binds the caller key the configuration named", async () => {
		const { client, log } = runtimeClient({
			mutate: () => ({
				result: {
					case: "sessionInput",
					value: { targetSessionObjectKey: "glados/llm-session/b", acceptedSequence: 4n },
				},
			}),
		});
		expect(client.canMutate).toBe(true);
		await client.sendSessionInput({ requestId: "r1", targetSessionObjectKey: "glados/llm-session/b", text: "go" });
		expect(log.binds).toEqual([CALLER]);
		expect(log.boundResources).toEqual([7]);
	});

	test("binds once per connection and rebinds after the daemon restarts", async () => {
		const { client, log, retireAll } = runtimeClient({
			mutate: () => ({
				result: {
					case: "sessionInput",
					value: { targetSessionObjectKey: "glados/llm-session/b", acceptedSequence: 1n },
				},
			}),
		});
		const input = { requestId: "r1", targetSessionObjectKey: "glados/llm-session/b", text: "go" };
		await client.sendSessionInput(input);
		await client.sendSessionInput({ ...input, requestId: "r2" });
		// One child resource serves both operations on one connection.
		expect(log.binds).toEqual([CALLER]);

		retireAll();
		await client.sendSessionInput({ ...input, requestId: "r3" });
		// The child id belonged to the connection that issued it, so a fresh
		// connection binds again rather than replaying an id the daemon forgot.
		expect(log.binds).toEqual([CALLER, CALLER]);
		expect(log.opens).toBe(2);
	});

	test("concurrent operations share one binding", async () => {
		const { client, log } = runtimeClient({
			mutate: () => ({
				result: {
					case: "sessionInput",
					value: { targetSessionObjectKey: "glados/llm-session/b", acceptedSequence: 1n },
				},
			}),
		});
		const input = { targetSessionObjectKey: "glados/llm-session/b", text: "go" };
		await Promise.all([
			client.sendSessionInput({ ...input, requestId: "a" }),
			client.sendSessionInput({ ...input, requestId: "b" }),
		]);
		expect(log.binds).toEqual([CALLER]);
	});
});

describe("World peer and session resources", () => {
	test("resolves one exact peer through the bound runtime", async () => {
		const session = { sessionObjectKey: "glados/llm-session/worker", parentSessionObjectKey: CALLER };
		const { client, log } = runtimeClient({
			resolvePeer: peerId => ({
				found: true,
				agent: { agentObjectKey: "glados/agents/worker", peerId, name: "Worker" },
				session,
			}),
		});

		expect(await client.resolveAgentPeer("worker")).toEqual({
			found: true,
			agent: { agentObjectKey: "glados/agents/worker", peerId: "worker", name: "Worker" },
			session,
			inactive: false,
		});
		expect(log.resolvedPeers).toEqual(["worker"]);
		expect(log.binds).toEqual([CALLER]);
	});

	test("streams complete Agent-tree snapshots from the root resource", async () => {
		const snapshots = [
			{ revision: 1n, agents: [{ agentObjectKey: "glados/agents/worker", peerId: "worker" }] },
			{ revision: 2n, agents: [{ agentObjectKey: "glados/agents/worker", peerId: "worker-2" }] },
		];
		const { client, log } = runtimeClient({
			agentTreeWatch: snapshots.map(snapshot => ({ snapshot })),
		});
		const received = [];
		for await (const snapshot of client.watchAgentTree()) received.push(snapshot);

		expect(received).toEqual(snapshots);
		expect(log.agentTreeWatches).toBe(1);
	});

	test("streams complete session snapshots and releases the child resource", async () => {
		const snapshots = [
			{ session: { sessionObjectKey: "glados/llm-session/worker", state: "LLM_SESSION_STATE_ACTIVE" } },
			{ taskResult: { output: "done", exitCode: 0 } },
		];
		const { client, log } = runtimeClient({
			sessionResourceId: 13,
			sessionWatch: snapshots.map(snapshot => ({ snapshot })),
		});
		const received = [];
		for await (const snapshot of client.watchSession("glados/llm-session/worker")) received.push(snapshot);

		expect(received).toEqual(snapshots);
		expect(log.accessedSessions).toEqual(["glados/llm-session/worker"]);
		expect(log.boundSessionResources).toEqual([13]);
		expect(log.sessionReleases).toBe(1);
	});

	test("stores peer and reserved-parent messages with typed queue receipts", async () => {
		const { client, log } = runtimeClient({
			mutate: req => ({
				requestId: req.requestId,
				result: {
					case: "sendPeerMessage",
					value: {
						messageObjectKey: `glados/messages/${req.requestId}`,
						clientMessageId: req.operation?.case === "sendPeerMessage" ? req.operation.value.clientMessageId : "",
						toAgentObjectKey: "glados/agents/target",
						targetLlmSessionObjectKey: "glados/llm-session/target",
						inboxSequence: 8n,
						outcome: PeerMessageOutcome.QUEUED_LIVE,
						replayed: false,
					},
				},
			}),
		});

		const peer = await client.sendPeerMessage({
			requestId: "send-peer",
			clientMessageId: "message-1",
			body: "hello",
			replyToClientMessageId: "question-1",
			expectsReply: true,
			target: { kind: "peer", peerId: "worker" },
		});
		await client.sendPeerMessage({
			requestId: "send-parent",
			clientMessageId: "message-2",
			body: "hello parent",
			target: { kind: "parent" },
		});

		expect(peer).toEqual({
			requestId: "send-peer",
			messageObjectKey: "glados/messages/send-peer",
			clientMessageId: "message-1",
			toAgentObjectKey: "glados/agents/target",
			targetLlmSessionObjectKey: "glados/llm-session/target",
			inboxSequence: 8n,
			outcome: PeerMessageOutcome.QUEUED_LIVE,
			replayed: false,
		});
		expect(log.mutations.map(request => request.operation)).toEqual([
			{
				case: "sendPeerMessage",
				value: {
					clientMessageId: "message-1",
					body: "hello",
					replyToClientMessageId: "question-1",
					expectsReply: true,
					target: { case: "targetPeerId", value: "worker" },
				},
			},
			{
				case: "sendPeerMessage",
				value: {
					clientMessageId: "message-2",
					body: "hello parent",
					replyToClientMessageId: undefined,
					expectsReply: false,
					target: { case: "targetParent", value: true },
				},
			},
		]);
	});

	test("rejects rewritten message identities and incomplete durable receipts", async () => {
		const { client, log } = runtimeClient({
			mutate: req => ({
				requestId: req.requestId,
				result: {
					case: "sendPeerMessage",
					value: {
						messageObjectKey: "glados/messages/1",
						clientMessageId: "different-message",
						toAgentObjectKey: "glados/agents/target",
						targetLlmSessionObjectKey: "glados/llm-session/target",
						inboxSequence: 1n,
						outcome: PeerMessageOutcome.QUEUED_LIVE,
					},
				},
			}),
		});

		await expect(
			client.sendPeerMessage({
				requestId: "send-peer",
				clientMessageId: " message-1 ",
				body: "hello",
				target: { kind: "peer", peerId: "worker" },
			}),
		).rejects.toThrow("peer client message id is invalid");
		expect(log.mutations).toEqual([]);

		await expect(
			client.sendPeerMessage({
				requestId: "send-peer",
				clientMessageId: "message-1",
				body: "hello",
				target: { kind: "peer", peerId: "worker" },
			}),
		).rejects.toThrow("returned client message ID different-message, expected message-1");
	});

	test("streams the bound mailbox and acknowledges one typed local outcome", async () => {
		const message = {
			messageObjectKey: "glados/messages/1",
			clientMessageId: "message-1",
			body: "hello",
			inboxSequence: 4n,
		};
		const { client, log } = runtimeClient({
			mailboxWatch: [{ result: { case: "message", value: message } }],
			mutate: () => ({
				result: {
					case: "ackPeerMessage",
					value: {
						messageObjectKey: message.messageObjectKey,
						consumedByLlmSessionObjectKey: CALLER,
						consumedAt: "2026-08-04T12:00:00Z",
						replayed: true,
					},
				},
			}),
		});
		const received = [];
		for await (const item of client.watchPeerMailbox()) received.push(item);
		const ack = await client.ackPeerMessage({
			requestId: "ack-1",
			messageObjectKey: message.messageObjectKey,
			outcome: PeerMessageAckOutcome.WAITER,
		});

		expect(received).toEqual([message]);
		expect(log.mailboxWatches).toBe(1);
		expect(log.mutations[0]?.operation).toEqual({
			case: "ackPeerMessage",
			value: {
				messageObjectKey: message.messageObjectKey,
				outcome: PeerMessageAckOutcome.WAITER,
			},
		});
		expect(ack).toEqual({
			requestId: "ack-1",
			messageObjectKey: message.messageObjectKey,
			consumedByLlmSessionObjectKey: CALLER,
			consumedAt: "2026-08-04T12:00:00Z",
			replayed: true,
		});
	});

	test("classifies a failed mailbox stream as an endpoint failure", async () => {
		const { client, log } = runtimeClient({
			mailboxFailure: new Error("retired mailbox endpoint"),
		});
		const iterator = client.watchPeerMailbox()[Symbol.asyncIterator]();

		await expect(iterator.next()).rejects.toBeInstanceOf(WorldEndpointError);
		expect(log.closes).toBe(1);
	});
});

describe("world request identity", () => {
	test("accepts printable ASCII within the daemon's bound", () => {
		expect(assertWorldRequestId("answer-1")).toBe("answer-1");
		// 0x20 is printable to the daemon, which iterates bytes 0x20..0x7e.
		expect(assertWorldRequestId("answer 1")).toBe("answer 1");
		expect(assertWorldRequestId("x".repeat(256))).toHaveLength(256);
	});

	test("rejects what the daemon would reject, before any dial", async () => {
		expect(() => assertWorldRequestId("")).toThrow(/required/);
		expect(() => assertWorldRequestId("x".repeat(257))).toThrow(/256 bytes/);
		expect(() => assertWorldRequestId("bad\nid")).toThrow(/printable ASCII/);
		expect(() => assertWorldRequestId("café")).toThrow(/printable ASCII/);

		const { dial, calls } = recordingDial();
		const client = WorldClient.create({ env: {}, setting: SOCKET, sessionSetting: CALLER, dial })!;
		await expect(
			client.answerQuestion({ requestId: "  ", questionObjectKey: "glados/questions/q", summary: "yes" }),
		).rejects.toThrow(/required/);
		expect(calls).toEqual([]);
	});
});

describe("world dispatch submission", () => {
	test("sends the identity tuple and defaults the request id to the intent key", async () => {
		const { client, log } = runtimeClient({
			mutate: () => ({
				result: { case: "dispatchSubmit", value: { session: { sessionObjectKey: "glados/llm-session/child" } } },
			}),
		});
		const expected = client.deriveIntentKey(IDENTITY);
		const result = await client.submitDispatch({
			identity: IDENTITY,
			worktreePath: "/wt/fix-auth",
			workingDirectory: "/wt/fix-auth",
			childWorldOperations: [WORLD_OPERATION_PERMISSIONS.question_answer],
			taskAgent: {
				peerId: "worker",
				displayName: "Worker",
				agentType: "task",
				agentSource: WorldTaskAgentSource.BUNDLED,
				purpose: "Fix auth",
				workerProfile: new Uint8Array([1, 2, 3]),
				workerProfileDigest: "a".repeat(64),
			},
		});

		expect(result.intentKey).toBe(expected.intentKey);
		// The envelope's retry key is the submission's own identity rather than a
		// second name for the same work.
		expect(result.requestId).toBe(expected.intentKey);
		expect(result.session?.sessionObjectKey).toBe("glados/llm-session/child");

		const sent = log.mutations[0];
		expect(sent?.requestId).toBe(expected.intentKey);
		expect(sent?.operation?.case).toBe("dispatchSubmit");
		const submit = sent?.operation?.case === "dispatchSubmit" ? sent.operation.value : undefined;
		expect(submit?.intentIdentity?.intentKey).toBe(expected.intentKey);
		// Normalized, because the daemon re-derives from exactly what it receives.
		expect(submit?.intentIdentity?.source?.objective).toBe(expected.source.objective);
		expect(submit?.childWorldOperations).toEqual(["world.question.answer"]);
		expect(submit?.taskAgent).toEqual({
			peerId: "worker",
			displayName: "Worker",
			agentType: "task",
			agentSource: WorldTaskAgentSource.BUNDLED,
			purpose: "Fix auth",
			workerProfile: new Uint8Array([1, 2, 3]),
			workerProfileDigest: "a".repeat(64),
		});
		// No parent field exists: the bound caller is the parent.
		expect(Object.keys(submit ?? {})).not.toContain("parentSessionObjectKey");
	});

	test("an explicit request id overrides the intent key without changing it", async () => {
		const { client, log } = runtimeClient({
			mutate: () => ({ result: { case: "dispatchSubmit", value: {} } }),
		});
		const expected = client.deriveIntentKey(IDENTITY);
		const result = await client.submitDispatch({ identity: IDENTITY, requestId: "submit-1" });
		expect(result.requestId).toBe("submit-1");
		expect(result.intentKey).toBe(expected.intentKey);
		const submit =
			log.mutations[0]?.operation?.case === "dispatchSubmit" ? log.mutations[0].operation.value : undefined;
		expect(submit?.intentIdentity?.intentKey).toBe(expected.intentKey);
	});
});

describe("world structured refusals", () => {
	test("a permission denial keeps the daemon's code and fields", async () => {
		const { client } = runtimeClient({
			mutate: () =>
				denial(
					WorldAuthorityDenialCode.OPERATION_NOT_ALLOWED,
					WorldRuntimeOperation.QUESTION_ANSWER,
					"world.question.answer",
				),
		});
		const error = await client
			.answerQuestion({ requestId: "r1", questionObjectKey: "glados/questions/q", summary: "yes" })
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(WorldAuthorityError);
		const denied = error as WorldAuthorityError;
		expect(denied.operation).toBe("question_answer");
		expect(denied.code).toBe(WorldAuthorityDenialCode.OPERATION_NOT_ALLOWED);
		expect(denied.codeName).toBe("OPERATION_NOT_ALLOWED");
		expect(denied.callerSessionObjectKey).toBe(CALLER);
		expect(denied.capabilityDigest).toBe("sha256:cap");
		expect(denied.requiredPermission).toBe("world.question.answer");
		expect(denied.detail).toBe("the caller manifest does not allow it");
	});

	test("a settled caller is reported as an unavailable manifest, not a missing session", async () => {
		const { client } = runtimeClient({
			mutate: () =>
				denial(
					WorldAuthorityDenialCode.CALLER_MANIFEST_UNAVAILABLE,
					WorldRuntimeOperation.SESSION_INPUT,
					"world.session.input",
				),
		});
		const error = (await client
			.sendSessionInput({ requestId: "r1", targetSessionObjectKey: "glados/llm-session/b", text: "go" })
			.catch((e: unknown) => e)) as WorldAuthorityError;
		expect(error.codeName).toBe("CALLER_MANIFEST_UNAVAILABLE");
	});

	test("an operation failure keeps its code, target, and request id", async () => {
		const { client } = runtimeClient({
			mutate: () =>
				failure(
					WorldOperationFailureCode.RETRY_CONFLICT,
					WorldRuntimeOperation.SESSION_INTERRUPT,
					"glados/llm-session/b",
				),
		});
		const error = await client
			.interruptSession({ requestId: "stop-1", targetSessionObjectKey: "glados/llm-session/b" })
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(WorldOperationError);
		const failed = error as WorldOperationError;
		expect(failed.operation).toBe("session_interrupt");
		expect(failed.code).toBe(WorldOperationFailureCode.RETRY_CONFLICT);
		expect(failed.codeName).toBe("RETRY_CONFLICT");
		expect(failed.targetObjectKey).toBe("glados/llm-session/b");
		expect(failed.requestId).toBe("stop-1");
	});

	test("a response carrying the wrong arm is a client error, not a silent success", async () => {
		const { client } = runtimeClient({
			mutate: () => ({ result: { case: "questionAnswer", value: { questionObjectKey: "q" } } }),
		});
		await expect(
			client.sendSessionInput({ requestId: "r1", targetSessionObjectKey: "glados/llm-session/b", text: "go" }),
		).rejects.toThrow(/returned questionAnswer result/);
	});
});

describe("world replayed effects", () => {
	test("a replayed answer is reported as replayed", async () => {
		const { client } = runtimeClient({
			mutate: () => ({
				result: {
					case: "questionAnswer",
					value: {
						questionObjectKey: "glados/questions/q",
						decisionObjectKey: "glados/questions/q/decision/abc",
						questionState: "answered",
						replayed: true,
					},
				},
			}),
		});
		const result = await client.answerQuestion({
			requestId: "answer-1",
			questionObjectKey: "glados/questions/q",
			summary: "yes",
		});
		expect(result.replayed).toBe(true);
		expect(result.decisionObjectKey).toBe("glados/questions/q/decision/abc");
	});

	test("a replayed steering delivery returns the stored sequence", async () => {
		const { client } = runtimeClient({
			mutate: () => ({
				result: {
					case: "sessionInput",
					value: { targetSessionObjectKey: "glados/llm-session/b", acceptedSequence: 9n, replayed: true },
				},
			}),
		});
		const result = await client.sendSessionInput({
			requestId: "steer-1",
			targetSessionObjectKey: "glados/llm-session/b",
			text: "go",
		});
		expect(result.acceptedSequence).toBe(9n);
		expect(result.replayed).toBe(true);
		expect(result.operation).toBe("session_input");
	});
});

/** One watch snapshot arm. */
function snapshot(intent: LookupDispatchIntentResponse, completionMet: boolean): WorldRuntimeWatchResponse {
	return { result: { case: "snapshot", value: { intent, completionMet } } };
}

describe("world dispatch watch", () => {
	test("sends the requested stopping condition", async () => {
		const seen: WorldRuntimeWatchRequest[] = [];
		const { client, log } = runtimeClient({
			watch: req => {
				seen.push(req);
				return [snapshot({ found: false }, true)];
			},
		});
		for (const stop of ["current", "custody", "terminal"] as const) {
			for await (const _ of client.watchDispatch({ intentKey: "di:abc", stop })) break;
		}
		expect(log.watches.map(req => req.completion)).toEqual([
			WorldWatchCompletion.CURRENT,
			WorldWatchCompletion.CUSTODY,
			WorldWatchCompletion.TERMINAL,
		]);
		expect(seen[0]?.intentKey).toBe("di:abc");
	});

	test("a missing intent is current state under `current`", async () => {
		const { client } = runtimeClient({ watch: () => [snapshot({ found: false }, true)] });
		const seen = [];
		for await (const next of client.watchDispatch({ intentKey: "di:abc", stop: "current" })) seen.push(next);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.intent.found).toBe(false);
		expect(seen[0]?.completionMet).toBe(true);
	});

	test("a missing intent closes an unmet custody watch rather than hanging", async () => {
		const { client } = runtimeClient({ watch: () => [snapshot({ found: false }, false)] });
		const seen = [];
		for await (const next of client.watchDispatch({ intentKey: "di:abc", stop: "custody" })) seen.push(next);
		// The stream ended without the condition holding, which the consumer has
		// to be able to observe: waiting for `completionMet` forever would hang.
		expect(seen).toHaveLength(1);
		expect(seen[0]?.completionMet).toBe(false);
	});

	test("carries complete snapshots until the condition holds", async () => {
		const pending: LookupDispatchIntentResponse = {
			found: true,
			intentState: "ADMITTED",
			activeAttemptKey: "glados/dispatch/attempt/1",
			attemptState: "RUNNING",
			awaitingCustody: true,
		};
		const settled: LookupDispatchIntentResponse = {
			...pending,
			attemptState: "ACCEPTED",
			awaitingCustody: false,
			custody: { claimState: "claimed", terminalAccepted: true },
			session: { sessionObjectKey: "glados/llm-session/child", state: "completed" },
		};
		const { client } = runtimeClient({ watch: () => [snapshot(pending, false), snapshot(settled, true)] });

		const seen = [];
		for await (const next of client.watchDispatch({ intentKey: "di:abc", stop: "terminal" })) {
			seen.push(next);
			if (next.completionMet) break;
		}
		expect(seen).toHaveLength(2);
		const last = seen[1];
		expect(last?.completionMet).toBe(true);
		expect(last?.intent.found).toBe(true);
		if (last?.intent.found) {
			expect(last.intent.attemptState).toBe("ACCEPTED");
			expect(last.intent.custody?.terminalAccepted).toBe(true);
			expect(last.intent.session?.sessionObjectKey).toBe("glados/llm-session/child");
		}
	});

	test("a denial on the stream raises the same typed error a mutation does", async () => {
		const { client } = runtimeClient({
			watch: () => [
				{
					result: {
						case: "authorityDenial",
						value: {
							operation: WorldRuntimeOperation.DISPATCH_WATCH,
							callerSessionObjectKey: CALLER,
							code: WorldAuthorityDenialCode.OPERATION_NOT_ALLOWED,
							requiredPermission: "world.dispatch.watch",
							detail: "no",
						},
					},
				},
			],
		});
		const error = await (async () => {
			try {
				for await (const _ of client.watchDispatch({ intentKey: "di:abc", stop: "terminal" }));
				return null;
			} catch (e: unknown) {
				return e;
			}
		})();
		expect(error).toBeInstanceOf(WorldAuthorityError);
		expect((error as WorldAuthorityError).operation).toBe("dispatch_watch");
		expect((error as WorldAuthorityError).requiredPermission).toBe("world.dispatch.watch");
	});

	test("a watch failure does not invent a request id", async () => {
		const { client } = runtimeClient({
			watch: () => [
				{
					result: {
						case: "operationFailure",
						value: {
							operation: WorldRuntimeOperation.DISPATCH_WATCH,
							code: WorldOperationFailureCode.MISSING_TARGET,
							targetObjectKey: "di:abc",
							detail: "missing",
						},
					},
				},
			],
		});
		const error = await (async () => {
			try {
				for await (const _ of client.watchDispatch({ intentKey: "di:abc", stop: "current" }));
				return null;
			} catch (caught: unknown) {
				return caught;
			}
		})();
		expect(error).toBeInstanceOf(WorldOperationError);
		expect((error as WorldOperationError).requestId).toBe("");
		expect((error as WorldOperationError).targetObjectKey).toBe("di:abc");
	});

	test("cancelling one watch leaves the client usable", async () => {
		const { client, log } = runtimeClient({
			watch: () => [snapshot({ found: true, intentState: "ADMITTED" }, false)],
			mutate: () => ({
				result: {
					case: "sessionInput",
					value: { targetSessionObjectKey: "glados/llm-session/b", acceptedSequence: 2n },
				},
			}),
		});
		const controller = new AbortController();
		for await (const _ of client.watchDispatch({ intentKey: "di:abc", stop: "terminal" }, controller.signal)) {
			controller.abort();
			break;
		}
		// Same connection, same binding: cancelling a stream is scoped to it.
		const result = await client.sendSessionInput({
			requestId: "after-watch",
			targetSessionObjectKey: "glados/llm-session/b",
			text: "go",
		});
		expect(result.acceptedSequence).toBe(2n);
		expect(log.opens).toBe(1);
		expect(log.binds).toEqual([CALLER]);
	});

	test("an empty intent key never reaches a connection", async () => {
		const { dial, calls } = recordingDial();
		const client = WorldClient.create({ env: {}, setting: SOCKET, sessionSetting: CALLER, dial })!;
		await expect(
			(async () => {
				for await (const _ of client.watchDispatch({ intentKey: "  ", stop: "current" }));
			})(),
		).rejects.toThrow(/intent key is required/);
		expect(calls).toEqual([]);
	});
});
