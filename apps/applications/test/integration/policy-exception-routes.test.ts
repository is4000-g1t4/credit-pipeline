// E3 policy-exception route integration (real Postgres): flag gating,
// case access, view/explain/follow-up/memo, replay, edit/approve, generic
// create rejection, terminal 409, source-down 503, audit hygiene,
// documentDerived access, 7-year retention, and approved tombstone block.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { randomUUID } from "node:crypto";
import { createDb } from "@credit/db";
import {
	applications,
	auditLog,
	caseAccessGrants,
	policyEvaluations,
} from "@credit/db/applications";
import { hashQuote, sourceRefKey } from "@credit/core";
import { createLogger } from "@credit/service-kit";
import { stubGateway } from "@credit/service-kit/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createArtifact } from "../../src/assist/artifacts.js";
import type { PolicySectionDelivery } from "../../src/assist/policy-exception/types.js";
import { loadEnv } from "../../src/env.js";
import { createUser, signed, type TestContext, type TestUser } from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

const POLICY_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

const BODY_91 =
	"Individual automatic-processing bands apply to amounts from S$1,000 to S$25,000 with assessment values recorded for the file.";
const QUOTE_A = "amounts from S$1,000 to S$25,000 with assessment values";
const BODY_12 =
	"Scores from 580 to 649 may proceed with a 25% exposure reduction and dual sign-off recorded for the file.";
const QUOTE_B = "may proceed with a 25% exposure reduction and dual sign-off";
const BODY_21 =
	"Total debt servicing ratio above 50% is reviewed, with a hard cap of 55% recorded for the file.";
const QUOTE_D = "is reviewed, with a hard cap of 55% recorded";
const BODY_53 =
	"Standard mitigants are a 50 basis point uplift with a 20% exposure reduction recorded for the file.";
const QUOTE_E = "a 50 basis point uplift with a 20% exposure reduction";
const BODY_51 =
	"Exceptions require dual sign-off with a regularisation plan of up to 12 months recorded for the file.";
const QUOTE_C = "require dual sign-off with a regularisation plan of up to 12 months";

function section(
	policyKey: string,
	sectionId: string,
	heading: string,
	body: string,
): PolicySectionDelivery {
	return {
		policyId: POLICY_ID,
		policyVersionId: VERSION_ID,
		policyKey,
		sectionId,
		version: "v1",
		heading,
		body,
		truncated: false,
		effectiveFrom: "2026-01-01",
		effectiveTo: null,
		contentHash: "0123456789abcdef0123456789abcdef",
		quoteHash: hashQuote(body),
		drawerToken: `drawer-${policyKey}-${sectionId}`,
	};
}

const SECTIONS = [
	section("POL-CR-009", "9.1", "Individual bands", BODY_91),
	section("POL-CR-002", "2.1", "Servicing cap", BODY_21),
	section("POL-CR-005", "5.3", "Mitigants", BODY_53),
	section("POL-CR-005", "5.1", "Exception route", BODY_51),
];

const fakePolicyClient = {
	resolveSections: async (input: { refs: Array<{ policyKey: string; sectionId: string }> }) => {
		const known = new Map(SECTIONS.map((s) => [`${s.policyKey}#${s.sectionId}`, s]));
		const sections = [];
		const missing = [];
		for (const ref of input.refs) {
			const found = known.get(`${ref.policyKey}#${ref.sectionId}`);
			if (found) sections.push(found);
			else
				missing.push({
					policyKey: ref.policyKey,
					sectionId: ref.sectionId,
					reason: "not_found" as const,
				});
		}
		return {
			status: (missing.length > 0 ? "partial" : "ok") as "ok" | "partial",
			sections,
			missing,
		};
	},
	searchSections: async () => ({ status: "ok" as const, sections: SECTIONS, missing: [] }),
};

function policyEvidenceRef(s: PolicySectionDelivery): string {
	return sourceRefKey({
		type: "policy_section",
		policyKey: s.policyKey,
		policyVersionId: s.policyVersionId,
		sectionId: s.sectionId,
		quoteHash: s.quoteHash,
	});
}

