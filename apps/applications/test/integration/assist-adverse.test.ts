// EN-08 adverse-action route integration (real Postgres): deterministic
// letter draft from a declined decision, metadata-only audit, edit/approve
// fail-closed behavior, profile guards, and route access guards.
import { randomUUID } from "node:crypto";
import { createDb } from "@credit/db";
import {
	applications,
	auditLog,
	caseAccessGrants,
	decisions,
	externalReports,
	generatedArtifacts,
	scores,
} from "@credit/db/applications";
import { ADVERSE_JURISDICTION_PROFILES, type AdverseActionLetterContent } from "@credit/core";
import { createLogger } from "@credit/service-kit";
import { stubGateway } from "@credit/service-kit/test";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { AssistConfig } from "../../src/assist/index.js";
import { loadEnv } from "../../src/env.js";
import { createUser, signed, type TestContext, type TestUser } from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

const AS_OF = new Date("2026-06-30T00:00:00Z");
const NOW = new Date("2026-07-01T00:00:00Z");
const CONTACT_PATH = "https://example.com/contact";
const SG = ADVERSE_JURISDICTION_PROFILES.SG;

const REASONS_3 = [
	{ code: "SCORE_TOO_LOW", text: "Assessment result below the minimum." },
	{ code: "DELINQUENCIES", text: "Past payment delinquencies on record." },
	{ code: "CREDIT_UTILIZATION", text: "Credit utilization above the preferred level." },
];
const REASONS_2 = REASONS_3.slice(0, 2);

let ctx: TestContext;
let officer: TestUser;
let otherOfficer: TestUser;
let applicant: TestUser;

let appA = "";
let decisionA = "";
let appB = "";
let appC = "";
let appD = "";
let appE = "";

let artifactA = "";
let letterTexts: string[] = [];

type TestApp = ReturnType<typeof createApp>;

const noResearch = (async () => new Response("no run", { status: 404 })) as typeof fetch;

function assistConfig(over: Partial<AssistConfig> = {}): Partial<AssistConfig> {
	return {
		enabled: true,
		retentionDays: 90,
		researchUrl: "http://research.test",
		researchTimeoutMs: 2_000,
		adverseJurisdiction: "SG",
		adverseContactPath: CONTACT_PATH,
		...over,
	};
}

function variantApp(over: Partial<AssistConfig> = {}): TestApp {
	const env = loadEnv();
	return createApp({
		db: ctx.db,
		sql: ctx.sql,
		env,
		gateway: stubGateway(),
		logger: createLogger("assist-adverse-test"),
		documents: { config: { featureEnabled: true } },
		assist: {
			config: assistConfig(over),
			now: () => NOW,
			researchFetchImpl: noResearch,
		},
	});
}

async function call(
	method: string,
	path: string,
	user: TestUser,
	body?: unknown,
): Promise<Response> {
	return callOn(ctx.app, method, path, user, body);
}

async function callOn(
	app: TestApp,
	method: string,
	path: string,
	user: TestUser,
	body?: unknown,
): Promise<Response> {
	const raw = body === undefined ? undefined : JSON.stringify(body);
	const bare = path.split("?")[0] as string;
	return app.request(path, {
		method,
		headers: {
			...signed(ctx, user, method, bare, { "content-type": "application/json" }, raw),
		},
		body: raw,
	});
}

