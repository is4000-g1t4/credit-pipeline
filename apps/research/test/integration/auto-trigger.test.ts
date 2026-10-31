// T11 auto-trigger integration: real credit_research Postgres, fake
// agent/judge (no model, Tavily, Grafana, Kafka, or applications network —
// the context fetch is faked except for the HMAC proof test, which runs a
// local stub HTTP server).
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { agentRuns, createDb, researchAccessGrants, researchAuditLog } from "@credit/db/research";
import { createLogger, resolveInternalUser } from "@credit/service-kit";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	classifyAutoMessage,
	checkAutoCaps,
	fetchResearchContextOverHttp,
	handleReviewRequested,
	type AutoTriggerDeps,
	type ResearchContextResult,
} from "../../src/auto-trigger.js";
import { grantResearchAccess } from "../../src/access.js";
import {
	stubAgentRunner,
	stubLanguageRepair,
	stubSupportJudge,
} from "../../src/agents/case-brief/index.js";
import { loadEnv } from "../../src/env.js";
import { ensureRun, type CaseFactsPayload } from "../../src/lifecycle.js";
import { runAgentAttempt } from "../../src/agent-run.js";
import { sweepAgentRuns } from "../../src/agent-sweep.js";
import {
	caseFacts,
	degradedObservability,
	get,
	post,
	setupApp,
	successFixture,
	teardown,
	user,
	waitRun,
	type TestContext,
} from "../helper.js";

process.env.LOG_LEVEL ??= "silent";
const testLogger = createLogger("research-auto-test");

// The suite shares one database. In-flight auto rows left by an earlier
// test (or an earlier failed suite run) would reserve budget and make the
// cap assertions non-deterministic — but other suites' live rows are none
// of this file's business. Snapshot the live ids before each case and
// delete only rows this suite created afterwards.
let liveBefore = new Set<string>();

async function liveAutoIds(): Promise<Set<string>> {
	const { db, sql: raw } = createDb(loadEnv().databaseUrl);
	try {
		const rows = (await db.execute(
			sql`SELECT id FROM agent_runs WHERE trigger = 'auto' AND (status IN ('queued', 'running') OR (context_status = 'running' AND context_stage_token IS NOT NULL))`,
		)) as unknown as Array<{ id: string }>;
		return new Set(rows.map((r) => r.id));
	} finally {
		await raw.end();
	}
}

beforeEach(async () => {
	liveBefore = await liveAutoIds();
});

afterEach(async () => {
	const before = liveBefore;
	liveBefore = new Set();
	const { db, sql: raw } = createDb(loadEnv().databaseUrl);
	try {
		const rows = (await db.execute(
			sql`SELECT id FROM agent_runs WHERE trigger = 'auto' AND (status IN ('queued', 'running') OR (context_status = 'running' AND context_stage_token IS NOT NULL))`,
		)) as unknown as Array<{ id: string }>;
		const fresh = rows.map((r) => r.id).filter((id) => !before.has(id));
		if (fresh.length > 0) await db.delete(agentRuns).where(inArray(agentRuns.id, fresh));
	} finally {
		await raw.end();
	}
});

/** Caps/budget lifted so shared-DB accumulation from other suites cannot flake these. */
function autoEnv() {
	return {
		...loadEnv(),
		agentsEnabled: true,
		autoTriggerMaxRunsPerApplicantDay: 1000,
		autoTriggerMaxRunsPerDay: 100_000,
		autoTriggerDailyCostBudgetUsd: 1000,
	};
}

function envelope(applicationId: string, id: string = randomUUID()) {
	return {
		id,
		type: "review.requested" as const,
		version: 1 as const,
		occurredAt: new Date().toISOString(),
		applicationId,
		payload: { applicationId, reference: "CR-2026-0001", reasonCodes: ["R1"] },
	};
}

function depsFor(
	ctx: TestContext,
	fetchResearchContext?: (applicationId: string) => Promise<ResearchContextResult>,
	envOverrides: Partial<ReturnType<typeof loadEnv>> = {},
): AutoTriggerDeps {
	const use = successFixture();
	const deps: AutoTriggerDeps = {
		db: ctx.db,
		env: { ...autoEnv(), ...envOverrides },
		logger: testLogger,
		runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
		judge: stubSupportJudge(),
		repair: stubLanguageRepair(),
		observability: degradedObservability,
		fetchResearchContext,
		// In-process stand-in for Temporal: attempt 1 of the real activity.
		starter: {
			start: async (input) => {
				void runAgentAttempt(deps as never, input, 1).catch(() => undefined);
				return { started: true };
			},
		},
	};
	return deps;
}

function contextFor(
	facts: CaseFactsPayload,
	applicantUserId: string = randomUUID(),
	contextConsent = true,
): (applicationId: string) => Promise<ResearchContextResult> {
	return async (applicationId: string) => {
		if (applicationId !== facts.applicationId) return { ok: false, status: 404 };
		return { ok: true, caseFacts: facts, applicantUserId, contextConsent };
	};
}

async function auditRows(ctx: TestContext, applicationId: string) {
	return ctx.db
		.select()
		.from(researchAuditLog)
		.where(eq(researchAuditLog.applicationId, applicationId));
}

async function postView(
	ctx: TestContext,
	path: string,
	who: { id: string; email: string; role: "applicant" | "officer" | "service" },
) {
	return post(ctx, path, who, {});
}

