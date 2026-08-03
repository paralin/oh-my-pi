import { describe, expect, it } from "bun:test";
import { canonicalJsonStringify } from "@oh-my-pi/pi-utils/json";

describe("canonicalJsonStringify", () => {
	it("orders object members at every depth", () => {
		const payload = { b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } };
		const reordered = { a: { c: 3, d: [{ y: 2, z: 1 }] }, b: 1 };

		expect(canonicalJsonStringify(payload)).toBe(canonicalJsonStringify(reordered));
		expect(canonicalJsonStringify(payload)).toBe('{"a":{"c":3,"d":[{"y":2,"z":1}]},"b":1}');
	});

	it("keeps array order, scalar types, and binary bytes meaningful", () => {
		expect(canonicalJsonStringify([1, 2])).not.toBe(canonicalJsonStringify([2, 1]));
		expect(canonicalJsonStringify({ a: 1 })).not.toBe(canonicalJsonStringify({ a: "1" }));
		expect(canonicalJsonStringify({ a: null })).not.toBe(canonicalJsonStringify({}));
		// Index keys encode position, so sorting them lexicographically would
		// reorder the bytes: 10 must stay after 2, not before it.
		expect(canonicalJsonStringify(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))).toBe(
			JSON.stringify(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])),
		);
	});

	it("keeps toJSON hooks, bigints, and a bare undefined serializable", () => {
		expect(canonicalJsonStringify({ at: new Date(0) })).toBe('{"at":"1970-01-01T00:00:00.000Z"}');
		expect(canonicalJsonStringify({ b: 9007199254740993n })).toBe('{"b":"9007199254740993"}');
		expect(canonicalJsonStringify(undefined)).toBe("null");
	});
});
