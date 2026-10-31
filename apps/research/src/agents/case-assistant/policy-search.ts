// Policy-search bridge helpers (agent-private): the exact request body the
// policy service expects, identity scrubbing for model-authored queries, and
// compaction/citation of the sections that come back.
import { scrubKnownPii } from "@credit/core";
import type { CaseAssistantPolicyRef } from "./types.js";

/** Only sections the answer actually cites: the drawer must never imply a
 * source the assistant did not use. */
export function citedPolicyRefs(
	answer: string,
	refs: CaseAssistantPolicyRef[],
): CaseAssistantPolicyRef[] {
	return refs.filter(
		(ref) =>
			answer.includes(`${ref.policyKey} §${ref.sectionId}`) ||
			answer.includes(`${ref.policyKey} ${ref.sectionId}`),
	);
}

export interface PolicySearchBody {
	applicationId: string;
	actorId: string;
	actorRole: string;
	policyAsOf: string;
	productScope: "sme" | "individual";
	query: string;
	topK: number;
}

/** Exact bridge body the policy search expects; pure for tests. */
export function buildPolicySearchBody(input: {
	applicationId: string;
	actorId: string;
	actorRole: string;
	asOfDate: string;
	caseType: unknown;
	query: string;
}): PolicySearchBody {
	return {
		applicationId: input.applicationId,
		actorId: input.actorId,
		actorRole: input.actorRole,
		policyAsOf: input.asOfDate,
		productScope: input.caseType === "sme" ? "sme" : "individual",
		query: input.query,
		topK: 4,
	};
}

/** Scrub known case identity before a model-authored query leaves for the
 * policy embedder. Direct identifiers are rejected by the policy service;
 * names and UENs are not, so scrub them here. */
export function policySearchQuery(query: string, caseFacts: Record<string, unknown>): string {
	const known = ["applicantName", "companyName", "registrationNumber", "city"]
		.map((key) => caseFacts[key])
		.filter((v): v is string => typeof v === "string" && v.trim().length >= 3);
	return scrubKnownPii(query, known);
}

export interface PolicySectionRow {
	policyKey?: unknown;
	sectionId?: unknown;
	heading?: unknown;
	version?: unknown;
	effectiveFrom?: unknown;
	policyVersionId?: unknown;
	body?: unknown;
	drawerToken?: unknown;
}

/** Compact a policy section for the model; the quote is the body head only. */
export function compactPolicySection(row: PolicySectionRow): {
	section: Record<string, unknown>;
	ref: CaseAssistantPolicyRef | null;
} {
	if (
		typeof row.policyKey !== "string" ||
		typeof row.sectionId !== "string" ||
		typeof row.policyVersionId !== "string"
	) {
		return { section: { unavailable: true }, ref: null };
	}
	const body = typeof row.body === "string" ? row.body : "";
	const ref: CaseAssistantPolicyRef = {
		policyKey: row.policyKey,
		sectionId: row.sectionId,
		heading: typeof row.heading === "string" ? row.heading : "",
		version: typeof row.version === "string" ? row.version : "",
		effectiveFrom: typeof row.effectiveFrom === "string" ? row.effectiveFrom : "",
		policyVersionId: row.policyVersionId,
		quote: body.slice(0, 600),
		drawerToken: typeof row.drawerToken === "string" ? row.drawerToken : "",
	};
	return {
		section: {
			policyKey: ref.policyKey,
			sectionId: ref.sectionId,
			heading: ref.heading,
			version: ref.version,
			effectiveFrom: ref.effectiveFrom,
			policyVersionId: ref.policyVersionId,
			quote: ref.quote,
			drawerToken: ref.drawerToken,
		},
		ref,
	};
}
