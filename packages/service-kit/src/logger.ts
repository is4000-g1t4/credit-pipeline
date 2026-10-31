// Pino logger factory (SPEC FR-11.7): same PII redaction the monolith used —
// national IDs (last 4 only in app code), credentials, contact and financial
// fields are censored wherever they appear in logged objects. Request logs
// carry request id + method/path/status/ms only — never bodies or queries.
//
// pino `redact` paths like `*.email` only match exactly one nesting level, so
// sensitive keys are censored by a deep walk (formatters.log + bindings)
// instead. pino runs formatters.log BEFORE serializers, so the walk also
// flattens Errors itself (otherwise err.body/err.details would print in
// clear). pino redact is kept only for the request header paths.
import pino, { type Logger } from "pino";

export type { Logger };

const CENSOR = "[REDACTED]";
const MAX_DEPTH = 12;

// Exact keys, matched case-insensitively at ANY depth, including inside arrays.
const SENSITIVE_KEYS = new Set(
	[
		"registrationNumber",
		"registration_number",
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

// Substrings of the key, lowercased with `_`/`-` removed: catches
// applicantEmail, contactPhone, nationalIdLast4, api_key, internalSecret,
// passwordHash, annualIncomeCents, revenueCents, dateOfBirth, ...
const SENSITIVE_SUBSTRINGS = [
	"email",
	"phone",
	"nationalid",
	"password",
	"secret",
	"apikey",
	"authorization",
	"dateofbirth",
	"income",
	"revenue",
];

// Word-segment rules (camelCase/snake_case/kebab-case split), so short or
// ambiguous words do not over-match:
// - `token` only as the LAST segment: token, accessToken, runToken,
//   lease_token are secrets; inputTokens, maxTokens, tokenCount are not.
// - `dob` as any segment (dob, dobIso) but not inside another word.
// - `address` as any segment (address, addressLine1, homeAddress) EXCEPT
//   network endpoints (ipAddress, remoteAddress, temporalAddress, ...),
//   which are infrastructure config, not applicant PII.
const NETWORK_ADDRESS_QUALIFIERS = new Set([
	"ip",
	"mac",
	"remote",
	"local",
	"server",
	"host",
	"temporal",
]);

function keySegments(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function isSensitiveKey(key: string): boolean {
	const lower = key.toLowerCase();
	if (SENSITIVE_KEYS.has(lower)) return true;
	const compact = lower.replace(/[_-]/g, "");
	if (SENSITIVE_SUBSTRINGS.some((s) => compact.includes(s))) return true;
	const segments = keySegments(key);
	if (segments.at(-1) === "token") return true;
	if (segments.includes("dob")) return true;
	const addressAt = segments.indexOf("address");
	if (addressAt !== -1) {
		const qualifier = addressAt > 0 ? segments[addressAt - 1]! : "";
		if (!NETWORK_ADDRESS_QUALIFIERS.has(qualifier)) return true;
	}
	return false;
}

/** Values JSON-serialized as-is: no keys to redact. */
function isOpaqueValue(value: object): boolean {
	return value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

/**
 * Plain-object view of an Error, shaped like pino's std err serializer
 * (type, message, stack, aggregateErrors, own enumerable props) plus a
 * structured `cause`. The caller redacts it like any other object.
 */
function errorToObject(err: Error): Record<string, unknown> {
	const out: Record<string, unknown> = {
		type: typeof err.constructor === "function" ? err.constructor.name : err.name,
		message: err.message,
		stack: err.stack,
	};
	const errors = (err as { errors?: unknown }).errors;
	if (Array.isArray(errors)) out.aggregateErrors = errors;
	for (const [k, v] of Object.entries(err)) {
		if (!(k in out)) out[k] = v;
	}
	if (err.cause !== undefined) out.cause = err.cause;
	return out;
}

/**
 * Deep-redacts sensitive keys without mutating the input. Cycle-safe,
 * depth-capped. Errors become plain objects (see errorToObject); other class
 * instances are walked by their own enumerable keys (or their toJSON()
 * result); Dates, Buffers and typed arrays pass through.
 */
export function redactDeep(value: unknown, depth = 0, ancestors = new WeakSet<object>()): unknown {
	if (value === null || typeof value !== "object") return value;
	if (isOpaqueValue(value)) return value;
	if (ancestors.has(value)) return "[Circular]";
	if (depth >= MAX_DEPTH) return "[MaxDepth]";
	ancestors.add(value);
	let out: unknown;
	if (Array.isArray(value)) {
		out = value.map((item) => redactDeep(item, depth + 1, ancestors));
	} else {
		let source: object = value;
		if (value instanceof Error) {
			source = errorToObject(value);
		} else if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
			const json: unknown = (value as { toJSON: () => unknown }).toJSON();
			if (json === null || typeof json !== "object") {
				ancestors.delete(value);
				return json;
			}
			source = json;
		}
		const copy: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(source)) {
			copy[k] = isSensitiveKey(k) ? CENSOR : redactDeep(v, depth + 1, ancestors);
		}
		out = copy;
	}
	ancestors.delete(value);
	return out;
}

export function createLogger(service: string, destination?: pino.DestinationStream): Logger {
	const logger = pino(
		{
			level: process.env.LOG_LEVEL ?? "info",
			base: { service },
			formatters: {
				log: (obj) => redactDeep(obj) as Record<string, unknown>,
				bindings: (bindings) => redactDeep(bindings) as Record<string, unknown>,
			},
			// formatters.log already turned Errors into redacted plain objects.
			// The default std err serializer would treat them as error-like again
			// and overwrite `type` with "Object", so pass them through.
			serializers: { err: (value: unknown) => value },
			redact: {
				paths: ["req.headers.cookie", "req.headers.authorization"],
				censor: CENSOR,
			},
		},
		destination,
	);
	// child() bindings bypass formatters.log, and pino resets
	// formatters.bindings on every child, so redact them on the way in.
	// Children inherit this override through the prototype chain.
	const originalChild = logger.child;
	logger.child = function <L extends string = never>(
		this: Logger,
		bindings: pino.Bindings,
		options?: pino.ChildLoggerOptions<L>,
	) {
		return Reflect.apply(originalChild, this, [redactDeep(bindings), options]) as pino.Logger<L>;
	};
	const originalSetBindings = logger.setBindings;
	logger.setBindings = function (this: Logger, bindings: pino.Bindings) {
		Reflect.apply(originalSetBindings, this, [redactDeep(bindings)]);
	};
	return logger;
}
