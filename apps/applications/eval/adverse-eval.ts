// EN-08 adverse-action eval (deterministic, no LLM). Archetype: pure
// gate/classifier. Cases exercise the production letter builder
// (buildAdverseActionLetter) across its failure taxonomy, plus the shared
// generated-text validator on one valid and two tainted letters.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	ADVERSE_JURISDICTION_PROFILES,
	sourceRefKey,
	validateAdverseLetterDecisionBinding,
	validateGeneratedText,
	type AdverseActionLetterContent,
	type AdverseJurisdictionProfile,
	type EvidenceBundle,
	type EvidenceItem,
	type SourceRef,
} from "@credit/core";
import {
	buildAdverseActionLetter,
	buildAdverseReasonFacts,
	type BuildAdverseLetterResult,
} from "../src/assist/adverse.js";
import type { applications, decisions, scores } from "@credit/db/applications";

const appId = "66666666-6666-4666-8666-666666666666";
const usAppId = "77777777-7777-4777-8777-777777777777";
const contactPath = "https://example.com/contact";

const SG_CODES = ["SCORE_IN_REFER_BAND", "DSCR_IN_REFER_BAND", "AMOUNT_ABOVE_AUTO_LIMIT"];
const US_CODES = ["SCORE_TOO_LOW", "DTI_TOO_HIGH", "SHORT_EMPLOYMENT", "DELINQUENCIES"];

function scoreItem(decisionId: string, code: string): EvidenceItem {
	const ref = { type: "score_reason", scoreId: decisionId, code } as SourceRef;
	return {
		ref: sourceRefKey(ref),
		sourceType: "score_reason",
		label: code,
		content: code,
		access: { retentionUntil: null, legalHold: false },
		metadata: {},
	};
}

function identityItem(applicationId: string, field: string, content: string): EvidenceItem {
	const ref = { type: "case_fact", applicationId, field } as SourceRef;
	return {
		ref: sourceRefKey(ref),
		sourceType: "case_fact",
		label: field,
		content,
		access: { retentionUntil: null, legalHold: false },
		metadata: {},
	};
}

function bundleFor(
	applicationId: string,
	decisionId: string,
	codes: string[],
	identity: Array<[string, string]>,
): EvidenceBundle {
	return {
		applicationId,
		asOf: "2026-06-30T00:00:00.000Z",
		assembledAt: "2026-06-30T01:00:00.000Z",
		items: [
			...identity.map(([field, content]) => identityItem(applicationId, field, content)),
			...codes.map((code) => scoreItem(decisionId, code)),
		],
		unavailable: [],
	};
}

function smeApplication() {
	return {
		id: appId,
		reference: "APP-2026-ADV01",
		type: "sme",
		product: "sme_term_loan",
		status: "pending_review",
		amountCents: 6_000_000,
		termMonths: 60,
		purpose: "Cafe expansion",
		identity: { fullName: "Tomas Aurora", city: "Singapore" },
		business: {
			companyName: "Cafe Aurora",
			industry: "hospitality",
			yearsTrading: 4,
			annualRevenueCents: 61_000_000,
			monthlyFcfCents: 380_000,
			existingDebtServiceCents: 30_000,
		},
		financial: null,
		submittedAt: new Date("2026-06-30T00:00:00Z"),
		createdAt: new Date("2026-06-30T00:00:00Z"),
	} as unknown as typeof applications.$inferSelect;
}

function personalApplication() {
	return {
		id: usAppId,
		reference: "APP-2026-ADV02",
		type: "individual",
		product: "personal_loan",
		status: "pending_review",
		amountCents: 2_500_000,
		termMonths: 36,
		purpose: "Debt consolidation",
		identity: { fullName: "Alex Rivera", city: "Austin" },
		business: {},
		financial: { employmentYears: 1 },
		submittedAt: new Date("2026-06-30T00:00:00Z"),
		createdAt: new Date("2026-06-30T00:00:00Z"),
	} as unknown as typeof applications.$inferSelect;
}

function namelessApplication() {
	const application = smeApplication();
	return {
		...application,
		identity: {},
		business: { industry: "hospitality" },
	} as unknown as typeof applications.$inferSelect;
}

