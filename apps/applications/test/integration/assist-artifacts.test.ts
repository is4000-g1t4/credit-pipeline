// EN-02 artifact lifecycle integration (real Postgres): versioning +
// approval, concurrent-edit conflicts, DB trigger immutability,
// tombstones, one-draft uniqueness, retention holds, audit hygiene.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../../.env", import.meta.url)),
});

import { randomUUID } from "node:crypto";
import {
	auditLog,
	createDb,
	generatedArtifacts,
	type Db,
} from "@credit/db/applications";
import { HttpError } from "@credit/service-kit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	approveArtifact,
	createArtifact,
	createArtifactHold,
	getArtifact,
	listArtifacts,
	releaseArtifactHold,
	runArtifactRetention,
	tombstoneArtifact,
	updateArtifact,
} from "../../src/assist/artifacts.js";
import { insertApplication } from "../helper.js";

const TITLE = "SENTINEL-TITLE-AA101";
const BODY = "SENTINEL-BODY-BB202";
const QUOTE = "SENTINEL-QUOTE-CC303";

function content(tag: string): Record<string, unknown> {
	return { title: `${TITLE}-${tag}`, body: `${BODY}-${tag}` };
}

function citations() {
	return [{ ref: "evidence:doc-1", quote: QUOTE, path: "title" }];
}

const { db, sql } = createDb(
	process.env["APPLICATIONS_DATABASE_URL"] ??
		"postgres://credit:credit@localhost:5432/credit_applications",
);

async function draft(
	database: Db,
	applicationId: string,
	tag: string = randomUUID(),
	type: "credit_memo" | "policy_exception_memo" | "adverse_action_letter" = "credit_memo",
) {
	return createArtifact(database, {
		applicationId,
		type,
		content: content(tag),
		citations: citations(),
		createdBy: randomUUID(),
		model: "test-model",
		promptVersion: "v1",
		retentionDays: 30,
	});
}

async function auditActions(
	applicationId: string,
): Promise<Array<{ action: string; payload: unknown }>> {
	const rows = await db.select().from(auditLog).where(eq(auditLog.applicationId, applicationId));
	return rows.map((row) => ({ action: row.action, payload: row.payload }));
}

beforeAll(async () => {
	// Touch the connection early so a missing database fails fast.
	await sql`select 1`;
});

afterAll(async () => {
	await sql.end();
});

describe("versioning and approval", () => {
	it("edits bump revision, approvals supersede, edits of approved rows fork", async () => {
		const applicationId = await insertApplication(db);
		const actor = randomUUID();

		const v1 = await draft(db, applicationId);
		expect(v1.version).toBe(1);
		expect(v1.revision).toBe(1);
		expect(v1.status).toBe("draft");

		const edited = await updateArtifact(db, {
			id: v1.id,
			actor,
			expectedRevision: 1,
			content: content("edit"),
			citations: citations(),
			model: "test-model",
			promptVersion: "v2",
			retentionDays: 30,
		});
		expect(edited.createdVersion).toBe(false);
		expect(edited.artifact.version).toBe(1);
		expect(edited.artifact.revision).toBe(2);

		const approved = await approveArtifact(db, { id: v1.id, actor, expectedRevision: 2 });
		expect(approved.status).toBe("approved");
		expect(approved.approvedBy).toBe(actor);
		expect(approved.approvedAt).not.toBeNull();

		// Editing an approved row forks a new draft; the old row stays approved.
		const fork = await updateArtifact(db, {
			id: v1.id,
			actor,
			expectedRevision: 2,
			content: content("v2"),
			citations: citations(),
			model: "test-model",
			promptVersion: "v3",
			retentionDays: 30,
		});
		expect(fork.createdVersion).toBe(true);
		expect(fork.artifact.version).toBe(2);
		expect(fork.artifact.revision).toBe(1);
		expect(fork.artifact.status).toBe("draft");

		const stillApproved = await getArtifact(db, v1.id);
		expect(stillApproved?.status).toBe("approved");

		const v2 = await approveArtifact(db, { id: fork.artifact.id, actor, expectedRevision: 1 });
		expect(v2.status).toBe("approved");
		const superseded = await getArtifact(db, v1.id);
		expect(superseded?.status).toBe("superseded");

		// Newest version first.
		const all = await listArtifacts(db, applicationId);
		expect(all.map((a) => a.version)).toEqual([2, 1]);
		const memos = await listArtifacts(db, applicationId, "credit_memo");
		expect(memos).toHaveLength(2);
		expect(await listArtifacts(db, applicationId, "adverse_action_letter")).toEqual([]);
		expect(await getArtifact(db, randomUUID())).toBeNull();
	});
});

