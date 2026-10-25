// EN-01 — case evidence bundle and citation contract (pure).
//
// A source ref is the stable, serialisable identity of one evidence span.
// Ref keys are deterministic: the same case + source span always produces the
// same key, so an artifact can be re-validated after a reload. Missing and
// unavailable sources are first-class typed entries, never silently dropped.
import { createHash } from "node:crypto";
import { z } from "zod";

export const SOURCE_TYPES = [
	"document",
	"context_signal",
	"external_evidence",
	"policy_section",
	"score_reason",
	"case_fact",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export const UNAVAILABLE_CODES = [
	"missing",
	"unavailable",
	"retention_expired",
	"access_denied",
] as const;

export type UnavailableCode = (typeof UNAVAILABLE_CODES)[number];

const uuid = z.uuid();
const offset = z.number().int().min(0);
const page = z.number().int().min(1);
const sectionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const quoteHash = z.string().regex(/^[a-f0-9]{16,64}$/);
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const caseField = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,80}$/);

export const documentSourceRefSchema = z
	.object({
		type: z.literal("document"),
		documentFileId: uuid,
		pageNumber: page,
		offsetStart: offset,
		offsetEnd: offset,
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.offsetStart >= value.offsetEnd) {
			ctx.addIssue({ code: "custom", message: "offsetStart must be < offsetEnd" });
		}
	});

export const contextSignalSourceRefSchema = z
	.object({
		type: z.literal("context_signal"),
		signalRef: z.string().min(1).max(300),
	})
	.strict();

export const externalEvidenceSourceRefSchema = z
	.object({
		type: z.literal("external_evidence"),
		evidenceId: uuid,
	})
	.strict();

export const policySectionSourceRefSchema = z
	.object({
		type: z.literal("policy_section"),
		policyKey: z.string().min(1).max(80),
		policyVersionId: uuid,
		sectionId,
		quoteHash,
	})
	.strict();

export const scoreReasonSourceRefSchema = z
	.object({
		type: z.literal("score_reason"),
		scoreId: uuid,
		code: reasonCode,
	})
	.strict();

export const caseFactSourceRefSchema = z
	.object({
		type: z.literal("case_fact"),
		applicationId: uuid,
		field: caseField,
	})
	.strict();

/** The stable sourceRef union. `case_fact` is the case-scoped structured
 * extension (request/entity fields); the five backlog sources are the rest. */
export const sourceRefSchema = z.discriminatedUnion("type", [
	documentSourceRefSchema,
	contextSignalSourceRefSchema,
	externalEvidenceSourceRefSchema,
	policySectionSourceRefSchema,
	scoreReasonSourceRefSchema,
	caseFactSourceRefSchema,
]);

export type SourceRef = z.infer<typeof sourceRefSchema>;

const DOCUMENT_RE = /^document:([0-9a-f-]{36}):p(\d+):(\d+)-(\d+)$/i;
const CONTEXT_PREFIX = "context_signal:";
const EXTERNAL_PREFIX = "external_evidence:";
const POLICY_RE =
	/^policy_section:([A-Za-z0-9][A-Za-z0-9._-]{0,79}):([0-9a-f-]{36}):([A-Za-z0-9][A-Za-z0-9._-]{0,63}):([a-f0-9]{16,64})$/i;
const SCORE_RE = /^score_reason:([0-9a-f-]{36}):([A-Z][A-Z0-9_]{0,63})$/;
const CASE_FACT_RE = /^case_fact:([0-9a-f-]{36}):([A-Za-z][A-Za-z0-9_.]{0,80})$/;

/** Canonical ref key. Never contains PII: ids, field names, and hashes only. */
export function sourceRefKey(ref: SourceRef): string {
	switch (ref.type) {
		case "document":
			return `document:${ref.documentFileId}:p${ref.pageNumber}:${ref.offsetStart}-${ref.offsetEnd}`;
		case "context_signal":
			return `${CONTEXT_PREFIX}${ref.signalRef}`;
		case "external_evidence":
			return `${EXTERNAL_PREFIX}${ref.evidenceId}`;
		case "policy_section":
			return `policy_section:${ref.policyKey}:${ref.policyVersionId}:${ref.sectionId}:${ref.quoteHash}`;
		case "score_reason":
			return `score_reason:${ref.scoreId}:${ref.code}`;
		case "case_fact":
			return `case_fact:${ref.applicationId}:${ref.field}`;
	}
}

