// Public health (SPEC §6): same db/kafka/temporal/outbox checks the
// monolith ran (copied semantics: 1s timeouts, `{status:"ok"}` only when
// db+kafka+temporal are up), plus an informational `services` map from the
// downstream `/health` endpoints probed in parallel. Downstream state never
// flips the top-level status — it is reported separately.
import { checkDb, checkTemporal, withTimeout } from "@credit/service-kit";
import { Hono } from "hono";
import { Kafka } from "kafkajs";
import type { GatewayDeps } from "./deps.js";

const CHECK_TIMEOUT_MS = 1000;

interface Check {
	ok: boolean;
	error?: string;
}

async function checkKafka(deps: GatewayDeps): Promise<Check> {
	const kafka = new Kafka({ brokers: deps.env.kafkaBrokers.split(",") });
	const admin = kafka.admin({ retry: { retries: 0 } });
	try {
		await withTimeout(admin.connect(), CHECK_TIMEOUT_MS);
		try {
			await withTimeout(admin.listTopics(), CHECK_TIMEOUT_MS);
		} finally {
			await admin.disconnect().catch(() => {});
		}
		return { ok: true };
	} catch (err) {
		try {
			await admin.disconnect().catch(() => {});
		} catch {
			// ignore — the check already failed
		}
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

interface ServiceStatus {
	ok: boolean;
	status?: string;
	error?: string;
	outbox?: { backlog?: unknown; deadLettered?: unknown };
}

async function checkService(deps: GatewayDeps, baseUrl: string): Promise<ServiceStatus> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	try {
		const res = await withTimeout(
			fetchImpl(`${baseUrl.replace(/\/$/, "")}/health`),
			CHECK_TIMEOUT_MS,
		);
		let body: unknown = null;
		try {
			body = await res.json();
		} catch {
			return { ok: false, error: `HTTP ${res.status} (non-JSON)` };
		}
		const status = (body as { status?: unknown })?.status;
		const checks = (body as { checks?: unknown })?.checks;
		const outbox =
			checks !== null && typeof checks === "object" && "outbox" in checks
				? (checks as { outbox?: ServiceStatus["outbox"] }).outbox
				: undefined;
		return typeof status === "string" && res.ok && status === "ok"
			? { ok: true, status, ...(outbox !== undefined ? { outbox } : {}) }
			: { ok: false, status: typeof status === "string" ? status : undefined };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export function healthRoutes(deps: GatewayDeps): Hono {
	const app = new Hono();

	app.get("/", async (c) => {
		const [db, kafka, temporal] = await Promise.all([
			checkDb(() => deps.sql`SELECT 1`),
			checkKafka(deps),
			checkTemporal(deps.env.temporalAddress),
		]);
		const [applications, review, loans, portfolio] = await Promise.all([
			checkService(deps, deps.env.applicationsUrl),
			checkService(deps, deps.env.reviewUrl),
			checkService(deps, deps.env.loansUrl),
			checkService(deps, deps.env.portfolioUrl),
		]);
		// The gateway owns credit_auth, which has no outbox table: the
		// backlog is aggregated from the writer services' own health
		// checks (applications + loans own outbox_events). Missing or
		// non-numeric contributions stay null.
		let backlog: number | null = null;
		let deadLettered: number | null = null;
		if (db.ok) {
			const sum = (pick: (o: NonNullable<ServiceStatus["outbox"]>) => unknown): number | null => {
				let total: number | null = null;
				for (const svc of [applications, review, loans, portfolio]) {
					const value = svc.outbox ? pick(svc.outbox) : undefined;
					if (typeof value === "number") total = (total ?? 0) + value;
				}
				return total;
			};
			backlog = sum((o) => o.backlog);
			deadLettered = sum((o) => o.deadLettered);
		}
		const ok = db.ok && kafka.ok && temporal.ok;
		return c.json({
			status: ok ? "ok" : "degraded",
			checks: { db, kafka, temporal, outbox: { backlog, deadLettered } },
			services: { applications, review, loans, portfolio },
		});
	});

	return app;
}