const [S91, S21, S53, S51] = SECTIONS as [
	PolicySectionDelivery,
	PolicySectionDelivery,
	PolicySectionDelivery,
	PolicySectionDelivery,
];

function explainDraft(): string {
	return JSON.stringify({
		status: "succeeded",
		rules: [
			{
				ruleId: "PL-DTI-HIGH",
				segments: [
					{
						text: "The servicing ratio is recorded above the automatic band for PL-DTI-HIGH.",
						citationIndexes: [0],
					},
				],
				citations: [{ policyKey: "POL-CR-009", sectionId: "9.1", quote: QUOTE_A }],
				confidence: "medium",
			},
		],
		limitations: [],
	});
}

function followupDraft(): string {
	return JSON.stringify({
		status: "succeeded",
		segments: [
			{
				text: "The servicing ratio is recorded above the automatic band.",
				citationIndexes: [0],
			},
		],
		citations: [{ policyKey: "POL-CR-009", sectionId: "9.1", quote: QUOTE_A }],
		limitations: [],
	});
}

function memoDraft(): string {
	return JSON.stringify({
		title: "Policy exception memo draft",
		sections: [
			{
				key: "rule_breached",
				title: "Rule breached",
				claims: [
					{
						text: "The servicing ratio is recorded above the automatic band for PL-DTI-HIGH.",
						citations: [{ ref: policyEvidenceRef(S91!), quote: QUOTE_A }],
					},
				],
				notAvailable: false,
			},
			{
				key: "compensating_factors",
				title: "Compensating factors",
				claims: [
					{
						text: "The file shows steady repayment capacity for the period.",
						citations: [{ ref: policyEvidenceRef(S21!), quote: QUOTE_D }],
					},
				],
				notAvailable: false,
			},
			{
				key: "mitigants",
				title: "Mitigants",
				claims: [
					{
						text: "A 20% exposure reduction is recorded with dual sign-off.",
						citations: [{ ref: policyEvidenceRef(S53!), quote: QUOTE_E }],
					},
				],
				notAvailable: false,
			},
			{
				key: "regularisation_plan",
				title: "Regularisation plan",
				claims: [
					{
						text: "A regularisation plan of up to 12 months is recorded.",
						citations: [{ ref: policyEvidenceRef(S51!), quote: QUOTE_C }],
					},
				],
				notAvailable: false,
			},
		],
		openItems: [],
	});
}

function scriptedRunner() {
	return {
		async run(input: { mode: string }): Promise<{
			rawOutput: string;
			toolCalls: Array<{ step: number; name: string; resultCount: number; sourceTypes: string[] }>;
			sourceRefs: string[];
			policySections: PolicySectionDelivery[];
			steps: number;
			usage: { inputTokens: number; outputTokens: number; costUsd: number };
		}> {
			const rawOutput =
				input.mode === "memo"
					? memoDraft()
					: input.mode === "followup"
						? followupDraft()
						: explainDraft();
			return {
				rawOutput,
				toolCalls: [
					{ step: 1, name: "list_failed_rules", resultCount: 1, sourceTypes: [] },
					{ step: 2, name: "get_exception_path", resultCount: 1, sourceTypes: [] },
					{
						step: 3,
						name: "search_policy",
						resultCount: SECTIONS.length,
						sourceTypes: ["policy_section"],
					},
					{ step: 4, name: "get_policy_section", resultCount: 1, sourceTypes: ["policy_section"] },
				],
				sourceRefs: SECTIONS.map(policyEvidenceRef),
				policySections: SECTIONS,
				steps: 5,
				usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.001 },
			};
		},
	};
}

const DTI_INPUTS = {
	kind: "individual",
	score: 700,
	existingDebtCents: 160_000,
	monthlyIncomeCents: 500_000,
	newPaymentCents: 100_000,
	amountCents: 1_200_000,
	termMonths: 48,
	employmentYears: 6,
} as const;

