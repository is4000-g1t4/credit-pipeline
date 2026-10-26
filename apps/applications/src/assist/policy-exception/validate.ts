// Pure E3 policy-exception validators: no DB, no network, no logging.
//
// Explain/follow-up validate the model's cited prose against the
// deterministic rule context and the case catalog (rule + exception refs and
// sections actually returned by the tools). The memo validator runs the EN-03
// `validateGeneratedText` policy-memo check first, then the E3 section-matrix
// and numeric/approver/mitigant guards. One repair is the orchestrator's job;
// these functions only report typed issues.
import {
	containsAdvisoryActionLanguage,
	containsApplicationReference,
	hasDirectIdentifier,
	locateQuote,
	POLICY_RULE_DEFINITIONS,
	ruleDefinitionById,
	validateGeneratedText,
	parseSourceRef,
	type EvidenceBundle,
	type PolicyRuleDefinition,
} from "@credit/core";
import { z } from "zod";
import type { PolicyExceptionMemoContent } from "./memo.js";
import { sectionKey } from "./tools.js";
import type {
	CaseRuleContext,
	CaseRuleFailure,
	PolicyExplanation,
	PolicyFollowUp,
	PolicySectionDelivery,
	RuleExplanation,
} from "./types.js";

export interface PolicyValidationIssue {
	code: string;
	path: string;
	message: string;
}

export interface PolicyValidateOpts {
	/** Sections returned by search/get during the run (bodies for quotes). */
	policySections?: PolicySectionDelivery[];
	/** Case identity values the prose must not repeat. */
	knownPii?: string[];
}

/** Case-scoped identity values from the evidence bundle. */
export function knownCasePii(evidence: EvidenceBundle): string[] {
	const fields = new Set(["applicantName", "companyName", "registrationNumber"]);
	return evidence.items
		.filter((item) => {
			if (item.sourceType !== "case_fact") return false;
			const field = item.metadata["field"];
			return typeof field === "string" && fields.has(field);
		})
		.map((item) => item.content.trim())
		.filter((value) => value.length >= 4);
}

function checkKnownPii(
	texts: readonly string[],
	path: string,
	issues: PolicyValidationIssue[],
	knownPii: readonly string[],
): void {
	const haystack = texts.join("\n").toLowerCase();
	for (const value of knownPii) {
		if (value.length >= 4 && haystack.includes(value.toLowerCase())) {
			issues.push({
				code: "PII_DETECTED",
				path,
				message: "text repeats a case identity value",
			});
			return;
		}
	}
}

const KNOWN_RULE_IDS = new Set(POLICY_RULE_DEFINITIONS.map((definition) => definition.ruleId));

const explanationCitationSchema = z
	.object({
		policyKey: z.string().min(1).max(80),
		sectionId: z.string().min(1).max(64),
		version: z.string().max(20).optional(),
		quote: z.string().min(1).max(4_000),
		policyVersionId: z.string().max(128).optional(),
		heading: z.string().max(200).optional(),
		effectiveFrom: z.string().max(20).optional(),
		effectiveTo: z.string().max(20).nullable().optional(),
		quoteStart: z.number().int().min(0).optional(),
		quoteEnd: z.number().int().min(0).optional(),
		contentHash: z.string().max(128).optional(),
		drawerToken: z.string().max(4_000).optional(),
	})
	.strict();

const segmentSchema = z
	.object({
		text: z.string().min(1).max(1_200),
		citationIndexes: z.array(z.number().int().min(0).max(32)).min(1).max(5),
	})
	.strict();

const ruleExplanationSchema = z
	.object({
		ruleId: z.string().min(1).max(64),
		segments: z.array(segmentSchema).min(1).max(10),
		citations: z.array(explanationCitationSchema).min(1).max(8),
		confidence: z.enum(["low", "medium", "high"]).catch("medium"),
	})
	.strict();

const explanationSchema = z
	.object({
		status: z.enum(["succeeded", "needs_policy_owner", "no_match"]),
		rules: z.array(ruleExplanationSchema).max(25),
		limitations: z.array(z.string().min(1).max(500)).max(10).default([]),
	})
	.strict();

const followUpSchema = z
	.object({
		status: z.enum(["succeeded", "needs_policy_owner", "no_match"]),
		segments: z.array(segmentSchema).max(10),
		citations: z.array(explanationCitationSchema).max(8),
		limitations: z.array(z.string().min(1).max(500)).max(10).default([]),
	})
	.strict();

function parseRaw(raw: unknown): { ok: true; value: unknown } | { ok: false } {
	try {
		if (typeof raw === "string") {
			const trimmed = raw
				.trim()
				.replace(/^```(?:json)?\s*/i, "")
				.replace(/\s*```$/, "");
			if (trimmed.length === 0) return { ok: false };
			return { ok: true, value: JSON.parse(trimmed) as unknown };
		}
		if (typeof raw === "object" && raw !== null) return { ok: true, value: raw };
		return { ok: false };
	} catch {
		return { ok: false };
	}
}

function schemaIssues(error: z.ZodError, base = ""): PolicyValidationIssue[] {
	return error.issues.map((issue) => ({
		code: "SCHEMA_INVALID",
		path: base
			? `${base}.${issue.path.map(String).join(".")}`
			: issue.path.map(String).join(".") || "_",
		message: issue.message,
	}));
}

type SectionMap = Map<string, PolicySectionDelivery>;

