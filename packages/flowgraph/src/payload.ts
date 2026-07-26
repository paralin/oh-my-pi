/**
 * Payload kinds: the typed blank a node asks the model to fill.
 *
 * A node names one kind. The engine validates the answer's payload against that
 * kind's schema and applies it to the artifact itself, so the grain of an edit
 * is a property of the graph rather than of the model's restraint. There is no
 * payload kind that rewrites a whole file, which is why a fill-body node cannot
 * quietly re-emit the type it was not asked about.
 */
import { z } from "@oh-my-pi/pi-ai";
import type { GoArtifact } from "./artifact";

const fieldSchema = z.object({
	name: z.string().min(1),
	type: z.string().min(1),
	doc: z.string().min(1),
});

const funcSchema = z.object({
	name: z.string().min(1),
	receiver: z.string().default(""),
	params: z.string().default(""),
	results: z.string().default(""),
	doc: z.string().min(1),
});

const schemas = {
	/** The node collects nothing; it only chooses an edge. */
	none: z.object({}),
	/** Declare the file and the struct that owns it, with no fields yet. */
	struct: z.object({
		file: z.string().regex(/^[a-z0-9_]+\.go$/, "lowercase Go file name"),
		name: z.string().min(1),
		doc: z.string().min(1),
	}),
	/** Replace the struct's entire field set. */
	fields: z.object({ fields: z.array(fieldSchema) }),
	/** Declare the function set with final signatures and no bodies. */
	stubs: z.object({
		imports: z.array(z.string().min(1)).default([]),
		funcs: z.array(funcSchema).min(1),
	}),
	/** Attach a step plan to each named function. */
	plans: z.object({
		plans: z.array(z.object({ func: z.string().min(1), steps: z.array(z.string().min(1)).min(1) })).min(1),
	}),
	/** Implement exactly one function body. */
	body: z.object({
		func: z.string().min(1),
		imports: z.array(z.string().min(1)).default([]),
		code: z.string().min(1),
		/** Plan steps worth keeping as comments. Everything else is dropped. */
		keepPlan: z.array(z.string()).default([]),
	}),
	/** Replace one body that is already implemented and turned out to be wrong. */
	revision: z.object({
		func: z.string().min(1),
		imports: z.array(z.string().min(1)).default([]),
		code: z.string().min(1),
		/** What was wrong with the body being replaced, kept in the record. */
		defect: z.string().min(1),
	}),
	/** Replace the whole test set of the artifact's test file. */
	tests: z.object({
		imports: z.array(z.string().min(1)).default([]),
		tests: z
			.array(
				z.object({
					name: z.string().regex(/^Test[A-Z_]\w*$/, "Go test function name starting with Test"),
					doc: z.string().min(1),
					code: z.string().min(1),
				}),
			)
			.min(1),
	}),
} as const;

/** Name of a payload kind a node may declare. */
export type PayloadKind = keyof typeof schemas;

/** Every payload kind, for graph validation. */
export const PAYLOAD_KINDS = Object.keys(schemas) as PayloadKind[];

/** JSON-schema-shaped description of a kind, rendered into the node's question. */
export function describePayload(kind: PayloadKind): string {
	return JSON.stringify(z.toJSONSchema(schemas[kind], { io: "input" }).properties ?? {});
}

/**
 * Validate and apply a payload to the artifact.
 *
 * Returns the human-readable reason on rejection so the engine can hand it back
 * as a tool error, which keeps the model in the node with a concrete correction
 * rather than advancing on a malformed answer.
 */
function normalizeReceiver(receiver: string): string {
	if (!receiver.trim()) return "";
	const typeExpression = receiver.trim().split(/\s+/).at(-1) ?? "";
	const typeName = typeExpression.replace(/^\*+/, "").split(".")[0]?.split("[")[0] ?? "";
	if (!typeName) return receiver;
	return `${typeName[0]?.toLowerCase()} ${typeExpression}`;
}

