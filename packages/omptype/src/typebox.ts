import { OmpTypeError } from "./errors";
import type { Def } from "./ir";
import { type NarrowContext, type Type as OmpType, type } from "./type";

export interface Meta {
	title?: string;
	description?: string;
	default?: unknown;
	examples?: unknown[];
	[key: string]: unknown;
}

export interface StringOpts extends Meta {
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	format?: string;
}

export interface NumberOpts extends Meta {
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
	multipleOf?: number;
}

export interface ArrayOpts extends Meta {
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
}

export interface ObjectOpts extends Meta {
	additionalProperties?: boolean | TSchema;
}
const OPTIONAL_INNER = Symbol("omptype.typebox.optionalInner");
const OBJECT_INFO = Symbol("omptype.typebox.objectInfo");

export interface TypeBoxValidationFailure {
	message: string;
}

export type TypeBoxSafeParseResult<T> =
	| { success: true; data: T }
	| { success: false; error: TypeBoxValidationFailure };

interface LegacyTypeBoxCompat<T> {
	/** TypeBox compatibility validator used by legacy extension loaders. */
	__validator(data: unknown): T | TypeBoxValidationFailure;
	/** Zod-style compatibility parser used by legacy extensions. */
	safeParse(input: unknown): TypeBoxSafeParseResult<T>;
}

export type TSchema<T = unknown> = OmpType<T> & LegacyTypeBoxCompat<T>;
export type Static<T extends TSchema> = T["infer"];
export type TAny = TSchema<unknown>;
export type TUnknown = TSchema<unknown>;
export type TNever = TSchema<never>;
export type TNull = TSchema<null>;
export type TString = TSchema<string>;
export type TNumber = TSchema<number>;
export type TInteger = TSchema<number>;
export type TBoolean = TSchema<boolean>;
export type TLiteral<V extends string | number | boolean | null> = TSchema<V>;
export type TArray<E extends TSchema> = TSchema<Static<E>[]>;
export type TTuple<E extends readonly TSchema[] = readonly TSchema[]> = TSchema<{
	-readonly [K in keyof E]: Static<E[K]>;
}>;
export type TOptional<E extends TSchema> = TSchema<Static<E> | undefined> & { readonly [OPTIONAL_INNER]: E };
export type TUnion<E extends readonly TSchema[] = readonly TSchema[]> = TSchema<Static<E[number]>>;
export type TIntersect<E extends readonly TSchema[] = readonly TSchema[]> = TSchema<
	UnionToIntersection<Static<E[number]>>
>;
export type TEnum<E extends readonly (string | number)[] = readonly (string | number)[]> = TSchema<E[number]>;
export type TRecord<K extends TSchema, V extends TSchema> = TSchema<Record<Extract<Static<K>, PropertyKey>, Static<V>>>;
export type TNullable<E extends TSchema> = TSchema<Static<E> | null>;
export type TReadonly<E extends TSchema> = TSchema<Readonly<Static<E>>>;
export type TUnsafe<T = unknown> = TSchema<T>;

type OptionalKeys<P extends Record<string, TSchema>> = {
	[K in keyof P]-?: P[K] extends { readonly [OPTIONAL_INNER]: TSchema } ? K : never;
}[keyof P];
type RequiredKeys<P extends Record<string, TSchema>> = Exclude<keyof P, OptionalKeys<P>>;
type ObjectStatic<P extends Record<string, TSchema>> = {
	[K in RequiredKeys<P>]: Static<P[K]>;
} & {
	[K in OptionalKeys<P>]?: Exclude<Static<P[K]>, undefined>;
};
export type TObject<P extends Record<string, TSchema> = Record<string, TSchema>> = TSchema<ObjectStatic<P>>;
type RequiredProps<P extends Record<string, TSchema>> = {
	[K in keyof P]: P[K] extends TOptional<infer E> ? E : P[K];
};