function buildSectionMap(
	catalog: PolicySectionDelivery[],
	extra?: PolicySectionDelivery[],
): { map: SectionMap; retrievedKeys: Set<string> } {
	const map: SectionMap = new Map();
	for (const section of catalog) map.set(sectionKey(section.policyKey, section.sectionId), section);
	const retrievedKeys = new Set<string>();
	for (const section of extra ?? []) {
		const key = sectionKey(section.policyKey, section.sectionId);
		retrievedKeys.add(key);
		if (!map.has(key)) map.set(key, section);
	}
	return { map, retrievedKeys };
}

function allowedRefKeys(context: CaseRuleContext): Set<string> {
	const keys = new Set<string>();
	for (const failure of context.failedRules) {
		const definition = ruleDefinitionById(failure.ruleId);
		if (!definition) continue;
		for (const ref of [...definition.ruleSectionRefs, ...definition.exceptionSectionRefs]) {
			keys.add(sectionKey(ref.policyKey, ref.sectionId));
		}
	}
	return keys;
}

function failedIds(context: CaseRuleContext): Set<string> {
	return new Set(context.failedRules.map((failure) => failure.ruleId));
}

// --- prose scans --------------------------------------------------------

const URL_RE = /https?:\/\/|www\./i;
const APP_REF_RE = /\bAPP-\d{4}-[A-Z2-7]{6}\b/gi;
const RULE_ID_RE = /\b[A-Z]{2,}(?:-[A-Z0-9]{2,})+\b/g;

/** Action language, URLs, foreign APP refs, direct identifiers. */
function scanProse(
	text: string,
	path: string,
	issues: PolicyValidationIssue[],
	context: CaseRuleContext,
): void {
	if (containsAdvisoryActionLanguage(text)) {
		issues.push({
			code: "ACTION_LANGUAGE",
			path,
			message: "text contains decision/approval language",
		});
	}
	if (URL_RE.test(text)) {
		issues.push({ code: "URL_DETECTED", path, message: "text contains a URL" });
	}
	if (containsApplicationReference(text)) {
		const refs = text.match(APP_REF_RE) ?? [];
		const foreign = refs.filter(
			(ref) =>
				context.applicationReference === null ||
				ref.toUpperCase() !== context.applicationReference.toUpperCase(),
		);
		if (foreign.length > 0) {
			issues.push({
				code: "FOREIGN_REFERENCE",
				path,
				message: "text references another application",
			});
		}
	}
	if (hasDirectIdentifier(text)) {
		issues.push({ code: "PII_DETECTED", path, message: "text contains a direct identifier" });
	}
}

