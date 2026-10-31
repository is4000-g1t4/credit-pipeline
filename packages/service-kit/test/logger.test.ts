// Logger PII redaction: sensitive keys are censored at any depth (top level,
// nested, inside arrays), income*/revenue* prefixes too; the rest passes through.
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";

function capture() {
	const lines: string[] = [];
	const logger = createLogger("test", { write: (s: string) => void lines.push(s) });
	return { logger, last: () => JSON.parse(lines[lines.length - 1]!) as Record<string, any> };
}

describe("logger redaction", () => {
	it("redacts top-level sensitive keys", () => {
		const { logger, last } = capture();
		logger.info({ email: "a@b.co", nationalId: "123", applicationId: "app-1" }, "hi");
		expect(last().email).toBe("[REDACTED]");
		expect(last().nationalId).toBe("[REDACTED]");
		expect(last().applicationId).toBe("app-1");
		expect(last().msg).toBe("hi");
	});

	it("redacts one level deep", () => {
		const { logger, last } = capture();
		logger.info({ a: { b: { email: "x@y.z" }, ok: 1 } });
		expect(last().a.b.email).toBe("[REDACTED]");
		expect(last().a.ok).toBe(1);
	});

	it("redacts three levels deep", () => {
		const { logger, last } = capture();
		logger.info({ l1: { l2: { l3: { phone: "555", dob: "2000-01-01", keep: "yes" } } } });
		expect(last().l1.l2.l3.phone).toBe("[REDACTED]");
		expect(last().l1.l2.l3.dob).toBe("[REDACTED]");
		expect(last().l1.l2.l3.keep).toBe("yes");
	});

	it("redacts inside arrays", () => {
		const { logger, last } = capture();
		logger.info({ applicants: [{ address: "1 Main St", id: 1 }, { nested: [{ password: "p" }] }] });
		expect(last().applicants[0].address).toBe("[REDACTED]");
		expect(last().applicants[0].id).toBe(1);
		expect(last().applicants[1].nested[0].password).toBe("[REDACTED]");
	});

	it("redacts income*/revenue* keys, case-insensitively", () => {
		const { logger, last } = capture();
		logger.info({
			incomeCents: 5_000_00,
			annualIncomeCents: 6_000_00,
			RevenueCents: 7_000_00,
			deep: { revenueCents: 1, IncomeSource: "job" },
			amountCents: 42,
		});
		expect(last().incomeCents).toBe("[REDACTED]");
		expect(last().annualIncomeCents).toBe("[REDACTED]");
		expect(last().RevenueCents).toBe("[REDACTED]");
		expect(last().deep.revenueCents).toBe("[REDACTED]");
		expect(last().deep.IncomeSource).toBe("[REDACTED]");
		expect(last().amountCents).toBe(42);
	});

	it("passes non-sensitive fields through and does not mutate the input", () => {
		const { logger, last } = capture();
		const input = { requestId: "r1", status: 200, nested: { email: "a@b.co", ms: 3 } };
		logger.info(input);
		expect(last().requestId).toBe("r1");
		expect(last().status).toBe(200);
		expect(last().nested.ms).toBe(3);
		expect(input.nested.email).toBe("a@b.co");
	});

	it("survives cycles and keeps err structure", () => {
		const { logger, last } = capture();
		const cyc: Record<string, unknown> = { email: "a@b.co" };
		cyc.self = cyc;
		logger.info({ cyc, err: new Error("boom") });
		expect(last().cyc.email).toBe("[REDACTED]");
		expect(last().cyc.self).toBe("[Circular]");
		expect(last().err.message).toBe("boom");
		expect(typeof last().err.stack).toBe("string");
	});

	it("still redacts request cookie/authorization headers", () => {
		const { logger, last } = capture();
		logger.info({ req: { headers: { cookie: "s=1", authorization: "Bearer x", host: "h" } } });
		expect(last().req.headers.cookie).toBe("[REDACTED]");
		expect(last().req.headers.authorization).toBe("[REDACTED]");
		expect(last().req.headers.host).toBe("h");
	});
});
