// Agentic memo route integration (real Postgres, scripted fake model):
// agent happy path + trace/audit, idempotent replay, typed failures,
// missing-model 503, and the deterministic trace.
import { randomUUID } from "node:crypto";
import {
	applications,
	auditLog,
	caseAccessGrants,
	generatedArtifacts,
} from "@credit/db/applications";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { assembleCaseEvidence } from "../../src/assist/evidence.js";
import { buildCreditMemo } from "../../src/assist/memo.js";
import { MemoModelError, type MemoModel } from "../../src/assist/memo-model.js";
import { createUser, setupApp, signed, type TestContext, type TestUser } from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

const NOW = new Date("2026-07-01T00:00:00Z");
const SENTINEL = `SENTINEL-AGENT-${randomUUID()}`;

interface ScriptedStep {
	content?: string | null;
	toolCalls?: Array<{ name: string; arguments?: unknown }>;
	error?: Error;
}

/** Programmable fake: each test loads a script, the route drives it. */
function programmableModel(): {
	model: MemoModel;
	setScript: (steps: ScriptedStep[]) => void;
	calls: () => number;
} {
	let script: ScriptedStep[] = [];
	let index = 0;
	let count = 0;
	return {
		calls: () => count,
		setScript: (steps) => {
			script = steps;
			index = 0;
		},
		model: {
			async complete() {
				count += 1;
				const step = script[Math.min(index, Math.max(0, script.length - 1))];
				index += 1;
				if (!step) throw new MemoModelError("UNAVAILABLE");
				if (step.error) throw step.error;
				return {
					content: step.content ?? null,
					toolCalls: (step.toolCalls ?? []).map((call, callIndex) => ({
						id: `call_${count}_${callIndex}`,
						name: call.name,
						arguments: call.arguments ?? {},
					})),
					usage: { inputTokens: 10, outputTokens: 20, costUsd: 0 },
				};
			},
		},
	};
}

let ctx: TestContext;
let officer: TestUser;
const fake = programmableModel();

function agentCtx(): TestContext {
	return setupApp({
		documents: { config: { featureEnabled: true } },
		assist: {
			config: { enabled: true, memoWriter: "agent" },
			memoModel: fake.model,
			now: () => NOW,
		},
	});
}

async function seedCase(sentinelCompany: string): Promise<string> {
	const [row] = await ctx.db
		.insert(applications)
		.values({
			reference: `AGT-${randomUUID().slice(0, 8)}`,
			applicantUserId: randomUUID(),
			type: "sme",
			product: "sme_term_loan",
			status: "pending_review",
			amountCents: 6_000_000,
			termMonths: 60,
			purpose: "Agent route test",
			identity: { fullName: "Agent Owner", city: "Singapore" },
			business: {
				companyName: sentinelCompany,
				industry: "hospitality",
				yearsTrading: 4,
				annualRevenueCents: 61_000_000,
				monthlyFcfCents: 380_000,
				existingDebtServiceCents: 30_000,
			},
			financial: null,
			consents: [true, true, true],
			submittedAt: new Date("2026-06-30T00:00:00Z"),
		})
		.returning({ id: applications.id });
	await ctx.db.insert(caseAccessGrants).values({
		applicationId: row.id,
		userId: officer.id,
		accessRole: "assigned_officer",
		grantedBy: officer.id,
	});
	return row.id;
}

/** Valid memo JSON for the seeded case, built with the production builder. */
async function memoJson(applicationId: string): Promise<string> {
	const rows = await ctx.db.select().from(applications).where(eq(applications.id, applicationId));
	const application = rows[0];
	if (!application) throw new Error("seeded case missing");
	const evidence = await assembleCaseEvidence({
		db: ctx.db,
		application,
		officer: { id: officer.id, email: officer.email, role: "officer" },
		assignedToMe: true,
		documentsEnabled: true,
		now: NOW,
		research: { url: null, secret: "test", timeoutMs: 1_000 },
	});
	return JSON.stringify(buildCreditMemo({ application, evidence }));
}