describe("handleReviewRequested", () => {
	it("ensures one auto run per referral and starts execution", async () => {
		const ctx = setupApp();
		try {
			const facts = caseFacts();
			const applicantUserId = randomUUID();
			const deps = depsFor(ctx, contextFor(facts, applicantUserId));
			const out = await handleReviewRequested(deps, envelope(facts.applicationId));
			expect(out.handled).toBe("ensured");
			const runId = (out as { runId: string }).runId;

			const run = await waitRun(ctx, runId);
			expect(run.status).toBe("succeeded");
			expect(run.trigger).toBe("auto");
			expect(run.requestedByRole).toBe("service");
			expect(run.requestedBy).toBe(deps.env.autoTriggerServiceUserId);
			expect(run.triggerEventId).not.toBe(null);
			expect(run.applicantUserId).toBe(applicantUserId);
			// Cap accounting never leaks into the stored prompt facts, the
			// public summary, or (by column) the trace metadata.
			expect(JSON.stringify(run.caseFacts)).not.toContain(applicantUserId);

			const audits = await auditRows(ctx, facts.applicationId);
			expect(audits.some((a) => a.action === "auto.ensure" && a.runId === runId)).toBe(true);
			expect(audits.every((a) => a.actorRole === "service")).toBe(true);
		} finally {
			await teardown(ctx);
		}
	});

	it("returns the original run for duplicate envelopes, even when terminal", async () => {
		const ctx = setupApp();
		try {
			const facts = caseFacts();
			const deps = depsFor(ctx, contextFor(facts));
			const eventId = randomUUID();
			const first = await handleReviewRequested(deps, envelope(facts.applicationId, eventId));
			expect(first.handled).toBe("ensured");
			const runId = (first as { runId: string }).runId;
			expect((await waitRun(ctx, runId)).status).toBe("succeeded");

			// Redelivery after success: no-op, same run, zero new paid calls.
			const second = await handleReviewRequested(deps, envelope(facts.applicationId, eventId));
			expect(second).toEqual({ handled: "duplicate", runId });
			const rows = await ctx.db
				.select({ id: agentRuns.id })
				.from(agentRuns)
				.where(eq(agentRuns.applicationId, facts.applicationId));
			expect(rows).toHaveLength(1);

			const audits = await auditRows(ctx, facts.applicationId);
			expect(audits.some((a) => a.action === "auto.duplicate" && a.runId === runId)).toBe(true);
		} finally {
			await teardown(ctx);
		}
	});

	it("skips without consent, when not pending, and on missing context — audited, no run", async () => {
		const ctx = setupApp();
		try {
			for (const [facts, reason] of [
				[caseFacts({ aiResearchConsent: false }), "consent_required"],
				[caseFacts({ status: "approved" }), "not_pending"],
			] as Array<[CaseFactsPayload, string]>) {
				const deps = depsFor(ctx, contextFor(facts));
				const out = await handleReviewRequested(deps, envelope(facts.applicationId));
				expect(out).toEqual({ handled: "skipped", reason });
				const rows = await ctx.db
					.select({ id: agentRuns.id })
					.from(agentRuns)
					.where(eq(agentRuns.applicationId, facts.applicationId));
				expect(rows).toHaveLength(0);
				const audits = await auditRows(ctx, facts.applicationId);
				const skip = audits.find((a) => a.action === "auto.skip");
				expect(skip?.metadata).toMatchObject({ reason });
			}
			// 404 from applications: same shape, no run.
			const missingId = randomUUID();
			const deps = depsFor(ctx, async () => ({ ok: false, status: 404 }));
			const out = await handleReviewRequested(deps, envelope(missingId));
			expect(out).toEqual({ handled: "skipped", reason: "application_not_found" });
			expect((await auditRows(ctx, missingId)).some((a) => a.action === "auto.skip")).toBe(true);
		} finally {
			await teardown(ctx);
		}
	});

	it("enforces per-applicant, global, and cost guards with audited reasons", async () => {
		const ctx = setupApp();
		try {
			// Per-applicant cap: seed two auto runs for one applicant, the
			// third referral for the same applicant skips.
			const applicantUserId = randomUUID();
			const env = autoEnv();
			for (let i = 0; i < 2; i++) {
				const facts = caseFacts();
				await ensureRun(ctx.db, env, {
					applicationId: facts.applicationId,
					requestedBy: env.autoTriggerServiceUserId,
					requestedByRole: "service",
					trigger: "auto",
					triggerEventId: randomUUID(),
					applicantUserId,
					caseFacts: facts,
					aiResearchConsent: true,
				});
			}
			const cappedFacts = caseFacts();
			const capped = await handleReviewRequested(
				depsFor(ctx, contextFor(cappedFacts, applicantUserId), {
					autoTriggerMaxRunsPerApplicantDay: 2,
				}),
				envelope(cappedFacts.applicationId),
			);
			expect(capped).toEqual({ handled: "skipped", reason: "applicant_daily_cap" });

			// Global cap at zero: every referral skips.
			const globalFacts = caseFacts();
			const global = await handleReviewRequested(
				depsFor(ctx, contextFor(globalFacts), { autoTriggerMaxRunsPerDay: 0 }),
				envelope(globalFacts.applicationId),
			);
			expect(global).toEqual({ handled: "skipped", reason: "global_daily_cap" });

			// Cost budget: seed one AUTO run over budget, the next referral
			// skips. Officer runs never consume the automation budget.
			const richFacts = caseFacts();
			const [rich] = await ctx.db
				.insert(agentRuns)
				.values({
					applicationId: richFacts.applicationId,
					feature: "case_brief",
					status: "succeeded",
					trigger: "auto",
					requestedBy: randomUUID(),
					requestedByRole: "service",
					applicantUserId: randomUUID(),
					caseFacts: {},
					model: "deepseek/deepseek-v4.1-flash-1017",
					agentVersion: "vtest",
					promptVersion: "vtest",
					promptHash: "x",
					asOf: new Date(richFacts.asOf),
					grafanaConversationId: randomUUID(),
					usage: { costUsd: 99 },
					timeoutAt: new Date(),
					finishedAt: new Date(),
				})
				.returning({ id: agentRuns.id });
			expect(rich).toBeDefined();
			try {
				const spendFacts = caseFacts();
				const spend = await handleReviewRequested(
					depsFor(ctx, contextFor(spendFacts), { autoTriggerDailyCostBudgetUsd: 1 }),
					envelope(spendFacts.applicationId),
				);
				expect(spend).toEqual({ handled: "skipped", reason: "daily_cost_budget" });
			} finally {
				// The seeded $99 spend counts every run: delete it so repeated
				// suite runs do not exhaust the daily auto budget.
				if (rich) await ctx.db.execute(sql`DELETE FROM agent_runs WHERE id = ${rich.id}`);
			}
		} finally {
			await teardown(ctx);
		}
	});

	it("fetches context with the service principal over HMAC", async () => {
		const ctx = setupApp();
		const env = autoEnv();
		try {
			const facts = caseFacts();
			const applicantUserId = randomUUID();
			let count = 0;
			const seen: Record<string, string | undefined> = {};
			const server = createServer((req, res) => {
				count += 1;
				seen.role = req.headers["x-user-role"] as string | undefined;
				seen.userId = req.headers["x-user-id"] as string | undefined;
				seen.email = req.headers["x-user-email"] as string | undefined;
				seen.signature = req.headers["x-internal-signature"] as string | undefined;
				seen.ts = req.headers["x-internal-ts"] as string | undefined;
				seen.bodyHash = req.headers["x-body-sha256"] as string | undefined;
				seen.requestId = req.headers["x-request-id"] as string | undefined;
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ caseFacts: facts, applicantUserId }));
			});
			await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
			const port = (server.address() as AddressInfo).port;
			try {
				// No fake: exercises the real service-HMAC context fetch
				// against the stub applications server above.
				const deps = depsFor(ctx, undefined, {
					applicationsUrl: `http://127.0.0.1:${port}`,
				});
				const out = await handleReviewRequested(deps, envelope(facts.applicationId));
				expect(out.handled).toBe("ensured");
				expect(count).toBe(1);
				expect(seen.role).toBe("service");
				expect(seen.userId).toBe(env.autoTriggerServiceUserId);
				// The captured signature verifies as the service principal.
				const who = resolveInternalUser(
					env.internalSecret,
					{
						method: "GET",
						path: `/internal/applications/${facts.applicationId}/research-context`,
						userId: seen.userId ?? "",
						role: seen.role ?? "",
						email: seen.email ?? "",
						ts: seen.ts ?? "",
						signature: seen.signature ?? "",
						bodyHash: seen.bodyHash ?? "",
						requestId: seen.requestId ?? "",
					},
					Number(seen.ts ?? "0"),
				);
				expect(who).toMatchObject({ id: env.autoTriggerServiceUserId, role: "service" });
			} finally {
				await new Promise<void>((r) => server.close(() => r()));
			}
		} finally {
			await teardown(ctx);
		}
	});
});

