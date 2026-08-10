import { describe, expect, it } from "bun:test";
import { actCancellationCapability } from "../../src/session/act-cancellation";

describe("Act cancellation capability", () => {
	it("uses correlated synchronous-cell and managed-process cancellation on POSIX", () => {
		expect(actCancellationCapability("linux")).toBe("posix-managed");
		expect(actCancellationCapability("darwin")).toBe("posix-managed");
	});

	it("uses cooperative-only cancellation on Windows", () => {
		expect(actCancellationCapability("win32")).toBe("cooperative-only");
	});
});
