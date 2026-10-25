// US-ADV-1/2 deterministic adverse-action letter builder.
//
// Pure: no clock, no DB, no logging. Inputs are the terminal decision, its
// reasons, the case row, the latest score, and the case evidence bundle. The
// reason text comes only from the EN-08 taxonomy; citations must be exact
// evidence items. Everything fails closed before persistence.
import {
	evidenceIndex,
	sourceRefKey,
	selectAdverseReasons,
	validateAdverseJurisdictionProfile,
	validateAdverseLetterContent,
	type AdverseActionLetterContent,
	type AdverseJurisdictionProfile,
	type AdverseReasonFacts,
	type EvidenceBundle,
	type EvidenceItem,
	type SelectedPrincipalReason,
} from "@credit/core";
import type { applications, decisions, scores } from "@credit/db/applications";

export interface BuildAdverseLetterInput {
	application: typeof applications.$inferSelect;
	decision: typeof decisions.$inferSelect;
	score: typeof scores.$inferSelect | null;
	evidence: EvidenceBundle;
	profile: AdverseJurisdictionProfile;
	contactPath: string;
}

export interface AdverseLetterBuildFailure {
	code: "NOT_DECLINED" | "NEEDS_OFFICER_INPUT" | "FAIR_LENDING_BLOCKED" | "DISCLOSURE_UNAVAILABLE";
	detail: string;
	reasonCodes?: string[];
	unmappedCodes?: string[];
	missingCitationCodes?: string[];
	terms?: string[];
	issues?: string[];
	requiredMin?: number;
	requiredMax?: number;
}

export type BuildAdverseLetterResult =
	| {
			ok: true;
			content: AdverseActionLetterContent;
			reasons: SelectedPrincipalReason[];
			droppedCodes: string[];
	  }
	| { ok: false; failure: AdverseLetterBuildFailure };

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reason codes frozen into the decision: the decision reasons plus any
 * negative score factors in its snapshot (officer declines carry one generic
 * officer code but the snapshot still holds the specific factors). */
export function decisionReasonCodes(decision: typeof decisions.$inferSelect): string[] {
	const codes: string[] = [];
	const rows = Array.isArray(decision.reasons) ? (decision.reasons as unknown[]) : [];
	for (const row of rows) {
		if (typeof row === "string") {
			codes.push(row);
			continue;
		}
		if (typeof row !== "object" || row === null) continue;
		const code = asText((row as Record<string, unknown>)["code"]);
		if (code !== null) codes.push(code);
	}
	const snapshot = asRecord(decision.snapshot);
	const factors = Array.isArray(snapshot["factors"]) ? (snapshot["factors"] as unknown[]) : [];
	for (const raw of factors) {
		if (typeof raw !== "object" || raw === null) continue;
		const factor = raw as Record<string, unknown>;
		const code = asText(factor["code"]);
		if (code === null) continue;
		const points = asNumber(factor["points"]);
		if (points === null || points >= 0) continue;
		codes.push(code);
	}
	return [...new Set(codes)];
}

/** Policy/scorecard versions frozen into the decision snapshot. */
export function decisionSnapshotVersions(decision: typeof decisions.$inferSelect): {
	policyVersion: string | null;
	scorecardVersion: string | null;
} {
	const snapshot = asRecord(decision.snapshot);
	return {
		policyVersion: asText(snapshot["policyVersion"]),
		scorecardVersion: asText(snapshot["scorecardVersion"]),
	};
}

function reasonRows(decision: typeof decisions.$inferSelect): {
	codes: string[];
	labels: string[];
} {
	const rows = Array.isArray(decision.reasons) ? (decision.reasons as unknown[]) : [];
	const labels: string[] = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const text = asText((row as Record<string, unknown>)["text"]);
		if (text !== null) labels.push(text);
	}
	const snapshot = asRecord(decision.snapshot);
	const factors = Array.isArray(snapshot["factors"]) ? (snapshot["factors"] as unknown[]) : [];
	for (const raw of factors) {
		if (typeof raw !== "object" || raw === null) continue;
		const label = asText((raw as Record<string, unknown>)["label"]);
		if (label !== null) labels.push(label);
	}
	return { codes: decisionReasonCodes(decision), labels };
}

