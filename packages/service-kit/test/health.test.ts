// withTimeout: a never-resolving promise rejects, a fast one passes through.
import { describe, expect, it } from "vitest";
import { withTimeout } from "../src/health.js";

describe("withTimeout", () => {
	it("rejects a never-resolving promise", async () => {
		await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow("timeout");
	});

	it("resolves a fast promise", async () => {
		await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
	});
});
