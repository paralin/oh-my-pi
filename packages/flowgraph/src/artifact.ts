/**
 * The artifact under construction, as a typed model rather than file text.
 *
 * The walk engine owns emission: nodes contribute typed fragments and this
 * module renders them to Go. That is what makes an off-grain edit
 * unrepresentable. A node that may add fields cannot also rewrite a function
 * body, because the only thing it can hand back is a field list, and formatting
 * defects cannot occur at all because no model ever writes the layout.
 */
import * as fs from "node:fs/promises";
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

/** One test function: a name, what it establishes, and its body. */
export interface GoTest {
	/** Go test function name, such as `TestAllowConsumesBurst`. */
	name: string;
	/** Comment above the test, saying what behaviour it pins down. */
	doc: string;
	/** Body source, without the `func` line or the closing brace. */
	code: string;
}

/** The two files the walk is constructing: the implementation and its test. */
export interface GoArtifact {
	/** File name relative to the workspace root. */
	file: string;
	packageName: string;
	imports: string[];
	structs: GoStruct[];
	funcs: GoFunc[];
	/** Imports of the test file, kept apart so `testing` never reaches the implementation. */
	testImports: string[];
	/** Test functions, rendered to the `_test.go` beside the artifact. */
	tests: GoTest[];
}

/** Start an empty artifact for a package. */
export function emptyArtifact(file: string, packageName: string): GoArtifact {
	return { file, packageName, imports: [], structs: [], funcs: [], testImports: [], tests: [] };
}

/**
 * Package clause the artifact must carry to compile inside `dir`.
 *
 * A directory that already holds Go source owns its package name, and a second
 * clause in the same directory is a build error no payload in the graph can
 * repair, so the walk adopts the name it finds and falls back to the graph's
 * only when the directory is empty of Go.
 */
export async function resolvePackageName(dir: string, fallback: string): Promise<string> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return fallback;
	}
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".go")) continue;
		const source = await fs.readFile(path.join(dir, entry), "utf8").catch(() => "");
		const clause = source.match(/^package\s+([A-Za-z_]\w*)/m);
		if (clause) return clause[1] as string;
	}
	return fallback;
}

/** Name of the test file beside the artifact, or empty before the file is named. */
export function testFileName(artifact: GoArtifact): string {
	if (!artifact.file) return "";
	return `${artifact.file.replace(/\.go$/, "")}_test.go`;
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

/**
 * Imports the rendered declarations actually mention.
 *
 * Go rejects an unused import, and a step that names the imports its bodies
 * will need runs before those bodies exist, so the stub file would never build.
 * The engine owns the import block, so it also owns keeping it honest: an
 * import returns to the file the moment a body names it. Comments are stripped
 * first, since a plan step that mentions a package does not use it.
 */
function usedImports(imports: readonly string[], declarations: string): string[] {
	const code = declarations.replace(/\/\/[^\n]*/g, "");
	return imports.filter(entry => {
		const spec = entry.trim().split(/\s+/);
		const name = spec.length > 1 ? (spec[0] as string) : (spec[0] as string).split("/").pop();
		return name === "_" || name === "." || new RegExp(`\\b${name}\\s*\\.`).test(code);
	});
}

function renderImports(imports: readonly string[]): string[] {
	if (imports.length === 0) return [];
	const sorted = [...new Set(imports)].sort();
	return [
		sorted.length === 1
			? `import ${JSON.stringify(sorted[0])}`
			: `import (\n${sorted.map(i => `\t${JSON.stringify(i)}`).join("\n")}\n)`,
	];
}

/** Render the artifact to Go source. Deterministic: the same model always emits the same bytes. */
export function renderArtifact(artifact: GoArtifact): string {
	const declarations = [
		...artifact.structs.map(renderStruct),
		...artifact.funcs.map(renderFunc),
	];
	const sections = [
		`package ${artifact.packageName}`,
		...renderImports(usedImports(artifact.imports, declarations.join("\n\n"))),
		...declarations,
	];
	return `${sections.join("\n\n")}\n`;
}

/**
 * Render the test file. Same grain as the implementation: the model hands back
 * named bodies and the engine owns the package clause, the imports and the
 * `func` lines, so a test cannot be misformatted and cannot silently land in
 * the wrong package.
 */
export function renderTests(artifact: GoArtifact): string {
	const declarations = artifact.tests.map(test => {
		const body = test.code.split("\n").map(line => (line ? `\t${line}` : ""));
		return [renderDoc(test.doc, ""), `func ${test.name}(t *testing.T) {`, ...body, "}"].join("\n");
	});
	const sections = [
		`package ${artifact.packageName}`,
		...renderImports(usedImports(artifact.testImports, declarations.join("\n\n"))),
		...declarations,
	];
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
	const written = [artifact.file];
	await Bun.write(path.join(root, artifact.file), renderArtifact(artifact));
	const testFile = testFileName(artifact);
	if (testFile && artifact.tests.length > 0) {
		await Bun.write(path.join(root, testFile), renderTests(artifact));
		written.push(testFile);
	}
	await Bun.spawn(["gofmt", "-w", ...written], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited;
}

/** Names of functions still carrying no body, in declaration order. */
export function unimplementedFuncs(artifact: GoArtifact): string[] {
	return artifact.funcs.filter(fn => fn.body === undefined).map(fn => fn.name);
}
