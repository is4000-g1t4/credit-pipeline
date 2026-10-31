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

	it("redacts sensitive own props on logged errors, keeping the std err shape", () => {
		const { logger, last } = capture();
		class UpstreamError extends Error {}
		const err = Object.assign(new UpstreamError("upstream failed"), {
			body: '{"email":"a@b.co"}',
			email: "a@b.co",
			status: 502,
			details: { nationalId: "123-45-6789", reason: "bad" },
		});
		logger.error({ err }, "failed");
		const out = last().err;
		expect(out.type).toBe("UpstreamError");
		expect(out.message).toBe("upstream failed");
		expect(typeof out.stack).toBe("string");
		expect(out.status).toBe(502);
		expect(out.body).toBe("[REDACTED]");
		expect(out.email).toBe("[REDACTED]");
		expect(out.details.nationalId).toBe("[REDACTED]");
		expect(out.details.reason).toBe("bad");
		// caller's error is untouched
		expect(err.email).toBe("a@b.co");
	});

	it("redacts errors logged directly and through their cause chain", () => {
		const { logger, last } = capture();
		const inner = Object.assign(new Error("inner"), { phone: "555-0100", code: "E1" });
		const outer = new Error("outer", { cause: inner });
		logger.error(outer);
		const out = last().err;
		expect(out.type).toBe("Error");
		expect(out.message).toBe("outer");
		expect(out.cause.message).toBe("inner");
		expect(out.cause.code).toBe("E1");
		expect(out.cause.phone).toBe("[REDACTED]");
		expect(last().msg).toBe("outer");
	});

	it("survives error cause cycles", () => {
		const { logger, last } = capture();
		const err = new Error("loop") as Error & { cause?: unknown };
		err.cause = err;
		logger.error({ err });
		expect(last().err.cause).toBe("[Circular]");
	});

	it("redacts class instances and keeps Date/Buffer values", () => {
		const { logger, last } = capture();
		class Applicant {
			constructor(
				public id: string,
				public email: string,
			) {}
		}
		const at = new Date("2026-01-02T03:04:05.000Z");
		logger.info({ applicant: new Applicant("a1", "a@b.co"), at, raw: Buffer.from("hi") });
		expect(last().applicant).toEqual({ id: "a1", email: "[REDACTED]" });
		expect(last().at).toBe("2026-01-02T03:04:05.000Z");
		expect(last().raw).toEqual({ type: "Buffer", data: [104, 105] });
	});

	it("redacts child logger bindings", () => {
		const { logger, last } = capture();
		const child = logger.child({ email: "a@b.co", runId: "r1", nested: { phone: "555" } });
		child.info("hello");
		expect(last().email).toBe("[REDACTED]");
		expect(last().nested.phone).toBe("[REDACTED]");
		expect(last().runId).toBe("r1");
		expect(last().service).toBe("test");
		child.child({ email: "c@d.co" }).info("grandchild");
		expect(last().email).toBe("[REDACTED]");
		expect(last().runId).toBe("r1");
	});

	it("still redacts request cookie/authorization headers", () => {
		const { logger, last } = capture();
		logger.info({ req: { headers: { cookie: "s=1", authorization: "Bearer x", host: "h" } } });
		expect(last().req.headers.cookie).toBe("[REDACTED]");
		expect(last().req.headers.authorization).toBe("[REDACTED]");
		expect(last().req.headers.host).toBe("h");
	});
});

describe("sensitive key matching", () => {
	it.each([
		"applicantEmail",
		"contactPhone",
		"dateOfBirth",
		"date_of_birth",
		"dob",
		"dobIso",
		"addressLine1",
		"homeAddress",
		"address",
		"nationalIdLast4",
		"national_id",
		"apiKey",
		"api_key",
		"OPENROUTER_API_KEY",
		"token",
		"accessToken",
		"runToken",
		"leaseToken",
		"lease_token",
		"sessionToken",
		"secret",
		"internalSecret",
		"Authorization",
		"passwordHash",
		"annualRevenueCents",
		"monthlyIncomeCents",
	])("redacts %s", (key) => {
		const { logger, last } = capture();
		logger.info({ [key]: "v" });
		expect(last()[key]).toBe("[REDACTED]");
	});

	it.each([
		"requestId",
		"runId",
		"tokenCount",
		"inputTokens",
		"outputTokens",
		"maxTokens",
		"maxOutputTokens",
		"tokens",
		"prompt_tokens",
		"completion_tokens",
		"ipAddress",
		"remoteAddress",
		"temporalAddress",
		"applicationId",
		"documentFileId",
		"errorCode",
		"amountCents",
		"lastError",
		"crosscheckId",
	])("keeps %s", (key) => {
		const { logger, last } = capture();
		logger.info({ [key]: "v" });
		expect(last()[key]).toBe("v");
	});
});