async function seedDeclinedCase(
	reasons: Array<{ code: string; text: string }>,
	snapshot: unknown = { policyVersion: "policy-v1.0", scorecardVersion: "scorecard-v1" },
): Promise<{ appId: string; decisionId: string }> {
	const [app] = await ctx.db
		.insert(applications)
		.values({
			reference: `ADV-${randomUUID().slice(0, 8)}`,
			applicantUserId: applicant.id,
			type: "sme",
			product: "sme_term_loan",
			status: "declined",
			amountCents: 6_000_000,
			termMonths: 60,
			purpose: "Cafe expansion",
			identity: {
				fullName: "Tomas Aurora",
				email: applicant.email,
				city: "Singapore",
			},
			business: {
				companyName: "Cafe Aurora",
				registrationNumber: "CAFEAUR1",
				industry: "hospitality",
				yearsTrading: 4,
				annualRevenueCents: 61_000_000,
			},
			financial: null,
			consents: [true, true, true],
			contextAnalysisConsent: true,
			documentProcessingConsent: true,
			submittedAt: AS_OF,
		})
		.returning({ id: applications.id });
	const appId = app.id;
	// Score factors use unrelated codes so the letter must cite the
	// decision-reason items, never score-factor items.
	await ctx.db.insert(scores).values({
		applicationId: appId,
		modelVersion: "scorecard-v1",
		score: 520,
		grade: "D",
		factors: [
			{ code: "SECTOR_RISK", label: "Sector risk", points: -40, impact: "negative" },
			{ code: "REVENUE_SCALE", label: "Revenue scale", points: 75, impact: "positive" },
		],
		affordability: {},
	});
	await ctx.db.insert(externalReports).values({
		applicationId: appId,
		provider: "mock-bureau-v1",
		kind: "bureau",
		version: "mock-bureau-v1",
		payload: { bureauScore: 520, delinquencies: 3, utilizationPct: 88, inquiries6m: 5 },
	});
	const [decision] = await ctx.db
		.insert(decisions)
		.values({
			applicationId: appId,
			outcome: "declined",
			decidedBy: "system",
			reasons,
			snapshot,
		})
		.returning({ id: decisions.id });
	await ctx.db.insert(caseAccessGrants).values({
		applicationId: appId,
		userId: officer.id,
		accessRole: "assigned_officer",
		grantedBy: officer.id,
	});
	return { appId, decisionId: decision.id };
}

async function seedPendingCase(): Promise<string> {
	const [app] = await ctx.db
		.insert(applications)
		.values({
			reference: `ADV-${randomUUID().slice(0, 8)}`,
			applicantUserId: applicant.id,
			type: "sme",
			product: "sme_term_loan",
			status: "pending_review",
			amountCents: 6_000_000,
			termMonths: 60,
			purpose: "Cafe expansion",
			identity: { fullName: "Tomas Aurora", email: applicant.email, city: "Singapore" },
			business: { companyName: "Cafe Aurora", industry: "hospitality", yearsTrading: 4 },
			financial: null,
			consents: [true, true, true],
			submittedAt: AS_OF,
		})
		.returning({ id: applications.id });
	await ctx.db.insert(caseAccessGrants).values({
		applicationId: app.id,
		userId: officer.id,
		accessRole: "assigned_officer",
		grantedBy: officer.id,
	});
	return app.id;
}

beforeAll(async () => {
	const env = loadEnv();
	const { db, sql } = createDb(env.databaseUrl);
	ctx = {
		app: createApp({
			db,
			sql,
			env,
			gateway: stubGateway(),
			logger: createLogger("assist-adverse-test"),
			documents: { config: { featureEnabled: true } },
			assist: {
				config: assistConfig(),
				now: () => NOW,
				researchFetchImpl: noResearch,
			},
		}),
		db,
		sql,
		gateway: stubGateway(),
		secret: env.internalSecret,
	};
	officer = await createUser(ctx, "officer");
	otherOfficer = await createUser(ctx, "officer");
	applicant = await createUser(ctx, "applicant");

	({ appId: appA, decisionId: decisionA } = await seedDeclinedCase(REASONS_3));
	({ appId: appB } = await seedDeclinedCase(REASONS_3));
	({ appId: appC } = await seedDeclinedCase(REASONS_3));
	({ appId: appD } = await seedDeclinedCase(REASONS_2));
	appE = await seedPendingCase();
});

afterAll(async () => {
	await ctx.sql.end();
});

