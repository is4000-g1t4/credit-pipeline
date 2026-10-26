// EN-07 rule-failures integration (real Postgres): service-only route with
// the second HMAC, case scoping, typed 404/409s, and the metadata-only
// read audit. Rows accumulate harmlessly like the other suites.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { createHmac, randomUUID } from "node:crypto";
import { createDb } from "@credit/db";
import { applications, auditLog, decisions, policyEvaluations } from "@credit/db/applications";
import { buildCheckOnlySnapshot, buildCreditSnapshot, POLICY_VERSION } from "@credit/core";
import { createLogger, signInternalHeaders } from "@credit/service-kit";
import { stubGateway } from "@credit/service-kit/test";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { assembleCaseEvidence } from "../../src/assist/evidence.js";
import { loadEnv } from "../../src/env.js";
import { createUser, type TestContext, type TestUser } from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

const RULE_SECRET = "integration-rule-context-secret-0123456789";

// setupApp cannot express the EN-07 env gate (routes read env, not the
// assist runtime config), so this file wires createApp directly with a
// spread-overridden env. Shape mirrors the shared helper.
function setupPolicyApp(
	policyExceptionEnabled: boolean,
	policyRuleContextSecret: string | null,
): TestContext {
	const base = loadEnv();
	const env = {
		...base,
		assist: { ...base.assist, enabled: true, policyExceptionEnabled, policyRuleContextSecret },
	};
	const { db, sql } = createDb(base.databaseUrl);
	const gateway = stubGateway();
	const app = createApp({
		db,
		sql,
		env,
		gateway,
		logger: createLogger("policy-rule-failures-test"),
	});
	return { app, db, sql, gateway, secret: base.internalSecret };
}

const INDIVIDUAL_REFER = {
	kind: "individual",
	score: 650,
	existingDebtCents: 61_000,
	monthlyIncomeCents: 420_000,
	newPaymentCents: 100_000,
	amountCents: 1_200_000,
	termMonths: 48,
	employmentYears: 6,
};

let ctx: TestContext;
let ctxFlagOff: TestContext;
let ctxNoSecret: TestContext;
let svc: TestUser;

function ruleHeaders(
	use: TestContext,
	user: TestUser,
	path: string,
	appId: string,
	over: {
		ts?: number;
		sig?: string;
		requestId?: string;
		omitSecond?: boolean;
		secondPath?: string;
		secondAppId?: string;
	} = {},
): Record<string, string> {
	const requestId = over.requestId ?? randomUUID();
	const base = signInternalHeaders(use.secret, {
		userId: user.id,
		role: user.role,
		email: user.email,
		method: "GET",
		path,
		requestId,
	});
	if (over.omitSecond) return base;
	const ts = over.ts ?? Date.now();
	const message = `GET\n${over.secondPath ?? path}\n${over.secondAppId ?? appId}\n${user.id}\n${ts}\n${requestId}`;
	const sig = over.sig ?? createHmac("sha256", RULE_SECRET).update(message, "utf8").digest("hex");
	return { ...base, "x-rule-context-ts": String(ts), "x-rule-context-signature": sig };
}

async function seedApp(
	use: TestContext,
	over: Partial<typeof applications.$inferSelect> = {},
): Promise<string> {
	const [row] = await use.db
		.insert(applications)
		.values({
			reference: `RC-${randomUUID().slice(0, 8)}`,
			applicantUserId: randomUUID(),
			type: "individual",
			product: "personal_loan",
			status: "submitted",
			amountCents: 1_200_000,
			termMonths: 48,
			purpose: "rule context integration",
			identity: { fullName: "Rule Ctx", city: "Singapore" },
			business: { companyName: "SECRET-RC-CO" },
			consents: [true, true, true],
			submittedAt: new Date("2026-06-01T00:00:00Z"),
			...over,
		})
		.returning({ id: applications.id });
	return row.id;
}