/** Registry rule ids and POL-CR keys that do not belong to this case. */
function scanCaseScope(
	text: string,
	path: string,
	issues: PolicyValidationIssue[],
	context: CaseRuleContext,
	allowedKeys: Set<string>,
): void {
	const withoutAppRefs = text.replace(APP_REF_RE, " ");
	for (const match of withoutAppRefs.match(RULE_ID_RE) ?? []) {
		if (match.startsWith("POL-CR-")) continue;
		if (KNOWN_RULE_IDS.has(match as never)) {
			if (!failedIds(context).has(match)) {
				issues.push({
					code: "FOREIGN_RULE",
					path,
					message: `rule ${match} is not a failed rule of this case`,
				});
			}
		} else {
			issues.push({ code: "UNKNOWN_RULE", path, message: `unknown rule id ${match}` });
		}
	}
	for (const match of text.matchAll(
		/\b(POL-CR-\d{3})\b(?:\s*(?:#|section)\s*(\d+(?:\.\d+)?))?/gi,
	)) {
		const key = match[1]!.toUpperCase();
		const section = match[2];
		let known = false;
		for (const allowed of allowedKeys) {
			if (section !== undefined ? allowed === `${key}#${section}` : allowed.startsWith(`${key}#`)) {
				known = true;
				break;
			}
		}
		if (!known) {
			issues.push({
				code: "FOREIGN_SECTION",
				path,
				message: `policy ${key}${section ? `#${section}` : ""} is outside this case`,
			});
		}
	}
}

// --- numeric / approver / mitigant guard ----------------------------------

type Unit = "percent" | "bps" | "pp" | "months" | "years" | "money" | "ratio" | "score";

interface NumToken {
	value: number;
	unit: Unit;
}

const NUM_RE =
	/S\$\s*([\d,]+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*-?\s*(%|percent(?:age\s*points?)?|bps|basis\s*points?|pp|months?|years?|x)(?![A-Za-z0-9_])/gi;
const SCORE_RE = /\b(?:score|assessment value|credit assessment)\D{0,12}(\d{3})\b/gi;

function extractNumericTokens(text: string): NumToken[] {
	const tokens: NumToken[] = [];
	for (const match of text.matchAll(NUM_RE)) {
		if (match[1] !== undefined) {
			tokens.push({ value: Math.round(Number(match[1].replaceAll(",", "")) * 100), unit: "money" });
			continue;
		}
		const rawUnit = (match[3] ?? "").toLowerCase().replace(/\s+/g, " ");
		const value = Number(match[2]);
		if (!Number.isFinite(value)) continue;
		if (rawUnit === "%" || rawUnit.startsWith("percent")) tokens.push({ value, unit: "percent" });
		else if (rawUnit === "bps" || rawUnit.startsWith("basis")) tokens.push({ value, unit: "bps" });
		else if (rawUnit === "pp") tokens.push({ value, unit: "pp" });
		else if (rawUnit === "x") tokens.push({ value, unit: "ratio" });
		else if (rawUnit.startsWith("year")) tokens.push({ value, unit: "years" });
		else tokens.push({ value, unit: "months" });
	}
	for (const match of text.matchAll(SCORE_RE)) {
		const value = Number(match[1]);
		if (Number.isFinite(value)) tokens.push({ value, unit: "score" });
	}
	return tokens;
}

/** Threshold displays such as "580–699", "12–60 months", "S$1,000–S$25,000"
 * carry endpoints without a unit on every number. Add those endpoints with
 * the threshold's unit so a correct prose restatement is not rejected. */
function rawThresholdTokens(text: string): NumToken[] {
	const unit: Unit = /%/.test(text)
		? "percent"
		: /bps|basis/i.test(text)
			? "bps"
			: /months?/i.test(text)
				? "months"
				: /years?/i.test(text)
					? "years"
					: /S\$/.test(text)
						? "money"
						: /\d\s*x/i.test(text)
							? "ratio"
							: "score";
	const tokens: NumToken[] = [];
	for (const match of text.matchAll(/[\d,]+(?:\.\d+)?/g)) {
		const value = Number(match[0].replaceAll(",", ""));
		if (!Number.isFinite(value)) continue;
		tokens.push({
			value: unit === "money" ? Math.round(value * 100) : value,
			unit,
		});
	}
	return tokens;
}

function allowedTokensFor(failure: CaseRuleFailure): NumToken[] {
	const texts = [
		failure.observed,
		failure.threshold,
		failure.exception.reason ?? "",
		failure.explanationLimitation ?? "",
		...failure.exception.mitigants.map((mitigant) => mitigant.label),
		...failure.exception.conditions,
	];
	if (failure.exception.regularisationPlanMaxMonths !== null) {
		texts.push(`${failure.exception.regularisationPlanMaxMonths} months`);
	}
	const tokens = texts.flatMap(extractNumericTokens);
	tokens.push(...rawThresholdTokens(failure.observed));
	tokens.push(...rawThresholdTokens(failure.threshold));
	return tokens;
}

function checkNumerics(
	text: string,
	path: string,
	issues: PolicyValidationIssue[],
	allowed: NumToken[],
): void {
	for (const candidate of extractNumericTokens(text)) {
		const ok = allowed.some(
			(token) =>
				token.unit === candidate.unit &&
				(token.unit === "money"
					? token.value === candidate.value
					: Math.abs(token.value - candidate.value) < 1e-9),
		);
		if (!ok) {
			issues.push({
				code: "NUMERIC_MISMATCH",
				path,
				message: "numeric value does not match the rule observed/threshold/exception path",
			});
			return;
		}
	}
}

const APPROVER_RE = /single[\s_-]*officer|team[\s_-]*manager|credit[\s_-]*committee/gi;

function approverLevelOf(mention: string): "single_officer" | "team_manager" | "credit_committee" {
	const lowered = mention.toLowerCase();
	if (lowered.startsWith("single")) return "single_officer";
	if (lowered.startsWith("team")) return "team_manager";
	return "credit_committee";
}

/** An approver mention must equal the deterministic approver. A
 * "minimum"-qualified mention is allowed only when it names the expected
 * level or a higher one: it never lets a lower approver pass as final. */
function checkApprovers(
	text: string,
	path: string,
	issues: PolicyValidationIssue[],
	expected: Set<"single_officer" | "team_manager" | "credit_committee" | null>,
): void {
	const mentions = text.match(APPROVER_RE) ?? [];
	if (mentions.length === 0) return;
	const minimumQualified =
		/\bminimum\b/i.test(text) && /\b(?:verify|verification|confirm|confirmed)\b/i.test(text);
	const rank = {
		single_officer: 0,
		team_manager: 1,
		credit_committee: 2,
	} as const;
	const expectedLevels = [...expected].filter(
		(level): level is "single_officer" | "team_manager" | "credit_committee" => level !== null,
	);
	if (expectedLevels.length === 0) {
		issues.push({
			code: "APPROVER_MISMATCH",
			path,
			message: "no approver is defined for this rule",
		});
		return;
	}
	const minimumExpected = Math.min(...expectedLevels.map((level) => rank[level]));
	const matches = mentions.some((mention) => {
		const level = approverLevelOf(mention);
		return minimumQualified ? rank[level] >= minimumExpected : expected.has(level);
	});
	if (!matches) {
		issues.push({
			code: "APPROVER_MISMATCH",
			path,
			message: "no approver mention matches the deterministic exception path",
		});
	}
}

const MITIGANT_RE =
	/pricing\s*uplift|limit\s*reduction|exposure\s*reduction|collateral\s*top-?up|director\s*guarantee|reviewable|dual\s*sign|mitigant/i;

function checkMitigants(
	text: string,
	path: string,
	issues: PolicyValidationIssue[],
	failures: CaseRuleFailure[],
): void {
	if (!MITIGANT_RE.test(text)) return;
	// "No mitigants apply" / "mitigants are not applicable" is a negative
	// statement, not a claim that a mitigant exists.
	if (
		/\b(?:no|not|without|never)\b[^.]{0,80}\b(?:mitigant|pricing uplift|limit reduction|collateral top-?up|director guarantee|reviewable|dual sign)/i.test(
			text,
		)
	) {
		return;
	}
	const mentioned = new Set(
		(text.match(RULE_ID_RE) ?? []).filter((ruleId) => !ruleId.startsWith("POL-CR-")),
	);
	const relevant =
		mentioned.size > 0 ? failures.filter((failure) => mentioned.has(failure.ruleId)) : failures;
	const anyMitigants = relevant.some((failure) => failure.exception.mitigants.length > 0);
	if (!anyMitigants) {
		issues.push({
			code: "MITIGANT_MISMATCH",
			path,
			message: "mitigant claim has no deterministic exception path behind it",
		});
	}
}

// --- citation checks -------------------------------------------------------

interface ModelCitation {
	policyKey: string;
	sectionId: string;
	quote: string;
}

function checkCitation(
	citation: ModelCitation,
	path: string,
	issues: PolicyValidationIssue[],
	sections: SectionMap,
	retrievedKeys: Set<string>,
	definition: PolicyRuleDefinition | undefined,
): PolicySectionDelivery | null {
	const key = sectionKey(citation.policyKey, citation.sectionId);
	const section = sections.get(key);
	if (!section) {
		issues.push({
			code: "CITATION_NOT_FROM_TOOL",
			path,
			message: "citation section was not returned by a policy tool for this case",
		});
		return null;
	}
	if (citation.quote.trim().length < 20) {
		issues.push({
			code: "QUOTE_TOO_SHORT",
			path,
			message: "citation quote is below 20 characters",
		});
		return null;
	}
	if (!locateQuote(section.body, citation.quote)) {
		issues.push({
			code: "CITATION_QUOTE_MISMATCH",
			path,
			message: "citation quote is not an exact excerpt of the section",
		});
		return null;
	}
	if (definition) {
		const inRule = definition.ruleSectionRefs.some(
			(ref) => sectionKey(ref.policyKey, ref.sectionId) === key,
		);
		const inException = definition.exceptionSectionRefs.some(
			(ref) => sectionKey(ref.policyKey, ref.sectionId) === key,
		);
		if (!inRule && !inException) {
			issues.push({
				code: "CITATION_SECTION_MISMATCH",
				path,
				message: "citation section is outside the rule mapping",
			});
		} else if (!inRule && !retrievedKeys.has(key)) {
			issues.push({
				code: "CITATION_NOT_FROM_TOOL",
				path,
				message: "exception-path citation was not fetched by a policy tool",
			});
		}
	}
	return section;
}

function failureFor(context: CaseRuleContext, ruleId: string): CaseRuleFailure | undefined {
	return context.failedRules.find((failure) => failure.ruleId === ruleId);
}

function requiredRuleIds(context: CaseRuleContext): string[] {
	return context.failedRules
		.filter(
			(failure) =>
				failure.decisionRelevant &&
				failure.mappingState === "mapped" &&
				failure.effect !== "informational",
		)
		.map((failure) => failure.ruleId);
}

/** Deterministic citation coverage: append a cited segment for each required
 * rule/exception section the model omitted. The quote is a safe sentence from
 * the canonical body, so the added prose is grounded and scanned. */
function ensureSectionCitations(
	segments: Array<{ text: string; citationIndexes: number[] }>,
	citations: RuleExplanation["citations"],
	refs: ReadonlyArray<{ policyKey: string; sectionId: string }>,
	catalog: SectionMap,
): void {
	for (const ref of refs) {
		if (
			citations.some(
				(citation) => citation.policyKey === ref.policyKey && citation.sectionId === ref.sectionId,
			)
		) {
			continue;
		}
		const section = catalog.get(sectionKey(ref.policyKey, ref.sectionId));
		if (!section) continue;
		const quote = safePolicyQuote(section.body);
		if (!quote) continue;
		const index = citations.length;
		citations.push({
			policyKey: section.policyKey,
			sectionId: section.sectionId,
			version: section.version,
			quote,
			policyVersionId: section.policyVersionId,
			heading: section.heading,
			effectiveFrom: section.effectiveFrom,
			effectiveTo: section.effectiveTo,
			drawerToken: section.drawerToken,
		});
		segments.push({ text: quote, citationIndexes: [index] });
	}
}

function safePolicyQuote(body: string): string | null {
	const sentences = body
		.split(/(?<=[.!?])\s+|\n+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length >= 20 && sentence.length <= 500);
	const allowed: string[] = [];
	for (const sentence of sentences) {
		if (containsAdvisoryActionLanguage(sentence)) continue;
		if (containsApplicationReference(sentence)) continue;
		if (hasDirectIdentifier(sentence)) continue;
		if (/\bPOL-CR-\d{3}\b/.test(sentence)) continue;
		allowed.push(sentence);
	}
	const neutral = allowed.find(
		(sentence) => !/single[\s_-]*officer|team[\s_-]*manager|credit[\s_-]*committee/i.test(sentence),
	);
	if (neutral ?? allowed[0]) return neutral ?? allowed[0] ?? null;
	// A section can be entirely action/approver/policy-reference prose (for
	// example POL-CR-001 1.2). Fall back to an exact clause that is still a
	// substring of the body and free of the scanned words.
	const clauses = body
		.split(/(?<=[.;])\s+|\n+|\s*\(/g)
		.map((clause) => clause.trim())
		.filter((clause) => clause.length >= 20 && clause.length <= 500);
	return (
		clauses.find(
			(clause) =>
				!containsAdvisoryActionLanguage(clause) &&
				!containsApplicationReference(clause) &&
				!hasDirectIdentifier(clause) &&
				!/\bPOL-CR-\d{3}\b/.test(clause),
		) ?? null
	);
}

// --- explain ---------------------------------------------------------------

export function validateExplanation(
	raw: unknown,
	context: CaseRuleContext,
	catalog: PolicySectionDelivery[],
	opts: PolicyValidateOpts = {},
): { ok: boolean; answer?: PolicyExplanation; issues: PolicyValidationIssue[] } {
	const issues: PolicyValidationIssue[] = [];
	const parsedRaw = parseRaw(raw);
	if (!parsedRaw.ok) {
		return {
			ok: false,
			issues: [{ code: "SCHEMA_INVALID", path: "_", message: "output is not strict JSON" }],
		};
	}
	const parsed = explanationSchema.safeParse(parsedRaw.value);
	if (!parsed.success) return { ok: false, issues: schemaIssues(parsed.error) };
	const answer = parsed.data;
	const allowedKeys = allowedRefKeys(context);
	const requiredNow = requiredRuleIds(context);
	if (answer.status !== "succeeded" && requiredNow.length === 0) {
		if (answer.rules.length > 0) {
			issues.push({ code: "STATUS_MISMATCH", path: "rules", message: "non-success has no rules" });
		}
		for (const [index, limitation] of answer.limitations.entries()) {
			scanProse(limitation, `limitations.${index}`, issues, context);
			scanCaseScope(limitation, `limitations.${index}`, issues, context, allowedKeys);
		}
		checkKnownPii([...answer.limitations], "limitations", issues, opts.knownPii ?? []);
		return {
			ok: issues.length === 0,
			answer: issues.length === 0 ? (answer as PolicyExplanation) : undefined,
			issues,
		};
	}
	// A mapped failed rule must be explained. If the model answered
	// no_match/needs_policy_owner anyway, the server composes the factual rule
	// entries below rather than dropping a decision driver.
	if (answer.status !== "succeeded") answer.status = "succeeded";

	const { map, retrievedKeys } = buildSectionMap(catalog, opts.policySections);
	const required = requiredRuleIds(context);
	const catalogTokens = [...map.values()].flatMap((section) => extractNumericTokens(section.body));
	const allApprovers = new Set(
		context.failedRules
			.filter((failure) => failure.mappingState === "mapped")
			.map((failure) => failure.exception.approver),
	);
	const seen = new Set<string>();
	for (const [index, entry] of answer.rules.entries()) {
		const base = `rules.${index}`;
		if (seen.has(entry.ruleId)) {
			issues.push({
				code: "RULE_COVERAGE",
				path: `${base}.ruleId`,
				message: "duplicate rule explanation",
			});
			continue;
		}
		seen.add(entry.ruleId);
		const definition = ruleDefinitionById(entry.ruleId);
		if (!definition) {
			issues.push({ code: "UNKNOWN_RULE", path: `${base}.ruleId`, message: "unknown rule id" });
			continue;
		}
		const failure = failureFor(context, entry.ruleId);
		if (!failure || failure.mappingState !== "mapped") {
			issues.push({
				code: "UNMAPPED_RULE",
				path: `${base}.ruleId`,
				message: "rule is not a mapped failed rule of this case",
			});
			continue;
		}
		if (failure.effect === "informational") {
			issues.push({
				code: "INFORMATIONAL_RULE",
				path: `${base}.ruleId`,
				message: "informational triggers are not explained as rules",
			});
			continue;
		}
		for (const [citationIndex, citation] of entry.citations.entries()) {
			checkCitation(
				citation,
				`${base}.citations.${citationIndex}`,
				issues,
				map,
				retrievedKeys,
				definition,
			);
		}
		const allowed = [...allowedTokensFor(failure), ...catalogTokens];
		const expectedApprover = allApprovers;
		for (const [segmentIndex, segment] of entry.segments.entries()) {
			const path = `${base}.segments.${segmentIndex}`;
			for (const citationIndex of segment.citationIndexes) {
				if (citationIndex >= entry.citations.length) {
					issues.push({
						code: "CITATION_MISSING",
						path: `${path}.citationIndexes`,
						message: "citation index is out of range",
					});
				}
			}
			scanProse(segment.text, `${path}.text`, issues, context);
			checkKnownPii([segment.text], `${path}.text`, issues, opts.knownPii ?? []);
			scanCaseScope(segment.text, `${path}.text`, issues, context, allowedKeys);
			checkNumerics(segment.text, `${path}.text`, issues, allowed);
			checkApprovers(segment.text, `${path}.text`, issues, expectedApprover);
			checkMitigants(segment.text, `${path}.text`, issues, context.failedRules);
		}
	}
	for (const id of required) {
		if (seen.has(id)) continue;
		const failure = failureFor(context, id);
		if (!failure) continue;
		const sectionRef = failure.ruleSectionRefs[0];
		if (!sectionRef) continue;
		const section = map.get(sectionKey(sectionRef.policyKey, sectionRef.sectionId));
		if (!section) continue;
		const quote = safePolicyQuote(section.body);
		if (!quote) continue;
		answer.rules.push({
			ruleId: id,
			segments: [
				{
					text: quote,
					citationIndexes: [0],
				},
			],
			citations: [
				{
					policyKey: section.policyKey,
					sectionId: section.sectionId,
					version: section.version,
					quote,
					policyVersionId: section.policyVersionId,
					heading: section.heading,
					effectiveFrom: section.effectiveFrom,
					effectiveTo: section.effectiveTo,
					drawerToken: section.drawerToken,
				},
			],
			confidence: "low",
		});
		seen.add(id);
	}
	for (const [index, limitation] of answer.limitations.entries()) {
		scanProse(limitation, `limitations.${index}`, issues, context);
		checkKnownPii([limitation], `limitations.${index}`, issues, opts.knownPii ?? []);
	}
	// Deterministic citation coverage: append grounded, pre-validated quotes
	// for any required rule/exception section the model omitted. This runs
	// only after validation so added prose cannot bypass the guards.
	if (issues.length === 0) {
		for (const entry of answer.rules) {
			const failure = failureFor(context, entry.ruleId);
			if (!failure) continue;
			ensureSectionCitations(entry.segments, entry.citations, failure.ruleSectionRefs, map);
			const exceptionRefs =
				failure.exception.state === "allowed" || failure.exception.state === "structural_remedy"
					? failure.exception.citations
					: failure.exception.citations.filter(
							(ref) => !(ref.policyKey === "POL-CR-005" && ref.sectionId === "5.1"),
						);
			ensureSectionCitations(entry.segments, entry.citations, exceptionRefs, map);
		}
	}
	return {
		ok: issues.length === 0,
		answer: issues.length === 0 ? (answer as PolicyExplanation) : undefined,
		issues,
	};
}

// --- follow-up ---------------------------------------------------------------

export function validateFollowUp(
	raw: unknown,
	context: CaseRuleContext,
	catalog: PolicySectionDelivery[],
	opts: PolicyValidateOpts = {},
): { ok: boolean; answer?: PolicyFollowUp; issues: PolicyValidationIssue[] } {
	const issues: PolicyValidationIssue[] = [];
	const parsedRaw = parseRaw(raw);
	if (!parsedRaw.ok) {
		return {
			ok: false,
			issues: [{ code: "SCHEMA_INVALID", path: "_", message: "output is not strict JSON" }],
		};
	}
	const parsed = followUpSchema.safeParse(parsedRaw.value);
	if (!parsed.success) return { ok: false, issues: schemaIssues(parsed.error) };
	const answer = parsed.data;
	if (answer.status !== "succeeded") {
		if (answer.segments.length > 0) {
			issues.push({
				code: "STATUS_MISMATCH",
				path: "segments",
				message: "non-success has no segments",
			});
		}
		for (const [index, limitation] of answer.limitations.entries()) {
			scanProse(limitation, `limitations.${index}`, issues, context);
		}
		checkKnownPii([...answer.limitations], "limitations", issues, opts.knownPii ?? []);
		return {
			ok: issues.length === 0,
			answer: issues.length === 0 ? (answer as PolicyFollowUp) : undefined,
			issues,
		};
	}
	if (answer.segments.length === 0) {
		issues.push({
			code: "CITATION_MISSING",
			path: "segments",
			message: "a succeeded follow-up needs a segment",
		});
	}

	const { map, retrievedKeys } = buildSectionMap(catalog, opts.policySections);
	const allowedKeys = allowedRefKeys(context);
	const mappedFailures = context.failedRules.filter((failure) => failure.mappingState === "mapped");
	const mappedDefs = new Map(
		mappedFailures.map((failure) => failure.ruleId).map((id) => [id, ruleDefinitionById(id)]),
	);
	const unionAllowed = mappedFailures.flatMap(allowedTokensFor);
	for (const section of map.values()) {
		unionAllowed.push(...extractNumericTokens(section.body));
	}
	const unionApprovers = new Set(mappedFailures.map((failure) => failure.exception.approver));
	for (const [citationIndex, citation] of answer.citations.entries()) {
		const path = `citations.${citationIndex}`;
		const key = sectionKey(citation.policyKey, citation.sectionId);
		const section = map.get(key);
		if (!section) {
			issues.push({
				code: "CITATION_NOT_FROM_TOOL",
				path,
				message: "citation section was not returned by a policy tool for this case",
			});
			continue;
		}
		if (citation.quote.trim().length < 20) {
			issues.push({
				code: "QUOTE_TOO_SHORT",
				path,
				message: "citation quote is below 20 characters",
			});
			continue;
		}
		if (!locateQuote(section.body, citation.quote)) {
			issues.push({
				code: "CITATION_QUOTE_MISMATCH",
				path,
				message: "citation quote is not an exact excerpt of the section",
			});
			continue;
		}
		let inScope = false;
		let needsFetched = true;
		for (const definition of mappedDefs.values()) {
			if (!definition) continue;
			if (
				definition.ruleSectionRefs.some((ref) => sectionKey(ref.policyKey, ref.sectionId) === key)
			) {
				inScope = true;
				needsFetched = false;
				break;
			}
			if (
				definition.exceptionSectionRefs.some(
					(ref) => sectionKey(ref.policyKey, ref.sectionId) === key,
				)
			) {
				inScope = true;
			}
		}
		if (!inScope) {
			issues.push({
				code: "CITATION_SECTION_MISMATCH",
				path,
				message: "citation section is outside the case rule mappings",
			});
		} else if (needsFetched && !retrievedKeys.has(key)) {
			issues.push({
				code: "CITATION_NOT_FROM_TOOL",
				path,
				message: "exception-path citation was not fetched by a policy tool",
			});
		}
	}
	for (const [segmentIndex, segment] of answer.segments.entries()) {
		const path = `segments.${segmentIndex}`;
		for (const citationIndex of segment.citationIndexes) {
			if (citationIndex >= answer.citations.length) {
				issues.push({
					code: "CITATION_MISSING",
					path: `${path}.citationIndexes`,
					message: "citation index is out of range",
				});
			}
		}
		scanProse(segment.text, `${path}.text`, issues, context);
		checkKnownPii([segment.text], `${path}.text`, issues, opts.knownPii ?? []);
		scanCaseScope(segment.text, `${path}.text`, issues, context, allowedKeys);
		checkNumerics(segment.text, `${path}.text`, issues, unionAllowed);
		checkApprovers(segment.text, `${path}.text`, issues, unionApprovers);
		checkMitigants(segment.text, `${path}.text`, issues, mappedFailures);
	}
	for (const [index, limitation] of answer.limitations.entries()) {
		scanProse(limitation, `limitations.${index}`, issues, context);
		scanCaseScope(limitation, `limitations.${index}`, issues, context, allowedKeys);
		checkKnownPii([limitation], `limitations.${index}`, issues, opts.knownPii ?? []);
	}
	if (issues.length === 0) {
		for (const failure of mappedFailures) {
			ensureSectionCitations(answer.segments, answer.citations, failure.ruleSectionRefs, map);
			const exceptionRefs =
				failure.exception.state === "allowed" || failure.exception.state === "structural_remedy"
					? failure.exception.citations
					: failure.exception.citations.filter(
							(ref) => !(ref.policyKey === "POL-CR-005" && ref.sectionId === "5.1"),
						);
			ensureSectionCitations(answer.segments, answer.citations, exceptionRefs, map);
		}
	}
	return {
		ok: issues.length === 0,
		answer: issues.length === 0 ? (answer as PolicyFollowUp) : undefined,
		issues,
	};
}

// --- memo --------------------------------------------------------------------

const memoRuleSchema = z
	.object({
		ruleId: z.string().min(1).max(64),
		reasonCode: z.string().min(1).max(64),
		observed: z.string().min(1).max(200),
		threshold: z.string().min(1).max(200),
		effect: z.enum(["decline", "refer", "informational"]),
		persisted: z.boolean(),
		exceptionState: z.enum([
			"allowed",
			"prohibited",
			"not_applicable",
			"structural_remedy",
			"mapping_unavailable",
		]),
		approver: z.enum(["single_officer", "team_manager", "credit_committee"]).nullable(),
		mitigantCodes: z.array(z.string().min(1).max(80)).max(10),
		ruleSectionRefs: z
			.array(z.object({ policyKey: z.string(), sectionId: z.string() }).strict())
			.max(10),
	})
	.strict();

const composedMemoSchema = z
	.object({
		title: z.string().min(1).max(200),
		sections: z.array(z.unknown()).min(4).max(4),
		openItems: z.array(z.unknown()).max(50),
		rules: z.array(memoRuleSchema).max(25),
		regularisationPlanMonths: z.number().int().min(0).max(60).nullable(),
	})
	.loose();

const PLAN_SECTIONS = new Set(["5.1", "2.2", "3.1"]);

export function validatePolicyMemoDraft(
	raw: unknown,
	context: CaseRuleContext,
	catalog: PolicySectionDelivery[],
	evidence: import("@credit/core").EvidenceBundle,
): { ok: boolean; content?: PolicyExceptionMemoContent; issues: PolicyValidationIssue[] } {
	const issues: PolicyValidationIssue[] = [];
	const parsedRaw = parseRaw(raw);
	if (!parsedRaw.ok) {
		return {
			ok: false,
			issues: [{ code: "SCHEMA_INVALID", path: "_", message: "output is not strict JSON" }],
		};
	}
	const composed = composedMemoSchema.safeParse(parsedRaw.value);
	if (!composed.success) {
		return { ok: false, issues: schemaIssues(composed.error) };
	}
	const draft = composed.data as {
		title: string;
		sections: Array<{
			key: string;
			title: string;
			claims: Array<{ text: string; citations: unknown[] }>;
			notAvailable: boolean;
		}>;
		openItems: Array<{ text: string; code: string; sourceRef?: string }>;
		rules: z.infer<typeof memoRuleSchema>[];
		regularisationPlanMonths: number | null;
	};

	// The server-composed block must cover every failed rule before any prose
	// check runs: a missing rule is a deterministic bug, not a model repair.
	const ruleIds = new Set(draft.rules.map((rule) => rule.ruleId));
	for (const failure of context.failedRules) {
		if (!ruleIds.has(failure.ruleId)) {
			issues.push({
				code: "RULE_COVERAGE",
				path: "rules",
				message: `failed rule ${failure.ruleId} is missing from the composed block`,
			});
		}
	}
	const mappedFailures = context.failedRules.filter((failure) => failure.mappingState === "mapped");
	const allowedExists = mappedFailures.some(
		(failure) =>
			failure.exception.state === "allowed" || failure.exception.state === "structural_remedy",
	);
	if (draft.regularisationPlanMonths !== null && draft.regularisationPlanMonths > 12) {
		issues.push({
			code: "PLAN_MONTHS",
			path: "regularisationPlanMonths",
			message: "regularisation plan exceeds 12 months",
		});
	}
	if (!allowedExists && draft.regularisationPlanMonths !== null) {
		issues.push({
			code: "PLAN_MONTHS",
			path: "regularisationPlanMonths",
			message: "regularisation plan requires an allowed exception",
		});
	}
	if (allowedExists && draft.regularisationPlanMonths !== 12) {
		issues.push({
			code: "PLAN_MONTHS",
			path: "regularisationPlanMonths",
			message: "regularisation plan must be 12 months for an allowed exception",
		});
	}

	// EN-03 schema/citation/PII scans on the model-written part only. The
	// server-composed `rules` block is structured metadata, never prose.
	const coreChecked = validateGeneratedText({
		artifactType: "policy_exception_memo",
		content: { title: draft.title, sections: draft.sections, openItems: draft.openItems },
		evidence,
	});
	if (!coreChecked.ok) {
		for (const issue of coreChecked.issues) {
			issues.push({ code: issue.code, path: issue.path, message: issue.message });
		}
		return { ok: false, issues: issues.slice(0, 100) };
	}

	const { map } = buildSectionMap(catalog, []);
	const allowedKeys = allowedRefKeys(context);
	const byKey = new Map(draft.sections.map((section) => [section.key, section]));
	const openTexts = draft.openItems.map((item) => item.text).join("\n");
	const ruleBreached = byKey.get("rule_breached");
	const mitigants = byKey.get("mitigants");
	const regularisation = byKey.get("regularisation_plan");
	if (!ruleBreached || !mitigants || !regularisation || !byKey.has("compensating_factors")) {
		issues.push({
			code: "SECTION_STATE",
			path: "sections",
			message: "memo must carry all four sections",
		});
		return { ok: false, issues };
	}
	if (mappedFailures.length > 0 && ruleBreached.notAvailable) {
		issues.push({
			code: "SECTION_STATE",
			path: "sections.rule_breached",
			message: "rule_breached is never notAvailable when mapped failures exist",
		});
	}
	if (allowedExists) {
		if (mitigants.notAvailable || mitigants.claims.length === 0) {
			issues.push({
				code: "SECTION_STATE",
				path: "sections.mitigants",
				message: "mitigants must carry claims for an allowed/structural exception",
			});
		}
	} else if (!mitigants.notAvailable || !/mitigant|exception|policy owner/i.test(openTexts)) {
		issues.push({
			code: "SECTION_STATE",
			path: "sections.mitigants",
			message: "mitigants must be notAvailable with an open item otherwise",
		});
	}
	// Every decision-relevant rule appears in rule_breached claims or an open
	// item (the composed open items cover unmapped rules).
	const breachTexts = ruleBreached.claims.map((claim) => claim.text).join("\n");
	for (const failure of context.failedRules) {
		if (!failure.decisionRelevant || failure.effect === "informational") continue;
		if (!breachTexts.includes(failure.ruleId) && !openTexts.includes(failure.ruleId)) {
			issues.push({
				code: "RULE_COVERAGE",
				path: "sections.rule_breached",
				message: `decision-relevant rule ${failure.ruleId} appears in neither claims nor open items`,
			});
		}
	}
	// A claimed regularisation plan cites the exception/remedy section.
	if (!regularisation.notAvailable && regularisation.claims.length > 0) {
		let cited = false;
		for (const claim of regularisation.claims) {
			for (const citation of claim.citations) {
				const ref = (citation as { ref?: unknown }).ref;
				if (typeof ref !== "string") continue;
				const parsedRef = parseSourceRef(ref);
				if (parsedRef?.type === "policy_section" && PLAN_SECTIONS.has(parsedRef.sectionId))
					cited = true;
			}
		}
		if (!cited) {
			issues.push({
				code: "CITATION_SECTION_MISMATCH",
				path: "sections.regularisation_plan",
				message: "regularisation plan must cite 5.1, 2.2, or 3.1",
			});
		}
	}

	const unionAllowed = mappedFailures.flatMap(allowedTokensFor);
	for (const section of map.values()) {
		unionAllowed.push(...extractNumericTokens(section.body));
	}
	for (const item of evidence.items) {
		unionAllowed.push(...extractNumericTokens(item.content));
	}
	const unionApprovers = new Set(mappedFailures.map((failure) => failure.exception.approver));
	draft.sections.forEach((section, sectionIndex) => {
		scanProse(section.title, `sections.${sectionIndex}.title`, issues, context);
		section.claims.forEach((claim, claimIndex) => {
			const path = `sections.${sectionIndex}.claims.${claimIndex}.text`;
			scanProse(claim.text, path, issues, context);
			scanCaseScope(claim.text, path, issues, context, allowedKeys);
			checkNumerics(claim.text, path, issues, unionAllowed);
			checkApprovers(claim.text, path, issues, unionApprovers);
			checkMitigants(claim.text, path, issues, mappedFailures);
			// Whitespace-tolerant quote check against the catalog body; the
			// EN-03 exact check against evidence already passed above.
			for (const citation of claim.citations) {
				const ref = (citation as { ref?: unknown; quote?: unknown }).ref;
				const quote = (citation as { quote?: unknown }).quote;
				if (typeof ref !== "string" || typeof quote !== "string") continue;
				const parsedRef = parseSourceRef(ref);
				if (parsedRef?.type !== "policy_section") continue;
				const body = map.get(sectionKey(parsedRef.policyKey, parsedRef.sectionId))?.body;
				if (body && !locateQuote(body, quote)) {
					issues.push({
						code: "CITATION_QUOTE_MISMATCH",
						path,
						message: "citation quote diverges from the catalog section",
					});
				}
			}
		});
	});
	draft.openItems.forEach((item, index) => {
		const path = `openItems.${index}.text`;
		scanProse(item.text, path, issues, context);
		scanCaseScope(item.text, path, issues, context, allowedKeys);
	});
	scanProse(draft.title, "title", issues, context);

	return {
		ok: issues.length === 0,
		content: issues.length === 0 ? (parsedRaw.value as PolicyExceptionMemoContent) : undefined,
		issues: issues.slice(0, 100),
	};
}
