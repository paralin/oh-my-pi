import { type AskInput, type AskOwner, executeAsk, isReservedAskOptionLabel } from "../ask/structured";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_QUESTIONS = 32;
const MAX_OPTIONS = 64;
const MAX_ID_CHARS = 256;
const MAX_QUESTION_CHARS = 16_384;
const MAX_LABEL_CHARS = 4_096;
const MAX_HEADER_CHARS = 256;
const MAX_DESCRIPTION_CHARS = 16_384;
const MAX_PREVIEW_CHARS = 65_536;

function strictObject(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function objectValue(value: unknown, name: string): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError(`${name} must be an object`);
	return value as Readonly<Record<string, unknown>>;
}

function requiredString(data: Readonly<Record<string, unknown>>, name: string, max: number): string {
	const value = data[name];
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string`);
	if (value.length > max) throw new RangeError(`${name} is too large`);
	return value;
}

function optionalString(data: Readonly<Record<string, unknown>>, name: string, max: number): string | undefined {
	if (data[name] === undefined) return undefined;
	return requiredString(data, name, max);
}

function normalizedQuestions(value: unknown): AskInput["questions"] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTIONS) {
		throw new TypeError(`questions must contain 1 through ${MAX_QUESTIONS} items`);
	}
	const ids = new Set<string>();
	const questions = value.map((rawQuestion, questionIndex) => {
		const data = objectValue(rawQuestion, `questions[${questionIndex}]`);
		strictObject(data, ["id", "question", "header", "options", "multi", "recommended"]);
		const rawOptions = data.options;
		if (!Array.isArray(rawOptions) || rawOptions.length > MAX_OPTIONS)
			throw new TypeError(`questions[${questionIndex}].options must contain at most ${MAX_OPTIONS} items`);
		const options = rawOptions.map((rawOption, optionIndex) => {
			const option = objectValue(rawOption, `questions[${questionIndex}].options[${optionIndex}]`);
			strictObject(option, ["label", "description", "preview"]);
			return {
				label: requiredString(option, "label", MAX_LABEL_CHARS),
				description: optionalString(option, "description", MAX_DESCRIPTION_CHARS),
				preview: optionalString(option, "preview", MAX_PREVIEW_CHARS),
			};
		});
		const multi = data.multi ?? false;
		if (typeof multi !== "boolean") throw new TypeError(`questions[${questionIndex}].multi must be a boolean`);
		const recommended = data.recommended;
		if (
			recommended !== undefined &&
			(typeof recommended !== "number" ||
				!Number.isInteger(recommended) ||
				recommended < 0 ||
				recommended >= options.length)
		) {
			throw new RangeError(`questions[${questionIndex}].recommended must be an in-range integer`);
		}
		const id = requiredString(data, "id", MAX_ID_CHARS);
		if (ids.has(id)) throw new TypeError(`questions[${questionIndex}].id must be unique`);
		ids.add(id);
		return {
			id,
			question: requiredString(data, "question", MAX_QUESTION_CHARS),
			header: optionalString(data, "header", MAX_HEADER_CHARS),
			options,
			multi,
			recommended: recommended as number | undefined,
		};
	});
	if (questions.some(question => question.options.some(option => isReservedAskOptionLabel(option.label)))) {
		throw new TypeError("questions contain an unsupported reserved option label");
	}
	return questions;
}

export interface IpythonAskServiceOptions {
	readonly owner: (request: IpythonHostRequest) => AskOwner;
}

/** Exposes the shared structured ask execution to Python host requests. */
export class IpythonAskService {
	readonly handlers: IpythonHostHandlers;

	constructor(private readonly options: IpythonAskServiceOptions) {
		this.handlers = { "ask.questions": request => this.#questions(request) };
	}

	async #questions(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strictObject(request.data, ["questions"]);
		request.signal.throwIfAborted();
		const questions = normalizedQuestions(request.data.questions);
		await request.publishProgress("Ask questions started", { count: questions.length });
		const result = await executeAsk(this.options.owner(request), { questions }, request.signal);
		request.signal.throwIfAborted();
		await request.publishProgress("Ask questions completed", { count: questions.length });
		return { ...result.details };
	}
}