describe("adverse-action happy path", () => {
	it("drafts a cited SG letter from the declined decision", async () => {
		const res = await call("POST", `/api/assist/cases/${appA}/adverse-action`, officer);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			artifact: {
				id: string;
				type: string;
				status: string;
				version: number;
				revision: number;
				content: AdverseActionLetterContent;
			};
			principalReasons: Array<{ code: string }>;
			decisionId: string;
			jurisdiction: string;
			profileVersion: string;
		};
		expect(body.artifact.type).toBe("adverse_action_letter");
		expect(body.artifact.status).toBe("draft");
		expect(body.artifact.version).toBe(1);
		const content = body.artifact.content;
		expect(content.applicantName).toBe("Cafe Aurora");
		expect(content.decisionId).toBe(decisionA);
		expect(content.jurisdiction).toBe("SG");
		expect(content.profileVersion).toBe("sg-feat-v2");
		expect(content.decision).toBe("not_successful");
		expect(content.principalReasons).toHaveLength(3);
		expect(content.principalReasons.map((reason) => reason.code)).toEqual(
			REASONS_3.map((reason) => reason.code),
		);
		for (const reason of content.principalReasons) {
			expect(reason.citations.length).toBeGreaterThanOrEqual(1);
			expect(reason.citations[0]?.ref).toBe(`score_reason:${decisionA}:${reason.code}`);
			expect(reason.citations[0]?.quote).toBe(reason.code);
			if (reason.code === "DELINQUENCIES") {
				expect(
					reason.citations.some((citation) => citation.ref.includes("bureau.delinquencies")),
				).toBe(true);
			}
			if (reason.code === "CREDIT_UTILIZATION") {
				expect(
					reason.citations.some((citation) => citation.ref.includes("bureau.utilizationPct")),
				).toBe(true);
			}
		}
		expect(content.notices).toEqual(SG.disclosures.map((notice) => notice.text));
		expect(content.contactPath).toBe(CONTACT_PATH);
		expect(body.principalReasons).toHaveLength(3);
		expect(body.decisionId).toBe(decisionA);
		expect(body.jurisdiction).toBe("SG");
		expect(body.profileVersion).toBe("sg-feat-v2");
		artifactA = body.artifact.id;
		letterTexts = content.principalReasons.map((reason) => reason.text);
	});

	it("writes a metadata-only audit row for the draft", async () => {
		const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appA));
		const created = rows.find(
			(row) =>
				row.action === "artifact.created" &&
				(row.payload as Record<string, unknown>)["type"] === "adverse_action_letter",
		);
		expect(created).toBeDefined();
		const payload = created?.payload as Record<string, unknown>;
		expect(payload).toMatchObject({
			feature: "assist",
			decisionId: decisionA,
			reasonCodes: REASONS_3.map((reason) => reason.code),
			jurisdiction: "SG",
			profileVersion: "sg-feat-v2",
			legalReviewRef: SG.legalReview.reference,
			profileWordingHash: SG.wordingHash,
			taxonomyVersion: "adverse-taxonomy-v2",
			policyVersion: "policy-v1.0",
			scorecardVersion: "scorecard-v1",
			fairLendingScan: "passed",
			fairLendingDenyListVersion: "fair-lending-v1",
			droppedReasonCodes: [],
		});
		const citationRefs = payload["citationRefs"] as unknown;
		expect(Array.isArray(citationRefs)).toBe(true);
		expect(citationRefs).toHaveLength(5);
		for (const ref of citationRefs as string[]) {
			expect(ref.startsWith("score_reason:") || ref.startsWith("case_fact:")).toBe(true);
		}
		const text = JSON.stringify(payload);
		expect(text).not.toContain("Cafe Aurora");
		expect(text).not.toContain("Notice of credit outcome");
		for (const reasonText of letterTexts) {
			expect(text).not.toContain(reasonText);
		}
	});

	it("approves the draft, then a further edit versions with supersede on approval", async () => {
		const approve = await call("POST", `/api/assist/artifacts/${artifactA}/approve`, officer, {
			expectedRevision: 1,
			confirm: true,
		});
		expect(approve.status).toBe(200);
		const approved = (await approve.json()) as { artifact: { status: string } };
		expect(approved.artifact.status).toBe("approved");
		const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appA));
		const approvedAudit = audit.find((row) => row.action === "artifact.approved");
		expect(approvedAudit).toBeDefined();
		if (!approvedAudit) throw new Error("expected approval audit");
		expect(approvedAudit.payload).toMatchObject({
			decisionId: decisionA,
			reasonCodes: REASONS_3.map((reason) => reason.code),
			jurisdiction: "SG",
			profileVersion: "sg-feat-v2",
			legalReviewRef: SG.legalReview.reference,
			fairLendingScan: "passed",
			fairLendingDenyListVersion: "fair-lending-v1",
			profileWordingHash: SG.wordingHash,
			taxonomyVersion: "adverse-taxonomy-v2",
			policyVersion: "policy-v1.0",
			scorecardVersion: "scorecard-v1",
			droppedReasonCodes: [],
		});

		const get = await call("GET", `/api/assist/artifacts/${artifactA}`, officer);
		expect(get.status).toBe(200);
		const stored = (await get.json()) as {
			artifact: { revision: number; content: AdverseActionLetterContent };
		};
		const edit = await call("PATCH", `/api/assist/artifacts/${artifactA}`, officer, {
			expectedRevision: stored.artifact.revision,
			content: stored.artifact.content,
		});
		expect(edit.status).toBe(200);
		const v2 = (await edit.json()) as {
			artifact: { id: string; status: string; version: number; revision: number };
			createdVersion: boolean;
		};
		expect(v2.createdVersion).toBe(true);
		expect(v2.artifact.status).toBe("draft");
		expect(v2.artifact.version).toBe(2);

		// The source keeps v1 approved until v2 is approved (same lifecycle
		// as credit memos); approving v2 then supersedes v1.
		const approveV2 = await call(
			"POST",
			`/api/assist/artifacts/${v2.artifact.id}/approve`,
			officer,
			{ expectedRevision: v2.artifact.revision, confirm: true },
		);
		expect(approveV2.status).toBe(200);
		const rows = await ctx.db
			.select()
			.from(generatedArtifacts)
			.where(
				and(
					eq(generatedArtifacts.applicationId, appA),
					eq(generatedArtifacts.type, "adverse_action_letter"),
				),
			);
		expect(new Map(rows.map((row) => [row.version, row.status])).get(1)).toBe("superseded");
		expect(new Map(rows.map((row) => [row.version, row.status])).get(2)).toBe("approved");
	});
});