describe("optimistic concurrency", () => {
	it("concurrent edits: exactly one wins; stale approves lose", async () => {
		const applicationId = await insertApplication(db);
		const actor = randomUUID();
		const v1 = await draft(db, applicationId);

		const attempts = await Promise.allSettled(
			[1, 2].map((n) =>
				updateArtifact(db, {
					id: v1.id,
					actor,
					expectedRevision: 1,
					content: content(`race-${n}`),
					citations: citations(),
					model: "test-model",
					promptVersion: "v1",
					retentionDays: 30,
				}),
			),
		);
		const won = attempts.filter((r) => r.status === "fulfilled");
		const lost = attempts.filter((r) => r.status === "rejected");
		expect(won).toHaveLength(1);
		expect(lost).toHaveLength(1);
		const err = (lost[0] as PromiseRejectedResult).reason;
		expect(err).toBeInstanceOf(HttpError);
		expect((err as HttpError).status).toBe(409);
		expect((err as HttpError).code).toBe("VERSION_CONFLICT");

		// Winner is at revision 2; the stale approve (revision 1) must 409.
		await expect(
			approveArtifact(db, { id: v1.id, actor, expectedRevision: 1 }),
		).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
		const ok = await approveArtifact(db, { id: v1.id, actor, expectedRevision: 2 });
		expect(ok.status).toBe("approved");
	});
});

describe("immutability and tombstones", () => {
	it("approved content is frozen at the DB level and delete is terminal", async () => {
		const applicationId = await insertApplication(db);
		const actor = randomUUID();
		const v1 = await draft(db, applicationId);
		await approveArtifact(db, { id: v1.id, actor, expectedRevision: 1 });

		await expect(
			db
				.update(generatedArtifacts)
				.set({ content: { hacked: true } })
				.where(eq(generatedArtifacts.id, v1.id)),
		).rejects.toThrow();

		const tomb = await tombstoneArtifact(db, {
			id: v1.id,
			actor,
			expectedRevision: 1,
			reason: "officer-requested-removal",
		});
		expect(tomb.status).toBe("deleted");
		expect(tomb.deletedAt).not.toBeNull();

		// The row survives; the trigger makes delete terminal.
		const row = await getArtifact(db, v1.id);
		expect(row?.status).toBe("deleted");
		await expect(
			db
				.update(generatedArtifacts)
				.set({ retentionUntil: new Date() })
				.where(eq(generatedArtifacts.id, v1.id)),
		).rejects.toThrow();
	});

	it("terminal rows reject service edits; unknown rows 404", async () => {
		const applicationId = await insertApplication(db);
		const actor = randomUUID();
		const v1 = await draft(db, applicationId);
		await approveArtifact(db, { id: v1.id, actor, expectedRevision: 1 });
		await tombstoneArtifact(db, { id: v1.id, actor, expectedRevision: 1, reason: "gone" });
		await expect(
			updateArtifact(db, {
				id: v1.id,
				actor,
				expectedRevision: 1,
				content: content("late"),
				citations: citations(),
				model: "test-model",
				promptVersion: "v1",
				retentionDays: 30,
			}),
		).rejects.toMatchObject({ status: 409, code: "ARTIFACT_IMMUTABLE" });
		await expect(
			updateArtifact(db, {
				id: randomUUID(),
				actor,
				expectedRevision: 1,
				content: content("missing"),
				citations: citations(),
				model: "test-model",
				promptVersion: "v1",
				retentionDays: 30,
			}),
		).rejects.toMatchObject({ status: 404 });
	});
});

