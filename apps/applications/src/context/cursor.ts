// Opaque HMAC transaction-page cursor (SPEC-t17-t18 §3.2, D3a): bound to
// (applicationId, accountId, from, to) so callers cannot widen the window.
// `off` is the row offset; routes additionally cap pages per account.
import { createHmac, timingSafeEqual } from "node:crypto";
import { isUuid } from "../ids.js";

export interface ContextCursor {
	app: string;
	acct: string;
	from: string;
	to: string;
	off: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function encodeCursor(secret: string, cursor: ContextCursor): string {
	const raw = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
	const sig = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
	return `${raw}.${sig}`;
}

/** Fail closed: any tamper, shape drift, or window mismatch returns null. */
export function decodeCursor(secret: string, token: string): ContextCursor | null {
	try {
		const dot = token.lastIndexOf(".");
		if (dot <= 0) return null;
		const raw = token.slice(0, dot);
		const sig = token.slice(dot + 1);
		const expected = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
		const a = Buffer.from(sig, "utf8");
		const b = Buffer.from(expected, "utf8");
		if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
		const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<
			string,
			unknown
		>;
		if (
			typeof parsed["app"] !== "string" ||
			!isUuid(parsed["app"]) ||
			typeof parsed["acct"] !== "string" ||
			!isUuid(parsed["acct"]) ||
			typeof parsed["from"] !== "string" ||
			!DAY_RE.test(parsed["from"]) ||
			typeof parsed["to"] !== "string" ||
			!DAY_RE.test(parsed["to"]) ||
			typeof parsed["off"] !== "number" ||
			!Number.isInteger(parsed["off"]) ||
			(parsed["off"] as number) < 0
		) {
			return null;
		}
		return {
			app: parsed["app"],
			acct: parsed["acct"],
			from: parsed["from"],
			to: parsed["to"],
			off: parsed["off"] as number,
		};
	} catch {
		return null;
	}
}