function scoreFor(applicationId: string, id: string) {
	return {
		id,
		applicationId,
		modelVersion: "score-v1",
		score: 640,
		grade: "C",
		components: {},
		factors: [],
		affordability: {},
		createdAt: new Date("2026-06-30T00:00:00Z"),
	} as unknown as typeof scores.$inferSelect;
}

function decisionFor(id: string, applicationId: string, outcome: string, reasons: unknown[]) {
	return {
		id,
		applicationId,
		outcome,
		decidedBy: "system",
		reasons,
		snapshot: {},
		decidedAt: new Date("2026-06-30T00:00:00Z"),
		createdAt: new Date("2026-06-30T00:00:00Z"),
	} as unknown as typeof decisions.$inferSelect;
}

function builderObserved(
	result: BuildAdverseLetterResult,
	expected: { reasons?: number; notices?: number },
): { observed: string; claims: number; cited: number } {
	if (!result.ok) {
		const failure = result.failure;
		let sub = "";
		if (failure.code === "NEEDS_OFFICER_INPUT") {
			const detail = failure.detail;
			if (
				detail === "unmapped_code" ||
				detail === "insufficient_reasons" ||
				detail === "insufficient_specificity" ||
				detail === "template_invalid"
			) {
				sub = `/${detail}`;
			} else if (failure.missingCitationCodes !== undefined) {
				sub = "/missingCitationCodes";
			}
		}
		return { observed: `${failure.code}${sub}`, claims: 0, cited: 0 };
	}
	const reasons = result.content.principalReasons;
	const cited = reasons.filter((reason) => reason.citations.length > 0).length;
	if (expected.reasons !== undefined && reasons.length !== expected.reasons) {
		return { observed: `REASON_COUNT_${reasons.length}`, claims: reasons.length, cited };
	}
	if (expected.notices !== undefined && result.content.notices.length !== expected.notices) {
		return { observed: "NOTICE_COUNT_MISMATCH", claims: reasons.length, cited };
	}
	return { observed: "accept", claims: reasons.length, cited };
}

interface EvalCase {
	id: string;
	expected: string;
	tags: string[];
	run: () => { observed: string; claims: number; cited: number };
}

