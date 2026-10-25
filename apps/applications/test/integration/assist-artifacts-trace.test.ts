// Agentic trace persistence + idempotent replay lookup (real Postgres).
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../../.env", import.meta.url)),
});

import { randomUUID } from "node:crypto";
import { applications, auditLog, createDb, type Db } from "@credit/db/applications";
import { HttpError } from "@credit/service-kit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	approveArtifact,
	createArtifact,
	findArtifactByEvidence,
	getArtifact,
	tombstoneArtifact,
	updateArtifact,
} from "../../src/assist/artifacts.js";
import type { MemoAgentTrace } from "../../src/assist/memo-trace.js";

const TITLE = "SENTINEL-TRACE-TITLE-T404";
const QUOTE = "SENTINEL-TRACE-QUOTE-Q505";

function trace(evidenceHash: string): MemoAgentTrace {
	return {
		writer: "agent",
		agentVersion: "memo-agent-v1",
		model: "deepseek/deepseek-v4.1-flash-1017",
		promptVersion: "memo-agent-v1",
		evidenceHash,
		steps: 2,
		toolCalls: [{ step: 1, name: "list_evidence", resultCount: 4, sourceTypes: ["case_fact"] }],
		sourceRefs: ["case_fact:app:amountCents"],
		repairAttempted: false,
		repairSucceeded: null,
		fallbackReason: null,
		inputTokens: 10,
		outputTokens: 20,
		latencyMs: 30,
	};
}

const { db, sql } = createDb(
	process.env["APPLICATIONS_DATABASE_URL"] ??
		"postgres://credit:credit@localhost:5432/credit_applications",
);

async function insertApplication(database: Db): Promise<string> {
	const [row] = await database
		.insert(applications)
		.values({
			reference: `TRACE-${randomUUID()}`,
			applicantUserId: randomUUID(),
			type: "individual",
			product: "personal_loan",
			status: "submitted",
			amountCents: 1200000,
			termMonths: 48,
			purpose: "trace persistence test",
			identity: { fullName: "Trace Tester" },
			consents: [true],
			submittedAt: new Date(),
		})
		.returning();
	return row.id;
}

beforeAll(async () => {
	await sql`select 1`;
});

afterAll(async () => {
	await sql.end();
});

describe("trace persistence and DTO", () => {
	it("persists trace/hash on create and exposes them on the DTO", async () => {
		const applicationId = await insertApplication(db);
		const created = await createArtifact(db, {
			applicationId,
			type: "credit_memo",
			content: { title: TITLE },
			citations: [{ ref: "evidence:doc-1", quote: QUOTE, path: "title" }],
			createdBy: randomUUID(),
			model: "test-model",
			promptVersion: "v1",
			retentionDays: 30,
			agentTrace: trace("hash-aaa"),
		});
		expect(created.agentTrace?.evidenceHash).toBe("hash-aaa");
		expect(created.evidenceHash).toBe("hash-aaa");
		expect(created.agentTrace?.toolCalls).toHaveLength(1);

		// Explicit evidenceHash wins over the trace's when both are supplied.
		const applicationId2 = await insertApplication(db);
		const explicit = await createArtifact(db, {
			applicationId: applicationId2,
			type: "credit_memo",
			content: { title: TITLE },
			citations: [],
			createdBy: randomUUID(),
			model: "test-model",
			promptVersion: "v1",
			retentionDays: 30,
			agentTrace: trace("hash-aaa"),
			evidenceHash: "hash-explicit",
		});
		expect(explicit.evidenceHash).toBe("hash-explicit");

		// No trace: both stay null (existing behavior unchanged).
		const untraced = await createArtifact(db, {
			applicationId: await insertApplication(db),
			type: "credit_memo",
			content: { title: TITLE },
			citations: [],
			createdBy: randomUUID(),
			model: "test-model",
			promptVersion: "v1",
			retentionDays: 30,
		});
		expect(untraced.agentTrace).toBeNull();
		expect(untraced.evidenceHash).toBeNull();
	});

	it("rejects an invalid trace with a typed internal error (no leak)", async () => {
		const applicationId = await insertApplication(db);
		const bad = trace("hash-bad") as unknown as Record<string, unknown>;
		delete bad["steps"];
		await expect(
			createArtifact(db, {
				applicationId,
				type: "credit_memo",
				content: { title: TITLE },
				citations: [],
				createdBy: randomUUID(),
				model: "test-model",
				promptVersion: "v1",
				retentionDays: 30,
				agentTrace: bad as unknown as MemoAgentTrace,
			}),
		).rejects.toMatchObject({ status: 500, code: "ARTIFACT_TRACE_INVALID" });
	});
});

