// Cookie sign/verify and the in-memory rate limiter — all pure,
// compose-free.
import { describe, expect, it } from "vitest";
import { createRateLimiter, parseCookies, signSession, verifySession } from "../src/auth.js";

const SECRET = "test-secret-1234567890abcdef";

describe("session cookie", () => {
	it("round-trips the user id", () => {
		const value = signSession("user-1", SECRET, 1_000);
		expect(verifySession(value, SECRET, 2_000)).toBe("user-1");
	});

	it("rejects tampered payloads and signatures", () => {
		const value = signSession("user-1", SECRET, 1_000);
		const [payload, sig] = value.split(".");
		expect(verifySession(`${btoa("tampered")}.${sig}`, SECRET, 2_000)).toBeNull();
		expect(verifySession(`${payload}.bogus-signature`, SECRET, 2_000)).toBeNull();
		expect(verifySession("no-dot-at-all", SECRET, 2_000)).toBeNull();
		expect(verifySession("", SECRET, 2_000)).toBeNull();
	});

	it("rejects the wrong secret and expired sessions", () => {
		const value = signSession("user-1", SECRET, 1_000);
		expect(verifySession(value, "other-secret", 2_000)).toBeNull();
		expect(verifySession(value, SECRET, 1_000 + 7 * 24 * 3600 * 1000)).toBeNull();
	});

	it("parses cookie headers", () => {
		expect(parseCookies("session=abc.def; other=1")).toEqual({
			session: "abc.def",
			other: "1",
		});
		expect(parseCookies("")).toEqual({});
	});
});

describe("rate limiter", () => {
	it("allows up to the limit, then blocks until the window passes", () => {
		const limiter = createRateLimiter(3, 60_000);
		expect(limiter.check("ip", 0)).toBe(true);
		expect(limiter.check("ip", 1)).toBe(true);
		expect(limiter.check("ip", 2)).toBe(true);
		expect(limiter.check("ip", 3)).toBe(false);
		expect(limiter.check("other", 3)).toBe(true);
		expect(limiter.check("ip", 60_001)).toBe(true);
	});
});