describe("one draft per case and type", () => {
	it("a second draft create 409s", async () => {
		const applicationId = await insertApplication(db);
		await draft(db, applicationId);
		await expect(draft(db, applicationId)).rejects.toMatchObject({
			status: 409,
			code: "DRAFT_EXISTS",
		});
		// A different type still gets its own draft.
		const other = await draft(db, applicationId, randomUUID(), "adverse_action_letter");
		expect(other.version).toBe(1);
	});
});

describe("holds and retention", () => {
	it("expires tombstone; active holds skip; release unblocks; rows survive", async () => {
		const applicationId = await insertApplication(db);
		const actor = randomUUID();
		const expired = await createArtifact(db, {
			applicationId,
			type: "credit_memo",
			content: content("expired"),
			citations: citations(),
			createdBy: actor,
			model: "test-model",
			promptVersion: "v1",
			retentionDays: -30,
		});
		const held = await createArtifact(db, {
			applicationId,
			type: "policy_exception_memo",
			content: content("held"),
			citations: citations(),
			createdBy: actor,
			model: "test-model",
			promptVersion: "v1",
			retentionDays: -30,
		});

		const hold = await createArtifactHold(db, {
			artifactId: held.id,
			reason: "litigation",
			createdBy: actor,
		});
		expect(hold.artifactId).toBe(held.id);
		await expect(
			createArtifactHold(db, { artifactId: randomUUID(), reason: "x", createdBy: actor }),
		).rejects.toMatchObject({ status: 404 });

		let run = await runArtifactRetention(db, {});
		expect(run.checked).toBeGreaterThanOrEqual(1);
		expect(run.deleted).toBeGreaterThanOrEqual(1);
		expect(run.skippedHolds).toBeGreaterThanOrEqual(1);
		expect((await getArtifact(db, expired.id))?.status).toBe("deleted");
		expect((await getArtifact(db, held.id))?.status).toBe("draft");

		// Wrong-artifact release 404s; the real release is idempotent.
		await expect(
			releaseArtifactHold(db, { artifactId: expired.id, holdId: hold.holdId, actor }),
		).rejects.toMatchObject({ status: 404 });
		await releaseArtifactHold(db, { artifactId: held.id, holdId: hold.holdId, actor });
		await releaseArtifactHold(db, { artifactId: held.id, holdId: hold.holdId, actor });

		run = await runArtifactRetention(db, {});
		expect((await getArtifact(db, held.id))?.status).toBe("deleted");

		// Tombstoned rows are never hard-deleted.
		const rows = await db
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.applicationId, applicationId));
		expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([expired.id, held.id]));
	});
});

describe("audit hygiene", () => {
	it("audits carry ids only, never content text", async () => {
		const applicationId = await insertApplication(db);
		const actor = randomUUID();
		const v1 = await draft(db, applicationId, "audit-tag");
		await updateArtifact(db, {
			id: v1.id,
			actor,
			expectedRevision: 1,
			content: content("audit-edit"),
			citations: citations(),
			model: "test-model",
			promptVersion: "v1",
			retentionDays: 30,
		});
		await approveArtifact(db, { id: v1.id, actor, expectedRevision: 2 });

		const audits = await auditActions(applicationId);
		const actions = audits.map((a) => a.action);
		for (const expected of ["artifact.created", "artifact.edited", "artifact.approved"]) {
			expect(actions).toContain(expected);
		}
		for (const row of audits) {
			const payload = JSON.stringify(row.payload);
			for (const sentinel of [TITLE, BODY, QUOTE]) {
				expect(payload).not.toContain(sentinel);
			}
		}
	});
});