const SME_REFER_INPUTS = {
	kind: "sme",
	blendedScore: 720,
	monthlyFcfCents: 200_000,
	existingDebtServiceCents: 0,
	newPaymentCents: 100_000,
	amountCents: 1_000_000,
	termMonths: 36,
	yearsTrading: 1.5,
	annualRevenueCents: 30_000_000,
	industry: "retail",
} as const;

/** Clean auto-processing SME inputs; used to isolate an unknown reason code. */
const SME_CLEAN_INPUTS = {
	kind: "sme",
	blendedScore: 750,
	monthlyFcfCents: 1_500_000,
	existingDebtServiceCents: 0,
	newPaymentCents: 1_000_000,
	amountCents: 1_000_000,
	termMonths: 36,
	yearsTrading: 4,
	annualRevenueCents: 50_000_000,
	industry: "services",
} as const;

let ctx: TestContext;
let ctxNoClient: TestContext;
let ctxFlagOff: TestContext;
let officer: TestUser;
let otherOfficer: TestUser;
let applicant: TestUser;
let service: TestUser;
let appId: string;
let unmappedAppId: string;
let terminalAppId: string;

async function seedApp(
	status: "pending_review" | "declined",
	product: "personal_loan" | "sme_term_loan",
	amountCents: number,
	business: unknown = {},
): Promise<string> {
	const [row] = await ctx.db
		.insert(applications)
		.values({
			reference: `POL-${randomUUID().slice(0, 8)}`,
			applicantUserId: applicant.id,
			type: product === "sme_term_loan" ? "sme" : "individual",
			product,
			status,
			amountCents,
			termMonths: product === "sme_term_loan" ? 36 : 48,
			purpose: "policy exception test",
			identity: { fullName: "Policy Tester" },
			business,
			consents: [true, true, true],
			submittedAt: new Date("2026-06-30T00:00:00Z"),
		})
		.returning({ id: applications.id });
	return row.id;
}

async function seedEvaluation(
	applicationId: string,
	outcome: string,
	reasons: Array<{ code: string }>,
	inputs: unknown,
): Promise<void> {
	await ctx.db.insert(policyEvaluations).values({
		applicationId,
		policyVersion: "policy-v1.0",
		outcome,
		reasons,
		maxAmountCents: 1_200_000,
		inputs,
		inputHash: "hash",
		evaluatedAt: new Date("2026-06-30T10:00:00Z"),
	});
}

async function call(
	use: TestContext,
	method: string,
	path: string,
	user: TestUser,
	body?: unknown,
): Promise<Response> {
	const raw = body === undefined ? undefined : JSON.stringify(body);
	const bare = path.split("?")[0] as string;
	return use.app.request(path, {
		method,
		headers: {
			...signed(use, user, method, bare, { "content-type": "application/json" }, raw),
		},
		body: raw,
	});
}

function baseAssistConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		enabled: true,
		policyExceptionEnabled: true,
		policyExceptionRetentionDays: 2555,
		policyExceptionModel: "test-model",
		policyExceptionPromptVersion: "policy-exception-v1",
		policyExceptionAgentVersion: "policy-exception-agent-v1",
		policyExceptionValidatorVersion: "policy-exception-validator-v1",
		policyExceptionMaxSteps: 24,
		policyExceptionMaxToolCalls: 32,
		policyExceptionTimeoutMs: 30_000,
		policyExceptionMaxCostUsd: 0.25,
		policyExceptionMaxOutputTokens: 4000,
		policyExceptionRatePerMin: 10,
		policyUrl: "http://policy.test",
		policyInternalSecret: "0123456789abcdef0123456789abcdef",
		policyRuleContextSecret: "0123456789abcdef0123456789abcdef",
		policyAuditHashSecret: "0123456789abcdef0123456789abcdef",
		policyTimeoutMs: 5000,
		researchUrl: null,
		...over,
	};
}

