// Shared handler dependencies + the session user shape. The downstream
// services are reached through `fetchImpl` (injectable for tests) with the
// signed internal identity; the gateway itself never touches Temporal.
import type { Db } from "@credit/db";
import type { Logger } from "@credit/service-kit";
import type { Sql } from "postgres";
import type { RateLimiter } from "./auth.js";
import type { GatewayEnv } from "./env.js";

export interface SessionUser {
	id: string;
	email: string;
	fullName: string;
	role: "applicant" | "officer";
}

export type FetchImpl = typeof fetch;

export interface GatewayVariables {
	user: SessionUser;
	requestId: string;
}

export interface GatewayDeps {
	db: Db;
	sql: Sql;
	env: GatewayEnv;
	logger: Logger;
	loginLimiter: RateLimiter;
	/** Per-email login limiter (10/min on the normalized email). The web
	 * proxy shares one peer IP, so the IP limiter alone cannot tell users
	 * apart — both limiters are checked on every login. */
	loginEmailLimiter: RateLimiter;
	submitLimiter: RateLimiter;
	fetchImpl?: FetchImpl;
}
