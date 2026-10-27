// Blocking brief validation (§6.4): schema → PII/decision-language gates →
// one bounded language-repair pass → evidence snapshot/quote/date/tier
// verification → per-pair support judging → server-derived confidence.
// Moved verbatim from run.ts; behavior and repair rules unchanged.
import { randomUUID } from "node:crypto";
import {
	AgentTimeoutError,
	ModelUnavailableError,
	type FetchedEvidence,
} from "./agent.js";
import { judgeWithRepair, type JudgeUsage, type SupportJudge } from "./support.js";
import { RepairRejectedError, type LanguageRepair, type RepairUsage } from "./repair.js";
import {
	assessEntityMatch,
	buildSnapshot,
	decideConfidence,
	modelBriefSchema,
	piiExceptionApplies,
	resolvePublishedDate,
	scanForbidden,
	scanProtected,
	sha256Hex,
	verifyQuote,
	type CaseEntity,
	type Confidence,
	type ModelBrief,
	type ValidationScores,
} from "./validator.js";
import {
	countsTowardTwoSourceRule,
	isIndependent,
	registrableDomain,
	tierForHost,
	type SourceTier,
} from "./sources.js";
import { validateFinalUrl } from "./urls.js";

export class ValidationFailure extends Error {}

/** Max judge pairs per finding; over-limit candidates are skipped with an
 * explicit reason (no silent global discard). Bounds total judge work. */
const PER_FINDING_PAIR_CAP = 8;
export const VALIDATOR_VERSION = "v1";

export interface ProcessedEvidence {
	localId: string;
	id: string;
	url: string;
	finalUrl: string;
	host: string;
	title: string | null;
	publisher: string;
	publishedAt: string | null;
	dateBasis: "publisher_metadata" | "tavily_estimate" | "unknown";
	quote: string;
	quoteStart: number;
	quoteEnd: number;
	snapshotText: string;
	snapshotHash: string;
	rawContentSha256: string;
	sourceTier: SourceTier;
}

export interface ValidatedFinding {
	id: string;
	claim: string;
	category: string;
	whyItMatters: string;
	allegationStatus: string;
	confidence: Confidence;
	confidenceBasis: Record<string, unknown>;
	entityMatch: { identifierType: string; value: string; confidence: Confidence };
}

export interface ValidatedOutput {
	brief: Record<string, unknown>;
	validation: Record<string, unknown>;
	evidence: ProcessedEvidence[];
	findings: ValidatedFinding[];
	links: Array<{ findingId: string; evidenceId: string }>;
	judgeUsage: { usage: JudgeUsage; calls: number };
	repairUsage: { usage: RepairUsage; calls: number };
}

/** Generated text only (never exact quotes) for forbidden/PII scans. */
function generatedTexts(brief: ModelBrief): Array<[string, string]> {
	return [
		["summary", brief.summary],
		...brief.findings.flatMap((f, i): Array<[string, string]> => [
			[`findings[${i}].claim`, f.claim],
			[`findings[${i}].whyItMatters`, f.whyItMatters],
		]),
		...brief.contradictions.map((c, i): [string, string] => [
			`contradictions[${i}]`,
			c.description,
		]),
		...brief.unknowns.map((u, i): [string, string] => [`unknowns[${i}]`, u]),
		...brief.questionsForOfficer.map((q, i): [string, string] => [`questions[${i}]`, q]),
	];
}

function firstForbiddenHit(brief: ModelBrief): string | null {
	for (const [label, text] of generatedTexts(brief)) {
		if (scanForbidden(text).length > 0) return label;
	}
	return null;
}

function firstProtectedHit(brief: ModelBrief): string | null {
	for (const [label, text] of generatedTexts(brief)) {
		if (scanProtected(text).length > 0 && !piiExceptionApplies(text, [])) return label;
	}
	return null;
}

/** Dirty summary/findings need the repair pass; dirty non-findings
 * (contradictions/unknowns/questions) are droppable without it. */
function hasDirtySummaryOrFindings(brief: ModelBrief): boolean {
	return (
		scanForbidden(brief.summary).length > 0 ||
		brief.findings.some(
			(f) => scanForbidden(f.claim).length > 0 || scanForbidden(f.whyItMatters).length > 0,
		)
	);
}

/** Drop non-finding entries that still carry decision language after the
 * single repair pass. Findings/summary stay strict: dirty there still fails.
 * Returns the cleaned brief, or null when a finding/summary is dirty. */