beforeAll(async () => {
	const env = loadEnv();
	const { db, sql } = createDb(env.databaseUrl);
	const gateway = stubGateway();
	const makeApp = (assist: Record<string, unknown>) =>
		createApp({
			db,
			sql,
			env,
			gateway,
			logger: createLogger("policy-exception-test"),
			assist: assist as never,
		});
	ctx = {
		app: makeApp({
			config: baseAssistConfig(),
			policyClient: fakePolicyClient,
			policyExceptionAgentRunner: scriptedRunner(),
			now: () => new Date("2026-07-01T00:00:00Z"),
		}),
		db,
		sql,
		gateway,
		secret: env.internalSecret,
	};
	ctxNoClient = {
		app: makeApp({
			config: baseAssistConfig(),
			policyExceptionAgentRunner: scriptedRunner(),
			now: () => new Date("2026-07-01T00:00:00Z"),
		}),
		db,
		sql,
		gateway,
		secret: env.internalSecret,
	};
	ctxFlagOff = {
		app: makeApp({ config: baseAssistConfig({ policyExceptionEnabled: false }) }),
		db,
		sql,
		gateway,
		secret: env.internalSecret,
	};
	officer = await createUser(ctx, "officer");
	otherOfficer = await createUser(ctx, "officer");
	applicant = await createUser(ctx, "applicant");
	service = await createUser(ctx, "service");

	appId = await seedApp("pending_review", "personal_loan", 1_200_000);
	await seedEvaluation(appId, "decline", [{ code: "DTI_TOO_HIGH" }], DTI_INPUTS);
	unmappedAppId = await seedApp("pending_review", "sme_term_loan", 1_000_000);
	await seedEvaluation(unmappedAppId, "decline", [{ code: "BANKRUPTCY_FLAG" }], SME_CLEAN_INPUTS);
	terminalAppId = await seedApp("declined", "personal_loan", 1_200_000);

	await ctx.db.insert(caseAccessGrants).values({
		applicationId: appId,
		userId: officer.id,
		accessRole: "assigned_officer",
		grantedBy: service.id,
	});
});

afterAll(async () => {
	await ctx.sql.end();
});

describe("flag and access gates", () => {
	it("returns 404 when the flag is off and 403 for applicants", async () => {
		for (const path of [
			`/api/assist/cases/${appId}/policy-exception`,
			`/api/assist/cases/${appId}/policy-exception/explain`,
			`/api/assist/cases/${appId}/policy-exception/followups`,
			`/api/assist/cases/${appId}/policy-exception/memo`,
		]) {
			const res = await call(
				ctxFlagOff,
				"GET",
				`/api/assist/cases/${appId}/policy-exception`,
				officer,
			);
			expect(res.status, path).toBe(404);
			void path;
		}
		const offExplain = await call(
			ctxFlagOff,
			"POST",
			`/api/assist/cases/${appId}/policy-exception/explain`,
			officer,
			{},
		);
		expect(offExplain.status).toBe(404);
		const applicantRes = await call(
			ctx,
			"GET",
			`/api/assist/cases/${appId}/policy-exception`,
			applicant,
		);
		expect(applicantRes.status).toBe(403);
	});
});

describe("officer view", () => {
	it("returns context, catalog, and latest memo summary", async () => {
		const res = await call(ctx, "GET", `/api/assist/cases/${appId}/policy-exception`, officer);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			context: { failedRules: Array<{ ruleId: string }>; applicationReference: string };
			sections: Array<{ policyKey: string; sectionId: string; drawerToken: string; body: string }>;
			sourceStatus: string;
			latestArtifact: null | { id: string };
		};
		expect(body.context.failedRules.map((r) => r.ruleId)).toContain("PL-DTI-HIGH");
		expect(body.context.applicationReference).toMatch(/^POL-/);
		expect(body.sections.length).toBeGreaterThan(0);
		expect(body.sourceStatus).toBe("partial");
		expect(body.latestArtifact).toBeNull();
		for (const section of body.sections) {
			expect(section.drawerToken.length).toBeGreaterThan(0);
			expect(section.body.length).toBeGreaterThan(0);
		}
	});

	it("still returns context with sourceStatus unavailable when the client is missing", async () => {
		const res = await call(
			ctxNoClient,
			"GET",
			`/api/assist/cases/${appId}/policy-exception`,
			officer,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			sourceStatus: string;
			context: { failedRules: unknown[] };
		};
		expect(body.sourceStatus).toBe("unavailable");
		expect(body.context.failedRules.length).toBeGreaterThan(0);
	});
});