describe("adverse-action edit/approve guards", () => {
	let artifactB = "";

	it("drafts the second case", async () => {
		const res = await call("POST", `/api/assist/cases/${appB}/adverse-action`, officer);
		expect(res.status).toBe(201);
		artifactB = ((await res.json()) as { artifact: { id: string } }).artifact.id;
	});

	it("blocks a protected-attribute edit and audits it", async () => {
		const get = await call("GET", `/api/assist/artifacts/${artifactB}`, officer);
		const stored = (await get.json()) as {
			artifact: { revision: number; content: AdverseActionLetterContent };
		};
		const edited: AdverseActionLetterContent = {
			...stored.artifact.content,
			principalReasons: stored.artifact.content.principalReasons.map((reason, index) =>
				index === 0 ? { ...reason, text: "Applicant age is 40." } : reason,
			),
		};
		const patch = await call("PATCH", `/api/assist/artifacts/${artifactB}`, officer, {
			expectedRevision: stored.artifact.revision,
			content: edited,
		});
		expect(patch.status).toBe(422);
		const body = (await patch.json()) as {
			error: { code: string; issues: Array<{ code: string }> };
		};
		expect(body.error.code).toBe("GENERATED_TEXT_INVALID");
		expect(body.error.issues.map((issue) => issue.code)).toContain("PROTECTED_ATTRIBUTE");
		const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appB));
		const blocked = rows.find((row) => row.action === "artifact.edit_blocked");
		expect(blocked).toBeDefined();
		if (!blocked) throw new Error("expected an audit row");
		expect(
			((blocked.payload as Record<string, unknown>)["issueCodes"] as string[]).some((code) =>
				code.includes("PROTECTED_ATTRIBUTE"),
			),
		).toBe(true);
	});

	it("blocks approval of stored invalid text and audits it", async () => {
		const rows = await ctx.db
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.id, artifactB));
		const content = rows[0]?.content as AdverseActionLetterContent;
		const tampered: AdverseActionLetterContent = {
			...content,
			principalReasons: content.principalReasons.map((reason, index) =>
				index === 0 ? { ...reason, text: "Applicant age is 40." } : reason,
			),
		};
		await ctx.db
			.update(generatedArtifacts)
			.set({ content: tampered })
			.where(eq(generatedArtifacts.id, artifactB));
		const approve = await call("POST", `/api/assist/artifacts/${artifactB}/approve`, officer, {
			expectedRevision: 1,
			confirm: true,
		});
		expect(approve.status).toBe(422);
		const body = (await approve.json()) as {
			error: { code: string; issues: Array<{ code: string }> };
		};
		expect(body.error.code).toBe("GENERATED_TEXT_INVALID");
		expect(body.error.issues.map((issue) => issue.code)).toContain("PROTECTED_ATTRIBUTE");
		const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appB));
		expect(audit.some((row) => row.action === "artifact.approve_blocked")).toBe(true);
	});
});