describe("queued-run sweep (crash after insert)", () => {
	it("starts a stranded queued run instead of leaving it", async () => {
		const ctx = setupApp();
		try {
			const env = autoEnv();
			const facts = caseFacts();
			// Crash between queued insert and claim: row committed, never started.
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: env.autoTriggerServiceUserId,
				requestedByRole: "service",
				trigger: "auto",
				triggerEventId: randomUUID(),
				applicantUserId: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const starts: Array<{ runId: string; token: string }> = [];
			const sweepDeps = {
				db: ctx.db,
				env,
				logger: testLogger,
				starter: {
					start: async (input: { runId: string; token: string }) => {
						starts.push(input);
						void runAgentAttempt(depsFor(ctx) as never, input as never, 1).catch(() => undefined);
						return { started: true };
					},
				},
			};
			// Fresh rows are left to their inserter; only ~10s-old rows qualify.
			await sweepAgentRuns(sweepDeps);
			expect(starts.map((s) => s.runId)).not.toContain(run.id);
			await ctx.db.execute(
				sql`UPDATE agent_runs SET created_at = now() - INTERVAL '11 seconds' WHERE id = ${run.id}`,
			);
			await sweepAgentRuns(sweepDeps);
			expect(starts).toContainEqual(
				expect.objectContaining({ runId: run.id, token: run.runToken }),
			);
			expect((await waitRun(ctx, run.id)).status).toBe("succeeded");
		} finally {
			await teardown(ctx);
		}
	});

	it("the sweep starts a crash-left queued run even when it is past its lease", async () => {
		const ctx = setupApp();
		try {
			const env = autoEnv();
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: env.autoTriggerServiceUserId,
				requestedByRole: "service",
				trigger: "auto",
				triggerEventId: randomUUID(),
				applicantUserId: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			// Crash-left AND past its lease (but not the 5 minute overdue
			// grace): the sweep must start it, not fail it.
			await ctx.db.execute(
				sql`UPDATE agent_runs SET created_at = now() - INTERVAL '11 seconds', timeout_at = now() - INTERVAL '61 seconds' WHERE id = ${run.id}`,
			);
			const deps = depsFor(ctx);
			const { started, failed } = await sweepAgentRuns({
				db: ctx.db,
				env,
				logger: testLogger,
				starter: deps.starter!,
			});
			expect(started).toContain(run.id);
			expect(failed).not.toContain(run.id);
			expect((await waitRun(ctx, run.id)).status).toBe("succeeded");
		} finally {
			await teardown(ctx);
		}
	});
});