/** Inverse of `sourceRefKey`; null for a malformed or unknown key. */
export function parseSourceRef(key: string): SourceRef | null {
	const document = DOCUMENT_RE.exec(key);
	if (document) {
		const parsed = documentSourceRefSchema.safeParse({
			type: "document",
			documentFileId: document[1],
			pageNumber: Number(document[2]),
			offsetStart: Number(document[3]),
			offsetEnd: Number(document[4]),
		});
		return parsed.success ? parsed.data : null;
	}
	if (key.startsWith(CONTEXT_PREFIX)) {
		const signalRef = key.slice(CONTEXT_PREFIX.length);
		const parsed = contextSignalSourceRefSchema.safeParse({ type: "context_signal", signalRef });
		return parsed.success ? parsed.data : null;
	}
	if (key.startsWith(EXTERNAL_PREFIX)) {
		const evidenceId = key.slice(EXTERNAL_PREFIX.length);
		const parsed = externalEvidenceSourceRefSchema.safeParse({
			type: "external_evidence",
			evidenceId,
		});
		return parsed.success ? parsed.data : null;
	}
	const policy = POLICY_RE.exec(key);
	if (policy) {
		const parsed = policySectionSourceRefSchema.safeParse({
			type: "policy_section",
			policyKey: policy[1],
			policyVersionId: policy[2],
			sectionId: policy[3],
			quoteHash: policy[4].toLowerCase(),
		});
		return parsed.success ? parsed.data : null;
	}
	const score = SCORE_RE.exec(key);
	if (score) {
		const parsed = scoreReasonSourceRefSchema.safeParse({
			type: "score_reason",
			scoreId: score[1],
			code: score[2],
		});
		return parsed.success ? parsed.data : null;
	}
	const fact = CASE_FACT_RE.exec(key);
	if (fact) {
		const parsed = caseFactSourceRefSchema.safeParse({
			type: "case_fact",
			applicationId: fact[1],
			field: fact[2],
		});
		return parsed.success ? parsed.data : null;
	}
	return null;
}

export const evidenceAccessSchema = z
	.object({
		retentionUntil: z.iso.datetime().nullable(),
		legalHold: z.boolean(),
	})
	.strict();

export type EvidenceAccess = z.infer<typeof evidenceAccessSchema>;

const metadataValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const evidenceItemSchema = z
	.object({
		ref: z.string().min(1).max(500),
		sourceType: z.enum(SOURCE_TYPES),
		label: z.string().min(1).max(200),
		/** Exact source excerpt (or structured case value). Citation quotes
		 * must be an exact substring of this string. */
		content: z.string().min(1),
		access: evidenceAccessSchema,
		metadata: z.record(z.string(), metadataValue).default({}),
	})
	.strict();

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const unavailableSourceSchema = z
	.object({
		ref: z.string().min(1).max(500),
		sourceType: z.enum(SOURCE_TYPES),
		code: z.enum(UNAVAILABLE_CODES),
		detail: z.string().max(300).optional(),
	})
	.strict();

export type UnavailableSource = z.infer<typeof unavailableSourceSchema>;

export const evidenceBundleSchema = z
	.object({
		applicationId: uuid,
		/** Case as-of, ISO instant (the submitted-at clock). */
		asOf: z.iso.datetime(),
		assembledAt: z.iso.datetime(),
		items: z.array(evidenceItemSchema).max(500),
		unavailable: z.array(unavailableSourceSchema).max(100),
	})
	.strict();

export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

/** Index a bundle by ref key; duplicate refs keep the first item. */
export function evidenceIndex(bundle: EvidenceBundle): {
	items: Map<string, EvidenceItem>;
	unavailable: Map<string, UnavailableSource>;
} {
	const items = new Map<string, EvidenceItem>();
	for (const item of bundle.items) if (!items.has(item.ref)) items.set(item.ref, item);
	const unavailable = new Map<string, UnavailableSource>();
	for (const item of bundle.unavailable)
		if (!unavailable.has(item.ref)) unavailable.set(item.ref, item);
	return { items, unavailable };
}

/** Short, stable hash used in policy source refs. */
export function hashQuote(quote: string): string {
	return createHash("sha256").update(quote, "utf8").digest("hex").slice(0, 32);
}