interface RuntimeType<T> extends OmpType<T> {
	[OPTIONAL_INNER]?: TSchema;
	[OBJECT_INFO]?: ObjectInfo;
	describe(description: string): RuntimeType<T>;
	default(value: T | (() => T)): RuntimeType<T>;
	or<R>(schema: OmpType<R>): RuntimeType<T | R>;
	and<R>(schema: OmpType<R>): RuntimeType<T & R>;
	array(): RuntimeType<T[]>;
	atLeastLength(bound: number): RuntimeType<T>;
	atMostLength(bound: number): RuntimeType<T>;
	atLeast(bound: number): RuntimeType<T>;
	atMost(bound: number): RuntimeType<T>;
	narrow<N extends T>(predicate: (value: T, ctx: NarrowContext) => value is N): RuntimeType<N>;
	narrow(predicate: (value: T, ctx: NarrowContext) => boolean): RuntimeType<T>;
}
type CompatRuntime<T> = RuntimeType<T> & LegacyTypeBoxCompat<T>;

type ObjectInfo = { props: Record<string, TSchema>; additionalProperties?: boolean | TSchema };

function validationFailure(message: string): TypeBoxValidationFailure {
	return { message };
}

function withLegacyCompat<T>(schema: OmpType<T>): CompatRuntime<T> {
	const compatSchema = schema as unknown as CompatRuntime<T>;
	if (!Object.hasOwn(compatSchema, "__validator")) {
		Object.defineProperty(compatSchema, "__validator", {
			value: (data: unknown): T | TypeBoxValidationFailure => {
				const result = schema(data);
				return result instanceof type.errors ? validationFailure(result.summary) : result;
			},
			configurable: true,
		});
	}
	if (!Object.hasOwn(compatSchema, "safeParse")) {
		Object.defineProperty(compatSchema, "safeParse", {
			value: (input: unknown): TypeBoxSafeParseResult<T> => {
				const result = schema(input);
				return result instanceof type.errors
					? { success: false, error: validationFailure(result.summary) }
					: { success: true, data: result };
			},
			configurable: true,
		});
	}
	return compatSchema;
}

function applyMeta<T>(schema: RuntimeType<T>, opts?: Meta): CompatRuntime<T> {
	let result = schema;
	const description = opts?.description ?? opts?.title;
	if (description !== undefined) result = result.describe(description);
	if (opts && Object.hasOwn(opts, "default")) result = result.default(opts.default as T);
	return withLegacyCompat(result);
}

function withJsonSchemaKeywords<T>(schema: CompatRuntime<T>, keywords: Record<string, unknown>): CompatRuntime<T> {
	const emitBase = schema.toJsonSchema.bind(schema);
	schema.toJsonSchema = options => ({ ...emitBase(options), ...keywords });
	return schema;
}

function checkFiniteOption(name: string, value: number | undefined): void {
	if (value !== undefined && !Number.isFinite(value)) throw new OmpTypeError(`${name} must be finite`);
}

function tString(opts?: StringOpts): TString {
	checkFiniteOption("minLength", opts?.minLength);
	checkFiniteOption("maxLength", opts?.maxLength);
	let schema = type.raw(
		opts?.format === "url" || opts?.format === "uri" ? "string.url" : "string",
	) as RuntimeType<string>;
	if (opts?.minLength !== undefined) schema = schema.atLeastLength(opts.minLength);
	if (opts?.maxLength !== undefined) schema = schema.atMostLength(opts.maxLength);
	if (opts?.pattern !== undefined) {
		let regex: RegExp;
		try {
			regex = new RegExp(opts.pattern);
		} catch {
			throw new OmpTypeError(`invalid regular expression pattern ${JSON.stringify(opts.pattern)}`);
		}
		schema = schema.narrow((value, ctx) => regex.test(value) || ctx.mustBe(`a string matching ${opts.pattern}`));
	}
	if (opts?.format !== undefined && opts.format !== "url" && opts.format !== "uri") {
		const format = opts.format;
		const valid = formatPredicate(format);
		schema = schema.narrow((value, ctx) => valid(value) || ctx.mustBe(`a string in ${format} format`));
	}
	return applyMeta(schema, opts);
}

function formatPredicate(format: string): (value: string) => boolean {
	switch (format) {
		case "url":
		case "uri":
			return value => {
				try {
					new URL(value);
					return true;
				} catch {
					return false;
				}
			};
		case "email":
			return value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
		case "uuid":
			return value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
		case "date-time":
			return value =>
				/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
				!Number.isNaN(Date.parse(value));
		case "date":
			return value => /^\d{4}-\d\d-\d\d$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
		default:
			return () => true;
	}
}

