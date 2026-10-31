// Server-composed `policy_exception_memo` content.
//
// The model writes prose only (`title`, `sections`, `openItems`). The
// deterministic `rules` block (every failed rule with its observed value,
// threshold, effect, persistence, exception state, approver, mitigant codes,
// and rule refs) and `regularisationPlanMonths` are merged here, before
// validation, so the model can never invent a mapping, approver, or
// mitigant. Deterministic open items cover unmapped rules, the staff/PEP
// verification floor, and unavailable collateral values.
import {
	containsApplicationReference,
	containsBriefDecisionLanguage,
	hasDirectIdentifier,
	parseSourceRef,
	ruleDefinitionById,
	sourceRefKey,
	type EvidenceBundle,
	type PolicyExceptionMemoContent as CoreMemoContent,
} from "@credit/core";
import type { CaseRuleContext } from "./types.js";

function safePolicyQuote(body: string, prefer?: RegExp): string | null {
	const sentences = body
		.split(/(?<=[.!?])\s+|\n+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length >= 20 && sentence.length <= 500);
	const allowed: string[] = [];
	for (const sentence of sentences) {
		if (containsBriefDecisionLanguage(sentence)) continue;
		if (containsApplicationReference(sentence)) continue;
		if (hasDirectIdentifier(sentence)) continue;
		if (/\bPOL-CR-\d{3}\b/.test(sentence)) continue;
		allowed.push(sentence);
	}
	const preferred = prefer ? allowed.find((sentence) => prefer.test(sentence)) : undefined;
	const neutral = allowed.find(
		(sentence) => !/single[\s_-]*officer|team[\s_-]*manager|credit[\s_-]*committee/i.test(sentence),
	);
	if (preferred ?? neutral ?? allowed[0]) return preferred ?? neutral ?? allowed[0] ?? null;
	const clauses = body
		.split(/(?<=[.;])\s+|\n+|\s*\(/g)
		.map((clause) => clause.trim())
		.filter((clause) => clause.length >= 20 && clause.length <= 500);
	return (
		clauses.find(
			(clause) =>
				!containsBriefDecisionLanguage(clause) &&
				!containsApplicationReference(clause) &&
				!hasDirectIdentifier(clause) &&
				!/\bPOL-CR-\d{3}\b/.test(clause),
		) ?? null
	);
}

/** Deterministic citation scaffolding for the memo's factual sections. The
 * model writes the narrative; these claims ensure every failed rule and its
 * mapped exception section is cited even when the model omits one. */
function deterministicSectionClaims(
	context: CaseRuleContext,
	evidence: EvidenceBundle | undefined,
): {
	rule: CoreMemoContent["sections"][number]["claims"];
	mitigants: CoreMemoContent["sections"][number]["claims"];
	plan: CoreMemoContent["sections"][number]["claims"];
} {
	const rule: CoreMemoContent["sections"][number]["claims"] = [];
	const mitigants: CoreMemoContent["sections"][number]["claims"] = [];
	const plan: CoreMemoContent["sections"][number]["claims"] = [];
	if (!evidence) return { rule, mitigants, plan };
	const bySection = new Map<string, { ref: string; body: string }>();
	for (const item of evidence.items) {
		if (item.sourceType !== "policy_section") continue;
		const parsed = parseSourceRef(item.ref);
		if (parsed?.type !== "policy_section") continue;
		bySection.set(`${parsed.policyKey}#${parsed.sectionId}`, {
			ref: item.ref,
			body: item.content,
		});
	}
	const add = (
		target: CoreMemoContent["sections"][number]["claims"],
		key: string,
		prefer?: RegExp,
	): void => {
		const section = bySection.get(key);
		if (!section) return;
		if (target.some((claim) => claim.citations.some((citation) => citation.ref === section.ref))) {
			return;
		}
		const quote = safePolicyQuote(section.body, prefer);
		if (!quote) return;
		target.push({ text: quote, citations: [{ ref: section.ref, quote }] });
	};
	for (const failure of context.failedRules) {
		for (const sectionRef of failure.ruleSectionRefs) {
			add(rule, `${sectionRef.policyKey}#${sectionRef.sectionId}`);
		}
		for (const sectionRef of failure.exception.citations) {
			const isGeneralExceptionRule =
				sectionRef.policyKey === "POL-CR-005" && sectionRef.sectionId === "5.1";
			const exceptionEligible =
				failure.exception.state === "allowed" || failure.exception.state === "structural_remedy";
			if (!isGeneralExceptionRule || exceptionEligible) {
				add(
					rule,
					`${sectionRef.policyKey}#${sectionRef.sectionId}`,
					sectionRef.policyKey === "POL-CR-009" && sectionRef.sectionId === "9.3"
						? /authorities apply/i
						: undefined,
				);
			}
			if (exceptionEligible) {
				if (sectionRef.policyKey === "POL-CR-005" && sectionRef.sectionId === "5.3") {
					add(
						mitigants,
						`${sectionRef.policyKey}#${sectionRef.sectionId}`,
						/pricing|limit reduction|reviewable|collateral/i,
					);
				}
				if (
					(sectionRef.policyKey === "POL-CR-005" && sectionRef.sectionId === "5.1") ||
					(sectionRef.policyKey === "POL-CR-002" && sectionRef.sectionId === "2.2") ||
					(sectionRef.policyKey === "POL-CR-003" && sectionRef.sectionId === "3.1")
				) {
					add(
						plan,
						`${sectionRef.policyKey}#${sectionRef.sectionId}`,
						/reviewable|month|secured|guarantee/i,
					);
				}
				if (
					failure.exception.state === "structural_remedy" &&
					((sectionRef.policyKey === "POL-CR-002" && sectionRef.sectionId === "2.2") ||
						(sectionRef.policyKey === "POL-CR-003" && sectionRef.sectionId === "3.1"))
				) {
					add(
						mitigants,
						`${sectionRef.policyKey}#${sectionRef.sectionId}`,
						/reviewable|secured|guarantee/i,
					);
				}
			}
		}
	}
	return { rule, mitigants, plan };
}

export interface PolicyExceptionMemoRule {
	ruleId: string;
	reasonCode: string;
	observed: string;
	threshold: string;
	effect: "decline" | "refer" | "informational";
	persisted: boolean;
	exceptionState:
		| "allowed"
		| "prohibited"
		| "not_applicable"
		| "structural_remedy"
		| "mapping_unavailable";
	approver: "single_officer" | "team_manager" | "credit_committee" | null;
	mitigantCodes: string[];
	ruleSectionRefs: Array<{ policyKey: string; sectionId: string }>;
}

export type PolicyExceptionMemoContent = CoreMemoContent & {
	rules: PolicyExceptionMemoRule[];
	regularisationPlanMonths: number | null;
};

export interface PolicyExceptionModelDraft {
	title: string;
	sections: CoreMemoContent["sections"];
	openItems: CoreMemoContent["openItems"];
}

/** Merge the model prose with the deterministic rule block and plan months,
 * then append deterministic open items for gaps the model must not fill. */
export function composePolicyMemoContent(
	modelDraft: PolicyExceptionModelDraft,
	context: CaseRuleContext,
	_evidence?: EvidenceBundle,
): PolicyExceptionMemoContent {
	const rules: PolicyExceptionMemoRule[] = context.failedRules.map((failure) => ({
		ruleId: failure.ruleId,
		reasonCode: failure.reasonCode,
		observed: failure.observed,
		threshold: failure.threshold,
		effect: failure.effect,
		persisted: failure.persisted,
		exceptionState: failure.exception.state,
		approver: failure.exception.approver,
		mitigantCodes: failure.exception.mitigants.map((mitigant) => mitigant.code),
		ruleSectionRefs: ruleDefinitionById(failure.ruleId)?.ruleSectionRefs ?? [],
	}));
	const mappedFailures = context.failedRules.filter((failure) => failure.mappingState === "mapped");
	const allowedExists = mappedFailures.some(
		(failure) =>
			failure.exception.state === "allowed" || failure.exception.state === "structural_remedy",
	);
	const regularisationPlanMonths = allowedExists ? 12 : null;

	const openItems: CoreMemoContent["openItems"] = (
		Array.isArray(modelDraft.openItems) ? modelDraft.openItems : []
	).filter((item) => typeof item?.text === "string");
	const addItem = (text: string, code: "failed_rule" | "other"): void => {
		if (!openItems.some((item) => item.text === text)) openItems.push({ text, code });
	};
	for (const ruleId of context.unmappedRuleIds) {
		addItem(
			`Rule ${ruleId} has no registry mapping; policy owner review is required before any exception prose.`,
			"failed_rule",
		);
	}
	for (const ruleId of context.unmappedExceptionRuleIds) {
		addItem(
			`Rule ${ruleId} states the rule but records no exception route; policy owner review is required.`,
			"failed_rule",
		);
	}
	const limitations = context.limitations.join("\n");
	if (/staff|PEP|connected/i.test(limitations)) {
		addItem(
			"Verify committee routing: staff, PEP, and connected-party status is unavailable, so the stated route is a minimum only.",
			"other",
		);
	}
	if (/LTV|collateral/i.test(limitations)) {
		addItem(
			"Collateral value and LTV are unavailable; the unsecured branch applies until a documented value is recorded.",
			"other",
		);
	}
	if (!allowedExists) {
		const nonStandard = mappedFailures.some(
			(failure) =>
				failure.exception.state === "prohibited" ||
				failure.exception.state === "mapping_unavailable",
		);
		addItem(
			nonStandard
				? "No exception route is available for the failed rules; mitigants are not applicable and policy owner review is required for any further step."
				: "This is a standard-authority review trigger; no exception route or mitigant is required.",
			"other",
		);
	}

	// Deterministic rule_breached/mitigants/plan claims: every failed rule and
	// its mapped exception/remedy section is cited even when the model omits
	// one. The model still writes the compensating-factors narrative.
	const pinnedId = context.evaluationId ?? context.decisionId ?? context.applicationId;
	const deterministic = deterministicSectionClaims(context, _evidence);
	const evidenceRefs = new Set(_evidence?.items.map((item) => item.ref) ?? []);
	const ruleClaimsFromContext = context.failedRules
		.filter((failure) => failure.effect !== "informational")
		.map((failure) => {
			const ref = sourceRefKey({
				type: "score_reason",
				scoreId: pinnedId,
				code: `RULE_${failure.reasonCode}`,
			});
			return {
				ref,
				claim: {
					text: `Rule ${failure.ruleId} is recorded with observed ${failure.observed} and threshold ${failure.threshold}.`,
					citations: [
						{
							ref,
							quote: `observed=${failure.observed}; threshold=${failure.threshold}`,
						},
					],
				},
			};
		})
		.filter((entry) => evidenceRefs.has(entry.ref))
		.map((entry) => entry.claim);
	const safeSections: CoreMemoContent["sections"] = (
		Array.isArray(modelDraft.sections) ? modelDraft.sections : []
	).map((section) => {
		const raw = section as unknown as Record<string, unknown>;
		return {
			...(section as CoreMemoContent["sections"][number]),
			title: typeof raw["title"] === "string" ? raw["title"] : "",
			claims: Array.isArray(raw["claims"])
				? (raw["claims"] as CoreMemoContent["sections"][number]["claims"])
				: [],
			notAvailable: raw["notAvailable"] === true,
		};
	});
	const mergeClaims = (
		existing: CoreMemoContent["sections"][number]["claims"],
		extra: CoreMemoContent["sections"][number]["claims"],
	): CoreMemoContent["sections"][number]["claims"] => {
		const seen = new Set(existing.map((claim) => claim.text));
		return [...existing, ...extra.filter((claim) => !seen.has(claim.text))];
	};
	const sections = safeSections.map((section) => {
		if (section.key === "rule_breached") {
			const claims = mergeClaims(
				mergeClaims(section.claims, deterministic.rule),
				ruleClaimsFromContext,
			);
			return claims.length > 0 ? { ...section, claims, notAvailable: false } : section;
		}
		if (section.key === "mitigants") {
			if (!allowedExists) {
				return { ...section, claims: [], notAvailable: true };
			}
			const claims = mergeClaims(section.claims, deterministic.mitigants);
			return claims.length > 0 ? { ...section, claims, notAvailable: false } : section;
		}
		if (section.key === "regularisation_plan") {
			if (!allowedExists) {
				return { ...section, claims: [], notAvailable: true };
			}
			const claims = mergeClaims(section.claims, deterministic.plan);
			return claims.length > 0 ? { ...section, claims, notAvailable: false } : section;
		}
		return section;
	});

	return {
		title: modelDraft.title,
		sections,
		openItems,
		rules,
		regularisationPlanMonths,
	};
}