function evidenceNumber(evidence: EvidenceBundle | null, field: string): number | null {
	if (evidence === null) return null;
	for (const item of evidence.items) {
		if (item.sourceType !== "case_fact") continue;
		if (item.metadata["field"] !== field) continue;
		const value = Number(item.content);
		return Number.isFinite(value) ? value : null;
	}
	return null;
}

export function buildAdverseReasonFacts(
	application: typeof applications.$inferSelect,
	decision: typeof decisions.$inferSelect,
	score: typeof scores.$inferSelect | null,
	evidence: EvidenceBundle | null = null,
): AdverseReasonFacts {
	const business = asRecord(application.business);
	const financial = asRecord(application.financial);
	const snapshot = asRecord(decision.snapshot);
	return {
		product: application.product,
		amountCents: asNumber(application.amountCents),
		termMonths: asNumber(application.termMonths),
		annualRevenueCents: asNumber(business["annualRevenueCents"]),
		yearsTrading: asNumber(business["yearsTrading"]),
		employmentYears: asNumber(financial["employmentYears"]),
		bankRelationshipYears: asNumber(financial["bankRelationshipYears"]),
		existingDebtServiceCents:
			asNumber(business["existingDebtServiceCents"]) ?? asNumber(financial["existingDebtCents"]),
		industry: asText(business["industry"]),
		delinquencies: evidenceNumber(evidence, "bureau.delinquencies"),
		utilizationPct: evidenceNumber(evidence, "bureau.utilizationPct"),
		assessmentResult: score?.score ?? asNumber(snapshot["score"]),
	};
}

function applicantNameOf(application: typeof applications.$inferSelect): string | null {
	const identity = asRecord(application.identity);
	const business = asRecord(application.business);
	const fullName = asText(identity["fullName"]);
	const companyName = asText(business["companyName"]);
	if (application.type === "sme") return companyName ?? fullName;
	return fullName;
}

function supportingFactField(code: string): string | null {
	if (code === "DELINQUENCIES") return "bureau.delinquencies";
	if (code === "CREDIT_UTILIZATION") return "bureau.utilizationPct";
	return null;
}

function citationsFor(
	code: string,
	decisionId: string,
	items: Map<string, EvidenceItem>,
): Array<{ ref: string; quote: string }> | null {
	const exactRef = sourceRefKey({ type: "score_reason", scoreId: decisionId, code });
	const exact = items.get(exactRef);
	if (!exact) return null;
	const citations = [{ ref: exact.ref, quote: exact.content }];
	const factField = supportingFactField(code);
	if (factField !== null) {
		for (const item of items.values()) {
			if (item.sourceType !== "case_fact" || item.metadata["field"] !== factField) continue;
			if (!Number.isFinite(Number(item.content))) continue;
			citations.push({ ref: item.ref, quote: item.content });
			break;
		}
	}
	return citations;
}

/**
 * Build the applicant letter from the deterministic decision. `decisionId` is
 * persisted inside the content for audit/traceability; it is structured data,
 * never part of the applicant-facing prose.
 */