export function applyPayload(
	kind: PayloadKind,
	raw: unknown,
	artifact: GoArtifact,
): { ok: true; summary: string } | { ok: false; reason: string } {
	const parsed = schemas[kind].safeParse(raw ?? {});
	if (!parsed.success) {
		return {
			ok: false,
			reason: parsed.error.issues.map(i => `${i.path.join(".") || "payload"}: ${i.message}`).join("; "),
		};
	}

	switch (kind) {
		case "none":
			return { ok: true, summary: "no artifact change" };

		case "struct": {
			const value = parsed.data as z.infer<(typeof schemas)["struct"]>;
			if (artifact.structs.some(s => s.name === value.name)) {
				return { ok: false, reason: `struct ${value.name} already exists` };
			}
			artifact.file = value.file;
			artifact.structs.push({ name: value.name, doc: value.doc, fields: [] });
			return { ok: true, summary: `declared struct ${value.name} in ${value.file}` };
		}

		case "fields": {
			const value = parsed.data as z.infer<(typeof schemas)["fields"]>;
			const struct = artifact.structs.at(-1);
			if (!struct) return { ok: false, reason: "no struct has been declared yet" };
			struct.fields = value.fields;
			return { ok: true, summary: `set ${value.fields.length} field(s) on ${struct.name}` };
		}

		case "stubs": {
			const value = parsed.data as z.infer<(typeof schemas)["stubs"]>;
			artifact.imports.push(...value.imports);
			artifact.funcs = value.funcs.map(fn => ({ ...fn, receiver: normalizeReceiver(fn.receiver), plan: [] }));
			return { ok: true, summary: `declared ${value.funcs.length} stub(s)` };
		}

		case "plans": {
			const value = parsed.data as z.infer<(typeof schemas)["plans"]>;
			for (const plan of value.plans) {
				const fn = artifact.funcs.find(f => f.name === plan.func);
				if (!fn) return { ok: false, reason: `unknown function: ${plan.func}` };
				fn.plan = plan.steps;
			}
			return { ok: true, summary: `planned ${value.plans.length} body/bodies` };
		}

		case "body": {
			const value = parsed.data as z.infer<(typeof schemas)["body"]>;
			const fn = artifact.funcs.find(f => f.name === value.func);
			if (!fn) return { ok: false, reason: `unknown function: ${value.func}` };
			if (fn.body !== undefined) return { ok: false, reason: `${value.func} is already implemented` };
			artifact.imports.push(...value.imports);
			fn.plan = value.keepPlan;
			fn.body = value.code;
			return { ok: true, summary: `implemented ${value.func}` };
		}

		case "revision": {
			const value = parsed.data as z.infer<(typeof schemas)["revision"]>;
			const fn = artifact.funcs.find(f => f.name === value.func);
			if (!fn) return { ok: false, reason: `unknown function: ${value.func}` };
			// The mirror of the `body` guard: `body` refuses to overwrite, this
			// refuses to write a body that does not exist yet, so neither kind can
			// stand in for the other and the record says which one happened.
			if (fn.body === undefined) return { ok: false, reason: `${value.func} is not implemented yet` };
			artifact.imports.push(...value.imports);
			fn.body = value.code;
			return { ok: true, summary: `revised ${value.func}: ${value.defect}` };
		}

		case "tests": {
			const value = parsed.data as z.infer<(typeof schemas)["tests"]>;
			if (!artifact.file) return { ok: false, reason: "no artifact file has been named yet" };
			const names = new Set<string>();
			for (const test of value.tests) {
				if (names.has(test.name)) return { ok: false, reason: `duplicate test: ${test.name}` };
				names.add(test.name);
			}
			// The engine writes the `t *testing.T` signature, so the import it
			// implies is the engine's to add rather than a thing a payload can
			// forget.
			artifact.testImports = ["testing", ...value.imports];
			artifact.tests = value.tests;
			return { ok: true, summary: `wrote ${value.tests.length} test(s)` };
		}
	}
}