describe("adverse-action profile guard", () => {
	it("rejects approval when a required notice is missing", async () => {
		const drafted = await call("POST", `/api/assist/cases/${appC}/adverse-action`, officer);
		expect(drafted.status).toBe(201);
		const id = ((await drafted.json()) as { artifact: { id: string } }).artifact.id;
		const rows = await ctx.db
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.id, id));
		const content = rows[0]?.content as AdverseActionLetterContent;
		await ctx.db
			.update(generatedArtifacts)
			.set({ content: { ...content, notices: content.notices.slice(0, -1) } })
			.where(eq(generatedArtifacts.id, id));
		const approve = await call("POST", `/api/assist/artifacts/${id}/approve`, officer, {
			expectedRevision: 1,
			confirm: true,
		});
		expect(approve.status).toBe(422);
		const body = (await approve.json()) as {
			error: { code: string; issues: Array<{ code: string }> };
		};
		expect(body.error.code).toBe("ADVERSE_PROFILE_INVALID");
		expect(body.error.issues.map((issue) => issue.code)).toContain("DISCLOSURE_MISSING");
	});
});

describe("adverse-action provenance guards", () => {
	it("rejects a forged decision id or a reason outside the decision", async () => {
		const { appId } = await seedDeclinedCase(REASONS_3);
		const drafted = await call("POST", `/api/assist/cases/${appId}/adverse-action`, officer);
		expect(drafted.status).toBe(201);
		const id = ((await drafted.json()) as { artifact: { id: string } }).artifact.id;
		const get = await call("GET", `/api/assist/artifacts/${id}`, officer);
		const stored = (await get.json()) as {
			artifact: { revision: number; content: AdverseActionLetterContent };
		};
		const forgedId: AdverseActionLetterContent = {
			...stored.artifact.content,
			decisionId: randomUUID(),
		};
		const idPatch = await call("PATCH", `/api/assist/artifacts/${id}`, officer, {
			expectedRevision: stored.artifact.revision,
			content: forgedId,
		});
		expect(idPatch.status).toBe(422);
		const idBody = (await idPatch.json()) as {
			error: { code: string; issues: Array<{ code: string }> };
		};
		expect(idBody.error.code).toBe("ADVERSE_DECISION_MISMATCH");
		expect(idBody.error.issues.map((issue) => issue.code)).toContain("DECISION_ID_MISMATCH");

		const inventedReason = structuredClone(stored.artifact.content);
		inventedReason.principalReasons[0] = {
			...inventedReason.principalReasons[0]!,
			code: "SECTOR_RISK",
		};
		const reasonPatch = await call("PATCH", `/api/assist/artifacts/${id}`, officer, {
			expectedRevision: stored.artifact.revision,
			content: inventedReason,
		});
		expect(reasonPatch.status).toBe(422);
		const reasonBody = (await reasonPatch.json()) as {
			error: { code: string; issues: Array<{ code: string }> };
		};
		expect(reasonBody.error.code).toBe("ADVERSE_DECISION_MISMATCH");
		expect(reasonBody.error.issues.map((issue) => issue.code)).toContain(
			"REASON_CODE_NOT_IN_DECISION",
		);

		const forgedText = structuredClone(stored.artifact.content);
		forgedText.principalReasons[0]!.text = "Recent gambling activity affected the outcome.";
		const textPatch = await call("PATCH", `/api/assist/artifacts/${id}`, officer, {
			expectedRevision: stored.artifact.revision,
			content: forgedText,
		});
		expect(textPatch.status).toBe(422);
		const textBody = (await textPatch.json()) as {
			error: { code: string; issues: Array<{ code: string }> };
		};
		expect(textBody.error.code).toBe("ADVERSE_DECISION_MISMATCH");
		expect(textBody.error.issues.map((issue) => issue.code)).toContain("REASON_TEXT_MISMATCH");
		const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appId));
		expect(audit.filter((row) => row.action === "artifact.edit_blocked").length).toBeGreaterThan(1);
	});

	it("rejects a citation that is not the matching decision reason", async () => {
		const { appId, decisionId } = await seedDeclinedCase(REASONS_3);
		const drafted = await call("POST", `/api/assist/cases/${appId}/adverse-action`, officer);
		const id = ((await drafted.json()) as { artifact: { id: string } }).artifact.id;
		const get = await call("GET", `/api/assist/artifacts/${id}`, officer);
		const stored = (await get.json()) as {
			artifact: { revision: number; content: AdverseActionLetterContent };
		};
		const content = structuredClone(stored.artifact.content);
		content.principalReasons[0]!.citations[0] = {
			ref: `score_reason:${decisionId}:DELINQUENCIES`,
			quote: "DELINQUENCIES",
		};
		const patch = await call("PATCH", `/api/assist/artifacts/${id}`, officer, {
			expectedRevision: stored.artifact.revision,
			content,
		});
		expect(patch.status).toBe(422);
		const body = (await patch.json()) as {
			error: { code: string; issues: Array<{ code: string }> };
		};
		expect(body.error.code).toBe("ADVERSE_DECISION_MISMATCH");
		expect(body.error.issues.map((issue) => issue.code)).toContain("CITATION_NOT_DECISION_REASON");
	});

	it("rejects a changed contact path, title, or an extra notice", async () => {
		const { appId } = await seedDeclinedCase(REASONS_3);
		const drafted = await call("POST", `/api/assist/cases/${appId}/adverse-action`, officer);
		const id = ((await drafted.json()) as { artifact: { id: string } }).artifact.id;
		const get = await call("GET", `/api/assist/artifacts/${id}`, officer);
		const stored = (await get.json()) as {
			artifact: { revision: number; content: AdverseActionLetterContent };
		};
		const changedContact: AdverseActionLetterContent = {
			...stored.artifact.content,
			contactPath: "https://evil.example/contact",
		};
		const contactPatch = await call("PATCH", `/api/assist/artifacts/${id}`, officer, {
			expectedRevision: stored.artifact.revision,
			content: changedContact,
		});
		expect(contactPatch.status).toBe(422);
		const contactBody = (await contactPatch.json()) as {
			error: { code: string; issues: Array<{ code: string }> };
		};
		expect(contactBody.error.code).toBe("ADVERSE_DECISION_MISMATCH");
		expect(contactBody.error.issues.map((issue) => issue.code)).toContain("CONTACT_PATH_MISMATCH");

		const extraNotice: AdverseActionLetterContent = {
			...stored.artifact.content,
			notices: [...stored.artifact.content.notices, "Your application has been approved."],
		};
		const noticePatch = await call("PATCH", `/api/assist/artifacts/${id}`, officer, {
			expectedRevision: stored.artifact.revision,
			content: extraNotice,
		});
		expect(noticePatch.status).toBe(422);
		const noticeBody = (await noticePatch.json()) as {
			error: { code: string; issues: Array<{ code: string }> };
		};
		expect(noticeBody.error.code).toBe("ADVERSE_PROFILE_INVALID");
		expect(noticeBody.error.issues.map((issue) => issue.code)).toContain("NOTICE_MISMATCH");

		const changedTitle: AdverseActionLetterContent = {
			...stored.artifact.content,
			title: "Changed title",
		};
		const titlePatch = await call("PATCH", `/api/assist/artifacts/${id}`, officer, {
			expectedRevision: stored.artifact.revision,
			content: changedTitle,
		});
		expect(titlePatch.status).toBe(422);
		const titleBody = (await titlePatch.json()) as {
			error: { code: string; issues: Array<{ code: string }> };
		};
		expect(titleBody.error.code).toBe("ADVERSE_PROFILE_INVALID");
		expect(titleBody.error.issues.map((issue) => issue.code)).toContain("TITLE_MISMATCH");
	});

	it("uses negative snapshot factors to complete an officer decline", async () => {
		const { appId } = await seedDeclinedCase(
			[{ code: "OFFICER_JUDGEMENT", text: "Officer judgement" }],
			{
				factors: [
					{ code: "DELINQUENCIES", label: "Delinquencies", points: -80, impact: "negative" },
					{
						code: "CREDIT_UTILIZATION",
						label: "Credit utilization",
						points: -20,
						impact: "negative",
					},
				],
			},
		);
		const res = await call("POST", `/api/assist/cases/${appId}/adverse-action`, officer);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			artifact: { content: AdverseActionLetterContent };
		};
		expect(body.artifact.content.principalReasons.map((reason) => reason.code)).toEqual([
			"DELINQUENCIES",
			"CREDIT_UTILIZATION",
			"OFFICER_JUDGEMENT",
		]);
	});

	it("audits a generation blocked by the fair-lending input scan", async () => {
		const { appId } = await seedDeclinedCase([
			{ code: "SCORE_TOO_LOW", text: "Applicant age is 40." },
			{ code: "DELINQUENCIES", text: "Delinquencies" },
			{ code: "CREDIT_UTILIZATION", text: "Credit utilization" },
		]);
		const res = await call("POST", `/api/assist/cases/${appId}/adverse-action`, officer);
		expect(res.status).toBe(422);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"FAIR_LENDING_BLOCKED",
		);
		const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appId));
		const blocked = rows.find((row) => row.action === "artifact.generate_blocked");
		expect(blocked).toBeDefined();
		if (!blocked) throw new Error("expected a generation-blocked audit row");
		const payload = blocked.payload as Record<string, unknown>;
		expect(payload).toMatchObject({
			failureCode: "FAIR_LENDING_BLOCKED",
			jurisdiction: "SG",
			profileVersion: "sg-feat-v2",
		});
		expect(JSON.stringify(payload)).not.toContain("Applicant age is 40");
	});
});

