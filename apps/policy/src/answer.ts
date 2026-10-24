import { createHash, createHmac } from "node:crypto";
import { locateQuote } from "@credit/core";
import { z } from "zod";
import { documentRef, signalRef, type PolicyCaseContext } from "./case-context.js";
import { EMAIL_RE, NRIC_RE, PHONE_RE } from "./gates.js";

export interface RetrievedSection {
	policyId: string;
	policyVersionId: string;
	policyKey: string;
	title: string;
	sectionId: string;
	heading: string;
	version: string;
	effectiveFrom: string;
	effectiveTo: string | null;
	body: string;
	policyFamily: string;
	productScope: string;
	jurisdiction: string;
}

export interface AnswerCitation {
	policyId: string;
	policyKey: string;
	policyVersionId: string;
	sectionId: string;
	heading: string;
	version: string;
	effectiveFrom: string;
	effectiveTo: string | null;
	quote: string;
	quoteStart: number;
	quoteEnd: number;
	contentHash: string;
	drawerToken: string;
}

export interface AnswerSegment {
	text: string;
	citationIndexes: number[];
}

export type NavigatorStatus =
	| "succeeded"
	| "no_match"
	| "needs_policy_owner"
	| "out_of_scope"
	| "identifier_blocked"
	| "rate_limited"
	| "budget_exceeded"
	| "failed";

export interface NavigatorAnswer {
	status: NavigatorStatus;
	segments: AnswerSegment[];
	citations: AnswerCitation[];
	limitations: string[];
}

export interface CaseAnswerItem {
	ref: string;
	explanationSegments: AnswerSegment[];
	citations: AnswerCitation[];
	confidence: "low" | "medium" | "high";
}

export interface CaseAnswer {
	status: "succeeded" | "no_match" | "needs_policy_owner";
	summary?: string;
	items: CaseAnswerItem[];
	limitations: string[];
}

const modelCitationSchema = z
	.object({
		policyKey: z.string().min(1).max(40),
		sectionId: z.string().min(1).max(64),
		version: z.string().min(1).max(20).optional(),
		quote: z.string().min(20).max(1_000),
	})
	.strict();

const modelSegmentSchema = z
	.object({
		text: z.string().min(1).max(400),
		citationIndexes: z.array(z.number().int().min(0).max(99)).min(1).max(3),
	})
	.strict();

export const navigatorModelSchema = z
	.object({
		status: z.enum(["succeeded", "no_match", "needs_policy_owner"]),
		segments: z.array(modelSegmentSchema).max(12).default([]),
		citations: z.array(modelCitationSchema).max(12).default([]),
		limitations: z.array(z.string().max(600)).max(8).default([]),
	})
	.strict();

export const caseModelSchema = z
	.object({
		status: z.enum(["succeeded", "no_match", "needs_policy_owner"]),
		summary: z.string().max(600).optional(),
		items: z
			.array(
				z
					.object({
						ref: z.string().min(1).max(300),
						explanationSegments: z.array(modelSegmentSchema).max(6).default([]),
						citations: z.array(modelCitationSchema).max(12).default([]),
						confidence: z.enum(["low", "medium", "high"]).default("low"),
					})
					.strict(),
			)
			.max(50)
			.default([]),
		limitations: z.array(z.string().max(600)).max(8).default([]),
	})
	.strict();

const URL_RE = /https?:\/\/|www\.[a-z0-9]/i;
const DECISION_RE =
	/\b(I|we)\s+(approve|decline|recommend|suggest)\b|\b(you|we)\s+should\s+(approve|decline)\b/i;

/** One claim per segment, one sentence terminator. Decimal points and
 * abbreviations without a following space do not count; common spaced
 * abbreviations (i.e., e.g., etc.) are stripped first. */
export function isSingleClaim(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed.length > 400) return false;
	const cleaned = trimmed.replace(/\b(i\.e|e\.g|viz|etc)\./gi, "$1");
	const terminators = cleaned.match(/[.!?](?=\s|$)/g) ?? [];
	return terminators.length <= 1;
}

export function containsForbidden(text: string): boolean {
	return EMAIL_RE.test(text) || PHONE_RE.test(text) || NRIC_RE.test(text) || URL_RE.test(text);
}

/** First-person/imperative decision language. Policy facts such as "a breach
 * is a hard decline" are allowed; "we approve this" is not. */
export function containsDecisionLanguage(text: string): boolean {
	return DECISION_RE.test(text);
}

/** Limitations are rendered to officers; drop unsafe ones rather than fail an
 * otherwise valid answer. */
function safeLimitations(limitations: string[]): string[] {
	return limitations.filter(
		(limitation) => !containsForbidden(limitation) && !containsDecisionLanguage(limitation),
	);
}