function tNumber(opts?: NumberOpts, integer = false): TNumber {
	for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const) {
		checkFiniteOption(key, opts?.[key]);
	}
	if (opts?.multipleOf !== undefined && opts.multipleOf <= 0)
		throw new OmpTypeError("multipleOf must be greater than zero");
	let lower: { value: number; exclusive: boolean } | undefined;
	if (opts?.minimum !== undefined) lower = { value: opts.minimum, exclusive: false };
	if (opts?.exclusiveMinimum !== undefined && (!lower || opts.exclusiveMinimum >= lower.value)) {
		lower = { value: opts.exclusiveMinimum, exclusive: true };
	}
	let upper: { value: number; exclusive: boolean } | undefined;
	if (opts?.maximum !== undefined) upper = { value: opts.maximum, exclusive: false };
	if (opts?.exclusiveMaximum !== undefined && (!upper || opts.exclusiveMaximum <= upper.value)) {
		upper = { value: opts.exclusiveMaximum, exclusive: true };
	}
	const keyword = integer ? "number.integer" : "number";
	const lowerDsl = lower ? `${lower.value} ${lower.exclusive ? "<" : "<="} ` : "";
	const upperDsl = upper ? ` ${upper.exclusive ? "<" : "<="} ${upper.value}` : "";
	let schema = type.raw(`${lowerDsl}${keyword}${upperDsl}`) as RuntimeType<number>;
	if (opts?.multipleOf !== undefined) {
		const divisor = opts.multipleOf;
		schema = schema.narrow((value, ctx) => {
			const quotient = value / divisor;
			return (
				Math.abs(quotient - Math.round(quotient)) <= Number.EPSILON * Math.max(1, Math.abs(quotient)) ||
				ctx.mustBe(`a multiple of ${divisor}`)
			);
		});
	}
	return applyMeta(schema, opts);
}

function tLiteral<const V extends string | number | boolean | null>(value: V, opts?: Meta): TLiteral<V> {
	return applyMeta(type.enumerated(value) as RuntimeType<V>, opts);
}

function tNever(opts?: Meta): TNever {
	return applyMeta(
		(type.raw("unknown") as RuntimeType<unknown>).narrow((_value, ctx): _value is never => ctx.mustBe("never")),
		opts,
	);
}

function tUnion<const E extends readonly TSchema[]>(schemas: E, opts?: Meta): TUnion<E> {
	if (schemas.length === 0) return tNever(opts) as TUnion<E>;
	let result = schemas[0] as unknown as RuntimeType<unknown>;
	for (let i = 1; i < schemas.length; i++) result = result.or(schemas[i]);
	return applyMeta(result, opts) as TUnion<E>;
}

function tIntersect<const E extends readonly TSchema[]>(
	schemas: E,
	opts?: Meta,
): TSchema<UnionToIntersection<Static<E[number]>>> {
	if (schemas.length === 0)
		return applyMeta(type.raw("unknown") as RuntimeType<unknown>, opts) as TSchema<
			UnionToIntersection<Static<E[number]>>
		>;
	const validateAll = (): RuntimeType<UnionToIntersection<Static<E[number]>>> => {
		const base = type.raw("unknown") as RuntimeType<unknown>;
		return base.narrow((value, ctx): value is UnionToIntersection<Static<E[number]>> => {
			for (const schema of schemas) {
				if (schema(value) instanceof type.errors) return ctx.mustBe("a value satisfying every intersection member");
			}
			return true;
		});
	};
	if (schemas.some(schema => schema.hasSteps)) return applyMeta(validateAll(), opts);
	let result = schemas[0] as unknown as RuntimeType<unknown>;
	try {
		for (let i = 1; i < schemas.length; i++) result = result.and(schemas[i]);
	} catch (error) {
		if (error instanceof OmpTypeError) return applyMeta(validateAll(), opts);
		throw error;
	}
	return applyMeta(result, opts) as TSchema<UnionToIntersection<Static<E[number]>>>;
}
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
	? I
	: never;

function enumValues(values: Record<string, string | number> | readonly (string | number)[]): (string | number)[] {
	if (Array.isArray(values)) return [...values];
	const result: (string | number)[] = [];
	const record = values as Record<string, string | number>;
	for (const key in record) {
		const value = record[key];
		if (!(/^\d+$/.test(key) && typeof value === "string") && !result.includes(value)) result.push(value);
	}
	return result;
}

