import { describe, expect, it } from "bun:test";
import type { PlayerCommand } from "@oh-my-pi/pi-coding-agent/tts/player";
import { StreamingAudioPlayer } from "@oh-my-pi/pi-coding-agent/tts/streaming-player";

/** A one-segment ~0.5s clip at 24 kHz, the shape `omp say "hi"` produces. */
const clip = (): Float32Array => new Float32Array(24_000 / 2).fill(0.1);

describe("StreamingAudioPlayer nonzero-exit fallback", () => {
	it("replays the buffered clip via file playback when the streaming backend exits nonzero", async () => {
		// `cat` drains stdin so the pipe write succeeds, then the shell exits 1 —
		// exactly the bundled-ffmpeg-without-outdev failure that used to silently
		// drop `omp say`'s single short clip.
		const played: string[] = [];
		const player = new StreamingAudioPlayer({
			commandsFor: (): PlayerCommand[] => [{ cmd: "sh", args: ["-c", "cat >/dev/null; exit 1"] }],
			playAudio: async wavPath => {
				played.push(wavPath);
			},
		});
		player.start(24_000);
		player.write(clip());
		await player.end();
		expect(played.length).toBe(1);
	});

	it("does not replay when the streaming backend exits cleanly", async () => {
		const played: string[] = [];
		const player = new StreamingAudioPlayer({
			commandsFor: (): PlayerCommand[] => [{ cmd: "sh", args: ["-c", "cat >/dev/null"] }],
			playAudio: async wavPath => {
				played.push(wavPath);
			},
		});
		player.start(24_000);
		player.write(clip());
		await player.end();
		expect(played.length).toBe(0);
	});

	it("plays every chunk via the file fallback when no streaming backend exists", async () => {
		const played: string[] = [];
		const player = new StreamingAudioPlayer({
			commandsFor: (): PlayerCommand[] => [],
			playAudio: async wavPath => {
				played.push(wavPath);
			},
		});
		player.start(24_000);
		player.write(clip());
		player.write(clip());
		await player.end();
		expect(played.length).toBe(2);
	});

	it("drops the replay buffer once the utterance exceeds the retention cap", async () => {
		// Long input must not accumulate unbounded PCM; past the cap the
		// nonzero-exit replay is forfeited rather than duplicating audio the
		// backend already played.
		const played: string[] = [];
		const player = new StreamingAudioPlayer({
			commandsFor: (): PlayerCommand[] => [{ cmd: "sh", args: ["-c", "cat >/dev/null; exit 1"] }],
			playAudio: async wavPath => {
				played.push(wavPath);
			},
			replayRetentionSeconds: 0.25,
		});
		player.start(24_000);
		player.write(clip());
		await player.end();
		expect(played.length).toBe(0);
	});
});
