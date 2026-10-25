// EN-01 case evidence bundle assembler.
//
// Impure shell around the pure evidence contract: case facts, score/policy
// reasons, cited document spans, and research/context/policy sections with
// typed unavailability. This module never logs: bundles may carry applicant
// data, so nothing here may emit document text, quotes, or names.
import {
	hashQuote,
	sourceRefKey,
	type EvidenceBundle,
	type EvidenceItem,
	type UnavailableSource,
} from "@credit/core";
import {
	applications,
	decisions,
	documentCrosschecks,
	documentFiles,
	documentFindings,
	documentLegalHolds,
	externalReports,
	policyEvaluations,
	scores,
	type Db,
} from "@credit/db/applications";
import { internalFetch } from "@credit/service-kit";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { isUuid } from "../ids.js";
import type { AssistActor } from "./access.js";

export interface EvidenceDeps {
	db: Db;
	application: typeof applications.$inferSelect;
	officer: AssistActor;
	assignedToMe: boolean;
	documentsEnabled: boolean;
	now: Date;
	research: {
		url: string | null;
		secret: string;
		timeoutMs: number;
		fetchImpl?: typeof fetch;
	};
}

export async function assembleCaseEvidence(deps: EvidenceDeps): Promise<EvidenceBundle> {
	const { db, application, now } = deps;
	const items: EvidenceItem[] = [];
	const unavailable: UnavailableSource[] = [];

	addCaseFacts(application, items);
	await addBureauFacts(db, application, items);
	await addScoreReasons(db, application, items, unavailable);
	await addDecisionReasons(db, application, items);
	await addDocuments(deps, items, unavailable);
	await addResearch(deps, items, unavailable);

	const seen = new Set<string>();
	const deduped = items.filter((item) => (seen.has(item.ref) ? false : (seen.add(item.ref), true)));
	deduped.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
	let kept = deduped;
	if (deduped.length > 500) {
		// Decision reasons are the adverse-action letter's citation base;
		// keep them ahead of document/research bulk when the cap trips.
		const decisionReasons = deduped.filter(
			(item) =>
				item.sourceType === "score_reason" &&
				(item.metadata["kind"] === "decision_reason" ||
					item.metadata["kind"] === "decision_factor"),
		);
		const rest = deduped.filter((item) => !decisionReasons.includes(item));
		kept = [...decisionReasons, ...rest].slice(0, 500);
		kept.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
		unavailable.push({
			ref: sourceRefKey({ type: "case_fact", applicationId: application.id, field: "truncated" }),
			sourceType: "case_fact",
			code: "unavailable",
			detail: "evidence item cap reached",
		});
	}
	const seenUnavailable = new Set<string>();
	const dedupedUnavailable = unavailable.filter((item) =>
		seenUnavailable.has(item.ref) ? false : (seenUnavailable.add(item.ref), true),
	);
	if (dedupedUnavailable.length > 100) {
		dedupedUnavailable.push({
			ref: sourceRefKey({
				type: "case_fact",
				applicationId: application.id,
				field: "unavailable_truncated",
			}),
			sourceType: "case_fact",
			code: "unavailable",
			detail: "unavailable-source cap reached",
		});
	}
	dedupedUnavailable.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

	return {
		applicationId: application.id,
		asOf: (application.submittedAt ?? application.createdAt).toISOString(),
		assembledAt: now.toISOString(),
		items: kept,
		unavailable: dedupedUnavailable.slice(0, 100),
	};
}

const CASE_LABELS: Record<string, string> = {
	reference: "Reference",
	type: "Type",
	product: "Product",
	amountCents: "Amount",
	termMonths: "Term",
	purpose: "Purpose",
	submittedAt: "Submitted at",
	status: "Status",
	applicantName: "Applicant name",
	companyName: "Company name",
	registrationNumber: "Registration number",
	industry: "Industry",
	yearsTrading: "Years trading",
	city: "City",
	"bureau.delinquencies": "Bureau delinquencies",
	"bureau.utilizationPct": "Bureau credit utilization",
	"bureau.bureauScore": "Bureau score",
};