describe("explain and follow-up", () => {
	it("explains a mapped rule with exact quotes", async () => {
		const res = await call(
			ctx,
			"POST",
			`/api/assist/cases/${appId}/policy-exception/explain`,
			officer,
			{},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; rules: Array<{ ruleId: string }> };
		expect(body.status).toBe("succeeded");
		expect(body.rules.map((r) => r.ruleId)).toContain("PL-DTI-HIGH");
	});

	it("returns MAPPING_UNAVAILABLE when every failed rule is unmapped", async () => {
		const res = await call(
			ctx,
			"POST",
			`/api/assist/cases/${unmappedAppId}/policy-exception/explain`,
			officer,
			{},
		);
		expect(res.status).toBe(422);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"MAPPING_UNAVAILABLE",
		);
	});

	it("answers a follow-up and gates scope/identifier without a model call", async () => {
		const ok = await call(
			ctx,
			"POST",
			`/api/assist/cases/${appId}/policy-exception/followups`,
			officer,
			{
				question: "What exception route covers the servicing ratio?",
			},
		);
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { status: string }).status).toBe("succeeded");

		const outOfScope = await call(
			ctx,
			"POST",
			`/api/assist/cases/${appId}/policy-exception/followups`,
			officer,
			{
				question: "How do vendors submit procurement invoices?",
			},
		);
		expect(outOfScope.status).toBe(200);
		expect(((await outOfScope.json()) as { status: string }).status).toBe("no_match");

		const identifier = await call(
			ctx,
			"POST",
			`/api/assist/cases/${appId}/policy-exception/followups`,
			officer,
			{
				question: "Contact borrower@example.com about the servicing ratio?",
			},
		);
		expect(identifier.status).toBe(200);
		expect(((await identifier.json()) as { status: string }).status).toBe("needs_policy_owner");
	});

	it("returns 503 when the policy source is down", async () => {
		const res = await call(
			ctxNoClient,
			"POST",
			`/api/assist/cases/${appId}/policy-exception/explain`,
			officer,
			{},
		);
		expect(res.status).toBe(503);
	});
});

describe("memo draft, replay, edit, approve", () => {
	let memoId = "";
	let memoRevision = 1;

	it("drafts a memo with 7-year retention", async () => {
		const res = await call(
			ctx,
			"POST",
			`/api/assist/cases/${appId}/policy-exception/memo`,
			officer,
			{},
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			artifact: { id: string; revision: number; retentionUntil: string };
		};
		memoId = body.artifact.id;
		memoRevision = body.artifact.revision;
		const retentionDays =
			(new Date(body.artifact.retentionUntil).getTime() -
				new Date("2026-07-01T00:00:00Z").getTime()) /
			86_400_000;
		expect(Math.round(retentionDays)).toBe(2555);
		const createdAudits = await ctx.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.applicationId, appId));
		const created = createdAudits.find(
			(row) =>
				row.action === "artifact.created" &&
				(row.payload as Record<string, unknown>)["artifactId"] === memoId,
		);
		expect(created).toBeDefined();
		expect((created?.payload as Record<string, unknown> | undefined)?.["feature"]).toBe(
			"policy_exception",
		);
	});

	it("replays the identical draft", async () => {
		const res = await call(
			ctx,
			"POST",
			`/api/assist/cases/${appId}/policy-exception/memo`,
			officer,
			{},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { artifact: { id: string }; replayed: boolean };
		expect(body.replayed).toBe(true);
		expect(body.artifact.id).toBe(memoId);
	});

	it("rejects the generic create route", async () => {
		const res = await call(ctx, "POST", `/api/assist/cases/${appId}/artifacts`, officer, {
			type: "policy_exception_memo",
			content: {},
		});
		expect(res.status).toBe(422);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"DEDICATED_ROUTE_REQUIRED",
		);
	});

	it("edits and approves the memo", async () => {
		const get = await call(ctx, "GET", `/api/assist/artifacts/${memoId}`, officer);
		expect(get.status).toBe(200);
		const content = ((await get.json()) as { artifact: { content: Record<string, unknown> } })
			.artifact.content;
		const edit = await call(ctx, "PATCH", `/api/assist/artifacts/${memoId}`, officer, {
			expectedRevision: memoRevision,
			content,
		});
		expect(edit.status).toBe(200);
		const edited = (await edit.json()) as { artifact: { revision: number } };
		memoRevision = edited.artifact.revision;
		const approve = await call(ctx, "POST", `/api/assist/artifacts/${memoId}/approve`, officer, {
			expectedRevision: memoRevision,
			confirm: true,
		});
		expect(approve.status).toBe(200);
		expect(((await approve.json()) as { artifact: { status: string } }).artifact.status).toBe(
			"approved",
		);
	});

	it("blocks tombstoning an approved memo", async () => {
		const res = await call(ctx, "POST", `/api/assist/artifacts/${memoId}/tombstone`, officer, {
			expectedRevision: memoRevision,
			reason: "officer cleanup",
		});
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"ARTIFACT_IMMUTABLE",
		);
	});

	it("requires pending_review for memo generation", async () => {
		const res = await call(
			ctx,
			"POST",
			`/api/assist/cases/${terminalAppId}/policy-exception/memo`,
			officer,
			{},
		);
		expect(res.status).toBe(409);
	});
});

