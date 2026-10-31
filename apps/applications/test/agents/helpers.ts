// Shared fixtures for the agent prompt-hash and retry tests. No DB, no
// network: every model call goes through a scripted fetch.
import { createHash } from "node:crypto";
import {
	hashQuote,
	resolveExceptionPath,
	ruleDefinitionById,
	type EvidenceBundle,
} from "@credit/core";
import type { applications } from "@credit/db/applications";
import type { IntegritySource } from "../../src/integrity/types.js";
import type {
	CaseRuleContext,
	PolicySectionDelivery,
} from "../../src/agents/policy-exception/index.js";

process.env.OTEL_SDK_DISABLED = "true";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const APP_ID = "55555555-5555-4555-8555-555555555555";

export function completion(content = "{}"): Response {
	return new Response(
		JSON.stringify({
			id: "chatcmpl-test",
			object: "chat.completion",
			created: 1,
			model: "m",
			choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

export function errorResponse(status: number): Response {
	return new Response(JSON.stringify({ error: { message: "upstream" } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export interface ScriptedFetch {
	fetchImpl: typeof fetch;
	/** Parsed JSON request bodies, one per HTTP call (retries included). */
	bodies: unknown[];
}

/** Plays `script` in order (the last entry repeats) and records each body. */
export function scriptedFetch(script: Array<() => Response>): ScriptedFetch {
	const bodies: unknown[] = [];
	const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
		bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
		const step = script[Math.min(bodies.length - 1, script.length - 1)]!;
		return step();
	}) as unknown as typeof fetch;
	return { fetchImpl, bodies };
}

interface ChatBody {
	messages: Array<{ role: string; content: string }>;
}

/** sha256 of the system and (single) user message of a captured request. */
export function messageHashes(body: unknown): { system: string; user: string } {
	const messages = (body as ChatBody).messages;
	return {
		system: sha256(messages.find((m) => m.role === "system")!.content),
		user: sha256(messages.find((m) => m.role === "user")!.content),
	};
}

export const runnerBase = {
	apiKey: "k",
	baseUrl: "https://example.invalid/v1",
	model: "m",
	maxToolCalls: 4,
	maxOutputTokens: 1000,
	timeoutMs: 8_000,
};

export const application = {
	id: APP_ID,
	reference: "APP-2026-0001",
	type: "sme",
	product: "sme_term_loan",
} as unknown as typeof applications.$inferSelect;

export const evidence: EvidenceBundle = {
	applicationId: APP_ID,
	asOf: "2026-06-30T00:00:00.000Z",
	assembledAt: "2026-06-30T01:00:00.000Z",
	items: [
		{
			ref: "case_fact:a",
			sourceType: "case_fact",
			label: "Fact A",
			content: "Applicant income is 5000 per month.",
			access: { retentionUntil: null, legalHold: false },
			metadata: {},
		},
	],
	unavailable: [
		{ ref: "unavail:1", sourceType: "document", code: "missing_document", detail: "no payslip" },
	] as unknown as EvidenceBundle["unavailable"],
};

export const integritySource = {
	applicationId: APP_ID,
	applicationReference: "APP-2026-0001",
	applicationType: "sme",
	product: "sme_term_loan",
	applicantUserId: APP_ID,
	customerProfileId: null,
	documentConsent: true,
	contextConsent: true,
	caseFacts: [],
	documents: [{}, {}],
	customerDocuments: [],
	crosscheck: null,
	signals: [{ code: "crosscheck_mismatch" }, { code: "duplicate_hash_cross_application" }],
	duplicateCounts: { crossApplicant: 1, sameApplicantOther: 2, sameApplication: 0 },
	duplicateMatches: [],
	unavailable: [{}],
	includeCustomerEvidence: true,
} as unknown as IntegritySource;

const POLICY_BODY =
	"Scores from 580 to 649 may proceed with a 25% exposure reduction and dual sign-off recorded for the file.";

export const policySection: PolicySectionDelivery = {
	policyId: "p",
	policyVersionId: "v",
	policyKey: "POL-CR-001",
	sectionId: "1.2",
	version: "v1",
	heading: "Assessment band review",
	body: POLICY_BODY,
	truncated: false,
	effectiveFrom: "2026-01-01",
	effectiveTo: null,
	contentHash: "abc",
	quoteHash: hashQuote(POLICY_BODY),
	drawerToken: "t",
};

export function policyContext(): CaseRuleContext {
	const def = ruleDefinitionById("PL-SCORE-REFER")!;
	return {
		applicationId: APP_ID,
		applicationReference: "APP-2026-ABCDEF",
		policyAsOf: "2026-06-30",
		product: "personal_loan",
		applicationKind: "individual",
		outcome: "refer",
		policyVersion: "v1",
		scorecardVersion: "scorecard-v1",
		registryVersion: "policy-registry-v1",
		score: 620,
		grade: "C",
		scoreBand: "review",
		amountCents: 6_000_000,
		secured: false,
		securedQualifying: false,
		status: "ok",
		failedRules: [
			{
				ruleId: "PL-SCORE-REFER",
				reasonCode: "SCORE_IN_REFER_BAND",
				effect: "refer",
				evaluated: true,
				persisted: true,
				decisionRelevant: true,
				observedValue: 620,
				observed: "620",
				threshold: def.threshold.display,
				scoreBand: "review",
				ruleSectionRefs: def.ruleSectionRefs,
				exception: resolveExceptionPath({
					definition: def,
					observedValue: 620,
					amountCents: 6_000_000,
					failedRuleCount: 1,
					securedQualifying: false,
				}),
				mappingState: "mapped",
				explanationLimitation: null,
			},
			{
				ruleId: "INFO-1",
				reasonCode: "SECTOR",
				effect: "informational",
				observed: "x",
				exception: { state: "not_applicable", approver: null },
			},
		],
		unmappedRuleIds: ["U1"],
		unmappedExceptionRuleIds: [],
		limitations: [],
	} as unknown as CaseRuleContext;
}