function dropForbiddenNonFindings(brief: ModelBrief): ModelBrief | null {
	if (hasDirtySummaryOrFindings(brief)) {
		return null;
	}
	return {
		...brief,
		contradictions: brief.contradictions.filter((c) => scanForbidden(c.description).length === 0),
		unknowns: brief.unknowns.filter((u) => scanForbidden(u).length === 0),
		questionsForOfficer: brief.questionsForOfficer.filter((q) => scanForbidden(q).length === 0),
	};
}

/** The repaired brief must keep finding/evidence counts, local IDs, and links. */
function checkRepairStructure(before: ModelBrief, after: ModelBrief): void {
	const mismatch = (): ValidationFailure =>
		new ValidationFailure("language repair changed the brief structure");
	if (after.findings.length !== before.findings.length) throw mismatch();
	if (after.evidence.length !== before.evidence.length) throw mismatch();
	if (
		after.evidence.map((e) => e.localId).join("\n") !==
		before.evidence.map((e) => e.localId).join("\n")
	) {
		throw mismatch();
	}
	for (const [i, f] of after.findings.entries()) {
		if (f.evidenceLocalIds.join("\n") !== before.findings[i].evidenceLocalIds.join("\n")) {
			throw mismatch();
		}
	}
}

export async function validateAndBuild(opts: {
	brief: unknown;
	fetched: FetchedEvidence[];
	entity: CaseEntity;
	asOf: string;
	judge: SupportJudge;
	repair: LanguageRepair;
	signal?: AbortSignal;
	runId: string;
}): Promise<ValidatedOutput> {
	const parsed = modelBriefSchema.safeParse(opts.brief);
	if (!parsed.success) throw new ValidationFailure("model brief failed schema validation");
	let brief: ModelBrief = parsed.data;

	// 1. Protected attributes fail immediately: rewording cannot fix a leak.
	const leaked = firstProtectedHit(brief);
	if (leaked) {
		throw new ValidationFailure(`model brief contains a protected attribute (${leaked})`);
	}

	// 2. One bounded language-repair pass for decision language, before
	// support judging. At most one model call; its usage counts toward the
	// run budget. A still-dirty or restructured reply fails safely with
	// zero persisted findings.
	let repairCalls = 0;
	let repairInputTokens = 0;
	let repairOutputTokens = 0;
	// Repair only when summary/findings carry decision language. Dirty
	// non-findings alone are dropped directly: no repair call is spent,
	// and a repair transport failure cannot fail the run for them.
	if (!hasDirtySummaryOrFindings(brief)) {
		brief = dropForbiddenNonFindings(brief) ?? brief;
	} else {
		let repaired: unknown;
		try {
			const out = await opts.repair(brief, { signal: opts.signal, runId: opts.runId });
			repaired = out.brief;
			repairInputTokens += out.usage?.inputTokens ?? Math.ceil(JSON.stringify(brief).length / 4);
			repairOutputTokens += out.usage?.outputTokens ?? 0;
			repairCalls = 1;
		} catch (err) {
			if (err instanceof RepairRejectedError) throw new ValidationFailure(err.message);
			if (opts.signal?.aborted) throw new AgentTimeoutError("language repair aborted");
			throw new ModelUnavailableError(
				err instanceof Error ? err.message : "language repair failed",
			);
		}
		const reparse = modelBriefSchema.safeParse(repaired);
		if (!reparse.success) throw new ValidationFailure("language repair failed schema validation");
		checkRepairStructure(brief, reparse.data);
		brief = reparse.data;
		const dirty = firstForbiddenHit(brief);
		if (dirty) {
			// The repair pass rewrites summary/findings only: drop dirty
			// non-finding entries instead of failing the run for a field
			// repair could not touch. Dirty summary/findings still fail.
			const cleaned = dropForbiddenNonFindings(brief);
			if (!cleaned)
				throw new ValidationFailure(`model brief contains decision language (${dirty})`);
			brief = cleaned;
			const stillDirty = firstForbiddenHit(brief);
			if (stillDirty)
				throw new ValidationFailure(`model brief contains decision language (${stillDirty})`);
		}
		const stillLeaked = firstProtectedHit(brief);
		if (stillLeaked) {
			throw new ValidationFailure(`model brief contains a protected attribute (${stillLeaked})`);
		}
	}
	// The judge is a model call: any transport failure is model_unavailable;
	// an aborted deadline is a timeout. Usage accumulates for the end-to-end
	// cost cap (estimated by chars when the judge reports none).
	let judgeInputTokens = 0;
	let judgeOutputTokens = 0;
	let judgeCalls = 0;
	const judge: SupportJudge = async (claim, quote, innerOpts) => {
		judgeCalls += 1;
		try {
			const judgment = await opts.judge(claim, quote, {
				signal: innerOpts?.signal ?? opts.signal,
				runId: innerOpts?.runId ?? opts.runId,
				repair: innerOpts?.repair,
			});
			judgeInputTokens +=
				judgment.usage?.inputTokens ?? Math.ceil((claim.length + quote.length) / 4);
			judgeOutputTokens += judgment.usage?.outputTokens ?? 0;
			return judgment;
		} catch (err) {
			if (opts.signal?.aborted) throw new AgentTimeoutError("support judge aborted");
			throw new ModelUnavailableError(err instanceof Error ? err.message : "support judge failed");
		}
	};
	// 3. Evidence: server-side snapshot, hash, offsets, dates, tiers.
	const fetchedByUrl = new Map<string, FetchedEvidence>();
	for (const f of opts.fetched) {
		fetchedByUrl.set(f.requestedUrl, f);
		fetchedByUrl.set(f.returnedUrl, f);
	}
	const processed: ProcessedEvidence[] = [];
	let droppedQuotes = 0;
	let droppedPii = 0;
	for (const ev of brief.evidence) {
		const raw = fetchedByUrl.get(ev.url);
		if (!raw) {
			droppedQuotes += 1;
			continue;
		}
		const finalUrl = raw.returnedUrl || raw.requestedUrl;
		if (
			raw.returnedUrl &&
			registrableDomain(new URL(raw.returnedUrl).hostname) !==
				registrableDomain(new URL(raw.requestedUrl).hostname)
		) {
			droppedQuotes += 1; // redirect off-allowlist
			continue;
		}
		const verdict = validateFinalUrl(finalUrl);
		if (!verdict.ok) {
			droppedQuotes += 1;
			continue;
		}
		let snap: {
			snapshotText: string;
			quote: string;
			quoteStart: number;
			quoteEnd: number;
			snapshotHash: string;
			rawContentSha256: string;
		};
		try {
			snap = buildSnapshot(raw.rawContent, ev.quote);
		} catch {
			droppedQuotes += 1;
			continue;
		}
		if (!verifyQuote(snap.snapshotText, snap.quote, snap.quoteStart, snap.quoteEnd)) {
			droppedQuotes += 1;
			continue;
		}
		const tier = tierForHost(verdict.host);
		// Protected-attribute quotes are quarantined unless the documented
		// fraud-record exception applies (official/registry tier + fraud text).
		if (scanProtected(snap.quote).length > 0 && !piiExceptionApplies(snap.quote, [tier])) {
			droppedPii += 1;
			continue;
		}
		// The model date counts only when verified in the fetched page;
		// otherwise the Tavily estimate, otherwise undated.
		const { publishedAt, dateBasis } = resolvePublishedDate({
			modelDate: ev.publishedAt,
			rawContent: raw.rawContent,
			tavilyDate: raw.searchPublishedDate,
		});
		if (publishedAt && publishedAt > opts.asOf) {
			droppedQuotes += 1; // after asOf: reject
			continue;
		}
		processed.push({
			localId: ev.localId,
			id: randomUUID(),
			url: raw.requestedUrl,
			finalUrl: verdict.finalUrl,
			host: verdict.host,
			title: typeof ev.title === "string" && ev.title ? ev.title : null,
			publisher:
				typeof ev.publisher === "string" && ev.publisher.trim()
					? ev.publisher.trim()
					: verdict.host,
			publishedAt,
			dateBasis,
			quote: snap.quote,
			quoteStart: snap.quoteStart,
			quoteEnd: snap.quoteEnd,
			snapshotText: snap.snapshotText,
			snapshotHash: snap.snapshotHash,
			rawContentSha256: snap.rawContentSha256,
			sourceTier: tier,
		});
	}
	// Dedupe by the stored unique key: two quotes from one small page share
	// a snapshot window, and the second row would 23505 on insert. The later
	// quote is dropped with an explicit reason — never remapped to the first
	// row, so a finding always cites its exact quoted passage.
	const deduped: ProcessedEvidence[] = [];
	const rowByKey = new Map<string, ProcessedEvidence>();
	const byLocalId = new Map<string, ProcessedEvidence>();
	const droppedDuplicateLocalIds = new Set<string>();
	let dedupedQuotes = 0;
	for (const e of processed) {
		const key = `${e.finalUrl}\n${e.snapshotHash}`;
		if (rowByKey.has(key)) {
			droppedDuplicateLocalIds.add(e.localId);
			dedupedQuotes += 1;
			continue;
		}
		rowByKey.set(key, e);
		deduped.push(e);
		byLocalId.set(e.localId, e);
	}

	// 4. Findings: each judged only against its own linked evidence (the
	// model's evidenceLocalIds, or every surviving row when it cites none),
	// capped per finding with an explicit skip reason. Entity, PII, and
	// confidence derive from the *supported* evidence only — never from all
	// run evidence and never from the model's self-reported confidence.
	const findings: ValidatedOutput["findings"] = [];
	const links: ValidatedOutput["links"] = [];
	const discarded: Array<{ findingIndex: number; reason: string; claimHash: string }> = [];
	const supportLog: Array<{ findingId: string; evidenceIds: string[]; repaired: boolean }> = [];
	const findingLimitations: string[] = [];
	let unsupportedClaims = 0;
	let piiClaimDiscards = 0;
	let pairCapSkipped = 0;
	const entityScores: number[] = [];

	for (const [findingIndex, f] of brief.findings.entries()) {
		const hash = { findingIndex, claimHash: sha256Hex(f.claim) };
		if (f.entityMatch.identifierType === "name_only" && f.category === "adverse_media") {
			unsupportedClaims += 1;
			discarded.push({
				...hash,
				reason: "name_only never supports an adverse-media finding",
			});
			continue;
		}
		const linked =
			f.evidenceLocalIds.length > 0
				? f.evidenceLocalIds.flatMap((lid) => {
						const e = byLocalId.get(lid);
						return e ? [e] : [];
					})
				: [...deduped];
		const seenLink = new Set<string>();
		const candidates = linked.filter((e) => {
			if (seenLink.has(e.id)) return false;
			seenLink.add(e.id);
			return true;
		});
		if (candidates.length > PER_FINDING_PAIR_CAP) {
			pairCapSkipped += candidates.length - PER_FINDING_PAIR_CAP;
		}
		const capped = candidates.slice(0, PER_FINDING_PAIR_CAP);
		const supportedIds: string[] = [];
		let repaired = false;
		// No surviving evidence for the cited passages: the localIds were
		// hallucinated or their quotes were dropped as page duplicates above
		// — never judged against another passage's quote.
		if (capped.length === 0 && f.evidenceLocalIds.length > 0) {
			unsupportedClaims += 1;
			const allDuplicates = f.evidenceLocalIds.every((lid) => droppedDuplicateLocalIds.has(lid));
			discarded.push({
				...hash,
				reason: allDuplicates
					? "quoted passage was a duplicate of another passage from the same page and was dropped"
					: "cited evidence did not survive validation",
			});
			continue;
		}
		for (const e of capped) {
			// A verbatim claim is supported without spending a judge call; this
			// is the safest path for registry facts and keeps citations exact.
			const normalize = (v: string): string => v.replace(/\s+/g, " ").trim().toLowerCase();
			const claimText = normalize(f.claim);
			if (claimText.length >= 20 && normalize(e.quote).includes(claimText)) {
				supportedIds.push(e.id);
				continue;
			}
			// One initial verdict plus at most one repair (max 2 calls).
			const { verdict, repaired: fixed } = await judgeWithRepair(f.claim, e.quote, judge);
			if (fixed) repaired = true;
			if (verdict === "supported") supportedIds.push(e.id);
		}
		if (supportedIds.length === 0) {
			unsupportedClaims += 1;
			discarded.push({
				...hash,
				reason:
					capped.length < candidates.length
						? `no supporting quote in the first ${PER_FINDING_PAIR_CAP} linked passages (judge verdict)`
						: "no supporting quote (judge verdict)",
			});
			continue;
		}
		const cited = deduped.filter((e) => supportedIds.includes(e.id));
		if (
			scanProtected(f.claim).length > 0 &&
			!piiExceptionApplies(
				f.claim,
				cited.map((e) => e.sourceTier),
			)
		) {
			unsupportedClaims += 1;
			piiClaimDiscards += 1;
			discarded.push({
				...hash,
				reason: "protected attribute without a fraud-record exception",
			});
			continue;
		}
		const assessed = assessEntityMatch(
			opts.entity,
			{
				identifierType: f.entityMatch.identifierType,
				value: f.entityMatch.value,
				confidence: f.entityMatch.confidence,
			},
			{ officialSourceCited: cited.some((e) => e.sourceTier === "official") },
		);
		const counting = cited.filter((e) => countsTowardTwoSourceRule(e.sourceTier));
		// Greedy independent set: an item counts only when independent of
		// every counted item (domain + hash + no syndication marker).
		const counted: ProcessedEvidence[] = [];
		for (const e of counting) {
			if (counted.every((c) => isIndependent(c, e))) counted.push(e);
		}
		const independentCount = counted.length;
		const decided = decideConfidence({
			category: f.category,
			independentCount,
			hasOfficial: cited.some((e) => e.sourceTier === "official"),
			reviewPlatformOnly:
				cited.length > 0 && cited.every((e) => e.sourceTier === "review_platform"),
			undatedNews: cited.some(
				(e) =>
					e.publishedAt === null &&
					(e.sourceTier === "reputable_news" ||
						e.sourceTier === "review_platform" ||
						e.sourceTier === "other"),
			),
			entityConfidence: assessed.confidence,
		});
		const id = randomUUID();
		const scoreOf: Record<Confidence, number> = { low: 0, medium: 0.5, high: 1 };
		entityScores.push(scoreOf[assessed.confidence]);
		for (const limitation of [...assessed.reasons, ...decided.limitations]) {
			findingLimitations.push(`finding #${findingIndex + 1}: ${limitation}`);
		}
		findings.push({
			id,
			claim: f.claim,
			category: f.category,
			whyItMatters: f.whyItMatters,
			allegationStatus: f.allegationStatus,
			confidence: decided.confidence,
			confidenceBasis: {
				...decided.basis,
				limitations: decided.limitations,
				entityMatch: {
					identifierType: assessed.identifierType,
					confidence: assessed.confidence,
					reasons: assessed.reasons,
				},
				entityMatchCapped: assessed.capped,
			},
			entityMatch: {
				identifierType: assessed.identifierType,
				value: assessed.value,
				confidence: assessed.confidence,
			},
		});
		for (const eid of supportedIds) links.push({ findingId: id, evidenceId: eid });
		supportLog.push({ findingId: id, evidenceIds: supportedIds, repaired });
	}

	// 5. Contradictions keep only resolvable refs; limitation notes join unknowns.
	const contradictions = brief.contradictions.flatMap((c) => {
		const ids = c.evidenceLocalIds.flatMap((lid) => {
			const e = byLocalId.get(lid);
			return e ? [e.id] : [];
		});
		return ids.length > 0 ? [{ description: c.description, evidenceIds: ids }] : [];
	});
	const limitationNotes =
		findings.length > 0 ? [] : ["no supported findings remained after validation"];
	const unknowns = [...brief.unknowns, ...findingLimitations, ...limitationNotes];

	const totalFindings = brief.findings.length;
	const scores: ValidationScores = {
		citation_valid: brief.evidence.length === 0 ? 1 : deduped.length / brief.evidence.length,
		evidence_coverage: totalFindings === 0 ? 1 : findings.length / totalFindings,
		unsupported_claims: unsupportedClaims,
		entity_match_confidence:
			entityScores.length === 0 ? 0 : entityScores.reduce((a, b) => a + b, 0) / entityScores.length,
		// Actual leak checks: PII quotes quarantined plus PII claims dropped.
		pii_leak: droppedPii + piiClaimDiscards,
		support_pass_rate: totalFindings === 0 ? 1 : findings.length / totalFindings,
	};

	return {
		brief: {
			// A fully-discarded brief must not assert unsupported claims.
			summary:
				findings.length === 0 ? "No supported findings remained after validation." : brief.summary,
			contradictions,
			unknowns,
			questionsForOfficer: brief.questionsForOfficer,
		},
		validation: {
			validatorVersion: VALIDATOR_VERSION,
			scores,
			unsupportedClaims,
			droppedQuotes,
			droppedPii,
			dedupedQuotes,
			pairCapSkipped,
			discarded,
			support: supportLog,
		},
		evidence: deduped,
		findings,
		links,
		judgeUsage: {
			usage: { inputTokens: judgeInputTokens, outputTokens: judgeOutputTokens },
			calls: judgeCalls,
		},
		repairUsage: {
			usage: { inputTokens: repairInputTokens, outputTokens: repairOutputTokens },
			calls: repairCalls,
		},
	};
}