export function buildAdverseActionLetter(input: BuildAdverseLetterInput): BuildAdverseLetterResult {
	const { application, decision, score, evidence, profile, contactPath } = input;
	if (decision.outcome !== "declined") {
		return {
			ok: false,
			failure: { code: "NOT_DECLINED", detail: "the decision is not a decline" },
		};
	}
	const profileValidation = validateAdverseJurisdictionProfile(profile);
	if (!profileValidation.ok) {
		return {
			ok: false,
			failure: {
				code: "DISCLOSURE_UNAVAILABLE",
				detail: "the jurisdiction profile is not approved",
				issues: profileValidation.issues.map((issue) => issue.code),
			},
		};
	}
	if (contactPath.trim().length === 0 || contactPath.length > 300) {
		return {
			ok: false,
			failure: {
				code: "DISCLOSURE_UNAVAILABLE",
				detail: "the contact path is missing or too long",
			},
		};
	}
	const applicantName = applicantNameOf(application);
	if (applicantName === null) {
		return {
			ok: false,
			failure: { code: "NEEDS_OFFICER_INPUT", detail: "applicant name is missing" },
		};
	}
	const { codes, labels } = reasonRows(decision);
	if (codes.length === 0) {
		return {
			ok: false,
			failure: {
				code: "NEEDS_OFFICER_INPUT",
				detail: "the decision has no reason codes",
				reasonCodes: [],
			},
		};
	}
	const selection = selectAdverseReasons({
		reasonCodes: codes,
		inputLabels: labels,
		facts: buildAdverseReasonFacts(application, decision, score, evidence),
		profile,
	});
	if (!selection.ok) {
		const failure = selection.failure;
		if (failure.code === "FAIR_LENDING_BLOCKED") {
			return {
				ok: false,
				failure: {
					code: "FAIR_LENDING_BLOCKED",
					detail: `fair-lending ${failure.stage} check blocked the letter`,
					terms: failure.terms,
					reasonCodes: failure.reasonCodes,
				},
			};
		}
		return {
			ok: false,
			failure: {
				code: "NEEDS_OFFICER_INPUT",
				detail: failure.detail,
				reasonCodes: failure.reasonCodes,
				unmappedCodes: failure.unmappedCodes,
				requiredMin: failure.minReasons,
				requiredMax: failure.maxReasons,
			},
		};
	}
	const items = evidenceIndex(evidence).items;
	const principalReasons: AdverseActionLetterContent["principalReasons"] = [];
	const missingCitationCodes: string[] = [];
	for (const reason of selection.reasons) {
		const citations = citationsFor(reason.code, decision.id, items);
		if (citations === null) {
			missingCitationCodes.push(reason.code);
			continue;
		}
		principalReasons.push({
			code: reason.code,
			text: reason.text,
			citations,
		});
	}
	if (missingCitationCodes.length > 0) {
		return {
			ok: false,
			failure: {
				code: "NEEDS_OFFICER_INPUT",
				detail: "a principal reason has no citable decision evidence",
				reasonCodes: codes,
				missingCitationCodes,
			},
		};
	}
	const content: AdverseActionLetterContent = {
		title: profile.title,
		applicantName,
		decisionId: decision.id,
		jurisdiction: profile.code,
		profileVersion: profile.version,
		decision: profile.decision,
		principalReasons,
		notices: profile.disclosures.map((disclosure) => disclosure.text),
		contactPath,
		openItems: [],
	};
	const contentValidation = validateAdverseLetterContent(content, profile);
	if (!contentValidation.ok) {
		const issueCodes = contentValidation.issues.map((issue) => issue.code);
		const disclosureIssue = contentValidation.issues.some((issue) =>
			[
				"JURISDICTION_MISMATCH",
				"PROFILE_VERSION_MISMATCH",
				"TITLE_MISMATCH",
				"DISCLOSURE_MISSING",
				"NOTICE_MISMATCH",
				"CONTACT_PATH_MISSING",
			].includes(issue.code),
		);
		return {
			ok: false,
			failure: {
				code: disclosureIssue ? "DISCLOSURE_UNAVAILABLE" : "NEEDS_OFFICER_INPUT",
				detail: "the letter does not satisfy its jurisdiction profile",
				issues: issueCodes,
			},
		};
	}
	return {
		ok: true,
		content,
		reasons: selection.reasons,
		droppedCodes: selection.droppedCodes,
	};
}
