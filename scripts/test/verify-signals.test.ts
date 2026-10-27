// T18 demo:verify signal gating (SPEC-t17-t18 §2.5): exact expected-signal
// checks run only for stub runs whose context stage succeeded; live runs
// require non-empty deterministic types. Every other mode (flags-off,
// skipped/failed/not_applicable) is a passing seam. Compose-free.
import { describe, expect, it } from "vitest";
import { checkExpectedSignals } from "../lib/verify.js";

const BREADTALK = ["round_trip", "cash_deposit_share", "returned_payment"];

function signal(type: string, status = "review"): { type: string; status: string } {
	return { type, status };
}

describe("checkExpectedSignals", () => {
	it("passes any non-succeeded context as a seam (T18 disabled/skipped/failed)", () => {
		for (const contextStatus of ["skipped", "failed", "not_applicable", "queued", "running"]) {
			const checks = checkExpectedSignals({
				contextStatus,
				isStub: true,
				actual: [],
				expected: BREADTALK,
				runShortId: "abc123",
			});
			expect(checks).toHaveLength(1);
			expect(checks[0]).toMatchObject({ name: "t18 expected signals", ok: true });
		}
	});

	it("pins exact stub types with well-formed statuses (breadtalk)", () => {
		const checks = checkExpectedSignals({
			contextStatus: "succeeded",
			isStub: true,
			actual: BREADTALK.map((t) => signal(t)),
			expected: BREADTALK,
			runShortId: "abc123",
		});
		expect(checks.map((c) => [c.name, c.ok])).toEqual([
			["t18 signal statuses", true],
			["t18 expected signal types", true],
			["t18 no fabricated signals", true],
		]);
	});

	it("passes an empty succeeded stub when the manifest expects none", () => {
		const checks = checkExpectedSignals({
			contextStatus: "succeeded",
			isStub: true,
			actual: [],
			expected: [],
			runShortId: "abc123",
		});
		expect(checks.every((c) => c.ok)).toBe(true);
	});

	it("fails stub type drift and fabricated signals", () => {
		const checks = checkExpectedSignals({
			contextStatus: "succeeded",
			isStub: true,
			actual: [signal("round_trip"), signal("negative_balance")],
			expected: BREADTALK,
			runShortId: "abc123",
		});
		expect(checks.find((c) => c.name === "t18 expected signal types")?.ok).toBe(false);
		expect(checks.find((c) => c.name === "t18 no fabricated signals")?.ok).toBe(false);
	});

	it("fails malformed statuses even on a stub (insufficient_data pairing)", () => {
		const checks = checkExpectedSignals({
			contextStatus: "succeeded",
			isStub: true,
			actual: [{ type: "insufficient_data", status: "review" }],
			expected: ["insufficient_data"],
			runShortId: "abc123",
		});
		expect(checks.find((c) => c.name === "t18 signal statuses")?.ok).toBe(false);
	});

	it("checks live runs by status shape and deterministic type allowlist", () => {
		const checks = checkExpectedSignals({
			contextStatus: "succeeded",
			isStub: false,
			actual: [signal("round_trip"), signal("revenue_concentration")],
			expected: BREADTALK,
			runShortId: "abc123",
		});
		expect(checks.map((c) => [c.name, c.ok])).toEqual([
			["t18 signal statuses", true],
			["t18 expected signal types", true],
			["t18 no fabricated signals", true],
		]);
	});

	it("fails a live succeeded run with no signals or an unknown type", () => {
		const empty = checkExpectedSignals({
			contextStatus: "succeeded",
			isStub: false,
			actual: [],
			expected: BREADTALK,
			runShortId: "abc123",
		});
		expect(empty.find((c) => c.name === "t18 expected signal types")?.ok).toBe(false);

		const fabricated = checkExpectedSignals({
			contextStatus: "succeeded",
			isStub: false,
			actual: [signal("round_trip"), signal("made_up_signal")],
			expected: BREADTALK,
			runShortId: "abc123",
		});
		expect(fabricated.find((c) => c.name === "t18 no fabricated signals")?.ok).toBe(false);
	});
});