describe("adverse-action route guards", () => {
	it("denies applicants and hides assigned cases from other officers", async () => {
		const applicantRes = await call("POST", `/api/assist/cases/${appA}/adverse-action`, applicant);
		expect(applicantRes.status).toBe(403);
		const otherRes = await call("POST", `/api/assist/cases/${appA}/adverse-action`, otherOfficer);
		expect(otherRes.status).toBe(404);
	});

	it("returns 404 for the adverse route when the flag is off", async () => {
		const off = variantApp({ enabled: false });
		const res = await callOn(off, "POST", `/api/assist/cases/${appA}/adverse-action`, officer);
		expect(res.status).toBe(404);
	});

	it("rejects a case without a declined decision", async () => {
		const res = await call("POST", `/api/assist/cases/${appE}/adverse-action`, officer);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"CASE_NOT_DECLINED",
		);
	});

	it("rejects an unsupported jurisdiction", async () => {
		const unsupported = variantApp({ adverseJurisdiction: "XX" });
		const res = await callOn(
			unsupported,
			"POST",
			`/api/assist/cases/${appD}/adverse-action`,
			officer,
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"JURISDICTION_UNSUPPORTED",
		);
	});

	it("fails closed when the contact path is missing", async () => {
		const noContact = variantApp({ adverseContactPath: "" });
		const res = await callOn(
			noContact,
			"POST",
			`/api/assist/cases/${appD}/adverse-action`,
			officer,
		);
		expect(res.status).toBe(422);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"DISCLOSURE_UNAVAILABLE",
		);
	});

	it("fails closed on insufficient decision reasons", async () => {
		const res = await call("POST", `/api/assist/cases/${appD}/adverse-action`, officer);
		expect(res.status).toBe(422);
		const body = (await res.json()) as {
			error: {
				code: string;
				details: { reasonCodes: string[]; requiredMin: number | null };
			};
		};
		expect(body.error.code).toBe("NEEDS_OFFICER_INPUT");
		expect(body.error.details.reasonCodes).toHaveLength(2);
		expect(body.error.details.requiredMin).toBe(3);
	});

	it("rejects generic artifact creation for adverse letters", async () => {
		const res = await call("POST", `/api/assist/cases/${appE}/artifacts`, officer, {
			type: "adverse_action_letter",
			content: {},
		});
		expect(res.status).toBe(422);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"DEDICATED_ROUTE_REQUIRED",
		);
	});

	it("rejects a second draft while one is active", async () => {
		// Case B still holds an active draft (its approval was blocked above).
		const res = await call("POST", `/api/assist/cases/${appB}/adverse-action`, officer);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DRAFT_EXISTS");
	});
});