export function createDrawerToken(
	secret: string,
	input: { versionId: string; sectionId: string; asOf: string; queryId: string },
	ttlSeconds = 900,
	now = Date.now(),
): string {
	const exp = Math.floor(now / 1000) + ttlSeconds;
	const payload = [input.versionId, input.sectionId, input.asOf, String(exp)].join("\n");
	const sig = createHmac("sha256", secret).update(payload).digest("base64url");
	return Buffer.from(
		JSON.stringify({
			v: input.versionId,
			s: input.sectionId,
			a: input.asOf,
			e: exp,
			q: input.queryId,
			sig,
		}),
	).toString("base64url");
}

export function verifyDrawerToken(
	secret: string,
	token: string,
	input: { versionId: string; sectionId: string },
	now = Date.now(),
): { asOf: string } | null {
	let parsed: { v?: string; s?: string; a?: string; e?: number; sig?: string };
	try {
		parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as typeof parsed;
	} catch {
		return null;
	}
	if (parsed.v !== input.versionId || parsed.s !== input.sectionId) return null;
	if (typeof parsed.a !== "string") return null;
	if (!Number.isFinite(parsed.e) || (parsed.e as number) * 1000 < now) return null;
	const payload = [parsed.v, parsed.s, parsed.a, String(parsed.e)].join("\n");
	const expected = createHmac("sha256", secret).update(payload).digest("base64url");
	const a = Buffer.from(parsed.sig ?? "");
	const b = Buffer.from(expected);
	if (a.length !== b.length || !a.equals(b)) return null;
	return { asOf: parsed.a };
}

function findRetrieved(
	retrieved: RetrievedSection[],
	citation: z.infer<typeof modelCitationSchema>,
): RetrievedSection | null {
	const candidates = retrieved.filter(
		(section) =>
			section.policyKey === citation.policyKey && section.sectionId === citation.sectionId,
	);
	if (candidates.length === 0) return null;
	if (citation.version) {
		return candidates.find((section) => section.version === citation.version) ?? null;
	}
	return candidates.length === 1 ? (candidates[0] as RetrievedSection) : null;
}

function validateSegment(
	segment: z.infer<typeof modelSegmentSchema>,
	citations: z.infer<typeof modelCitationSchema>[],
	retrieved: RetrievedSection[],
	secret: string,
	asOf: string,
	queryId: string,
): { segment: AnswerSegment; citations: AnswerCitation[] } | null {
	if (!isSingleClaim(segment.text)) return null;
	if (containsForbidden(segment.text)) return null;
	const indexes = new Set(segment.citationIndexes);
	if (indexes.size !== segment.citationIndexes.length) return null;
	const out: AnswerCitation[] = [];
	for (const index of segment.citationIndexes) {
		const raw = citations[index];
		if (!raw) return null;
		const section = findRetrieved(retrieved, raw);
		if (!section) return null;
		const located = locateQuote(section.body, raw.quote, { minLength: 20 });
		if (!located) return null;
		if (containsForbidden(raw.quote) || containsForbidden(located.quote)) return null;
		out.push({
			policyId: section.policyId,
			policyKey: section.policyKey,
			policyVersionId: section.policyVersionId,
			sectionId: section.sectionId,
			heading: section.heading,
			version: section.version,
			effectiveFrom: section.effectiveFrom,
			effectiveTo: section.effectiveTo,
			quote: located.quote,
			quoteStart: located.quoteStart,
			quoteEnd: located.quoteEnd,
			contentHash: createHash("sha256").update(section.body).digest("hex"),
			drawerToken: createDrawerToken(secret, {
				versionId: section.policyVersionId,
				sectionId: section.sectionId,
				asOf,
				queryId,
			}),
		});
	}
	return { segment: { text: segment.text.trim(), citationIndexes: [] }, citations: out };
}

function reindexSegments(
	validated: Array<{ segment: AnswerSegment; citations: AnswerCitation[] }>,
): { segments: AnswerSegment[]; citations: AnswerCitation[] } {
	const citations: AnswerCitation[] = [];
	const keyToIndex = new Map<string, number>();
	const segments = validated.map(({ segment, citations: segmentCitations }) => {
		const indexes = segmentCitations.map((citation) => {
			const key = `${citation.policyVersionId}:${citation.sectionId}:${citation.quote}`;
			const existing = keyToIndex.get(key);
			if (existing !== undefined) return existing;
			const index = citations.length;
			citations.push(citation);
			keyToIndex.set(key, index);
			return index;
		});
		return { text: segment.text, citationIndexes: indexes };
	});
	return { segments, citations };
}