async function seedEvaluation(
	use: TestContext,
	appId: string,
	over: {
		inputs?: unknown;
		reasons?: unknown;
		outcome?: string;
		policyVersion?: string;
		evaluatedAt?: Date | null;
	} = {},
): Promise<string> {
	const [row] = await use.db
		.insert(policyEvaluations)
		.values({
			applicationId: appId,
			policyVersion: over.policyVersion ?? POLICY_VERSION,
			outcome: over.outcome ?? "refer",
			reasons: over.reasons ?? [{ code: "SCORE_IN_REFER_BAND" }, { code: "DTI_IN_REFER_BAND" }],
			maxAmountCents: 1_200_000,
			inputs: over.inputs ?? INDIVIDUAL_REFER,
			inputHash: `input-${randomUUID()}`,
			evaluatedAt:
				over.evaluatedAt === undefined ? new Date("2026-05-01T10:00:00Z") : over.evaluatedAt,
			createdAt: new Date("2026-05-01T09:00:00Z"),
		})
		.returning({ id: policyEvaluations.id });
	return row.id;
}

async function auditsFor(appId: string): Promise<Array<typeof auditLog.$inferSelect>> {
	return ctx.db
		.select()
		.from(auditLog)
		.where(
			and(eq(auditLog.applicationId, appId), eq(auditLog.action, "policy.rule_failures_read")),
		);
}

const ALLOWLISTED = new Set([
	"feature",
	"applicationId",
	"policyVersion",
	"registryVersion",
	"outcome",
	"scoreBand",
	"ruleIds",
	"reasonCodes",
	"mappingStates",
	"persistedCount",
]);

beforeAll(async () => {
	ctx = setupPolicyApp(true, RULE_SECRET);
	svc = await createUser(ctx, "service");
	ctxFlagOff = setupPolicyApp(false, RULE_SECRET);
	ctxNoSecret = setupPolicyApp(true, null);
});

afterAll(async () => {
	await ctx.sql.end();
	await ctxFlagOff.sql.end();
	await ctxNoSecret.sql.end();
});

