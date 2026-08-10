import { describe, expect, test } from "bun:test";
import { darwinSdk27BazelArgs } from "./bazel-natives";

const darwinTarget = ["//:natives-darwin-arm64"];

describe("Darwin SDK 27 Bazel configuration", () => {
	test("adds the compatibility define for a Darwin SDK 27 addon", () => {
		expect(darwinSdk27BazelArgs(darwinTarget, [], () => "27.0")).toEqual(["--define=omp_macos_sdk27=1"]);
	});

	test("leaves older Darwin SDKs unchanged", () => {
		expect(darwinSdk27BazelArgs(darwinTarget, [], () => "26.0")).toEqual([]);
	});

	test.each(["//:natives-linux-x64-baseline", "//:natives-win32-x64-baseline", "//:natives-linux-all"])(
		"does not probe SDKs without a Darwin target: %s",
		label => {
			expect(
				darwinSdk27BazelArgs([label], [], () => {
					throw new Error("non-Darwin targets must not probe xcrun");
				}),
			).toEqual([]);
		},
	);

	test("preserves an explicit SDK compatibility override", () => {
		expect(
			darwinSdk27BazelArgs(darwinTarget, ["--define=omp_macos_sdk27=0"], () => {
				throw new Error("explicit overrides must not probe xcrun");
			}),
		).toEqual([]);
	});
});
