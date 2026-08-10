import { Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { type PythonExecutionMessage, pythonExecutionToText } from "../../session/messages";

const MAX_HISTORY_TEXT = 8_000;

/** Renders removed Python-shortcut history without starting an evaluator. */
export class HistoricalPythonExecutionComponent extends Text {
	constructor(message: PythonExecutionMessage) {
		const text = sanitizeText(pythonExecutionToText(message));
		super(text.length <= MAX_HISTORY_TEXT ? text : `${text.slice(0, MAX_HISTORY_TEXT)}…`, 1, 0);
	}
}