function postMemo(user: TestUser, applicationId: string) {
	return ctx.app.request(`/api/assist/cases/${applicationId}/memos`, {
		method: "POST",
		headers: signed(ctx, user, "POST", `/api/assist/cases/${applicationId}/memos`),
	});
}

async function artifactRows(applicationId: string) {
	return ctx.db
		.select()
		.from(generatedArtifacts)
		.where(eq(generatedArtifacts.applicationId, applicationId));
}

beforeEach(async () => {
	if (ctx) await ctx.sql.end();
	ctx = agentCtx();
	officer = await createUser(ctx, "officer");
});

afterAll(async () => {
	await ctx.sql.end();
});

describe("agent memo route", () => {
	it("drafts via the agent with trace, metadata-only audit, and no leak", async () => {
		const company = `${SENTINEL}-CO`;
		const applicationId = await seedCase(company);
		fake.setScript([
			{ toolCalls: [{ name: "list_evidence", arguments: {} }] },
			{ content: await memoJson(applicationId) },
		]);
		const res = await postMemo(officer, applicationId);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			artifact: {
				id: string;
				agentTrace: {
					writer: string;
					agentVersion: string;
					model: string;
					promptVersion: string;
					evidenceHash: string;
					toolCalls: Array<{ name: string }>;
					sourceRefs: string[];
					repairAttempted: boolean;
				} | null;
				evidenceHash: string | null;
			};
		};
		const trace = body.artifact.agentTrace;
		expect(trace?.writer).toBe("agent");
		expect(trace?.toolCalls.length).toBeGreaterThan(0);
		expect(trace?.sourceRefs.length).toBeGreaterThan(0);
		expect(trace?.evidenceHash).toBe(body.artifact.evidenceHash);
		expect(typeof trace?.evidenceHash).toBe("string");

		const rows = await artifactRows(applicationId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.evidenceHash).toBe(body.artifact.evidenceHash);

		const audits = await ctx.db
			.select()
			.from(auditLog)
			.where(
				and(eq(auditLog.applicationId, applicationId), eq(auditLog.action, "artifact.created")),
			);
		expect(audits).toHaveLength(1);
		expect(audits[0]?.payload).toMatchObject({
			feature: "assist",
			writer: "agent",
			toolCallCount: trace?.toolCalls.length,
			sourceRefCount: trace?.sourceRefs.length,
			repairAttempted: false,
		});
		expect(
			typeof (audits[0]?.payload as Record<string, unknown> | undefined)?.["evidenceHash"],
		).toBe("string");
		// Metadata only: company name and memo prose never reach the audit row.
		expect(JSON.stringify(audits[0]?.payload)).not.toContain(company);
	});

	it("replays the same evidence with 200 and persists no second artifact", async () => {
		const applicationId = await seedCase(`${SENTINEL}-REPLAY`);
		fake.setScript([
			{ toolCalls: [{ name: "list_evidence", arguments: {} }] },
			{ content: await memoJson(applicationId) },
		]);
		const first = await postMemo(officer, applicationId);
		expect(first.status).toBe(201);
		const firstId = ((await first.json()) as { artifact: { id: string } }).artifact.id;

		fake.setScript([
			{ toolCalls: [{ name: "list_evidence", arguments: {} }] },
			{ content: await memoJson(applicationId) },
		]);
		const callsBefore = fake.calls();
		const second = await postMemo(officer, applicationId);
		expect(second.status).toBe(200);
		const replay = (await second.json()) as { artifact: { id: string }; replayed: boolean };
		expect(replay.artifact.id).toBe(firstId);
		expect(replay.replayed).toBe(true);
		// Replay short-circuits before the model: no new calls, no new row.
		expect(fake.calls()).toBe(callsBefore);
		expect(await artifactRows(applicationId)).toHaveLength(1);
	});

	it("maps model failures to typed errors and persists nothing", async () => {
		const failures: Array<{ step: ScriptedStep; status: number; code: string }> = [
			{
				step: { error: new MemoModelError("UNAVAILABLE") },
				status: 502,
				code: "MEMO_AGENT_UNAVAILABLE",
			},
			{ step: { error: new MemoModelError("TIMEOUT") }, status: 504, code: "MEMO_AGENT_TIMEOUT" },
			{
				step: { toolCalls: [{ name: "list_evidence", arguments: {} }] },
				status: 422,
				code: "MEMO_AGENT_INVALID",
			},
		];
		for (const [index, failure] of failures.entries()) {
			const applicationId = await seedCase(`${SENTINEL}-FAIL-${index}`);
			fake.setScript(
				failure.code === "MEMO_AGENT_INVALID"
					? [failure.step, { content: "not json" }, { content: "still not json" }]
					: [failure.step],
			);
			const res = await postMemo(officer, applicationId);
			expect(res.status, failure.code).toBe(failure.status);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(failure.code);
			expect(await artifactRows(applicationId)).toHaveLength(0);
		}
	});

	it("returns 503 when agent mode has no model", async () => {
		const noModel = setupApp({
			documents: { config: { featureEnabled: true } },
			assist: { config: { enabled: true, memoWriter: "agent" }, now: () => NOW },
		});
		try {
			const noModelOfficer = await createUser(noModel, "officer");
			const [row] = await noModel.db
				.insert(applications)
				.values({
					reference: `AGT-${randomUUID().slice(0, 8)}`,
					applicantUserId: randomUUID(),
					type: "sme",
					product: "sme_term_loan",
					status: "pending_review",
					amountCents: 6_000_000,
					termMonths: 60,
					purpose: "Missing model test",
					identity: { fullName: "No Model", city: "Singapore" },
					business: { companyName: "No Model Co" },
					financial: null,
					consents: [true, true, true],
					submittedAt: new Date("2026-06-30T00:00:00Z"),
				})
				.returning({ id: applications.id });
			await noModel.db.insert(caseAccessGrants).values({
				applicationId: row.id,
				userId: noModelOfficer.id,
				accessRole: "assigned_officer",
				grantedBy: noModelOfficer.id,
			});
			const res = await noModel.app.request(`/api/assist/cases/${row.id}/memos`, {
				method: "POST",
				headers: signed(noModel, noModelOfficer, "POST", `/api/assist/cases/${row.id}/memos`),
			});
			expect(res.status).toBe(503);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				"MEMO_AGENT_UNAVAILABLE",
			);
			expect(
				await noModel.db
					.select()
					.from(generatedArtifacts)
					.where(eq(generatedArtifacts.applicationId, row.id)),
			).toHaveLength(0);
		} finally {
			await noModel.sql.end();
		}
	});

	it("regenerates on writer switch instead of replaying, then replays same-writer", async () => {
		const det = setupApp({
			documents: { config: { featureEnabled: true } },
			assist: { config: { enabled: true, memoWriter: "deterministic" }, now: () => NOW },
		});
		try {
			const detOfficer = await createUser(det, "officer");
			const [row] = await det.db
				.insert(applications)
				.values({
					reference: `AGT-${randomUUID().slice(0, 8)}`,
					applicantUserId: randomUUID(),
					type: "sme",
					product: "sme_term_loan",
					status: "pending_review",
					amountCents: 6_000_000,
					termMonths: 60,
					purpose: "Writer switch test",
					identity: { fullName: "Switch Owner", city: "Singapore" },
					business: { companyName: "Switch Co" },
					financial: null,
					consents: [true, true, true],
					submittedAt: new Date("2026-06-30T00:00:00Z"),
				})
				.returning({ id: applications.id });
			await det.db.insert(caseAccessGrants).values({
				applicationId: row.id,
				userId: detOfficer.id,
				accessRole: "assigned_officer",
				grantedBy: detOfficer.id,
			});
			const detPath = `/api/assist/cases/${row.id}/memos`;
			const detRes = await det.app.request(detPath, {
				method: "POST",
				headers: signed(det, detOfficer, "POST", detPath),
			});
			expect(detRes.status).toBe(201);
			const detId = ((await detRes.json()) as { artifact: { id: string } }).artifact.id;

			const agent = setupApp({
				documents: { config: { featureEnabled: true } },
				assist: {
					config: { enabled: true, memoWriter: "agent" },
					memoModel: fake.model,
					now: () => NOW,
				},
			});
			try {
				const agentPath = `/api/assist/cases/${row.id}/memos`;
				const agentHeaders = () => signed(agent, detOfficer, "POST", agentPath);
				fake.setScript([
					{ toolCalls: [{ name: "list_evidence", arguments: {} }] },
					{ content: await memoJson(row.id) },
				]);
				// Same evidence, other writer: no replay, a new agent artifact.
				const res = await agent.app.request(agentPath, {
					method: "POST",
					headers: agentHeaders(),
				});
				expect(res.status).toBe(201);
				const body = (await res.json()) as {
					artifact: { id: string; version: number; agentTrace: { writer: string } | null };
				};
				expect(body.artifact.id).not.toBe(detId);
				expect(body.artifact.agentTrace?.writer).toBe("agent");
				expect(body.artifact.version).toBe(2);
				const oldRow = (
					await agent.db.select().from(generatedArtifacts).where(eq(generatedArtifacts.id, detId))
				)[0];
				expect(oldRow?.status).toBe("superseded");

				// Same writer and evidence: replay returns the same id, no model call.
				const callsBefore = fake.calls();
				const replay = await agent.app.request(agentPath, {
					method: "POST",
					headers: agentHeaders(),
				});
				expect(replay.status).toBe(200);
				const replayed = (await replay.json()) as {
					artifact: { id: string };
					replayed: boolean;
				};
				expect(replayed.artifact.id).toBe(body.artifact.id);
				expect(replayed.replayed).toBe(true);
				expect(fake.calls()).toBe(callsBefore);
			} finally {
				await agent.sql.end();
			}
		} finally {
			await det.sql.end();
		}
	});

	it("deterministic mode persists a deterministic trace with evidenceHash", async () => {
		const det = setupApp({
			documents: { config: { featureEnabled: true } },
			assist: { config: { enabled: true, memoWriter: "deterministic" }, now: () => NOW },
		});
		try {
			const detOfficer = await createUser(det, "officer");
			const [row] = await det.db
				.insert(applications)
				.values({
					reference: `AGT-${randomUUID().slice(0, 8)}`,
					applicantUserId: randomUUID(),
					type: "sme",
					product: "sme_term_loan",
					status: "pending_review",
					amountCents: 6_000_000,
					termMonths: 60,
					purpose: "Deterministic trace test",
					identity: { fullName: "Det Owner", city: "Singapore" },
					business: { companyName: "Det Co" },
					financial: null,
					consents: [true, true, true],
					submittedAt: new Date("2026-06-30T00:00:00Z"),
				})
				.returning({ id: applications.id });
			await det.db.insert(caseAccessGrants).values({
				applicationId: row.id,
				userId: detOfficer.id,
				accessRole: "assigned_officer",
				grantedBy: detOfficer.id,
			});
			const res = await det.app.request(`/api/assist/cases/${row.id}/memos`, {
				method: "POST",
				headers: signed(det, detOfficer, "POST", `/api/assist/cases/${row.id}/memos`),
			});
			expect(res.status).toBe(201);
			const body = (await res.json()) as {
				artifact: {
					agentTrace: {
						writer: string;
						evidenceHash: string;
						toolCalls: unknown[];
						inputTokens: number;
						outputTokens: number;
					} | null;
					evidenceHash: string | null;
				};
			};
			expect(body.artifact.agentTrace?.writer).toBe("deterministic");
			expect(body.artifact.agentTrace?.toolCalls).toEqual([]);
			expect(body.artifact.agentTrace?.inputTokens).toBe(0);
			expect(body.artifact.agentTrace?.outputTokens).toBe(0);
			expect(typeof body.artifact.evidenceHash).toBe("string");
			expect(body.artifact.agentTrace?.evidenceHash).toBe(body.artifact.evidenceHash);
		} finally {
			await det.sql.end();
		}
	});
});
