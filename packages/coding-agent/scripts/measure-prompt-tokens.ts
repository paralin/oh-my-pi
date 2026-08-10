import { countTokens } from "@oh-my-pi/pi-agent-core";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

function bytes(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

const built = await buildSystemPrompt({
	contextFiles: [],
	cwd: process.cwd(),
	resolvedSystemPromptCustomization: null,
});

console.log(`system prompt parts: ${built.systemPrompt.length}`);
for (const [index, part] of built.systemPrompt.entries()) {
	console.log(`part ${index}: ${countTokens(part)} tokens (bytes=${bytes(part)})`);
}
