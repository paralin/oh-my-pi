import { Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

const MAX_HISTORY_TEXT = 4_000;

function boundedText(value: unknown): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	} catch {
		text = String(value);
	}
	const clean = sanitizeText(text);
	return clean.length <= MAX_HISTORY_TEXT ? clean : `${clean.slice(0, MAX_HISTORY_TEXT)}…`;
}

/** Renders removed tool history without resolving or executing a live tool. */
export class HistoricalToolExecutionComponent extends Text {
	readonly #call: string;
	#text: string;
	#visible = true;

	constructor(name: string, args: unknown) {
		const call = `Removed tool: ${boundedText(name)} ${boundedText(args)}`.trimEnd();
		super(call);
		this.#call = call;
		this.#text = call;
	}

	setToolActivityVisible(visible: boolean): void {
		this.#visible = visible;
		this.setText(visible ? this.#text : "");
	}

	updateResult(result: { content?: readonly { type: string; text?: string }[]; isError?: boolean }): void {
		const text =
			result.content
				?.filter(item => item.type === "text")
				.map(item => item.text ?? "")
				.join("\n") ?? "";
		this.#text = `${this.#call}\nResult${result.isError ? " (error)" : ""}: ${boundedText(text)}`;
		if (this.#visible) this.setText(this.#text);
	}
}
