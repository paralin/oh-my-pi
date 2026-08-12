const DESCRIPTOR_MAX_WIDTH = 64;

const BASH_CELL_PATTERN = /^\s*%%bash\b/;
const BASH_LINE_PATTERN = /^\s*!/;
const IMPORT_LINE_PATTERN = /^\s*(?:import\s+\S|from\s+\S+\s+import\s+)/;
const SECRET_NAME_PATTERN = /\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*=\s*(?:(["'])[^"']*\2|\S+)/gi;
const SECRET_FLAG_PATTERN = /((?:--(?:api[-_]?key|token|secret|password)|-(?:k|t)))\s+(?:(["'])[^"']*\2|\S+)/gi;
const TOKEN_VALUE_PATTERN = /\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_-]+)\b/g;

export type IpythonPreviewLanguage = "bash" | "python";

export interface IpythonCodePreview {
	readonly language: IpythonPreviewLanguage;
	readonly text: string;
}

function descriptor(text: string): string {
	const redacted = text
		.replace(/[A-Za-z0-9+/_-]{80,}={0,2}/g, "<blob>")
		.replace(SECRET_NAME_PATTERN, "$1=<redacted>")
		.replace(SECRET_FLAG_PATTERN, "$1 <redacted>")
		.replace(TOKEN_VALUE_PATTERN, "<redacted>")
		.replace(/(["']).{160,}\1/g, "$1…$1")
		.replace(/\s+/g, " ")
		.trim();
	return redacted.length <= DESCRIPTOR_MAX_WIDTH
		? redacted
		: `${redacted.slice(0, DESCRIPTOR_MAX_WIDTH - 1).trimEnd()}…`;
}

function isIdentifierPart(char: string | undefined): boolean {
	return char !== undefined && /[A-Za-z0-9_.]/.test(char);
}

function skipPythonString(source: string, quoteIndex: number): number | undefined {
	const quote = source[quoteIndex];
	if (quote !== "'" && quote !== '"') return undefined;
	const triple = source.slice(quoteIndex, quoteIndex + 3) === quote.repeat(3);
	const delimiterLength = triple ? 3 : 1;
	for (let index = quoteIndex + delimiterLength; index < source.length; index++) {
		if (source[index] === "\\") {
			index += 1;
			continue;
		}
		if (triple) {
			if (source.slice(index, index + 3) === quote.repeat(3)) return index + 3;
			continue;
		}
		if (source[index] === quote) return index + 1;
	}
	return undefined;
}

function closingParenthesis(source: string, openIndex: number): number | undefined {
	let depth = 1;
	for (let index = openIndex + 1; index < source.length; index++) {
		const char = source[index];
		if (char === "#") {
			const newline = source.indexOf("\n", index + 1);
			if (newline < 0) return undefined;
			index = newline;
			continue;
		}
		if (char === "'" || char === '"') {
			const end = skipPythonString(source, index);
			if (end === undefined) return undefined;
			index = end - 1;
			continue;
		}
		if (char === "(") depth += 1;
		if (char === ")") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return undefined;
}

const COMMAND_CALL_NAMES = ["subprocess.run", "subprocess.check_call", "subprocess.check_output", "os.system"] as const;

type CommandCallName = (typeof COMMAND_CALL_NAMES)[number];

interface CommandCall {
	readonly name: CommandCallName;
	readonly arguments: string;
}

function commandCalls(code: string): CommandCall[] {
	const calls: CommandCall[] = [];
	for (let index = 0; index < code.length; index++) {
		const char = code[index];
		if (char === "#") {
			const newline = code.indexOf("\n", index + 1);
			if (newline < 0) break;
			index = newline;
			continue;
		}
		if (char === "'" || char === '"') {
			const end = skipPythonString(code, index);
			if (end === undefined) break;
			index = end - 1;
			continue;
		}
		const name = COMMAND_CALL_NAMES.find(candidate => code.slice(index, index + candidate.length) === candidate);
		if (!name || isIdentifierPart(code[index - 1])) continue;
		let open = index + name.length;
		while (/\s/.test(code[open] ?? "")) open += 1;
		if (code[open] !== "(") continue;
		const close = closingParenthesis(code, open);
		if (close === undefined) continue;
		calls.push({ name, arguments: code.slice(open + 1, close) });
		index = close;
	}
	return calls;
}

function splitTopLevel(source: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === "#") {
			const newline = source.indexOf("\n", index + 1);
			if (newline < 0) break;
			index = newline;
			continue;
		}
		if (char === "'" || char === '"') {
			const end = skipPythonString(source, index);
			if (end === undefined) return [];
			index = end - 1;
			continue;
		}
		if (char === "(" || char === "[" || char === "{") depth += 1;
		else if (char === ")" || char === "]" || char === "}") depth -= 1;
		else if (char === "," && depth === 0) {
			parts.push(source.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(source.slice(start));
	return parts;
}

function withoutComments(source: string): string {
	let text = "";
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === "#") {
			const newline = source.indexOf("\n", index + 1);
			if (newline < 0) break;
			text += "\n";
			index = newline;
			continue;
		}
		if (char === "'" || char === '"') {
			const end = skipPythonString(source, index);
			if (end === undefined) return text;
			text += source.slice(index, end);
			index = end - 1;
			continue;
		}
		text += char;
	}
	return text;
}

function staticPythonString(source: string): string | undefined {
	const text = withoutComments(source).trim();
	const prefix = text.match(/^[A-Za-z]*/)?.[0] ?? "";
	if (prefix.includes("f") || prefix.includes("F") || !/^[rRuUbB]*$/.test(prefix)) return undefined;
	const quoteIndex = prefix.length;
	const end = skipPythonString(text, quoteIndex);
	if (end === undefined || end !== text.length) return undefined;
	const quote = text[quoteIndex];
	const delimiterLength = text.slice(quoteIndex, quoteIndex + 3) === quote.repeat(3) ? 3 : 1;
	const value = text
		.slice(quoteIndex + delimiterLength, end - delimiterLength)
		.replace(/\\(?:\r\n|\n|[\\'"nrt])/g, escaped => {
			switch (escaped) {
				case "\\n":
					return "\n";
				case "\\r":
					return "\r";
				case "\\t":
					return "\t";
				case "\\\n":
				case "\\\r\n":
					return "";
				default:
					return escaped.slice(1);
			}
		});
	return value;
}

function staticStringList(source: string): string[] | undefined {
	const text = withoutComments(source).trim();
	if (!text.startsWith("[") || !text.endsWith("]")) return undefined;
	const values = splitTopLevel(text.slice(1, -1)).filter(value => value.trim());
	if (values.length === 0) return undefined;
	const parsed = values.map(staticPythonString);
	return parsed.every((value): value is string => value !== undefined) ? parsed : undefined;
}

function staticSubprocessCommand(call: string): string | undefined {
	const parts = splitTopLevel(call);
	const args = parts.find(part => /^\s*args\s*=(?!=)/.test(part));
	const argument = args?.replace(/^\s*args\s*=\s*/, "") ?? parts.find(part => !/^\s*[A-Za-z_]\w*\s*=/.test(part));
	if (!argument) return undefined;
	const list = staticStringList(argument);
	if (list && list.length > 0) {
		return list
			.map((word, index) =>
				/^(?:--(?:api[-_]?key|token|secret|password)|-(?:k|t))$/i.test(list[index - 1] ?? "") ? "<redacted>" : word,
			)
			.join(" ");
	}
	return staticPythonString(argument);
}

function staticSystemCommand(call: string): string | undefined {
	const argument = splitTopLevel(call).find(part => !/^\s*[A-Za-z_]\w*\s*=/.test(part));
	return argument ? staticPythonString(argument) : undefined;
}

function fallbackPythonPreview(code: string): string {
	for (const line of code.split("\n").reverse()) {
		const trimmed = line.trim();
		if (trimmed && !trimmed.startsWith("#") && !IMPORT_LINE_PATTERN.test(trimmed)) return descriptor(trimmed);
	}
	return "";
}

export function previewPythonCode(code: string): IpythonCodePreview {
	const calls = commandCalls(code);
	for (const call of calls) {
		const command =
			call.name === "os.system" ? staticSystemCommand(call.arguments) : staticSubprocessCommand(call.arguments);
		if (command !== undefined) return { language: "python", text: descriptor(command) };
	}
	if (calls[0] !== undefined) {
		return { language: "python", text: descriptor(`${calls[0].name}(${calls[0].arguments})`) };
	}
	return { language: "python", text: fallbackPythonPreview(code) };
}

export function previewBashCommand(command: string): IpythonCodePreview {
	let preview = "";
	for (const line of command.split("\n")) {
		for (const part of line.split(/(?:&&|;)/)) {
			const trimmed = part.trim().replace(BASH_LINE_PATTERN, "").trim();
			if (!trimmed || trimmed.startsWith("#") || /^set\s+[-+]/.test(trimmed)) continue;
			if (/^(?:export\s+\w+=|source\s+\S+|\.\s+\S+)/.test(trimmed)) continue;
			preview = trimmed;
		}
	}
	return { language: "bash", text: descriptor(preview) };
}

function shellMagicCommand(code: string): string | undefined {
	let magic: string | undefined;
	for (let index = 0; index < code.length; ) {
		if (index === 0 || code[index - 1] === "\n") {
			let first = index;
			while (code[first] === " " || code[first] === "\t") first += 1;
			if (code[first] === "!") {
				const end = code.indexOf("\n", first + 1);
				magic = code.slice(first, end < 0 ? code.length : end);
				index = end < 0 ? code.length : end + 1;
				continue;
			}
		}
		const char = code[index];
		if (char === "#") {
			const end = code.indexOf("\n", index + 1);
			index = end < 0 ? code.length : end + 1;
			continue;
		}
		if (char === "'" || char === '"') {
			const end = skipPythonString(code, index);
			if (end === undefined) break;
			index = end;
			continue;
		}
		index += 1;
	}
	return magic;
}

export function previewIpythonCode(code: string): IpythonCodePreview {
	const lines = code.trimEnd().split("\n");
	if (BASH_CELL_PATTERN.test(lines[0] ?? "")) return previewBashCommand(lines.slice(1).join("\n"));
	const magic = shellMagicCommand(code);
	if (magic) return previewBashCommand(magic);
	return previewPythonCode(code);
}
