// Test-only signature check: verifies the gateway's signed downstream
// headers with the same function the services use to authenticate them.
import { resolveInternalUser } from "@credit/service-kit";

export function resolveInternalHeadersForTest(
	secret: string,
	opts: { method: string; path: string; headers: Record<string, string> },
): { id: string; email: string; role: "applicant" | "officer" } | null {
	return resolveInternalUser(secret, {
		method: opts.method,
		path: opts.path,
		userId: opts.headers["x-user-id"] ?? "",
		role: opts.headers["x-user-role"] ?? "",
		email: opts.headers["x-user-email"] ?? "",
		ts: opts.headers["x-internal-ts"] ?? "",
		signature: opts.headers["x-internal-signature"] ?? "",
	});
}