function cases(): EvalCase[] {
	const sgDecisionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const usDecisionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	const sgEvidence = () =>
		bundleFor(appId, sgDecisionId, SG_CODES, [["companyName", "Cafe Aurora"]]);
	const usEvidence = () =>
		bundleFor(usAppId, usDecisionId, US_CODES, [["applicantName", "Alex Rivera"]]);
	const sgProfile = ADVERSE_JURISDICTION_PROFILES.SG;
	const usProfile = ADVERSE_JURISDICTION_PROFILES.US;

	const validSgLetter = () => {
		const decision = decisionFor(sgDecisionId, appId, "declined", SG_CODES);
		const score = scoreFor(appId, "c1111111-1111-4111-8111-111111111111");
		const evidence = sgEvidence();
		const result = buildAdverseActionLetter({
			application: smeApplication(),
			decision,
			score,
			evidence,
			profile: sgProfile,
			contactPath,
		});
		if (!result.ok) throw new Error(`fixture letter failed: ${result.failure.detail}`);
		return {
			content: structuredClone(result.content),
			evidence,
			facts: buildAdverseReasonFacts(smeApplication(), decision, score, evidence),
		};
	};

	const bindingObserved = (
		content: AdverseActionLetterContent,
		over: {
			decisionId?: string;
			codes?: string[];
			profile?: AdverseJurisdictionProfile;
			contactPath?: string;
		} = {},
	): string => {
		const result = validateAdverseLetterDecisionBinding({
			content,
			applicationId: appId,
			decisionId: over.decisionId ?? sgDecisionId,
			decisionReasonCodes: over.codes ?? SG_CODES,
			profile: over.profile ?? sgProfile,
			contactPath: over.contactPath ?? contactPath,
			facts: validSgLetter().facts,
		});
		return result.ok
			? "accept"
			: `ADVERSE_DECISION_MISMATCH/${result.issues[0]?.code ?? "UNKNOWN"}`;
	};

	return [
		{
			id: "sg-success-3",
			expected: "accept",
			tags: ["happy", "sg"],
			run: () =>
				builderObserved(
					buildAdverseActionLetter({
						application: smeApplication(),
						decision: decisionFor(sgDecisionId, appId, "declined", SG_CODES),
						score: scoreFor(appId, "c1111111-1111-4111-8111-111111111111"),
						evidence: sgEvidence(),
						profile: sgProfile,
						contactPath,
					}),
					{ reasons: 3, notices: sgProfile.disclosures.length },
				),
		},
		{
			id: "us-success-4",
			expected: "accept",
			tags: ["happy", "us"],
			run: () =>
				builderObserved(
					buildAdverseActionLetter({
						application: personalApplication(),
						decision: decisionFor(usDecisionId, usAppId, "declined", US_CODES),
						score: scoreFor(usAppId, "c2222222-2222-4222-8222-222222222222"),
						evidence: usEvidence(),
						profile: usProfile,
						contactPath,
					}),
					{ reasons: 4, notices: usProfile.disclosures.length },
				),
		},
		{
			id: "too-few-reasons",
			expected: "NEEDS_OFFICER_INPUT/insufficient_reasons",
			tags: ["gate"],
			run: () =>
				builderObserved(
					buildAdverseActionLetter({
						application: smeApplication(),
						decision: decisionFor(sgDecisionId, appId, "declined", SG_CODES.slice(0, 2)),
						score: scoreFor(appId, "c1111111-1111-4111-8111-111111111111"),
						evidence: sgEvidence(),
						profile: sgProfile,
						contactPath,
					}),
					{},
				),
		},
		{
			id: "unmapped-code",
			expected: "NEEDS_OFFICER_INPUT/unmapped_code",
			tags: ["gate"],
			run: () =>
				builderObserved(
					buildAdverseActionLetter({
						application: smeApplication(),
						decision: decisionFor(sgDecisionId, appId, "declined", [
							...SG_CODES,
							"NOT_A_REAL_CODE",
						]),
						score: scoreFor(appId, "c1111111-1111-4111-8111-111111111111"),
						evidence: sgEvidence(),
						profile: sgProfile,
						contactPath,
					}),
					{},
				),
		},
		{
			id: "generic-only",
			expected: "NEEDS_OFFICER_INPUT/insufficient_specificity",
			tags: ["gate"],
			run: () =>
				builderObserved(
					buildAdverseActionLetter({
						application: smeApplication(),
						decision: decisionFor(sgDecisionId, appId, "declined", [
							"OFFICER_JUDGEMENT",
							"INSUFFICIENT_EVIDENCE",
							"POLICY_EXCEPTION",
						]),
						score: scoreFor(appId, "c1111111-1111-4111-8111-111111111111"),
						evidence: sgEvidence(),
						profile: sgProfile,
						contactPath,
					}),
					{},
				),
		},
		{
			id: "protected-label",
			expected: "FAIR_LENDING_BLOCKED",
			tags: ["fair-lending"],
			run: () =>
				builderObserved(
					buildAdverseActionLetter({
						application: smeApplication(),
						decision: decisionFor(sgDecisionId, appId, "declined", [
							{ code: "SCORE_IN_REFER_BAND", text: "The applicant is male, so refer." },
							"DSCR_IN_REFER_BAND",
							"AMOUNT_ABOVE_AUTO_LIMIT",
						]),
						score: scoreFor(appId, "c1111111-1111-4111-8111-111111111111"),
						evidence: sgEvidence(),
						profile: sgProfile,
						contactPath,
					}),
					{},
				),
		},
		{
			id: "proxy-label",
			expected: "FAIR_LENDING_BLOCKED",
			tags: ["fair-lending"],
			run: () =>
				builderObserved(
					buildAdverseActionLetter({
						application: smeApplication(),
						decision: decisionFor(sgDecisionId, appId, "declined", [
							{ code: "SCORE_IN_REFER_BAND", text: "The zip code history is unfavourable." },
							"DSCR_IN_REFER_BAND",
							"AMOUNT_ABOVE_AUTO_LIMIT",
						]),
						score: scoreFor(appId, "c1111111-1111-4111-8111-111111111111"),
						evidence: sgEvidence(),
						profile: sgProfile,
						contactPath,
					}),
					{},
				),
		},
		{
			id: "missing-citation",
			expected: "NEEDS_OFFICER_INPUT/missingCitationCodes",
			tags: ["citation"],
			run: () =>
				builderObserved(
					buildAdverseActionLetter({
						application: smeApplication(),
						decision: decisionFor(sgDecisionId, appId, "declined", SG_CODES),
						score: scoreFor(appId, "c1111111-1111-4111-8111-111111111111"),
						evidence: bundleFor(appId, sgDecisionId, SG_CODES.slice(0, 1), [
							["companyName", "Cafe Aurora"],
						]),
						profile: sgProfile,
						contactPath,
					}),
					{},
				),
		},
		{
			id: "approved-decision",
			expected: "NOT_DECLINED",
			tags: ["gate"],
			run: () =>
				builderObserved(
					buildAdverseActionLetter({
						application: smeApplication(),
						decision: decisionFor(sgDecisionId, appId, "approved", SG_CODES),
						score: scoreFor(appId, "c1111111-1111-4111-8111-111111111111"),
						evidence: sgEvidence(),
						profile: sgProfile,
						contactPath,
					}),
					{},
				),
		},
		{
			id: "missing-name",
			expected: "NEEDS_OFFICER_INPUT",
			tags: ["gate"],
			run: () =>
				builderObserved(
					buildAdverseActionLetter({
						application: namelessApplication(),
						decision: decisionFor(sgDecisionId, appId, "declined", SG_CODES),
						score: scoreFor(appId, "c1111111-1111-4111-8111-111111111111"),
						evidence: sgEvidence(),
						profile: sgProfile,
						contactPath,
					}),
					{},
				),
		},
		{
			id: "validator-valid-sg",
			expected: "accept",
			tags: ["happy", "validator"],
			run: () => {
				const { content, evidence } = validSgLetter();
				const result = validateGeneratedText({
					artifactType: "adverse_action_letter",
					content,
					evidence,
				});
				const observed = result.ok ? "accept" : (result.issues[0]?.code ?? "UNKNOWN");
				return {
					observed,
					claims: content.principalReasons.length,
					cited: content.principalReasons.filter((reason) => reason.citations.length > 0).length,
				};
			},
		},
		{
			id: "validator-protected",
			expected: "PROTECTED_ATTRIBUTE",
			tags: ["fair-lending", "validator"],
			run: () => {
				const { content, evidence } = validSgLetter();
				content.principalReasons[0]!.text = "The applicant age of 40 is below the preferred range.";
				const result = validateGeneratedText({
					artifactType: "adverse_action_letter",
					content,
					evidence,
				});
				return {
					observed: result.ok ? "accept" : (result.issues[0]?.code ?? "UNKNOWN"),
					claims: 0,
					cited: 0,
				};
			},
		},
		{
			id: "validator-proxy",
			expected: "FAIR_LENDING_PROXY",
			tags: ["fair-lending", "validator"],
			run: () => {
				const { content, evidence } = validSgLetter();
				content.principalReasons[0]!.text = "The zip code pattern is below the preferred range.";
				const result = validateGeneratedText({
					artifactType: "adverse_action_letter",
					content,
					evidence,
				});
				return {
					observed: result.ok ? "accept" : (result.issues[0]?.code ?? "UNKNOWN"),
					claims: 0,
					cited: 0,
				};
			},
		},
		{
			id: "validator-internal-reference",
			expected: "INTERNAL_REFERENCE",
			tags: ["internal", "validator"],
			run: () => {
				const { content, evidence } = validSgLetter();
				content.principalReasons[0]!.text = "Model scorecard-v1 internal risk grade D.";
				const result = validateGeneratedText({
					artifactType: "adverse_action_letter",
					content,
					evidence,
				});
				return {
					observed: result.ok ? "accept" : (result.issues[0]?.code ?? "UNKNOWN"),
					claims: 0,
					cited: 0,
				};
			},
		},
		{
			id: "binding-forged-decision-id",
			expected: "ADVERSE_DECISION_MISMATCH/DECISION_ID_MISMATCH",
			tags: ["binding"],
			run: () => ({
				observed: bindingObserved(validSgLetter().content, {
					decisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				}),
				claims: 3,
				cited: 3,
			}),
		},
		{
			id: "binding-invented-code",
			expected: "ADVERSE_DECISION_MISMATCH/REASON_CODE_NOT_IN_DECISION",
			tags: ["binding"],
			run: () => {
				const { content } = validSgLetter();
				content.principalReasons[0] = { ...content.principalReasons[0]!, code: "SECTOR_RISK" };
				return { observed: bindingObserved(content), claims: 3, cited: 3 };
			},
		},
		{
			id: "binding-wrong-citation",
			expected: "ADVERSE_DECISION_MISMATCH/CITATION_NOT_DECISION_REASON",
			tags: ["binding"],
			run: () => {
				const { content } = validSgLetter();
				content.principalReasons[0]!.citations[0] = {
					ref: `score_reason:${sgDecisionId}:DSCR_IN_REFER_BAND`,
					quote: "DSCR_IN_REFER_BAND",
				};
				return { observed: bindingObserved(content), claims: 3, cited: 3 };
			},
		},
		{
			id: "binding-forged-text",
			expected: "ADVERSE_DECISION_MISMATCH/REASON_TEXT_MISMATCH",
			tags: ["binding"],
			run: () => {
				const { content } = validSgLetter();
				content.principalReasons[0]!.text = "Recent gambling activity affected the outcome.";
				return { observed: bindingObserved(content), claims: 3, cited: 3 };
			},
		},
		{
			id: "binding-contact-path",
			expected: "ADVERSE_DECISION_MISMATCH/CONTACT_PATH_MISMATCH",
			tags: ["binding"],
			run: () => ({
				observed: bindingObserved(validSgLetter().content, {
					contactPath: "https://evil.example/contact",
				}),
				claims: 3,
				cited: 3,
			}),
		},
	];
}