function tEnum<const E extends Record<string, string | number> | readonly (string | number)[]>(
	values: E,
	opts?: Meta,
): TSchema<E extends readonly (infer V)[] ? V : E[keyof E]> {
	return applyMeta(type.enumerated(...enumValues(values)) as RuntimeType<string | number>, opts) as unknown as TSchema<
		E extends readonly (infer V)[] ? V : E[keyof E]
	>;
}

function tArray<E extends TSchema>(item: E, opts?: ArrayOpts): TArray<E> {
	checkFiniteOption("minItems", opts?.minItems);
	checkFiniteOption("maxItems", opts?.maxItems);
	let schema = (item as unknown as RuntimeType<Static<E>>).array();
	if (opts?.minItems !== undefined) schema = schema.atLeastLength(opts.minItems);
	if (opts?.maxItems !== undefined) schema = schema.atMostLength(opts.maxItems);
	if (opts?.uniqueItems) {
		schema = schema.narrow((values, ctx) => {
			for (let i = 0; i < values.length; i++) {
				for (let j = i + 1; j < values.length; j++) {
					if (jsonEqual(values[i], values[j])) return ctx.mustBe("an array with unique items");
				}
			}
			return true;
		});
	}
	const result = applyMeta(schema, opts);
	return opts?.uniqueItems ? withJsonSchemaKeywords(result, { uniqueItems: true }) : result;
}

function jsonEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

function tTuple<const E extends readonly TSchema[]>(items: E, opts?: Meta): TTuple<E> {
	const schema = (type.raw("unknown") as RuntimeType<unknown>).narrow(
		(value, ctx): value is { -readonly [K in keyof E]: Static<E[K]> } => {
			if (!Array.isArray(value) || value.length !== items.length)
				return ctx.mustBe(`a tuple of length ${items.length}`);
			for (let i = 0; i < items.length; i++)
				if (items[i](value[i]) instanceof type.errors) return ctx.mustBe(`a valid item at index ${i}`);
			return true;
		},
	);
	return applyMeta(schema, opts);
}

function tObject<const P extends Record<string, TSchema>>(properties: P, opts?: ObjectOpts): TObject<P> {
	const def: Record<string, Def> = {};
	const props: Record<string, TSchema> = {};
	for (const key in properties) {
		const schema = properties[key];
		const inner = (schema as unknown as RuntimeType<unknown>)[OPTIONAL_INNER];
		def[inner ? `${key}?` : key] = (inner ?? schema) as Def;
		props[key] = schema;
	}
	if (opts?.additionalProperties === false) def["+"] = "reject";
	else if (opts?.additionalProperties && opts.additionalProperties !== true)
		def["[string]"] = opts.additionalProperties as Def;
	const schema = applyMeta(type.raw(def) as RuntimeType<ObjectStatic<P>>, opts);
	schema[OBJECT_INFO] = { props, additionalProperties: opts?.additionalProperties };
	return schema;
}

function tRecord<K extends TSchema, V extends TSchema>(key: K, value: V, opts?: Meta): TRecord<K, V> {
	const base = (type.raw({ "[string]": value }) as RuntimeType<Record<string, Static<V>>>).narrow((record, ctx) => {
		for (const name in record)
			if (key(name) instanceof type.errors) return ctx.mustBe("an object with valid record keys");
		return true;
	});
	return applyMeta(base, opts) as TRecord<K, V>;
}

function tOptional<E extends TSchema>(schema: E, opts?: Meta): TOptional<E> {
	const marker = applyMeta(
		(schema as unknown as RuntimeType<Static<E>>).or(type.raw("undefined")),
		opts,
	) as RuntimeType<Static<E> | undefined>;
	marker[OPTIONAL_INNER] = schema;
	return marker as unknown as TOptional<E>;
}

function tNullable<E extends TSchema>(schema: E, opts?: Meta): TSchema<Static<E> | null> {
	return applyMeta((schema as unknown as RuntimeType<Static<E>>).or(type.raw("null")), opts);
}

function requireObject(schema: TSchema, operation: string): ObjectInfo {
	const info = (schema as unknown as RuntimeType<unknown>)[OBJECT_INFO];
	if (!info) throw new OmpTypeError(`Type.${operation} requires a schema created by Type.Object`);
	return info;
}