export function validateNavigatorAnswer(
	output: unknown,
	retrieved: RetrievedSection[],
	opts: { secret: string; asOf: string; queryId: string },
):
	| { ok: true; answer: NavigatorAnswer; errors: [] }
	| { ok: false; answer: NavigatorAnswer; errors: string[] } {
	const parsed = navigatorModelSchema.safeParse(output);
	if (!parsed.success) {
		return {
			ok: false,
			answer: { status: "needs_policy_owner", segments: [], citations: [], limitations: [] },
			errors: ["model output failed schema validation"],
		};
	}
	const data = parsed.data;
	if (data.status !== "succeeded") {
		return {
			ok: true,
			answer: {
				status: data.status,
				segments: [],
				citations: [],
				limitations: safeLimitations(data.limitations),
			},
			errors: [],
		};
	}
	if (data.segments.length === 0) {
		return {
			ok: false,
			answer: {
				status: "needs_policy_owner",
				segments: [],
				citations: [],
				limitations: safeLimitations(data.limitations),
			},
			errors: ["answer has no segments"],
		};
	}
	const validated: Array<{ segment: AnswerSegment; citations: AnswerCitation[] }> = [];
	const errors: string[] = [];
	for (const [i, segment] of data.segments.entries()) {
		const result = validateSegment(
			segment,
			data.citations,
			retrieved,
			opts.secret,
			opts.asOf,
			opts.queryId,
		);
		if (!result) {
			errors.push(`segment ${i} has no valid citation or is not a single claim`);
			continue;
		}
		validated.push(result);
	}
	if (errors.length > 0 || validated.length !== data.segments.length) {
		return {
			ok: false,
			answer: {
				status: "needs_policy_owner",
				segments: [],
				citations: [],
				limitations: safeLimitations(data.limitations),
			},
			errors,
		};
	}
	const { segments, citations } = reindexSegments(validated);
	return {
		ok: true,
		answer: {
			status: "succeeded",
			segments,
			citations,
			limitations: safeLimitations(data.limitations),
		},
		errors: [],
	};
}

export function validateCaseAnswer(
	output: unknown,
	context: PolicyCaseContext,
	retrieved: RetrievedSection[],
	opts: { secret: string; asOf: string; queryId: string },
):
	| { ok: true; answer: CaseAnswer; errors: [] }
	| { ok: false; answer: CaseAnswer; errors: string[] } {
	const parsed = caseModelSchema.safeParse(output);
	if (!parsed.success) {
		return {
			ok: false,
			answer: { status: "needs_policy_owner", items: [], limitations: [] },
			errors: ["model output failed schema validation"],
		};
	}
	const data = parsed.data;
	if (data.status !== "succeeded") {
		return {
			ok: true,
			answer: {
				status: data.status,
				summary: data.summary,
				items: [],
				limitations: safeLimitations(data.limitations),
			},
			errors: [],
		};
	}
	const validRefs = new Set([
		...context.signals.map((signal) => signalRef(signal)),
		...context.documentFindings.map((finding) => documentRef(finding)),
	]);
	const items: CaseAnswerItem[] = [];
	const errors: string[] = [];
	for (const [i, item] of data.items.entries()) {
		if (!validRefs.has(item.ref)) {
			errors.push(`item ${i} has an unknown ref`);
			continue;
		}
		if (item.explanationSegments.length === 0) {
			errors.push(`item ${item.ref} has no explanation`);
			continue;
		}
		const validated: Array<{ segment: AnswerSegment; citations: AnswerCitation[] }> = [];
		let itemFailed = false;
		for (const segment of item.explanationSegments) {
			const result = validateSegment(
				segment,
				item.citations,
				retrieved,
				opts.secret,
				opts.asOf,
				opts.queryId,
			);
			if (!result) {
				itemFailed = true;
				break;
			}
			validated.push(result);
		}
		if (itemFailed || validated.length === 0) {
			errors.push(`item ${item.ref} has an invalid segment/citation`);
			continue;
		}
		const { segments, citations } = reindexSegments(validated);
		items.push({
			ref: item.ref,
			explanationSegments: segments,
			citations,
			confidence: item.confidence,
		});
	}
	if (items.length === 0) {
		return {
			ok: false,
			answer: {
				status: "needs_policy_owner",
				summary: data.summary,
				items: [],
				limitations: safeLimitations(data.limitations),
			},
			errors: errors.length > 0 ? errors : ["no valid case items"],
		};
	}
	return {
		ok: true,
		answer: {
			status: "succeeded",
			summary: data.summary,
			items,
			limitations: [
				...safeLimitations(data.limitations),
				...errors.map((error) => `Dropped: ${error}`),
			],
		},
		errors: [],
	};
}
