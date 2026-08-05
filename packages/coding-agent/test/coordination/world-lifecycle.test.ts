import { describe, expect, test } from "bun:test";
import { WorldCoordinationBackend, type WorldCoordinationClient } from "@oh-my-pi/pi-coding-agent/coordination/world";
import { PeerMessageOutcome } from "../../src/world/generated/llmsession.pb.js";

const ROTATION = {
	sessionId: "omp-session-2",
	previousSessionId: "omp-session-1",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	reason: "switch" as const,
};

describe("interactive World lifecycle", () => {
	test("waits for root custody rotation before completing a session transition", async () => {
		const rotation = Promise.withResolvers<void>();
		const calls: string[] = [];
		const client = {
			calls,
			canMutate: true,
			interactiveRoot: true,
			interactiveBinding: {},
			async rotateInteractiveRootTransition() {
				calls.push("rotate-start");
				await rotation.promise;
				calls.push("rotate-complete");
			},
		} as unknown as WorldCoordinationClient & {
			interactiveRoot: true;
			interactiveBinding: object;
			rotateInteractiveRootTransition(transition: typeof ROTATION): Promise<void>;
			calls: string[];
		};
		const backend = new WorldCoordinationBackend(client);
		const token = await backend.beforeRootTransition();

		let completed = false;
		const transition = backend.afterSessionTransition(token, ROTATION).then(() => {
			completed = true;
		});
		await Promise.resolve();

		expect(calls).toEqual(["rotate-start"]);
		expect(completed).toBe(false);

		rotation.resolve();
		await transition;
		expect(calls).toEqual(["rotate-start", "rotate-complete"]);
		expect(completed).toBe(true);
	});

	test("preserves the World client receiver across model reconfiguration", async () => {
		const client = {
			canMutate: true,
			interactiveRoot: true,
			interactiveBinding: {},
			async reconfigureInteractiveRootTransition(transition: { provider: string; model: string }) {
				expect(transition.model).toBe("claude-sonnet-4-5");
			},
		} as unknown as WorldCoordinationClient;
		const backend = new WorldCoordinationBackend(client);
		const token = await backend.beforeRootTransition();

		await backend.afterModelTransition(token, {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
	});

	test("drains an entered World mutation before rotating root custody", async () => {
		const sendStarted = Promise.withResolvers<void>();
		const allowSend = Promise.withResolvers<void>();
		const client = {
			canMutate: true,
			interactiveRoot: true,
			interactiveBinding: {},
			sessionKey: "glados/interactive/session-1",
			sendPeerMessage: async (request: { requestId: string; clientMessageId: string }) => {
				sendStarted.resolve();
				await allowSend.promise;
				return {
					requestId: request.requestId,
					messageObjectKey: "glados/messages/1",
					clientMessageId: request.clientMessageId,
					toAgentObjectKey: "glados/agents/peer",
					targetLlmSessionObjectKey: "glados/sessions/peer",
					inboxSequence: 1n,
					outcome: PeerMessageOutcome.QUEUED_LIVE,
					replayed: false,
				};
			},
		} as unknown as WorldCoordinationClient;
		const backend = new WorldCoordinationBackend(client);
		const sending = backend.send({
			targetPeerId: "peer",
			message: {
				id: "message-1",
				from: "main",
				to: "peer",
				body: "hello",
				ts: Date.now(),
			},
		});
		await sendStarted.promise;

		let drained = false;
		const transition = backend.beforeRootTransition().then(token => {
			drained = true;
			return token;
		});
		await Promise.resolve();
		expect(drained).toBe(false);

		allowSend.resolve();
		await sending;
		await transition;
		expect(drained).toBe(true);
	});
});
