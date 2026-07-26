/**
 * The artifact under construction, as a typed model rather than file text.
 *
 * The walk engine owns emission: nodes contribute typed fragments and this
 * module renders them to Go. That is what makes an off-grain edit
 * unrepresentable. A node that may add fields cannot also rewrite a function
 * body, because the only thing it can hand back is a field list, and formatting
 * defects cannot occur at all because no model ever writes the layout.
 */
import * as path from "node:path";

/** One struct field with its godoc comment. */
export interface GoField {
	name: string;
	type: string;
	doc: string;
}

/** One struct: the type the walk is building. */
export interface GoStruct {
	name: string;
	doc: string;
	fields: GoField[];
}

/** One function or method, in whatever state of completion the walk has reached. */
export interface GoFunc {
	name: string;
	/** Receiver clause such as `b *Budget`. Empty for a plain function. */
	receiver: string;
	/** Parameter list source, such as `limit int`. */
	params: string;
	/** Result list source, such as `(*Budget, error)`. */
	results: string;
	doc: string;
	/** Body plan, one entry per step, rendered as leading line comments. */
	plan: string[];
	/** Body source. Absent until a fill-body node supplies it. */
	body?: string;
}

/** The whole file the walk is constructing. */
export interface GoArtifact {
	/** File name relative to the workspace root. */
	file: string;
	packageName: string;
	imports: string[];
	structs: GoStruct[];
	funcs: GoFunc[];
}

/** Start an empty artifact for a package. */
export function emptyArtifact(file: string, packageName: string): GoArtifact {
	return { file, packageName, imports: [], structs: [], funcs: [] };
}

function renderDoc(doc: string, indent: string): string {
	return doc
		.split("\n")
		.map(line => `${indent}// ${line}`.trimEnd())
		.join("\n");
}

function renderStruct(struct: GoStruct): string {
	const fields = struct.fields.map(field => `${renderDoc(field.doc, "\t")}\n\t${field.name} ${field.type}`);
	const body = fields.length === 0 ? "" : `\n${fields.join("\n")}\n`;
	return `${renderDoc(struct.doc, "")}\ntype ${struct.name} struct {${body}}`;
}

function renderFunc(fn: GoFunc): string {
	const receiver = fn.receiver ? `(${fn.receiver}) ` : "";
	const results = fn.results ? ` ${fn.results}` : "";
	const plan = fn.plan.map(step => `\t// ${step}`);
	const body = fn.body ? fn.body.split("\n").map(line => (line ? `\t${line}` : "")) : ['\tpanic("not implemented")'];
	return [renderDoc(fn.doc, ""), `func ${receiver}${fn.name}(${fn.params})${results} {`, ...plan, ...body, "}"].join(
		"\n",
	);
}

/** Render the artifact to Go source. Deterministic: the same model always emits the same bytes. */
export function renderArtifact(artifact: GoArtifact): string {
	const sections = [`package ${artifact.packageName}`];
	if (artifact.imports.length > 0) {
		const sorted = [...new Set(artifact.imports)].sort();
		sections.push(
			sorted.length === 1
				? `import ${JSON.stringify(sorted[0])}`
				: `import (\n${sorted.map(i => `\t${JSON.stringify(i)}`).join("\n")}\n)`,
		);
	}
	for (const struct of artifact.structs) sections.push(renderStruct(struct));
	for (const fn of artifact.funcs) sections.push(renderFunc(fn));
	return `${sections.join("\n\n")}\n`;
}

/**
 * Write the artifact and normalize it with `gofmt`.
 *
 * Formatting is the engine's job, not the model's: running the formatter here
 * means no walk can produce misformatted output and no node has to spend
 * attention on layout.
 */
export async function writeArtifact(root: string, artifact: GoArtifact): Promise<void> {
	const target = path.join(root, artifact.file);
	await Bun.write(target, renderArtifact(artifact));
	await Bun.spawn(["gofmt", "-w", artifact.file], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited;
}

/** Names of functions still carrying no body, in declaration order. */
export function unimplementedFuncs(artifact: GoArtifact): string[] {
	return artifact.funcs.filter(fn => fn.body === undefined).map(fn => fn.name);
}
