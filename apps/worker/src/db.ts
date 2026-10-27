// Dual lazy singleton DB handles: the worker is the cross-domain
// orchestrator and holds connections to credit_applications and
// credit_loans ONLY — never auth/portfolio. URLs are validated by t3-env.
import { createDb } from "@credit/db";
import { workerEnv } from "./env.js";

let applicationsCached: ReturnType<typeof createDb> | null = null;
let loansCached: ReturnType<typeof createDb> | null = null;

export function getApplicationsDb(): ReturnType<typeof createDb> {
	if (!applicationsCached) applicationsCached = createDb(workerEnv.applicationsDatabaseUrl);
	return applicationsCached;
}

export function getLoansDb(): ReturnType<typeof createDb> {
	if (!loansCached) loansCached = createDb(workerEnv.loansDatabaseUrl);
	return loansCached;
}

export async function closeDb(): Promise<void> {
	if (applicationsCached) {
		await applicationsCached.sql.end({ timeout: 5 });
		applicationsCached = null;
	}
	if (loansCached) {
		await loansCached.sql.end({ timeout: 5 });
		loansCached = null;
	}
}

type ReservedSql = ReturnType<ReturnType<typeof createDb>["sql"]["reserve"]>;
export type ReservedDb = Awaited<ReservedSql>;

/** Reserve a pooled connection for the session-scoped relay advisory lock. */
export async function reserveApplications(): Promise<ReservedDb> {
	return getApplicationsDb().sql.reserve();
}

export async function reserveLoans(): Promise<ReservedDb> {
	return getLoansDb().sql.reserve();
}