describe("audit and access hygiene", () => {
	it("writes metadata-only audit rows", async () => {
		const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appId));
		const actions = new Set(rows.map((row) => row.action));
		for (const action of [
			"policy_exception.viewed",
			"policy_exception.explained",
			"policy_exception.followup",
		]) {
			expect(actions.has(action)).toBe(true);
		}
		const payload = JSON.stringify(rows.map((row) => row.payload));
		expect(payload).not.toContain("borrower@example.com");
		expect(payload).not.toContain(BODY_91);
		expect(payload).not.toContain("What exception route covers");
		const followup = rows.find((row) => row.action === "policy_exception.followup");
		expect(JSON.stringify(followup?.payload)).toContain("questionHmac");
	});

	it("hides document-derived memos from unassigned officers", async () => {
		const plainAppId = await seedApp("pending_review", "personal_loan", 1_200_000);
		const derivedAppId = await seedApp("pending_review", "personal_loan", 1_200_000);
		const plain = await createArtifact(ctx.db, {
			applicationId: plainAppId,
			type: "policy_exception_memo",
			content: {
				title: "t",
				sections: [],
				openItems: [],
				rules: [],
				regularisationPlanMonths: null,
			},
			citations: [],
			documentDerived: false,
			createdBy: officer.id,
			model: "test-model",
			promptVersion: "policy-exception-v1",
			retentionDays: 2555,
			auditFeature: "policy_exception",
		});
		const derived = await createArtifact(ctx.db, {
			applicationId: derivedAppId,
			type: "policy_exception_memo",
			content: {
				title: "t",
				sections: [],
				openItems: [],
				rules: [],
				regularisationPlanMonths: null,
			},
			citations: [],
			documentDerived: true,
			createdBy: officer.id,
			model: "test-model",
			promptVersion: "policy-exception-v1",
			retentionDays: 2555,
			auditFeature: "policy_exception",
		});
		const plainGet = await call(ctx, "GET", `/api/assist/artifacts/${plain.id}`, officer);
		expect(plainGet.status).toBe(200);
		const derivedGet = await call(ctx, "GET", `/api/assist/artifacts/${derived.id}`, officer);
		expect(derivedGet.status).toBe(404);
		const list = await call(ctx, "GET", `/api/assist/cases/${derivedAppId}/artifacts`, officer);
		const items = ((await list.json()) as { items: Array<{ id: string }> }).items;
		expect(items.some((item) => item.id === derived.id)).toBe(false);
	});

	it("flag-off hides policy memos", async () => {
		const res = await call(
			ctxFlagOff,
			"GET",
			`/api/assist/cases/${appId}/artifacts?type=policy_exception_memo`,
			officer,
		);
		expect(res.status).toBe(404);
	});
});