describe("update preserves trace", () => {
	it("draft edits and approved forks keep the trace unless replaced", async () => {
		const applicationId = await insertApplication(db);
		const actor = randomUUID();
		const v1 = await createArtifact(db, {
			applicationId,
			type: "credit_memo",
			content: { title: TITLE },
			citations: [],
			createdBy: actor,
			model: "test-model",
			promptVersion: "v1",
			retentionDays: 30,
			agentTrace: trace("hash-preserve"),
		});

		const edited = await updateArtifact(db, {
			id: v1.id,
			actor,
			expectedRevision: 1,
			content: { title: `${TITLE}-edit` },
			citations: [],
			model: "test-model",
			promptVersion: "v2",
			retentionDays: 30,
		});
		expect(edited.artifact.agentTrace?.evidenceHash).toBe("hash-preserve");
		expect(edited.artifact.evidenceHash).toBe("hash-preserve");

		const replaced = await updateArtifact(db, {
			id: v1.id,
			actor,
			expectedRevision: 2,
			content: { title: `${TITLE}-replaced` },
			citations: [],
			model: "test-model",
			promptVersion: "v2",
			retentionDays: 30,
			agentTrace: trace("hash-new"),
		});
		expect(replaced.artifact.agentTrace?.evidenceHash).toBe("hash-new");
		expect(replaced.artifact.evidenceHash).toBe("hash-new");

		await approveArtifact(db, { id: v1.id, actor, expectedRevision: 3 });
		const fork = await updateArtifact(db, {
			id: v1.id,
			actor,
			expectedRevision: 3,
			content: { title: `${TITLE}-fork` },
			citations: [],
			model: "test-model",
			promptVersion: "v3",
			retentionDays: 30,
		});
		expect(fork.createdVersion).toBe(true);
		expect(fork.artifact.version).toBe(2);
		expect(fork.artifact.agentTrace?.evidenceHash).toBe("hash-new");
		expect(fork.artifact.evidenceHash).toBe("hash-new");
	});
});

describe("findArtifactByEvidence", () => {
	it("returns the newest non-deleted row, scoped by case/type/hash", async () => {
		const applicationId = await insertApplication(db);
		const otherApp = await insertApplication(db);
		const actor = randomUUID();
		const v1 = await createArtifact(db, {
			applicationId,
			type: "credit_memo",
			content: { title: TITLE },
			citations: [],
			createdBy: actor,
			model: "test-model",
			promptVersion: "v1",
			retentionDays: 30,
			agentTrace: trace("hash-replay"),
		});
		await approveArtifact(db, { id: v1.id, actor, expectedRevision: 1 });
		const fork = await updateArtifact(db, {
			id: v1.id,
			actor,
			expectedRevision: 1,
			content: { title: `${TITLE}-v2` },
			citations: [],
			model: "test-model",
			promptVersion: "v1",
			retentionDays: 30,
		});

		// Newest version wins.
		const newest = await findArtifactByEvidence(db, {
			applicationId,
			type: "credit_memo",
			evidenceHash: "hash-replay",
		});
		expect(newest?.id).toBe(fork.artifact.id);
		expect(newest?.version).toBe(2);

		// Unknown hash, other type, other case: all miss.
		expect(
			await findArtifactByEvidence(db, {
				applicationId,
				type: "credit_memo",
				evidenceHash: "hash-nope",
			}),
		).toBeNull();
		expect(
			await findArtifactByEvidence(db, {
				applicationId,
				type: "adverse_action_letter",
				evidenceHash: "hash-replay",
			}),
		).toBeNull();
		expect(
			await findArtifactByEvidence(db, {
				applicationId: otherApp,
				type: "credit_memo",
				evidenceHash: "hash-replay",
			}),
		).toBeNull();

		// Tombstoning the newest falls back to the older non-deleted row…
		await tombstoneArtifact(db, {
			id: fork.artifact.id,
			actor,
			expectedRevision: 1,
			reason: "superseded-evidence",
		});
		const fallback = await findArtifactByEvidence(db, {
			applicationId,
			type: "credit_memo",
			evidenceHash: "hash-replay",
		});
		expect(fallback?.id).toBe(v1.id);

		// …and once all rows are deleted the lookup misses.
		await tombstoneArtifact(db, { id: v1.id, actor, expectedRevision: 1, reason: "gone" });
		expect(
			await findArtifactByEvidence(db, {
				applicationId,
				type: "credit_memo",
				evidenceHash: "hash-replay",
			}),
		).toBeNull();
		expect(await getArtifact(db, v1.id)).toMatchObject({ status: "deleted" });
	});
});