function tPartial<P extends Record<string, TSchema>>(schema: TObject<P>): TSchema<Partial<ObjectStatic<P>>> {
	const info = requireObject(schema, "Partial");
	const props: Record<string, TSchema> = {};
	for (const key in info.props)
		props[key] = (info.props[key] as unknown as RuntimeType<unknown>)[OPTIONAL_INNER]
			? info.props[key]
			: tOptional(info.props[key]);
	return tObject(props, { additionalProperties: info.additionalProperties }) as TSchema<Partial<ObjectStatic<P>>>;
}

function tRequired<P extends Record<string, TSchema>>(schema: TObject<P>): TObject<RequiredProps<P>> {
	const info = requireObject(schema, "Required");
	const props: Record<string, TSchema> = {};
	for (const key in info.props) {
		props[key] = (info.props[key] as unknown as RuntimeType<unknown>)[OPTIONAL_INNER] ?? info.props[key];
	}
	return tObject(props, { additionalProperties: info.additionalProperties }) as TObject<RequiredProps<P>>;
}

function tPick<P extends Record<string, TSchema>, const K extends readonly (keyof P)[]>(
	schema: TObject<P>,
	keys: K,
): TObject<Pick<P, K[number]>> {
	const info = requireObject(schema, "Pick");
	const props: Record<string, TSchema> = {};
	for (const key of keys) if (typeof key === "string" && info.props[key]) props[key] = info.props[key];
	return tObject(props, { additionalProperties: info.additionalProperties }) as TObject<Pick<P, K[number]>>;
}

function tOmit<P extends Record<string, TSchema>, const K extends readonly (keyof P)[]>(
	schema: TObject<P>,
	keys: K,
): TObject<Omit<P, K[number]>> {
	const info = requireObject(schema, "Omit");
	const omitted = new Set<PropertyKey>(keys);
	const props: Record<string, TSchema> = {};
	for (const key in info.props) if (!omitted.has(key)) props[key] = info.props[key];
	return tObject(props, { additionalProperties: info.additionalProperties }) as TObject<Omit<P, K[number]>>;
}

function tComposite<const E extends readonly TObject<Record<string, TSchema>>[]>(
	schemas: E,
	opts?: ObjectOpts,
): TSchema<UnionToIntersection<Static<E[number]>>> {
	const props: Record<string, TSchema> = {};
	for (const schema of schemas) Object.assign(props, requireObject(schema, "Composite").props);
	return tObject(props, opts) as TSchema<UnionToIntersection<Static<E[number]>>>;
}

function tUnsafe<T = unknown>(_jsonSchema: Record<string, unknown> = {}): TUnsafe<T> {
	// Raw JSON Schema is accepted for source compatibility but is not retained or validated:
	// omptype cannot honestly implement that contract without importing a second validator.
	return withLegacyCompat(type.unknown as OmpType<T>);
}

export const Type = {
	String: tString,
	Number: (opts?: NumberOpts) => tNumber(opts),
	Integer: (opts?: NumberOpts) => tNumber(opts, true),
	Boolean: (opts?: Meta) => applyMeta(type.raw("boolean") as RuntimeType<boolean>, opts),
	Null: (opts?: Meta) => applyMeta(type.raw("null") as RuntimeType<null>, opts),
	Any: (opts?: Meta) => applyMeta(type.raw("unknown") as RuntimeType<unknown>, opts),
	Unknown: (opts?: Meta) => applyMeta(type.raw("unknown") as RuntimeType<unknown>, opts),
	Never: tNever,
	Literal: tLiteral,
	Union: tUnion,
	Intersect: tIntersect,
	Enum: tEnum,
	Array: tArray,
	Tuple: tTuple,
	Object: tObject,
	Record: tRecord,
	Optional: tOptional,
	Nullable: tNullable,
	Readonly: <E extends TSchema>(schema: E): E => withLegacyCompat(schema) as unknown as E,
	Partial: tPartial,
	Required: tRequired,
	Pick: tPick,
	Omit: tOmit,
	Composite: tComposite,
	Unsafe: tUnsafe,
} as const;

export type TypeBuilder = typeof Type;
export default { Type };
