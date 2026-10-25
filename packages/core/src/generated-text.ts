// EN-03 — shared generated-text validator (pure).
//
// Every generated artifact is validated before it is persisted: strict
// per-type schema, citation existence + exact-quote match against the EN-01
// evidence bundle, a decision-language scan, and PII / protected-attribute
// scans. Failure returns typed issues, never a partially persisted artifact.
import { z } from "zod";
import {
	evidenceIndex,
	parseSourceRef,
	type EvidenceBundle,
	type UnavailableSource,
} from "./evidence.js";

export const ARTIFACT_TYPES = [
	"credit_memo",
	"policy_exception_memo",
	"adverse_action_letter",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const VALIDATION_CODES = [
	"SCHEMA_INVALID",
	"UNSUPPORTED_CLAIM",
	"CITATION_MALFORMED",
	"CITATION_MISSING",
	"CITATION_UNAVAILABLE",
	"CITATION_QUOTE_MISMATCH",
	"DECISION_LANGUAGE",
	"PII_DETECTED",
	"PROTECTED_ATTRIBUTE",
] as const;

export type ValidationCode = (typeof VALIDATION_CODES)[number];

export const citationSchema = z
	.object({
		ref: z.string().min(1).max(500),
		quote: z
			.string()
			.min(1)
			.max(4_000)
			.refine((value) => value.trim().length >= 1, "quote must contain a token"),
	})
	.strict();

export type Citation = z.infer<typeof citationSchema>;

export interface CitationRecord extends Citation {
	/** Content path, e.g. `sections.2.claims.0.citations.0`. */
	path: string;
}

export interface ValidationIssue {
	code: ValidationCode;
	path: string;
	message: string;
}

const claimSchema = z
	.object({
		text: z.string().min(1).max(1_200),
		citations: z.array(citationSchema).max(5),
	})
	.strict();

export const MEMO_SECTION_KEYS = [
	"request",
	"entity",
	"financial_summary",
	"strengths",
	"risks",
	"policy_compliance",
] as const;

export const POLICY_EXCEPTION_SECTION_KEYS = [
	"rule_breached",
	"compensating_factors",
	"mitigants",
	"regularisation_plan",
] as const;

const OPEN_ITEM_CODES = [
	"missing_document",
	"stale_document",
	"failed_rule",
	"unsupported_claim",
	"contradiction",
	"financials_unavailable",
	"other",
] as const;

export const openItemSchema = z
	.object({
		text: z.string().min(1).max(500),
		code: z.enum(OPEN_ITEM_CODES),
		sourceRef: z.string().min(1).max(500).optional(),
	})
	.strict();

export type OpenItem = z.infer<typeof openItemSchema>;

function sectionSchema<const K extends readonly [string, ...string[]]>(keys: K) {
	return z
		.object({
			key: z.enum(keys),
			title: z.string().min(1).max(120),
			claims: z.array(claimSchema).max(20),
			notAvailable: z.boolean().default(false),
		})
		.strict()
		.superRefine((section, ctx) => {
			if (section.notAvailable && section.claims.length > 0) {
				ctx.addIssue({
					code: "custom",
					path: ["claims"],
					message: "a not-available section cannot assert claims",
				});
			}
			if (!section.notAvailable && section.claims.length === 0) {
				ctx.addIssue({
					code: "custom",
					path: ["claims"],
					message: "an empty section must be marked notAvailable",
				});
			}
		});
}

function sectionsSchema<const K extends readonly [string, ...string[]]>(keys: K) {
	return z
		.array(sectionSchema(keys))
		.length(keys.length)
		.superRefine((sections, ctx) => {
			const seen = new Set<string>();
			for (const [index, section] of sections.entries()) {
				if (seen.has(section.key)) {
					ctx.addIssue({
						code: "custom",
						path: [index, "key"],
						message: `duplicate section ${section.key}`,
					});
				}
				seen.add(section.key);
			}
			for (const key of keys) {
				if (!seen.has(key)) {
					ctx.addIssue({ code: "custom", path: [], message: `missing section ${key}` });
				}
			}
		});
}

export const creditMemoContentSchema = z
	.object({
		title: z.string().min(1).max(200),
		sections: sectionsSchema(MEMO_SECTION_KEYS),
		openItems: z.array(openItemSchema).max(50),
		officerQuestions: z.array(z.string().min(1).max(500)).max(20),
	})
	.strict();

export type CreditMemoContent = z.infer<typeof creditMemoContentSchema>;

export const policyExceptionMemoContentSchema = z
	.object({
		title: z.string().min(1).max(200),
		sections: sectionsSchema(POLICY_EXCEPTION_SECTION_KEYS),
		openItems: z.array(openItemSchema).max(50),
	})
	.strict();

export type PolicyExceptionMemoContent = z.infer<typeof policyExceptionMemoContentSchema>;

export const adverseActionLetterContentSchema = z
	.object({
		title: z.string().min(1).max(200),
		applicantName: z.string().min(1).max(200),
		/** Structured outcome, not scanned as free text. */
		decision: z.enum(["declined", "not_successful"]),
		principalReasons: z
			.array(
				z
					.object({
						code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
						text: z.string().min(1).max(500),
						citations: z.array(citationSchema).min(1).max(5),
					})
					.strict(),
			)
			.min(3)
			.max(4),
		notices: z.array(z.string().min(1).max(1_000)).max(10),
		contactPath: z.string().min(1).max(300),
		openItems: z.array(openItemSchema).max(20).default([]),
	})
	.strict();

export type AdverseActionLetterContent = z.infer<typeof adverseActionLetterContentSchema>;

export type GeneratedContent =
	| CreditMemoContent
	| PolicyExceptionMemoContent
	| AdverseActionLetterContent;

export type ValidationResult =
	| { ok: true; artifactType: ArtifactType; content: GeneratedContent; citations: CitationRecord[] }
	| { ok: false; issues: ValidationIssue[] };

const SCHEMAS = {
	credit_memo: creditMemoContentSchema,
	policy_exception_memo: policyExceptionMemoContentSchema,
	adverse_action_letter: adverseActionLetterContentSchema,
} as const;

const DECISION_LANGUAGE_RE =
	/\b(?:approv(?:e|ed|es|al|ing)|declin(?:e|ed|es|ing)|reject(?:ed|ion|ing|s)?|recommend(?:ed|ation|ations|ing|s)?|decision(?:s)?|scor(?:e|ed|es|ing)|rat(?:e|ed|es|ing)|limit(?:s|ed)?|terms?)\b/i;

const PROTECTED_ATTRIBUTE_RE =
	/\b(?:gender|male|female|sex|sexual|age|ages|aged|race|racial|ethnicity|ethnic|religion|religious|marital|married|divorced|single|nationality|national origin|citizenship|disabilit(?:y|ies)|disabled|pregnan(?:t|cy)|genetic|veteran|date of birth|dob)\b/i;

/** Underscores/hyphens are word characters for `\b`; normalise identifiers
 * so `marital_status`, `decision_language`, and `long-term` cannot slip past. */
function scanNormalize(text: string): string {
	return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll(/[_-]+/g, " ");
}

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const NRIC_RE = /\b[STFGM]\d{7}[A-Z]\b/i;
const PHONE_RE = /(?:\+?65[\s-]?)?[689]\d{3}[\s-]?\d{4}\b/;
const LONG_ID_RE = /\b(?:\d[ -]?){10,19}\b/;

const APP_REFERENCE_RE = /\bAPP-\d{4}-[A-Z2-7]{6}\b/gi;

function hasDirectIdentifier(text: string): boolean {
	// The application reference is a structured case id, not applicant PII.
	const scrubbed = text.replace(APP_REFERENCE_RE, " ");
	return (
		EMAIL_RE.test(scrubbed) ||
		NRIC_RE.test(scrubbed) ||
		PHONE_RE.test(scrubbed) ||
		LONG_ID_RE.test(scrubbed)
	);
}

interface ClaimNode {
	path: string;
	citations: Citation[];
	/** Narrative claims must carry at least one citation. */
	requiresCitation: boolean;
}

interface TextNode {
	path: string;
	text: string;
	/** The dedicated applicant-name field is required in an adverse letter;
	 * direct-identifier regexes still apply, but the known-PII value check
	 * does not. */
	allowKnownPii?: boolean;
	/** A bank contact path may legitimately be an email/hotline. */
	allowContactPii?: boolean;
	/** Adverse-action notices may legitimately say "review this decision". */
	allowDecisionLanguage?: boolean;
}

/** Case-scoped PII values the generated prose must not repeat. The evidence
 * bundle is the only input, so this never needs a second case lookup. */
function knownPii(evidence: EvidenceBundle): string[] {
	const fields = new Set(["applicantName", "companyName", "registrationNumber"]);
	return (
		evidence.items
			.filter((item) => {
				if (item.sourceType !== "case_fact" || item.content.trim().length < 4) return false;
				const parsed = parseSourceRef(item.ref);
				if (parsed !== null && parsed.type === "case_fact") return fields.has(parsed.field);
				const field = item.metadata["field"];
				return typeof field === "string" && fields.has(field);
			})
			.map((item) => item.content.trim())
			// Single common words ("Credit", "Cash", "Financial", "Debt") collide
			// with static memo boilerplate. Multi-word names, identifiers, and
			// long tokens still get the known-PII check.
			.filter((value) => /[\s\d_-]/.test(value) || value.length >= 12)
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function citationNodes(artifactType: ArtifactType, content: GeneratedContent): ClaimNode[] {
	const nodes: ClaimNode[] = [];
	if (artifactType === "adverse_action_letter") {
		const letter = content as AdverseActionLetterContent;
		for (const [index, reason] of letter.principalReasons.entries()) {
			nodes.push({
				path: `principalReasons.${index}`,
				citations: reason.citations,
				requiresCitation: true,
			});
		}
		return nodes;
	}
	const document = content as CreditMemoContent | PolicyExceptionMemoContent;
	for (const [sectionIndex, section] of document.sections.entries()) {
		for (const [claimIndex, claim] of section.claims.entries()) {
			nodes.push({
				path: `sections.${sectionIndex}.claims.${claimIndex}`,
				citations: claim.citations,
				requiresCitation: true,
			});
		}
	}
	return nodes;
}

function openItemRefs(
	artifactType: ArtifactType,
	content: GeneratedContent,
): Array<{ path: string; ref: string }> {
	const refs: Array<{ path: string; ref: string }> = [];
	const items =
		artifactType === "adverse_action_letter"
			? (content as AdverseActionLetterContent).openItems
			: (content as CreditMemoContent | PolicyExceptionMemoContent).openItems;
	for (const [index, item] of items.entries()) {
		if (item.sourceRef !== undefined) {
			refs.push({ path: `openItems.${index}.sourceRef`, ref: item.sourceRef });
		}
	}
	return refs;
}

function textNodes(artifactType: ArtifactType, content: GeneratedContent): TextNode[] {
	const nodes: TextNode[] = [{ path: "title", text: content.title }];
	if (artifactType === "adverse_action_letter") {
		const letter = content as AdverseActionLetterContent;
		nodes.push({ path: "applicantName", text: letter.applicantName, allowKnownPii: true });
		for (const [index, reason] of letter.principalReasons.entries()) {
			nodes.push({ path: `principalReasons.${index}.text`, text: reason.text });
		}
		for (const [index, notice] of letter.notices.entries()) {
			nodes.push({ path: `notices.${index}`, text: notice, allowDecisionLanguage: true });
		}
		nodes.push({ path: "contactPath", text: letter.contactPath, allowContactPii: true });
		for (const [index, item] of letter.openItems.entries()) {
			nodes.push({ path: `openItems.${index}.text`, text: item.text });
		}
		return nodes;
	}
	const document = content as CreditMemoContent | PolicyExceptionMemoContent;
	for (const [sectionIndex, section] of document.sections.entries()) {
		nodes.push({ path: `sections.${sectionIndex}.title`, text: section.title });
		for (const [claimIndex, claim] of section.claims.entries()) {
			nodes.push({ path: `sections.${sectionIndex}.claims.${claimIndex}.text`, text: claim.text });
		}
	}
	for (const [index, item] of document.openItems.entries()) {
		nodes.push({ path: `openItems.${index}.text`, text: item.text });
	}
	if (artifactType === "credit_memo") {
		const memo = content as CreditMemoContent;
		for (const [index, question] of memo.officerQuestions.entries()) {
			nodes.push({ path: `officerQuestions.${index}`, text: question });
		}
	}
	return nodes;
}

function unavailableIssue(source: UnavailableSource): string {
	return `source is ${source.code}`;
}

/** Validate one generated artifact against its evidence bundle. Pure: no DB,
 * no logging, no persistence. The caller persists only when `ok` is true. */
export function validateGeneratedText(input: {
	artifactType: ArtifactType;
	content: unknown;
	evidence: EvidenceBundle;
}): ValidationResult {
	const schema = SCHEMAS[input.artifactType];
	const parsed = schema.safeParse(input.content);
	if (!parsed.success) {
		return {
			ok: false,
			issues: parsed.error.issues.map((issue) => ({
				code: "SCHEMA_INVALID",
				path: issue.path.map(String).join(".") || "_",
				message: issue.message,
			})),
		};
	}
	const content = parsed.data as GeneratedContent;

	const index = evidenceIndex(input.evidence);
	const issues: ValidationIssue[] = [];
	const citations: CitationRecord[] = [];

	if (input.artifactType === "adverse_action_letter") {
		const letter = content as AdverseActionLetterContent;
		const identityFields = new Set(["applicantName", "companyName"]);
		const identities = input.evidence.items
			.filter((item) => {
				if (item.sourceType !== "case_fact" || item.content.trim().length === 0) return false;
				const parsed = parseSourceRef(item.ref);
				if (parsed !== null && parsed.type === "case_fact") {
					return identityFields.has(parsed.field);
				}
				const field = item.metadata["field"];
				return typeof field === "string" && identityFields.has(field);
			})
			.map((item) => item.content.trim().toLowerCase());
		if (identities.length === 0) {
			issues.push({
				code: "CITATION_MISSING",
				path: "applicantName",
				message: "no case identity is available for the letter",
			});
		} else if (!identities.includes(letter.applicantName.trim().toLowerCase())) {
			issues.push({
				code: "CITATION_MISSING",
				path: "applicantName",
				message: "applicant name does not match the case record",
			});
		}
	}

	for (const node of citationNodes(input.artifactType, content)) {
		const seenRefs = new Set<string>();
		for (const citation of node.citations) {
			if (seenRefs.has(citation.ref)) {
				issues.push({
					code: "CITATION_MALFORMED",
					path: node.path,
					message: "duplicate citation ref in one claim",
				});
			}
			seenRefs.add(citation.ref);
		}
		if (node.requiresCitation && node.citations.length === 0) {
			issues.push({
				code: "UNSUPPORTED_CLAIM",
				path: node.path,
				message: "narrative claim has no citation; move it to open items",
			});
		}
		for (const [citationIndex, citation] of node.citations.entries()) {
			const path = `${node.path}.citations.${citationIndex}`;
			const parsedRef = parseSourceRef(citation.ref);
			if (!parsedRef) {
				issues.push({
					code: "CITATION_MALFORMED",
					path,
					message: "citation ref is not a valid source ref",
				});
				continue;
			}
			const item = index.items.get(citation.ref);
			if (!item) {
				const unavailable = index.unavailable.get(citation.ref);
				issues.push({
					code: unavailable ? "CITATION_UNAVAILABLE" : "CITATION_MISSING",
					path,
					message: unavailable
						? unavailableIssue(unavailable)
						: "citation does not exist in the case evidence bundle",
				});
				continue;
			}
			if (item.sourceType !== parsedRef.type) {
				issues.push({
					code: "CITATION_MALFORMED",
					path,
					message: "citation ref type does not match the evidence item",
				});
				continue;
			}
			// A one-character quote is a valid exact span for a structured
			// fact ("4" years), but meaningless for a document/policy/web
			// excerpt.
			if (
				item.sourceType !== "case_fact" &&
				item.sourceType !== "score_reason" &&
				citation.quote.trim().length < 3
			) {
				issues.push({
					code: "CITATION_QUOTE_MISMATCH",
					path,
					message: "citation quote is too short to be a meaningful excerpt",
				});
				continue;
			}
			if (!item.content.includes(citation.quote)) {
				issues.push({
					code: "CITATION_QUOTE_MISMATCH",
					path,
					message: "citation quote is not an exact excerpt of the source",
				});
				continue;
			}
			citations.push({ path, ref: citation.ref, quote: citation.quote });
		}
	}

	for (const node of openItemRefs(input.artifactType, content)) {
		if (!parseSourceRef(node.ref)) {
			issues.push({
				code: "CITATION_MALFORMED",
				path: node.path,
				message: "open-item ref is not a valid source ref",
			});
			continue;
		}
		if (!index.items.has(node.ref) && !index.unavailable.has(node.ref)) {
			issues.push({
				code: "CITATION_MISSING",
				path: node.path,
				message: "open-item ref does not exist in the case evidence bundle",
			});
		}
	}

	const piiValues = knownPii(input.evidence).map((value) => scanNormalize(value).toLowerCase());
	for (const node of textNodes(input.artifactType, content)) {
		const scanned = scanNormalize(node.text);
		if (!node.allowDecisionLanguage && DECISION_LANGUAGE_RE.test(scanned)) {
			issues.push({
				code: "DECISION_LANGUAGE",
				path: node.path,
				message: "text contains decision language",
			});
		}
		if (PROTECTED_ATTRIBUTE_RE.test(scanned)) {
			issues.push({
				code: "PROTECTED_ATTRIBUTE",
				path: node.path,
				message: "text contains a protected attribute or proxy",
			});
		}
		if (!node.allowContactPii && hasDirectIdentifier(node.text)) {
			issues.push({
				code: "PII_DETECTED",
				path: node.path,
				message: "text contains a direct identifier",
			});
		}
		if (!node.allowKnownPii && !node.allowContactPii) {
			const lowered = scanned.toLowerCase();
			if (
				piiValues.some((value) => new RegExp(`\\b${escapeRegExp(value)}\\b`, "i").test(lowered))
			) {
				issues.push({
					code: "PII_DETECTED",
					path: node.path,
					message: "text repeats a case-scoped PII value",
				});
			}
		}
	}

	if (issues.length > 0) return { ok: false, issues: issues.slice(0, 100) };
	return { ok: true, artifactType: input.artifactType, content, citations };
}
