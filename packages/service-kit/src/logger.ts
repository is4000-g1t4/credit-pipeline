// Pino logger factory (SPEC FR-11.7): same PII redaction the monolith used —
// national IDs (last 4 only in app code), credentials, contact and financial
// fields are censored wherever they appear in logged objects. Request logs
// carry request id + method/path/status/ms only — never bodies or queries.
//
// pino `redact` paths like `*.email` only match exactly one nesting level, so
// sensitive keys are censored by a deep walk (formatters.log) instead. pino
// redact is kept only for the request header paths.
import pino, { type Logger } from "pino";

export type { Logger };

const CENSOR = "[REDACTED]";
const MAX_DEPTH = 12;

// Matched case-insensitively at ANY depth, including inside arrays.
const SENSITIVE_KEYS = new Set(
	[
		"nationalId",
		"national_id",
		"registrationNumber",
		"registration_number",
		"dob",
		"email",
		"phone",
		"address",
		"password",
		"passwordHash",
		"password_hash",
		"identity",
		"financial",
		"business",
		// T01 document content (SPEC-t01-t02 §8): page text, quotes,
		// filenames, and crosscheck expected/observed values must
		// never reach logs/traces. Document failures log
		// {documentFileId, errorCode} only.
		"text",
		"quote",
		"originalFilename",
		"original_filename",
		"body",
		"observed",
		"expected",
	].map((k) => k.toLowerCase()),
);
// Keys starting with income/revenue (incomeCents, revenueCents).
const SENSITIVE_PREFIX = /^(income|revenue)/i;
// Keys that merely contain "income" (annualIncomeCents, monthlyIncomeCents).
const SENSITIVE_CONTAINS = /income/i;

function isSensitiveKey(key: string): boolean {
	return (
		SENSITIVE_KEYS.has(key.toLowerCase()) ||
		SENSITIVE_PREFIX.test(key) ||
		SENSITIVE_CONTAINS.test(key)
	);
}

function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Deep-redacts sensitive keys without mutating the input. Cycle-safe, depth-capped. */
export function redactDeep(value: unknown, depth = 0, ancestors = new WeakSet<object>()): unknown {
	if (value === null || typeof value !== "object") return value;
	const isArray = Array.isArray(value);
	// Errors, Dates, Buffers etc. keep their shape (pino's err serializer needs them).
	if (!isArray && !isPlainObject(value)) return value;
	if (ancestors.has(value)) return "[Circular]";
	if (depth >= MAX_DEPTH) return "[MaxDepth]";
	ancestors.add(value);
	let out: unknown;
	if (isArray) {
		out = (value as unknown[]).map((item) => redactDeep(item, depth + 1, ancestors));
	} else {
		const copy: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			copy[k] = isSensitiveKey(k) ? CENSOR : redactDeep(v, depth + 1, ancestors);
		}
		out = copy;
	}
	ancestors.delete(value);
	return out;
}

export function createLogger(service: string, destination?: pino.DestinationStream): Logger {
	return pino(
		{
			level: process.env.LOG_LEVEL ?? "info",
			base: { service },
			formatters: {
				log: (obj) => redactDeep(obj) as Record<string, unknown>,
			},
			redact: {
				paths: ["req.headers.cookie", "req.headers.authorization"],
				censor: CENSOR,
			},
		},
		destination,
	);
}