function humanize(key: string): string {
	const spaced = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_.]+/g, " ")
		.trim()
		.toLowerCase();
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function caseFact(
	applicationId: string,
	field: string,
	value: unknown,
	label?: string,
): EvidenceItem | null {
	if (value === null || value === undefined) return null;
	const content = value instanceof Date ? value.toISOString() : String(value);
	if (content.trim().length === 0) return null;
	return {
		ref: sourceRefKey({ type: "case_fact", applicationId, field }),
		sourceType: "case_fact",
		label: label ?? CASE_LABELS[field] ?? humanize(field.split(".").pop() ?? field),
		content,
		access: { retentionUntil: null, legalHold: false },
		metadata: { field },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const FIELD_RE = /^[A-Za-z][A-Za-z0-9_.]{0,80}$/;

function addCaseFacts(application: typeof applications.$inferSelect, items: EvidenceItem[]): void {
	const push = (field: string, value: unknown): void => {
		const item = caseFact(application.id, field, value);
		if (item) items.push(item);
	};
	push("reference", application.reference);
	push("type", application.type);
	push("product", application.product);
	push("amountCents", application.amountCents);
	push("termMonths", application.termMonths);
	push("purpose", application.purpose);
	push("submittedAt", application.submittedAt);
	push("status", application.status);
	const identity = isRecord(application.identity) ? application.identity : {};
	const business = isRecord(application.business) ? application.business : {};
	const financial = isRecord(application.financial) ? application.financial : {};
	push("applicantName", identity["fullName"]);
	push("companyName", business["companyName"]);
	push("registrationNumber", business["registrationNumber"]);
	push("industry", business["industry"]);
	push("yearsTrading", business["yearsTrading"]);
	push("city", identity["city"]);
	for (const [scope, block] of [
		["financial", financial],
		["business", business],
	] as const) {
		for (const [key, value] of Object.entries(block)) {
			if (typeof value !== "number" && typeof value !== "string") continue;
			if (typeof value === "number" && !Number.isFinite(value)) continue;
			if (typeof value === "string" && value.length === 0) continue;
			const field = `${scope}.${key}`;
			if (!FIELD_RE.test(field)) continue;
			push(field, value);
		}
	}
}

/** Structured bureau facts are case evidence, not document text. They let
 * the adverse-action templates name the delinquency count/utilization. */
async function addBureauFacts(
	db: Db,
	application: typeof applications.$inferSelect,
	items: EvidenceItem[],
): Promise<void> {
	const rows = await db
		.select()
		.from(externalReports)
		.where(
			and(eq(externalReports.applicationId, application.id), eq(externalReports.kind, "bureau")),
		)
		.orderBy(desc(externalReports.fetchedAt), desc(externalReports.id))
		.limit(1);
	const payload = rows[0]?.payload;
	if (!isRecord(payload)) return;
	for (const [field, key] of [
		["bureau.delinquencies", "delinquencies"],
		["bureau.utilizationPct", "utilizationPct"],
		["bureau.bureauScore", "bureauScore"],
	] as const) {
		const value = payload[key];
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		const item = caseFact(application.id, field, value);
		if (item) items.push(item);
	}
}

const REASON_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

async function addScoreReasons(
	db: Db,
	application: typeof applications.$inferSelect,
	items: EvidenceItem[],
	unavailable: UnavailableSource[],
): Promise<void> {
	const scoreRows = await db
		.select()
		.from(scores)
		.where(eq(scores.applicationId, application.id))
		.orderBy(desc(scores.createdAt), desc(scores.id))
		.limit(1);
	const score = scoreRows[0];
	let factorCount = 0;
	if (score && Array.isArray(score.factors)) {
		for (const raw of score.factors as unknown[]) {
			if (!isRecord(raw) || typeof raw["code"] !== "string" || !REASON_RE.test(raw["code"])) {
				continue;
			}
			const label =
				typeof raw["label"] === "string" && raw["label"].length > 0 ? raw["label"] : raw["code"];
			items.push({
				ref: sourceRefKey({ type: "score_reason", scoreId: score.id, code: raw["code"] }),
				sourceType: "score_reason",
				label: label.slice(0, 200),
				content: raw["code"],
				access: { retentionUntil: null, legalHold: false },
				metadata: {
					kind: "factor",
					impact:
						typeof raw["impact"] === "string" || typeof raw["impact"] === "number"
							? raw["impact"]
							: null,
					points: typeof raw["points"] === "number" ? raw["points"] : null,
					label,
				},
			});
			factorCount++;
		}
	}
	if (factorCount === 0) {
		unavailable.push({
			ref: sourceRefKey({ type: "score_reason", scoreId: application.id, code: "NO_SCORE" }),
			sourceType: "score_reason",
			code: "missing",
			detail: "no score factor",
		});
	}
	const policyRows = await db
		.select()
		.from(policyEvaluations)
		.where(eq(policyEvaluations.applicationId, application.id))
		.orderBy(desc(policyEvaluations.createdAt), desc(policyEvaluations.id))
		.limit(1);
	const evaluation = policyRows[0];
	let policyReasonCount = 0;
	if (evaluation && Array.isArray(evaluation.reasons)) {
		for (const raw of evaluation.reasons as unknown[]) {
			if (!isRecord(raw) || typeof raw["code"] !== "string" || !REASON_RE.test(raw["code"])) {
				continue;
			}
			items.push({
				ref: sourceRefKey({ type: "score_reason", scoreId: evaluation.id, code: raw["code"] }),
				sourceType: "score_reason",
				label: raw["code"],
				content: raw["code"],
				access: { retentionUntil: null, legalHold: false },
				metadata: {
					kind: "policy_reason",
					text: typeof raw["text"] === "string" ? raw["text"] : null,
					outcome: typeof evaluation.outcome === "string" ? evaluation.outcome : null,
				},
			});
			policyReasonCount++;
		}
	}
	if (policyReasonCount === 0) {
		unavailable.push({
			ref: sourceRefKey({
				type: "score_reason",
				scoreId: application.id,
				code: "NO_POLICY_EVALUATION",
			}),
			sourceType: "score_reason",
			code: "missing",
			detail: "no policy evaluation reason",
		});
	}
}

/** Terminal decision reasons are themselves citable evidence for the
 * adverse-action letter. The decision id stands in as the `score_reason`
 * source id; `kind: decision_reason` distinguishes it from score/policy
 * reasons. No decision means no items (memo cases stay unaffected). */
async function addDecisionReasons(
	db: Db,
	application: typeof applications.$inferSelect,
	items: EvidenceItem[],
): Promise<void> {
	const rows = await db
		.select()
		.from(decisions)
		.where(eq(decisions.applicationId, application.id))
		.limit(1);
	const decision = rows[0];
	if (!decision) return;
	const pushReason = (
		code: string,
		kind: "decision_reason" | "decision_factor",
		text: string | null,
	): void => {
		items.push({
			ref: sourceRefKey({ type: "score_reason", scoreId: decision.id, code }),
			sourceType: "score_reason",
			label: code,
			content: code,
			access: { retentionUntil: null, legalHold: false },
			metadata: { kind, text, outcome: decision.outcome },
		});
	};
	if (Array.isArray(decision.reasons)) {
		for (const raw of decision.reasons as unknown[]) {
			if (!isRecord(raw) || typeof raw["code"] !== "string" || !REASON_RE.test(raw["code"])) {
				continue;
			}
			pushReason(
				raw["code"],
				"decision_reason",
				typeof raw["text"] === "string" ? raw["text"] : null,
			);
		}
	}
	// Officer/check-only decisions may carry a single generic reason while
	// the frozen snapshot still holds the specific negative factors. Those
	// factors are part of the decision, so they are citable too.
	const snapshot = isRecord(decision.snapshot) ? decision.snapshot : {};
	const factors = Array.isArray(snapshot["factors"]) ? (snapshot["factors"] as unknown[]) : [];
	for (const raw of factors) {
		if (!isRecord(raw) || typeof raw["code"] !== "string" || !REASON_RE.test(raw["code"])) {
			continue;
		}
		const points = typeof raw["points"] === "number" ? raw["points"] : null;
		if (points === null || points >= 0) continue;
		pushReason(
			raw["code"],
			"decision_factor",
			typeof raw["label"] === "string" ? raw["label"] : null,
		);
	}
}

function documentRef(fileId: string): string {
	return sourceRefKey({
		type: "document",
		documentFileId: fileId,
		pageNumber: 1,
		offsetStart: 0,
		offsetEnd: 1,
	});
}

async function addDocuments(
	deps: EvidenceDeps,
	items: EvidenceItem[],
	unavailable: UnavailableSource[],
): Promise<void> {
	const { db, application, assignedToMe, documentsEnabled, now } = deps;
	if (!documentsEnabled) {
		unavailable.push({
			ref: documentRef(application.id),
			sourceType: "document",
			code: "unavailable",
			detail: "documents disabled",
		});
		return;
	}
	if (!assignedToMe) {
		unavailable.push({
			ref: documentRef(application.id),
			sourceType: "document",
			code: "access_denied",
			detail: "document access requires assignment",
		});
		return;
	}
	const files = await db
		.select()
		.from(documentFiles)
		.where(eq(documentFiles.applicationId, application.id));
	const holds = await db
		.select()
		.from(documentLegalHolds)
		.where(
			and(
				eq(documentLegalHolds.applicationId, application.id),
				isNull(documentLegalHolds.releasedAt),
			),
		);
	const held = (fileId: string): boolean =>
		holds.some((hold) => hold.documentFileId === null || hold.documentFileId === fileId);
	if (files.length === 0) {
		unavailable.push({
			ref: documentRef(application.id),
			sourceType: "document",
			code: "missing",
			detail: "no documents",
		});
	}
	const live = new Map<string, (typeof files)[number]>();
	for (const file of files) {
		if (file.status === "deleted") {
			unavailable.push({
				ref: documentRef(file.id),
				sourceType: "document",
				code: "retention_expired",
				detail: "document deleted",
			});
			continue;
		}
		// A legal hold survives retention expiry: the bytes are still present
		// and the assigned officer may cite them.
		if (file.retentionUntil <= now && !held(file.id)) {
			unavailable.push({
				ref: documentRef(file.id),
				sourceType: "document",
				code: "retention_expired",
				detail: "retention expired",
			});
			continue;
		}
		if (file.status !== "ready") {
			unavailable.push({
				ref: documentRef(file.id),
				sourceType: "document",
				code: "unavailable",
				detail: "document is not ready",
			});
			continue;
		}
		live.set(file.id, file);
	}
	// Mirror the context route: only the LATEST crosscheck may be cited. A
	// failed/redacted latest run must not fall back to older findings.
	const crosschecks = await db
		.select()
		.from(documentCrosschecks)
		.where(eq(documentCrosschecks.applicationId, application.id))
		.orderBy(desc(documentCrosschecks.startedAt), desc(documentCrosschecks.id))
		.limit(1);
	const cited = new Set<string>();
	const crosscheck = crosschecks[0];
	if (crosscheck && crosscheck.status !== "succeeded") {
		unavailable.push({
			ref: documentRef(application.id),
			sourceType: "document",
			code: "unavailable",
			detail: "latest document crosscheck is not available",
		});
	}
	if (crosscheck && crosscheck.status === "succeeded") {
		const findings = await db
			.select()
			.from(documentFindings)
			.where(
				and(
					eq(documentFindings.crosscheckId, crosscheck.id),
					eq(documentFindings.applicationId, application.id),
				),
			)
			.orderBy(asc(documentFindings.createdAt), asc(documentFindings.id));
		for (const finding of findings) {
			if (finding.documentFileId === null) continue;
			if (!live.has(finding.documentFileId)) {
				unavailable.push({
					ref: documentRef(finding.documentFileId),
					sourceType: "document",
					code: "unavailable",
					detail: "document changed during assembly",
				});
				continue;
			}
			if (typeof finding.quote !== "string" || finding.quote.trim().length === 0) continue;
			if (
				typeof finding.pageNumber !== "number" ||
				!Number.isInteger(finding.pageNumber) ||
				finding.pageNumber < 1 ||
				typeof finding.quoteStart !== "number" ||
				!Number.isInteger(finding.quoteStart) ||
				finding.quoteStart < 0 ||
				typeof finding.quoteEnd !== "number" ||
				!Number.isInteger(finding.quoteEnd) ||
				finding.quoteEnd <= finding.quoteStart
			) {
				continue;
			}
			const file = live.get(finding.documentFileId);
			if (!file || file.status !== "ready") continue;
			cited.add(file.id);
			items.push({
				ref: sourceRefKey({
					type: "document",
					documentFileId: finding.documentFileId,
					pageNumber: finding.pageNumber,
					offsetStart: finding.quoteStart,
					offsetEnd: finding.quoteEnd,
				}),
				sourceType: "document",
				label: `${finding.field} ${finding.status}`.slice(0, 200),
				content: finding.quote,
				access: {
					retentionUntil: file.retentionUntil.toISOString(),
					legalHold: held(file.id),
				},
				metadata: {
					field: finding.field,
					status: finding.status,
					confidence: finding.confidence,
					expected: typeof finding.expected === "string" ? finding.expected : null,
					observed: typeof finding.observed === "string" ? finding.observed : null,
				},
			});
		}
	}
	for (const file of live.values()) {
		if (file.status !== "ready" || cited.has(file.id)) continue;
		unavailable.push({
			ref: documentRef(file.id),
			sourceType: "document",
			code: "missing",
			detail: "no extracted citation",
		});
	}
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function researchRefs(applicationId: string): {
	external: string;
	policy: (detail: string) => string;
} {
	return {
		external: sourceRefKey({ type: "external_evidence", evidenceId: applicationId }),
		policy: (detail: string) =>
			sourceRefKey({
				type: "policy_section",
				policyKey: "unavailable",
				policyVersionId: applicationId,
				sectionId: "none",
				quoteHash: hashQuote(detail),
			}),
	};
}

async function addResearch(
	deps: EvidenceDeps,
	items: EvidenceItem[],
	unavailable: UnavailableSource[],
): Promise<void> {
	const { application, officer, research } = deps;
	const refs = researchRefs(application.id);
	const markDown = (code: "missing" | "unavailable", detail: string): void => {
		unavailable.push({ ref: refs.external, sourceType: "external_evidence", code, detail });
		unavailable.push({
			ref: refs.policy(detail),
			sourceType: "policy_section",
			code,
			detail,
		});
		unavailable.push({
			ref: sourceRefKey({
				type: "context_signal",
				signalRef: `signal:unavailable:context:${application.id}`,
			}),
			sourceType: "context_signal",
			code,
			detail,
		});
	};
	if (research.url === null) {
		markDown("unavailable", "research not configured");
		return;
	}
	let res: Response;
	try {
		res = await internalFetch(
			research.url,
			`/internal/research/applications/${application.id}/latest`,
			officer,
			{ secret: research.secret, timeoutMs: research.timeoutMs, fetchImpl: research.fetchImpl },
		);
	} catch {
		markDown("unavailable", "research unavailable");
		return;
	}
	if (!res.ok) {
		markDown(
			res.status === 404 ? "missing" : "unavailable",
			res.status === 404 ? "no research run" : "research unavailable",
		);
		return;
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	if (!isRecord(body)) {
		markDown("unavailable", "research unavailable");
		return;
	}
	const externalCount = addResearchEvidence(body, items);
	if (externalCount === 0) {
		unavailable.push({
			ref: refs.external,
			sourceType: "external_evidence",
			code: "missing",
			detail: "no external evidence",
		});
	}
	const contextCount = addContextSignals(body, items);
	if (contextCount === 0) {
		unavailable.push({
			ref: sourceRefKey({
				type: "context_signal",
				signalRef: `signal:unavailable:context:${application.id}`,
			}),
			sourceType: "context_signal",
			code: "missing",
			detail: "no context signals",
		});
	}
	addPolicySections(body, items, unavailable, refs);
}

function addResearchEvidence(body: Record<string, unknown>, items: EvidenceItem[]): number {
	if (!Array.isArray(body["evidence"]) || !Array.isArray(body["findings"])) return 0;
	let count = 0;
	const byId = new Map<string, Record<string, unknown>>();
	for (const raw of body["evidence"] as unknown[]) {
		if (isRecord(raw) && typeof raw["id"] === "string" && raw["id"].length > 0) {
			byId.set(raw["id"], raw);
		}
	}
	for (const raw of body["findings"] as unknown[]) {
		if (!isRecord(raw)) continue;
		const category = str(raw["category"]);
		if (category === null || !Array.isArray(raw["evidence"])) continue;
		const claim = str(raw["claim"]);
		const confidence = str(raw["confidence"]);
		for (const entry of raw["evidence"] as unknown[]) {
			if (!isRecord(entry) || typeof entry["id"] !== "string" || !isUuid(entry["id"])) {
				continue;
			}
			const full = byId.get(entry["id"]) ?? entry;
			const quote = str(full["quote"]);
			if (quote === null || quote.trim().length === 0) continue;
			const url = str(full["url"]) ?? str(full["finalUrl"]);
			items.push({
				ref: sourceRefKey({ type: "external_evidence", evidenceId: entry["id"] }),
				sourceType: "external_evidence",
				label: category.slice(0, 200),
				content: quote,
				access: { retentionUntil: null, legalHold: false },
				metadata: {
					claim,
					category,
					publisher: str(full["publisher"]),
					url,
					sourceTier: str(full["sourceTier"]),
					confidence,
					reviewStatus: str(raw["reviewStatus"]),
				},
			});
			count++;
		}
	}
	return count;
}

function addContextSignals(body: Record<string, unknown>, items: EvidenceItem[]): number {
	if (!isRecord(body["context"]) || !Array.isArray(body["context"]["signals"])) return 0;
	let count = 0;
	for (const raw of body["context"]["signals"] as unknown[]) {
		if (!isRecord(raw) || raw["superseded"] === true) continue;
		const type = str(raw["type"]);
		const metric = str(raw["metric"]);
		const status = str(raw["status"]);
		const confidence = str(raw["confidence"]);
		if (type === null || metric === null || status === null || confidence === null) continue;
		const periodStart =
			typeof raw["periodStart"] === "string" && raw["periodStart"].length > 0
				? raw["periodStart"]
				: "unknown";
		const periodEnd =
			typeof raw["periodEnd"] === "string" && raw["periodEnd"].length > 0
				? raw["periodEnd"]
				: "unknown";
		const accountScope =
			typeof raw["accountScope"] === "string" && raw["accountScope"].length > 0
				? raw["accountScope"]
				: "unknown";
		const observed = typeof raw["observed"] === "number" ? raw["observed"] : null;
		const expected = typeof raw["expected"] === "number" ? raw["expected"] : null;
		const signalRef = `signal:${type}:${metric}:${periodStart}:${periodEnd}:${accountScope}`;
		if (signalRef.length > 300) continue;
		items.push({
			ref: sourceRefKey({ type: "context_signal", signalRef }),
			sourceType: "context_signal",
			label: type.slice(0, 200),
			content: `observed=${observed ?? "unknown"} status=${status} confidence=${confidence}`,
			access: { retentionUntil: null, legalHold: false },
			metadata: {
				type,
				metric,
				status,
				confidence,
				observed,
				expected,
				policyVersion: str(raw["policyVersion"]),
				accountScope: typeof raw["accountScope"] === "string" ? raw["accountScope"] : null,
				reviewStatus: str(raw["reviewStatus"]),
			},
		});
		count++;
	}
	return count;
}

function addPolicySections(
	body: Record<string, unknown>,
	items: EvidenceItem[],
	unavailable: UnavailableSource[],
	refs: ReturnType<typeof researchRefs>,
): void {
	let count = 0;
	if (isRecord(body["policy"]) && isRecord(body["policy"]["brief"])) {
		const brief = body["policy"]["brief"];
		if (Array.isArray(brief["items"])) {
			for (const item of brief["items"] as unknown[]) {
				if (!isRecord(item) || !Array.isArray(item["citations"])) continue;
				for (const raw of item["citations"] as unknown[]) {
					if (!isRecord(raw)) continue;
					const policyKey = str(raw["policyKey"]);
					const policyVersionId = str(raw["policyVersionId"]);
					const sectionId = str(raw["sectionId"]);
					const heading = str(raw["heading"]);
					const version = str(raw["version"]);
					const effectiveFrom = str(raw["effectiveFrom"]);
					const quote = str(raw["quote"]);
					if (
						quote === null ||
						quote.trim().length === 0 ||
						policyKey === null ||
						!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(policyKey) ||
						policyVersionId === null ||
						!isUuid(policyVersionId) ||
						sectionId === null ||
						!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sectionId) ||
						heading === null ||
						version === null ||
						effectiveFrom === null
					) {
						continue;
					}
					if (
						raw["effectiveTo"] !== null &&
						raw["effectiveTo"] !== undefined &&
						typeof raw["effectiveTo"] !== "string"
					) {
						continue;
					}
					items.push({
						ref: sourceRefKey({
							type: "policy_section",
							policyKey,
							policyVersionId,
							sectionId,
							quoteHash: hashQuote(quote),
						}),
						sourceType: "policy_section",
						label: heading.slice(0, 200),
						content: quote,
						access: { retentionUntil: null, legalHold: false },
						metadata: {
							policyKey,
							version,
							sectionId,
							effectiveFrom,
							effectiveTo: typeof raw["effectiveTo"] === "string" ? raw["effectiveTo"] : null,
						},
					});
					count++;
				}
			}
		}
	}
	if (count === 0) {
		unavailable.push({
			ref: refs.policy("no policy citation"),
			sourceType: "policy_section",
			code: "missing",
			detail: "no policy citation",
		});
	}
}