interface CaseResult {
	id: string;
	expected: string;
	observed: string;
	pass: boolean;
	tags: string[];
}

function runOnce(): { results: CaseResult[]; claims: number; cited: number } {
	const evalCases = cases();
	let claims = 0;
	let cited = 0;
	const results = evalCases.map((testCase) => {
		const outcome = testCase.run();
		if (testCase.expected === "accept") {
			claims += outcome.claims;
			cited += outcome.cited;
		}
		const observed = outcome.observed;
		return {
			id: testCase.id,
			expected: testCase.expected,
			observed,
			pass: observed === testCase.expected,
			tags: testCase.tags,
		};
	});
	return { results, claims, cited };
}

const trials = [runOnce(), runOnce(), runOnce()];
const first = trials[0]!.results;
const passAt1 = first.filter((r) => r.pass).length / first.length;
const passAt3 =
	first.filter((_, index) => trials.every((trial) => trial.results[index]?.pass)).length /
	first.length;
const accepted = first.filter((r) => r.observed === "accept").length;
const unsafe = first.filter((r) => r.expected !== "accept");
const safetyPass = unsafe.filter((r) => r.pass).length / unsafe.length;
const falsePositive = first.filter((r) => r.expected === "accept" && !r.pass).length;
const falseNegative = first.filter(
	(r) => r.expected !== "accept" && r.observed === "accept",
).length;
const unsupportedClaimCount = trials[0]!.claims - trials[0]!.cited;
const citationCoverage = trials[0]!.claims === 0 ? 1 : trials[0]!.cited / trials[0]!.claims;
const byCode = Object.fromEntries(
	[...new Set(first.map((r) => r.observed))]
		.sort()
		.map((code) => [code, first.filter((r) => r.observed === code).length]),
);

const summary = {
	feature: "adverse-action EN-08 letter builder and validator",
	archetype: "pure gate/classifier",
	model: "deterministic",
	costUsd: 0,
	n: first.length,
	trials: 3,
	passAt1,
	passAt3,
	accepted,
	safetyPass,
	falsePositive,
	falseNegative,
	unsupportedClaimCount,
	citationCoverage,
	byCode,
	failures: first.filter((r) => !r.pass),
};

const outDir = fileURLToPath(new URL("./results/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
writeFileSync(
	`${outDir}adverse-${stamp}.json`,
	`${JSON.stringify({ summary, cases: first }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
if (passAt1 < 1) process.exitCode = 1;
