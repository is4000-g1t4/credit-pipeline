import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface CaseTokenClaims {
	jti: string;
	runId: string;
	applicationId: string;
	authorisingActorId: string;
	authorisingActorRole: "officer" | "service";
	asOf: string;
	exp: number;
}

export type CaseTokenInput = Omit<CaseTokenClaims, "jti" | "exp">;

const TOKEN_VERSION = 1;

function b64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

function sign(secret: string, body: string): string {
	return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Mint a short-lived, run-scoped token. The research service creates one per
 * attempt; the policy service binds every claim to the request body and
 * consumes the jti so a token cannot be replayed for another case. */
export function signCaseToken(
	secret: string,
	input: CaseTokenInput,
	ttlSeconds = 120,
	now = Date.now(),
): string {
	if (secret.length < 16) throw new Error("case token secret is too short");
	const claims: CaseTokenClaims = {
		...input,
		jti: randomUUID(),
		exp: Math.floor(now / 1000) + Math.max(1, ttlSeconds),
	};
	const payload = b64url(JSON.stringify({ v: TOKEN_VERSION, ...claims }));
	return `${payload}.${sign(secret, payload)}`;
}

/** Verify signature/expiry and require every claim to match the request. */
export function verifyCaseToken(
	secret: string,
	token: string,
	expected: CaseTokenInput,
	now = Date.now(),
): CaseTokenClaims | null {
	const [payload, signature, extra] = token.split(".");
	if (!payload || !signature || extra !== undefined) return null;
	const expectedSig = sign(secret, payload);
	const a = Buffer.from(signature);
	const b = Buffer.from(expectedSig);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const claims = parsed as CaseTokenClaims & { v?: number };
	if (claims.v !== TOKEN_VERSION) return null;
	if (!Number.isFinite(claims.exp) || claims.exp * 1000 < now) return null;
	if (typeof claims.jti !== "string" || !/^[0-9a-f-]{36}$/i.test(claims.jti)) return null;
	if (
		claims.runId !== expected.runId ||
		claims.applicationId !== expected.applicationId ||
		claims.authorisingActorId !== expected.authorisingActorId ||
		claims.authorisingActorRole !== expected.authorisingActorRole ||
		claims.asOf !== expected.asOf
	) {
		return null;
	}
	return claims;
}