describe("durable auto-event log (redelivery after change)", () => {
	it("redelivery after a status change returns the original run, zero new runs", async () => {
		const ctx = setupApp();
		try {
			const facts = caseFacts();
			const applicantUserId = randomUUID();
			const eventId = randomUUID();
			const first = await handleReviewRequested(
				depsFor(ctx, contextFor(facts, applicantUserId)),
				envelope(facts.applicationId, eventId),
			);
			expect(first.handled).toBe("ensured");
			const runId = (first as { runId: string }).runId;
			expect((await waitRun(ctx, runId)).status).toBe("succeeded");

			// The case has since been decided — and the context fetch must
			// not even run on redelivery.
			let fetches = 0;
			const second = await handleReviewRequested(
				depsFor(ctx, async () => {
					fetches += 1;
					throw new Error("context must not be fetched on redelivery");
				}),
				envelope(facts.applicationId, eventId),
			);
			expect(second).toEqual({ handled: "duplicate", runId });
			expect(fetches).toBe(0);
			const rows = await ctx.db
				.select({ id: agentRuns.id })
				.from(agentRuns)
				.where(eq(agentRuns.applicationId, facts.applicationId));
			expect(rows).toHaveLength(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("redelivery of a skip after consent is granted still returns the skip", async () => {
		const ctx = setupApp();
		try {
			const facts = caseFacts({ aiResearchConsent: false });
			const eventId = randomUUID();
			const first = await handleReviewRequested(
				depsFor(ctx, contextFor(facts)),
				envelope(facts.applicationId, eventId),
			);
			expect(first).toEqual({ handled: "skipped", reason: "consent_required" });

			// Consent has since been granted: the stored outcome still rules.
			const granted = caseFacts({
				applicationId: facts.applicationId,
				aiResearchConsent: true,
			});
			const second = await handleReviewRequested(
				depsFor(ctx, contextFor(granted)),
				envelope(facts.applicationId, eventId),
			);
			expect(second).toEqual({ handled: "skipped", reason: "consent_required" });
			const rows = await ctx.db
				.select({ id: agentRuns.id })
				.from(agentRuns)
				.where(eq(agentRuns.applicationId, facts.applicationId));
			expect(rows).toHaveLength(0);
		} finally {
			await teardown(ctx);
		}
	});

	it("an officer run absorbs the referral; redelivery stays duplicate", async () => {
		const ctx = setupApp();
		try {
			const env = autoEnv();
			const facts = caseFacts();
			const { run: officerRun } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const eventId = randomUUID();
			const first = await handleReviewRequested(
				depsFor(ctx, contextFor(facts)),
				envelope(facts.applicationId, eventId),
			);
			expect(first).toEqual({ handled: "duplicate", runId: officerRun.id });

			const second = await handleReviewRequested(
				depsFor(ctx, contextFor(facts)),
				envelope(facts.applicationId, eventId),
			);
			expect(second).toEqual({ handled: "duplicate", runId: officerRun.id });
			const rows = await ctx.db
				.select({ id: agentRuns.id })
				.from(agentRuns)
				.where(eq(agentRuns.applicationId, facts.applicationId));
			expect(rows).toHaveLength(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("rejects mismatched context and non-UUID applicants as permanent skips", async () => {
		const ctx = setupApp();
		try {
			const facts = caseFacts();
			const other = caseFacts();
			const eventId = randomUUID();
			let fetches = 0;
			const mismatched = await handleReviewRequested(
				depsFor(ctx, async () => {
					fetches += 1;
					return {
						ok: true,
						caseFacts: other,
						applicantUserId: randomUUID(),
						contextConsent: true,
					};
				}),
				envelope(facts.applicationId, eventId),
			);
			expect(mismatched).toEqual({ handled: "skipped", reason: "context_mismatch" });

			const badFacts = caseFacts();
			const badApplicant = await handleReviewRequested(
				depsFor(ctx, async () => ({
					ok: true,
					caseFacts: badFacts,
					applicantUserId: "not-a-uuid",
					contextConsent: true,
				})),
				envelope(badFacts.applicationId),
			);
			expect(badApplicant).toEqual({ handled: "skipped", reason: "invalid_applicant" });

			// The mismatch outcome is durable: redelivery replays it without
			// another fetch.
			const again = await handleReviewRequested(
				depsFor(ctx, async () => {
					fetches += 1;
					return {
						ok: true,
						caseFacts: other,
						applicantUserId: randomUUID(),
						contextConsent: true,
					};
				}),
				envelope(facts.applicationId, eventId),
			);
			expect(again).toEqual({ handled: "skipped", reason: "context_mismatch" });
			expect(fetches).toBe(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("treats 4xx/shape context failures as permanent skips, 5xx as transient", async () => {
		const ctx = setupApp();
		try {
			// Handler level: a 403 from applications is a permanent skip.
			const facts = caseFacts();
			const denied = await handleReviewRequested(
				depsFor(ctx, async () => ({ ok: false, status: 403 })),
				envelope(facts.applicationId),
			);
			expect(denied).toEqual({ handled: "skipped", reason: "context_invalid" });
			expect(
				(await auditRows(ctx, facts.applicationId)).some(
					(a) =>
						a.action === "auto.skip" &&
						(a.metadata as { reason?: string })?.reason === "context_invalid",
				),
			).toBe(true);

			// Fetch level: 4xx → status, bad shape → 422, 500 → throws.
			const env = autoEnv();
			const stub = (
				status: number,
				body: unknown,
			): Promise<{ server: ReturnType<typeof createServer>; port: number }> =>
				new Promise((resolve) => {
					const server = createServer((_, res) => {
						res.writeHead(status, { "content-type": "application/json" });
						res.end(typeof body === "string" ? body : JSON.stringify(body));
					});
					server.listen(0, "127.0.0.1", () => {
						resolve({ server, port: (server.address() as AddressInfo).port });
					});
				});
			const { server: s403, port: p403 } = await stub(403, { error: "nope" });
			try {
				expect(
					await fetchResearchContextOverHttp(
						{ ...env, applicationsUrl: `http://127.0.0.1:${p403}` },
						randomUUID(),
					),
				).toEqual({
					ok: false,
					status: 403,
				});
			} finally {
				await new Promise<void>((r) => s403.close(() => r()));
			}
			const shapeFacts = caseFacts();
			const { server: s200, port: p200 } = await stub(200, {
				caseFacts: { ...shapeFacts, bogus: "pii" },
				applicantUserId: randomUUID(),
			});
			try {
				// Strict schema: unknown keys fail closed as a bad shape.
				expect(
					await fetchResearchContextOverHttp(
						{ ...env, applicationsUrl: `http://127.0.0.1:${p200}` },
						shapeFacts.applicationId,
					),
				).toEqual({ ok: false, status: 422 });
			} finally {
				await new Promise<void>((r) => s200.close(() => r()));
			}
			const { server: s500, port: p500 } = await stub(500, { error: "boom" });
			try {
				await expect(
					fetchResearchContextOverHttp(
						{ ...env, applicationsUrl: `http://127.0.0.1:${p500}` },
						randomUUID(),
					),
				).rejects.toThrow(/returned 500/);
			} finally {
				await new Promise<void>((r) => s500.close(() => r()));
			}
		} finally {
			await teardown(ctx);
		}
	});

	it("a skip that wins leaves no executable paid run behind", async () => {
		const ctx = setupApp();
		try {
			const applicationId = randomUUID();
			const eventId = randomUUID();
			const applicantUserId = randomUUID();
			const skipFacts = caseFacts({ applicationId, aiResearchConsent: false });
			const ensureFacts = caseFacts({ applicationId, aiResearchConsent: true });
			// Both deliveries are in flight: the skip's context resolves
			// immediately while the ensure's waits for the skip to finish,
			// so the skip commits first under the shared lock. The ensure
			// must then converge on the skip with zero inserted runs — a
			// skip winner never leaves an executable paid run behind.
			const skipCall = handleReviewRequested(
				depsFor(ctx, contextFor(skipFacts, applicantUserId)),
				envelope(applicationId, eventId),
			);
			const ensureCall = handleReviewRequested(
				depsFor(ctx, async () => {
					await skipCall;
					return {
						ok: true as const,
						caseFacts: ensureFacts,
						applicantUserId,
						contextConsent: true,
					};
				}),
				envelope(applicationId, eventId),
			);
			const [skipOut, ensureOut] = await Promise.all([skipCall, ensureCall]);
			expect(skipOut).toEqual({ handled: "skipped", reason: "consent_required" });
			expect(ensureOut).toEqual({ handled: "skipped", reason: "consent_required" });
			const runs = await ctx.db
				.select({ id: agentRuns.id })
				.from(agentRuns)
				.where(eq(agentRuns.applicationId, applicationId));
			expect(runs).toHaveLength(0);
			const audits = await auditRows(ctx, applicationId);
			expect(audits.some((a) => a.action === "auto.skip")).toBe(true);
			expect(audits.some((a) => a.action === "auto.duplicate")).toBe(true);
		} finally {
			await teardown(ctx);
		}
	});

	it("treats 408/429 as transient but 400/401/404/422/shape as permanent skips", async () => {
		const ctx = setupApp();
		try {
			const env = autoEnv();
			const stub = (
				status: number,
				body: unknown,
			): Promise<{ server: ReturnType<typeof createServer>; port: number }> =>
				new Promise((resolve) => {
					const server = createServer((_, res) => {
						res.writeHead(status, { "content-type": "application/json" });
						res.end(typeof body === "string" ? body : JSON.stringify(body));
					});
					server.listen(0, "127.0.0.1", () => {
						resolve({ server, port: (server.address() as AddressInfo).port });
					});
				});
			// 408 (deadline) and 429 (rate-limited) throw: Kafka redelivers.
			for (const status of [408, 429, 500]) {
				const { server, port } = await stub(status, { error: "retryable" });
				try {
					await expect(
						fetchResearchContextOverHttp(
							{ ...env, applicationsUrl: `http://127.0.0.1:${port}` },
							randomUUID(),
						),
					).rejects.toThrow(new RegExp(`returned ${status}`));
				} finally {
					await new Promise<void>((r) => server.close(() => r()));
				}
			}
			// 400/401/403 are permanent: returned, never thrown.
			for (const status of [400, 401, 403]) {
				const { server, port } = await stub(status, { error: "nope" });
				try {
					expect(
						await fetchResearchContextOverHttp(
							{ ...env, applicationsUrl: `http://127.0.0.1:${port}` },
							randomUUID(),
						),
					).toEqual({ ok: false, status });
				} finally {
					await new Promise<void>((r) => server.close(() => r()));
				}
			}
			// Transport failure (closed port) is transient too.
			await expect(
				fetchResearchContextOverHttp(
					{ ...env, applicationsUrl: "http://127.0.0.1:1" },
					randomUUID(),
				),
			).rejects.toThrow(/unreachable/);
			// Handler level: 400/401 audit a permanent skip; 404 keeps its
			// application_not_found reason.
			const f400 = caseFacts();
			expect(
				await handleReviewRequested(
					depsFor(ctx, async () => ({ ok: false, status: 400 })),
					envelope(f400.applicationId),
				),
			).toEqual({ handled: "skipped", reason: "context_invalid" });
			const f401 = caseFacts();
			expect(
				await handleReviewRequested(
					depsFor(ctx, async () => ({ ok: false, status: 401 })),
					envelope(f401.applicationId),
				),
			).toEqual({ handled: "skipped", reason: "context_invalid" });
			expect(
				(await auditRows(ctx, f401.applicationId)).some(
					(a) =>
						a.action === "auto.skip" &&
						(a.metadata as { reason?: string })?.reason === "context_invalid",
				),
			).toBe(true);
		} finally {
			await teardown(ctx);
		}
	});

	it("caps race: two concurrent referrals for one applicant yield one run", async () => {
		const ctx = setupApp();
		try {
			const applicantUserId = randomUUID();
			const factsA = caseFacts();
			const factsB = caseFacts();
			const env = { autoTriggerMaxRunsPerApplicantDay: 1 };
			const [outA, outB] = await Promise.all([
				handleReviewRequested(
					depsFor(ctx, contextFor(factsA, applicantUserId), env),
					envelope(factsA.applicationId),
				),
				handleReviewRequested(
					depsFor(ctx, contextFor(factsB, applicantUserId), env),
					envelope(factsB.applicationId),
				),
			]);
			const sorted = [outA, outB]
				.map((o) => (o.handled === "skipped" ? `skipped:${o.reason}` : o.handled))
				.sort();
			expect(sorted).toEqual(["ensured", "skipped:applicant_daily_cap"]);
			const ensured = [outA, outB].find((o) => o.handled === "ensured") as { runId: string };
			await waitRun(ctx, ensured.runId);
			const count = (await ctx.db.execute(
				sql`SELECT count(*)::int AS n FROM agent_runs WHERE applicant_user_id = ${applicantUserId} AND trigger = 'auto'`,
			)) as unknown as Array<{ n: number }>;
			expect(count[0]?.n).toBe(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("failed and in-flight auto spend counts toward the budget; officer spend does not", async () => {
		const ctx = setupApp();
		try {
			const spendToday = async (): Promise<number> => {
				const rows = (await ctx.db.execute(
					// Recorded usage plus retained dead-attempt spend (checkAutoCaps sums both).
					sql`SELECT (SELECT coalesce(sum(CASE WHEN usage->>'costUsd' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (usage->>'costUsd')::double precision ELSE 0 END), 0) FROM agent_runs WHERE trigger = 'auto' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::float8
						+ (SELECT coalesce(sum(retained_cost_usd), 0) FROM agent_runs WHERE trigger = 'auto' AND (created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' OR retained_cost_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))::float8 AS total`,
				)) as unknown as Array<{ total: number }>;
				return rows[0]?.total ?? 0;
			};
			const baseline = await spendToday();
			const env = autoEnv();

			// Control: under budget with no seed, caps pass.
			expect(
				await checkAutoCaps(
					ctx.db,
					{ ...env, autoTriggerDailyCostBudgetUsd: baseline + 100 },
					randomUUID(),
				),
			).toEqual({ ok: true });

			// A failed auto run's recorded spend counts (no status filter).
			const failedFacts = caseFacts();
			const [failed] = await ctx.db
				.insert(agentRuns)
				.values({
					applicationId: failedFacts.applicationId,
					feature: "case_brief",
					status: "failed",
					trigger: "auto",
					requestedBy: env.autoTriggerServiceUserId,
					requestedByRole: "service",
					applicantUserId: randomUUID(),
					caseFacts: {},
					model: "deepseek/deepseek-v4.1-flash-1017",
					agentVersion: "vtest",
					promptVersion: "vtest",
					promptHash: "x",
					asOf: new Date(failedFacts.asOf),
					grafanaConversationId: randomUUID(),
					errorCode: "tool_error",
					error: "seeded failure",
					usage: { costUsd: 25 },
					timeoutAt: new Date(),
					finishedAt: new Date(),
				})
				.returning({ id: agentRuns.id });
			try {
				expect(await spendToday()).toBeCloseTo(baseline + 25, 5);
				expect(
					await checkAutoCaps(
						ctx.db,
						{ ...env, autoTriggerDailyCostBudgetUsd: baseline + 10 },
						randomUUID(),
					),
				).toEqual({ ok: false, reason: "daily_cost_budget" });
			} finally {
				await ctx.db.execute(sql`DELETE FROM agent_runs WHERE id = ${failed.id}`);
			}

			// A queued auto run reserves maxCostUsd against the budget.
			const queuedFacts = caseFacts();
			const [queued] = await ctx.db
				.insert(agentRuns)
				.values({
					applicationId: queuedFacts.applicationId,
					feature: "case_brief",
					status: "queued",
					trigger: "auto",
					requestedBy: env.autoTriggerServiceUserId,
					requestedByRole: "service",
					applicantUserId: randomUUID(),
					runToken: randomUUID(),
					caseFacts: {},
					model: "deepseek/deepseek-v4.1-flash-1017",
					agentVersion: "vtest",
					promptVersion: "vtest",
					promptHash: "x",
					asOf: new Date(queuedFacts.asOf),
					grafanaConversationId: randomUUID(),
					usage: {},
					timeoutAt: new Date(Date.now() + 120_000),
				})
				.returning({ id: agentRuns.id });
			try {
				expect(
					await checkAutoCaps(
						ctx.db,
						{ ...env, maxCostUsd: 5, autoTriggerDailyCostBudgetUsd: baseline + 2 },
						randomUUID(),
					),
				).toEqual({ ok: false, reason: "daily_cost_budget" });
			} finally {
				await ctx.db.execute(sql`DELETE FROM agent_runs WHERE id = ${queued.id}`);
			}

			// Officer spend never touches the automation budget.
			const officerFacts = caseFacts();
			await ctx.db.insert(agentRuns).values({
				applicationId: officerFacts.applicationId,
				feature: "case_brief",
				status: "succeeded",
				trigger: "officer",
				requestedBy: randomUUID(),
				requestedByRole: "officer",
				caseFacts: {},
				model: "deepseek/deepseek-v4.1-flash-1017",
				agentVersion: "vtest",
				promptVersion: "vtest",
				promptHash: "x",
				asOf: new Date(officerFacts.asOf),
				grafanaConversationId: randomUUID(),
				usage: { costUsd: 1_000_000 },
				timeoutAt: new Date(),
				finishedAt: new Date(),
			});
			expect(await spendToday()).toBeCloseTo(baseline, 5);
			const referral = caseFacts();
			const out = await handleReviewRequested(
				depsFor(ctx, contextFor(referral), { autoTriggerDailyCostBudgetUsd: baseline + 5 }),
				envelope(referral.applicationId),
			);
			expect(out.handled).toBe("ensured");
			await waitRun(ctx, (out as { runId: string }).runId);
		} finally {
			await teardown(ctx);
		}
	});

	it("prior-day runs: live context stages reserve, today's retry spend counts once", async () => {
		const ctx = setupApp();
		try {
			const env = autoEnv();
			const spendToday = async (): Promise<number> => {
				const rows = (await ctx.db.execute(
					// Recorded usage plus retained dead-attempt spend (checkAutoCaps sums both).
					sql`SELECT (SELECT coalesce(sum(CASE WHEN usage->>'costUsd' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (usage->>'costUsd')::double precision ELSE 0 END), 0) FROM agent_runs WHERE trigger = 'auto' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::float8
						+ (SELECT coalesce(sum(retained_cost_usd), 0) FROM agent_runs WHERE trigger = 'auto' AND (created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' OR retained_cost_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))::float8 AS total`,
				)) as unknown as Array<{ total: number }>;
				return rows[0]?.total ?? 0;
			};
			const baseline = await spendToday();
			const yesterday = new Date(Date.now() - 86_400_000);
			const seedPrior = async (over: Partial<typeof agentRuns.$inferInsert>) => {
				const facts = caseFacts();
				const [row] = await ctx.db
					.insert(agentRuns)
					.values({
						applicationId: facts.applicationId,
						feature: "case_brief",
						status: "failed",
						trigger: "auto",
						requestedBy: env.autoTriggerServiceUserId,
						requestedByRole: "service",
						applicantUserId: randomUUID(),
						caseFacts: {},
						model: "deepseek/deepseek-v4.1-flash-1017",
						agentVersion: "vtest",
						promptVersion: "vtest",
						promptHash: "x",
						asOf: new Date(facts.asOf),
						grafanaConversationId: randomUUID(),
						usage: {},
						timeoutAt: new Date(),
						finishedAt: new Date(),
						createdAt: yesterday,
						...over,
					})
					.returning({ id: agentRuns.id });
				return row;
			};

			// A prior-day run with a live retry stage reserves today's budget
			// even though its created_at is yesterday.
			const running = await seedPrior({
				contextStatus: "running",
				contextStageToken: randomUUID(),
				contextStartedAt: new Date(),
			});
			try {
				expect(
					await checkAutoCaps(
						ctx.db,
						{
							...env,
							maxCostUsd: 5,
							contextMaxCostUsd: 5,
							autoTriggerDailyCostBudgetUsd: baseline + 5,
						},
						randomUUID(),
					),
				).toEqual({ ok: false, reason: "daily_cost_budget" });
			} finally {
				await ctx.db.execute(sql`DELETE FROM agent_runs WHERE id = ${running.id}`);
			}

			// A prior-day run retried today counts its context_usage spend
			// today (the merged usage ledger is keyed by created_at, so it
			// would otherwise read as free).
			const retried = await seedPrior({
				contextStatus: "succeeded",
				contextUsage: { costUsd: 25 },
				contextStartedAt: new Date(),
			});
			try {
				expect(
					await checkAutoCaps(
						ctx.db,
						{ ...env, autoTriggerDailyCostBudgetUsd: baseline + 10 },
						randomUUID(),
					),
				).toEqual({ ok: false, reason: "daily_cost_budget" });
			} finally {
				await ctx.db.execute(sql`DELETE FROM agent_runs WHERE id = ${retried.id}`);
			}

			// Prior-day spend alone (no retry today) stays out of the budget.
			const old = await seedPrior({
				usage: { costUsd: 25 },
				contextUsage: { costUsd: 25 },
				contextStartedAt: yesterday,
			});
			try {
				expect(
					await checkAutoCaps(
						ctx.db,
						{ ...env, autoTriggerDailyCostBudgetUsd: baseline + 10 },
						randomUUID(),
					),
				).toEqual({ ok: true });
			} finally {
				await ctx.db.execute(sql`DELETE FROM agent_runs WHERE id = ${old.id}`);
			}
		} finally {
			await teardown(ctx);
		}
	});

	it("audit endpoint without history returns empty and claims nothing", async () => {
		const ctx = setupApp();
		try {
			const applicationId = randomUUID();
			const officerA = user("officer");
			const officerB = user("officer");
			for (const who of [officerA, officerB]) {
				const res = await get(ctx, `/internal/research/applications/${applicationId}/audit`, who);
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ applicationId, entries: [] });
			}
			// Neither page-open left a grant behind.
			const grants = await ctx.db
				.select({ id: researchAccessGrants.id })
				.from(researchAccessGrants)
				.where(eq(researchAccessGrants.applicationId, applicationId));
			expect(grants).toHaveLength(0);
		} finally {
			await teardown(ctx);
		}
	});

	it("research_audit_log is append-only in the database", async () => {
		const ctx = setupApp();
		try {
			const [row] = await ctx.db
				.insert(researchAuditLog)
				.values({
					applicationId: randomUUID(),
					actorId: randomUUID(),
					actorRole: "service",
					action: "auto.skip",
					metadata: {},
				})
				.returning({ id: researchAuditLog.id });
			// The migration trigger rejects the write; drizzle surfaces
			// the `Failed query` wrapper, so match the whole causal chain.
			const causes = (err: unknown): string =>
				err instanceof Error
					? `${err.message} ${err.cause instanceof Error ? causes(err.cause) : String(err.cause ?? "")}`
					: String(err);
			try {
				await ctx.db
					.update(researchAuditLog)
					.set({ action: "auto.ensure" })
					.where(eq(researchAuditLog.id, row.id));
				expect.unreachable("audit UPDATE must be rejected");
			} catch (err) {
				expect(causes(err)).toMatch(/append-only/);
			}
			try {
				await ctx.db.delete(researchAuditLog).where(eq(researchAuditLog.id, row.id));
				expect.unreachable("audit DELETE must be rejected");
			} catch (err) {
				expect(causes(err)).toMatch(/append-only/);
			}
		} finally {
			await teardown(ctx);
		}
	});
});

describe("classifyAutoMessage", () => {
	it("skips malformed and misrouted envelopes; processes review.requested", () => {
		expect(classifyAutoMessage("")).toEqual({ kind: "skip" });
		expect(classifyAutoMessage("{not json")).toEqual({ kind: "skip" });
		expect(classifyAutoMessage(JSON.stringify({ type: "bogus" }))).toEqual({ kind: "skip" });
		// Well-formed but misrouted: skipped, never retried.
		expect(
			classifyAutoMessage(
				JSON.stringify({
					id: randomUUID(),
					type: "decision.made",
					version: 1,
					occurredAt: new Date().toISOString(),
					payload: {
						decisionId: randomUUID(),
						applicationId: randomUUID(),
						outcome: "approved",
						decidedBy: "officer",
						reasonCodes: ["R1"],
					},
				}),
			),
		).toEqual({ kind: "skip" });
		const applicationId = randomUUID();
		const out = classifyAutoMessage(JSON.stringify(envelope(applicationId)));
		expect(out.kind).toBe("process");
		if (out.kind === "process") {
			expect((out.envelope.payload as { applicationId: string }).applicationId).toBe(applicationId);
		}
	});
});

describe("first-officer claim of auto runs", () => {
	it("lets the first officer read; the second gets 404", async () => {
		const ctx = setupApp();
		try {
			const facts = caseFacts();
			const deps = depsFor(ctx, contextFor(facts));
			const out = await handleReviewRequested(deps, envelope(facts.applicationId));
			const runId = (out as { runId: string }).runId;
			await waitRun(ctx, runId);

			// No grant exists yet: the auto run is unreadable without a claim.
			const officerA = user("officer");
			const officerB = user("officer");
			const latestA = await get(
				ctx,
				`/internal/research/applications/${facts.applicationId}/latest`,
				officerA,
			);
			expect(latestA.status).toBe(200);
			expect(((await latestA.json()) as { run: { id: string } }).run.id).toBe(runId);
			expect(
				(await get(ctx, `/internal/research/applications/${facts.applicationId}/latest`, officerB))
					.status,
			).toBe(404);

			// View works for the claimer, 404s for the stranger.
			const viewPath = `/internal/research/applications/${facts.applicationId}/runs/${runId}/view`;
			expect((await postView(ctx, viewPath, officerA)).status).toBe(200);
			expect((await postView(ctx, viewPath, officerB)).status).toBe(404);
		} finally {
			await teardown(ctx);
		}
	});

	it("exposes skip/ensure reasons at the auto-audit endpoint with no PII", async () => {
		const ctx = setupApp();
		try {
			// One skip (no consent) and one ensure on different applications.
			const skippedFacts = caseFacts({ aiResearchConsent: false });
			await handleReviewRequested(
				depsFor(ctx, contextFor(skippedFacts)),
				envelope(skippedFacts.applicationId),
			);
			const okFacts = caseFacts();
			const ensured = await handleReviewRequested(
				depsFor(ctx, contextFor(okFacts)),
				envelope(okFacts.applicationId),
			);
			const runId = (ensured as { runId: string }).runId;
			await waitRun(ctx, runId);

			// First officer claims on audit read, even with no run behind a skip.
			const reader = user("officer");
			const skipAudit = await get(
				ctx,
				`/internal/research/applications/${skippedFacts.applicationId}/audit`,
				reader,
			);
			expect(skipAudit.status).toBe(200);
			const skipBody = (await skipAudit.json()) as {
				entries: Array<{ action: string; metadata: Record<string, unknown> }>;
			};
			expect(skipBody.entries.some((e) => e.action === "auto.skip")).toBe(true);

			const okAudit = await get(
				ctx,
				`/internal/research/applications/${okFacts.applicationId}/audit`,
				reader,
			);
			expect(okAudit.status).toBe(200);
			const ownBody = (await okAudit.json()) as {
				entries: Array<{
					action: string;
					actorRole: string;
					runId: string | null;
					metadata: Record<string, unknown>;
					createdAt: string;
				}>;
			};
			expect(ownBody.entries.some((e) => e.action === "auto.ensure" && e.runId === runId)).toBe(
				true,
			);
			expect(ownBody.entries.every((e) => e.actorRole === "service")).toBe(true);
			// No PII anywhere in the payload: no names, cities, quotes, or facts.
			const dumped = JSON.stringify(ownBody);
			expect(dumped).not.toContain(okFacts.applicantName);
			expect(dumped).not.toContain(okFacts.city);
			expect(dumped).not.toContain("snapshot");
		} finally {
			await teardown(ctx);
		}
	});
});

describe("audit access (co-owners, specialists, no-history)", () => {
	it("two assigned officers both read audit; a stranger gets 404", async () => {
		const ctx = setupApp();
		try {
			const skippedFacts = caseFacts({ aiResearchConsent: false });
			await handleReviewRequested(
				depsFor(ctx, contextFor(skippedFacts)),
				envelope(skippedFacts.applicationId),
			);
			const appId = skippedFacts.applicationId;
			const ownerA = user("officer");
			const ownerB = user("officer");
			const stranger = user("officer");
			// Owner A claims via the audit read; owner B is co-granted by
			// the service. Neither blocks the other.
			expect(
				(await get(ctx, `/internal/research/applications/${appId}/audit`, ownerA)).status,
			).toBe(200);
			await grantResearchAccess(ctx.db, {
				applicationId: appId,
				userId: ownerB.id,
				accessRole: "assigned_officer",
				grantedBy: randomUUID(),
				granterRole: "service",
			});
			expect(
				(await get(ctx, `/internal/research/applications/${appId}/audit`, ownerB)).status,
			).toBe(200);
			expect(
				(await get(ctx, `/internal/research/applications/${appId}/audit`, ownerA)).status,
			).toBe(200);
			expect(
				(await get(ctx, `/internal/research/applications/${appId}/audit`, stranger)).status,
			).toBe(404);
		} finally {
			await teardown(ctx);
		}
	});

	it("a specialist reads audit without becoming the owner", async () => {
		const ctx = setupApp();
		try {
			const skippedFacts = caseFacts({ aiResearchConsent: false });
			await handleReviewRequested(
				depsFor(ctx, contextFor(skippedFacts)),
				envelope(skippedFacts.applicationId),
			);
			const appId = skippedFacts.applicationId;
			const specialist = user("officer");
			await grantResearchAccess(ctx.db, {
				applicationId: appId,
				userId: specialist.id,
				accessRole: "compliance",
				grantedBy: randomUUID(),
				granterRole: "service",
			});
			const res = await get(ctx, `/internal/research/applications/${appId}/audit`, specialist);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { entries: unknown[] };
			expect(body.entries.length).toBeGreaterThan(0);
			// The read claimed nothing: the grant is still specialist-only.
			const grants = await ctx.db
				.select()
				.from(researchAccessGrants)
				.where(eq(researchAccessGrants.applicationId, appId));
			expect(grants.filter((g) => g.userId === specialist.id).map((g) => g.accessRole)).toEqual([
				"compliance",
			]);
		} finally {
			await teardown(ctx);
		}
	});

	it("audit without history: 200 empty when no run exists, audited 404 when one does", async () => {
		const ctx = setupApp();
		try {
			// No run at all: empty, no grant, no denial audit.
			const bare = randomUUID();
			const stranger = user("officer");
			const empty = await get(ctx, `/internal/research/applications/${bare}/audit`, stranger);
			expect(empty.status).toBe(200);
			expect(await empty.json()).toEqual({ applicationId: bare, entries: [] });
			expect((await auditRows(ctx, bare)).filter((a) => a.action === "access.denied")).toHaveLength(
				0,
			);

			// An officer-owned run with no auto history: the stranger gets
			// the same audited 404 as latest, never an empty answer.
			const env = autoEnv();
			const facts = caseFacts();
			await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const denied = await get(
				ctx,
				`/internal/research/applications/${facts.applicationId}/audit`,
				stranger,
			);
			expect(denied.status).toBe(404);
			expect(
				(await auditRows(ctx, facts.applicationId)).some((a) => a.action === "access.denied"),
			).toBe(true);
		} finally {
			await teardown(ctx);
		}
	});
});