describe("supersedeDraft", () => {
	it("retires the live draft, versions forward, and audits metadata-only", async () => {
		const applicationId = await insertApplication(db);
		const actor = randomUUID();
		const input = {
			applicationId,
			type: "credit_memo" as const,
			content: { title: TITLE },
			citations: [{ ref: "evidence:doc-1", quote: QUOTE, path: "title" }],
			createdBy: actor,
			model: "test-model",
			promptVersion: "v1",
			retentionDays: 30,
		};
		const v1 = await createArtifact(db, { ...input, agentTrace: trace("hash-old") });
		expect(v1.version).toBe(1);

		// Default stays strict: a second draft without the flag still 409s.
		await expect(
			createArtifact(db, { ...input, agentTrace: trace("hash-new") }),
		).rejects.toMatchObject({ status: 409, code: "DRAFT_EXISTS" });

		const v2 = await createArtifact(db, {
			...input,
			agentTrace: trace("hash-new"),
			supersedeDraft: true,
		});
		expect(v2.version).toBe(2);
		expect(v2.status).toBe("draft");
		expect(v2.evidenceHash).toBe("hash-new");
		expect((await getArtifact(db, v1.id))?.status).toBe("superseded");

		const rows = await db.select().from(auditLog).where(eq(auditLog.applicationId, applicationId));
		const superseded = rows.find((row) => row.action === "artifact.superseded");
		expect(superseded?.payload).toMatchObject({
			artifactId: v1.id,
			supersededByVersion: 2,
		});
		for (const sentinel of [TITLE, QUOTE]) {
			expect(JSON.stringify(superseded?.payload)).not.toContain(sentinel);
		}
	});
});

describe("trace audit hygiene", () => {
	it("audit payloads carry metadata only, never content text", async () => {
		const applicationId = await insertApplication(db);
		await createArtifact(db, {
			applicationId,
			type: "credit_memo",
			content: { title: TITLE },
			citations: [{ ref: "evidence:doc-1", quote: QUOTE, path: "title" }],
			createdBy: randomUUID(),
			model: "test-model",
			promptVersion: "v1",
			retentionDays: 30,
			agentTrace: trace("hash-audit"),
		});
		const rows = await db.select().from(auditLog).where(eq(auditLog.applicationId, applicationId));
		const created = rows.find((row) => row.action === "artifact.created");
		expect(created).toBeDefined();
		const payload = JSON.stringify(created?.payload);
		expect(payload).toContain("hash-audit");
		for (const sentinel of [TITLE, QUOTE]) {
			expect(payload).not.toContain(sentinel);
		}
		expect(created?.payload).toMatchObject({ toolCallCount: 1, traceWriter: "agent" });
	});

	it("invalid trace error carries no trace content", async () => {
		const applicationId = await insertApplication(db);
		const bad = { ...trace("hash-bad"), writer: "rogue-model" };
		try {
			await createArtifact(db, {
				applicationId,
				type: "credit_memo",
				content: { title: TITLE },
				citations: [],
				createdBy: randomUUID(),
				model: "test-model",
				promptVersion: "v1",
				retentionDays: 30,
				agentTrace: bad as unknown as MemoAgentTrace,
			});
			expect.unreachable("expected ARTIFACT_TRACE_INVALID");
		} catch (err) {
			expect(err).toBeInstanceOf(HttpError);
			expect((err as HttpError).code).toBe("ARTIFACT_TRACE_INVALID");
			expect(String((err as Error).message)).not.toContain("rogue-model");
		}
	});
});