describe("rule-failures route", () => {
	it("returns 200 with the rule context for a pending case", async () => {
		const appId = await seedApp(ctx);
		await seedEvaluation(ctx, appId);
		const path = `/internal/applications/${appId}/rule-failures`;
		const res = await ctx.app.request(path, { headers: ruleHeaders(ctx, svc, path, appId) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { context: Record<string, unknown> };
		const context = body.context;
		expect(context["applicationId"]).toBe(appId);
		expect(context["status"]).toBe("ok");
		expect(context["policyVersion"]).toBe(POLICY_VERSION);
		expect(context["policyAsOf"]).toBe("2026-05-01");
		expect(context["score"]).toBe(650);
		expect(context["grade"]).toBe("C");
		expect(context["evaluationId"]).toEqual(expect.any(String));
		expect(context["decisionId"]).toBeNull();
		const rules = context["failedRules"] as Array<Record<string, unknown>>;
		expect(rules.map((rule) => rule["ruleId"])).toEqual(["PL-SCORE-REFER", "PL-DTI-REFER"]);
		for (const rule of rules) {
			expect(rule["observed"]).toEqual(expect.any(String));
			expect(rule["threshold"]).toEqual(expect.any(String));
			expect(rule["persisted"]).toBe(true);
			const exception = rule["exception"] as Record<string, unknown>;
			expect(exception["approverVerification"]).toBe("minimum");
			expect(exception["committeeCheckRequired"]).toBe(true);
		}
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("SECRET-RC-CO");
	});

	it("audits every read with metadata only", async () => {
		const appId = await seedApp(ctx);
		await seedEvaluation(ctx, appId);
		const path = `/internal/applications/${appId}/rule-failures`;
		const res = await ctx.app.request(path, { headers: ruleHeaders(ctx, svc, path, appId) });
		expect(res.status).toBe(200);
		const rows = await auditsFor(appId);
		expect(rows).toHaveLength(1);
		const payload = rows[0].payload as Record<string, unknown>;
		for (const key of Object.keys(payload)) {
			expect(ALLOWLISTED.has(key)).toBe(true);
		}
		expect(payload["feature"]).toBe("policy_exception");
		expect(payload["ruleIds"]).toEqual(["PL-SCORE-REFER", "PL-DTI-REFER"]);
		expect(payload["persistedCount"]).toBe(2);
		const serialized = JSON.stringify(payload);
		expect(serialized).not.toContain("SECRET-RC-CO");
		expect(serialized).not.toContain("observed");
		expect(serialized).not.toContain("threshold");
		expect(serialized).not.toContain("S$");
	});

	it("rejects missing, wrong, and stale second HMACs with 403", async () => {
		const appId = await seedApp(ctx);
		await seedEvaluation(ctx, appId);
		const path = `/internal/applications/${appId}/rule-failures`;
		const bare = ruleHeaders(ctx, svc, path, appId, { omitSecond: true });
		expect((await ctx.app.request(path, { headers: bare })).status).toBe(403);
		const wrong = ruleHeaders(ctx, svc, path, appId, { sig: "0".repeat(64) });
		expect((await ctx.app.request(path, { headers: wrong })).status).toBe(403);
		const stale = ruleHeaders(ctx, svc, path, appId, { ts: Date.now() - 10 * 60 * 1000 });
		expect((await ctx.app.request(path, { headers: stale })).status).toBe(403);
		const future = ruleHeaders(ctx, svc, path, appId, { ts: Date.now() + 10 * 60 * 1000 });
		expect((await ctx.app.request(path, { headers: future })).status).toBe(403);
		// Signed for another case: the second HMAC binds the application, so
		// a first-HMAC-valid request still fails the case binding.
		const otherId = randomUUID();
		const otherPath = `/internal/applications/${otherId}/rule-failures`;
		const cross = ruleHeaders(ctx, svc, path, appId, {
			secondPath: otherPath,
			secondAppId: otherId,
		});
		expect((await ctx.app.request(path, { headers: cross })).status).toBe(403);
		expect(await auditsFor(appId)).toHaveLength(0);
	});

	it("404s unknown and draft cases", async () => {
		const unknownId = randomUUID();
		const unknownPath = `/internal/applications/${unknownId}/rule-failures`;
		const unknown = await ctx.app.request(unknownPath, {
			headers: ruleHeaders(ctx, svc, unknownPath, unknownId),
		});
		expect(unknown.status).toBe(404);
		const draftId = await seedApp(ctx, { status: "draft", submittedAt: null });
		const draftPath = `/internal/applications/${draftId}/rule-failures`;
		const draft = await ctx.app.request(draftPath, {
			headers: ruleHeaders(ctx, svc, draftPath, draftId),
		});
		expect(draft.status).toBe(404);
	});

	it("409s missing evaluations, bad versions, and bad inputs", async () => {
		const emptyId = await seedApp(ctx);
		const emptyPath = `/internal/applications/${emptyId}/rule-failures`;
		const empty = await ctx.app.request(emptyPath, {
			headers: ruleHeaders(ctx, svc, emptyPath, emptyId),
		});
		expect(empty.status).toBe(409);
		expect(((await empty.json()) as { error: { code: string } }).error.code).toBe(
			"RULE_CONTEXT_UNAVAILABLE",
		);

		const staleId = await seedApp(ctx);
		await seedEvaluation(ctx, staleId, { policyVersion: "policy-v0.9" });
		const stalePath = `/internal/applications/${staleId}/rule-failures`;
		const stale = await ctx.app.request(stalePath, {
			headers: ruleHeaders(ctx, svc, stalePath, staleId),
		});
		expect(stale.status).toBe(409);
		expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
			"UNSUPPORTED_POLICY_VERSION",
		);

		const badId = await seedApp(ctx);
		await seedEvaluation(ctx, badId, { inputs: { kind: "individual" } });
		const badPath = `/internal/applications/${badId}/rule-failures`;
		const bad = await ctx.app.request(badPath, {
			headers: ruleHeaders(ctx, svc, badPath, badId),
		});
		expect(bad.status).toBe(409);
	});

	it("picks the latest evaluation by evaluatedAt", async () => {
		const appId = await seedApp(ctx);
		await seedEvaluation(ctx, appId, {
			policyVersion: "policy-v0.9",
			evaluatedAt: new Date("2026-04-01T10:00:00Z"),
		});
		await seedEvaluation(ctx, appId, { evaluatedAt: new Date("2026-05-01T10:00:00Z") });
		const path = `/internal/applications/${appId}/rule-failures`;
		const res = await ctx.app.request(path, { headers: ruleHeaders(ctx, svc, path, appId) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { context: { policyVersion: string } };
		expect(body.context.policyVersion).toBe(POLICY_VERSION);
	});

	it("returns not_applicable for check-only decisions", async () => {
		const appId = await seedApp(ctx, { status: "declined", decidedAt: new Date() });
		const snapshot = buildCheckOnlySnapshot({
			checks: [],
			reasons: [{ code: "OFFICER_JUDGEMENT", text: "manual" }],
			actor: svc.id,
			decidedAt: new Date("2026-05-02T10:00:00Z").toISOString(),
			inputs: INDIVIDUAL_REFER,
		});
		await ctx.db.insert(decisions).values({
			applicationId: appId,
			outcome: "declined",
			decidedBy: "system",
			reasons: [{ code: "OFFICER_JUDGEMENT", text: "manual" }],
			snapshot,
			decidedAt: new Date("2026-05-02T10:00:00Z"),
		});
		const path = `/internal/applications/${appId}/rule-failures`;
		const res = await ctx.app.request(path, { headers: ruleHeaders(ctx, svc, path, appId) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			context: { status: string; failedRules: unknown[]; score: null; decisionId: string };
		};
		expect(body.context.status).toBe("not_applicable");
		expect(body.context.failedRules).toEqual([]);
		expect(body.context.score).toBeNull();
		expect(body.context.decisionId).toEqual(expect.any(String));
		expect(await auditsFor(appId)).toHaveLength(1);
	});

	it("uses the frozen snapshot for decided cases", async () => {
		const appId = await seedApp(ctx, { status: "declined", decidedAt: new Date() });
		const declineInputs = { ...INDIVIDUAL_REFER, score: 500 };
		const snapshot = buildCreditSnapshot({
			inputs: declineInputs,
			score: 500,
			grade: "E",
			factors: [],
			rateBps: 1200,
			monthlyPaymentCents: 100_000,
			reasons: [{ code: "SCORE_TOO_LOW", text: "low" }],
			actor: svc.id,
			decidedAt: new Date("2026-05-02T10:00:00Z").toISOString(),
		});
		await ctx.db.insert(decisions).values({
			applicationId: appId,
			outcome: "declined",
			decidedBy: "system",
			reasons: [{ code: "SCORE_TOO_LOW", text: "low" }],
			snapshot,
			decidedAt: new Date("2026-05-02T10:00:00Z"),
		});
		// A conflicting auto evaluation must not move the frozen context.
		await seedEvaluation(ctx, appId, {
			outcome: "auto_approve",
			reasons: [],
			inputs: { ...INDIVIDUAL_REFER, score: 760 },
		});
		const path = `/internal/applications/${appId}/rule-failures`;
		const res = await ctx.app.request(path, { headers: ruleHeaders(ctx, svc, path, appId) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			context: {
				score: number;
				evaluationId: null;
				decisionId: string;
				failedRules: Array<{ ruleId: string }>;
			};
		};
		expect(body.context.score).toBe(500);
		expect(body.context.evaluationId).toBeNull();
		expect(body.context.decisionId).toEqual(expect.any(String));
		expect(body.context.failedRules.map((rule) => rule.ruleId)).toEqual(["PL-SCORE-LOW"]);
	});

	it("404s when the flag is off", async () => {
		const appId = await seedApp(ctxFlagOff);
		await seedEvaluation(ctxFlagOff, appId);
		const path = `/internal/applications/${appId}/rule-failures`;
		const res = await ctxFlagOff.app.request(path, {
			headers: ruleHeaders(ctxFlagOff, svc, path, appId),
		});
		expect(res.status).toBe(404);
	});

	it("503s when the rule-context secret is missing", async () => {
		const appId = await seedApp(ctxNoSecret);
		await seedEvaluation(ctxNoSecret, appId);
		const path = `/internal/applications/${appId}/rule-failures`;
		const res = await ctxNoSecret.app.request(path, {
			headers: ruleHeaders(ctxNoSecret, svc, path, appId),
		});
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"RULE_CONTEXT_AUTH_UNAVAILABLE",
		);
	});

	it("rejects non-service roles", async () => {
		const appId = await seedApp(ctx);
		await seedEvaluation(ctx, appId);
		const path = `/internal/applications/${appId}/rule-failures`;
		const officer = await createUser(ctx, "officer");
		const res = await ctx.app.request(path, { headers: ruleHeaders(ctx, officer, path, appId) });
		expect(res.status).toBe(403);
	});

	it("selects pinned evaluation/decision/snapshot rows for evidence", async () => {
		const appId = await seedApp(ctx);
		const oldEvalId = await seedEvaluation(ctx, appId, {
			policyVersion: "policy-v0.9",
			reasons: [{ code: "DTI_IN_REFER_BAND" }],
			evaluatedAt: new Date("2026-04-01T10:00:00Z"),
		});
		const newEvalId = await seedEvaluation(ctx, appId, {
			reasons: [{ code: "SCORE_IN_REFER_BAND" }],
			evaluatedAt: new Date("2026-05-01T10:00:00Z"),
		});
		const [decisionRow] = await ctx.db
			.insert(decisions)
			.values({
				applicationId: appId,
				outcome: "declined",
				decidedBy: "officer",
				reasons: [{ code: "SCORE_TOO_LOW", text: "low" }],
				snapshot: {
					factors: [{ code: "SENTINEL_NEG", points: -50, label: "sentinel" }],
				},
				decidedAt: new Date("2026-05-02T10:00:00Z"),
			})
			.returning({ id: decisions.id });
		const [appRow] = await ctx.db.select().from(applications).where(eq(applications.id, appId));

		// Default: latest rows win.
		const latest = await assembleCaseEvidence({
			db: ctx.db,
			application: appRow,
			officer: { id: svc.id, email: svc.email, role: "officer" },
			assignedToMe: false,
			documentsEnabled: false,
			now: new Date(),
			research: { url: null, secret: "test", timeoutMs: 1000 },
		});
		const latestRefs = latest.items.map((item) => item.ref).join("\n");
		expect(latestRefs).toContain(newEvalId);
		expect(latestRefs).not.toContain(oldEvalId);

		// Pinned: the older evaluation, the decision row, and an overriding
		// snapshot win instead.
		const pinned = await assembleCaseEvidence({
			db: ctx.db,
			application: appRow,
			officer: { id: svc.id, email: svc.email, role: "officer" },
			assignedToMe: false,
			documentsEnabled: false,
			now: new Date(),
			research: { url: null, secret: "test", timeoutMs: 1000 },
			pinned: {
				evaluationId: oldEvalId,
				decisionId: decisionRow.id,
				snapshot: { factors: [{ code: "PINNED_NEG", points: -30, label: "pinned" }] },
			},
		});
		const pinnedRefs = pinned.items.map((item) => item.ref).join("\n");
		expect(pinnedRefs).toContain(oldEvalId);
		expect(pinnedRefs).not.toContain(newEvalId);
		const pinnedCodes = pinned.items.map((item) => item.content);
		expect(pinnedCodes).toContain("PINNED_NEG");
		expect(pinnedCodes).not.toContain("SENTINEL_NEG");
	});
});
