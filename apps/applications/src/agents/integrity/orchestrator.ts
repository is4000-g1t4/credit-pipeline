// US-INT-1/2/3 bounded agent orchestrator.
//
// The runner produces one raw draft; this module owns JSON parsing, quote
// verification, deterministic confirmation, one repair attempt, bounds, and
// the metadata-only trace. It is pure and exported for evals, so the eval
// runner exercises the production path without a DB.

import { z } from "zod";
import {
	hashCanonical,
	locateQuote,
	utf16IndexToCodePoint,
	validateGeneratedText,
	type CitationRecord,
	type DocumentIntegrityBriefContent,
	type EvidenceBundle,
	type EvidenceItem,
	type UnavailableSource,
} from "@credit/core";
import type { MemoAgentTrace } from "../shared/trace.js";
import {
	INTEGRITY_CANDIDATE_FIELDS,
	INTEGRITY_CONSISTENCY_FIELDS,
	IntegrityAgentError,
	type IntegrityAgentMode,
	type IntegrityAgentRunner,
	type IntegrityAnalysisOutput,
	type IntegrityBriefCitationToken,
	type IntegrityBriefOutput,
	type IntegrityBriefResult,
	type IntegrityConfig,
	type IntegrityConsistencyProposal,
	type IntegritySource,
	type IntegrityToolCall,
	type IntegrityUsage,
	type ValidatedCandidate,
	type ValidatedConsistency,
} from "../../integrity/types.js";
import { confirmConsistency, validateCandidate, verifyQuote } from "./validator.js";
import { sha256Hex } from "../../documents/crypto.js";

const MAX_PREVIOUS_OUTPUT = 8_000;
const MAX_TOOL_REFS = 500;

export interface IntegrityAgentOutcomeBase {
	rawOutput: string;
	toolCalls: IntegrityToolCall[];
	sourceRefs: string[];
	steps: number;
	usage: IntegrityUsage;
	repairAttempted: boolean;
	repairSucceeded: boolean;
	latencyMs: number;
	issues: Array<{ code: string; path: string }>;
}

export interface AnalysisOutcome extends IntegrityAgentOutcomeBase {
	candidates: ValidatedCandidate[];
	consistency: ValidatedConsistency[];
	droppedClaims: number;
	evidenceHash: string;
	trace: MemoAgentTrace;
	/** Present only when the run was for a flagged case. */
	brief: IntegrityBriefResult | null;
}

export interface TriageOutcome extends IntegrityAgentOutcomeBase {
	content: DocumentIntegrityBriefContent;
	citations: CitationRecord[];
	evidence: EvidenceBundle;
	evidenceHash: string;
	trace: MemoAgentTrace;
}

interface RunnerResult {
	rawOutput: string;
	toolCalls: IntegrityToolCall[];
	sourceRefs: string[];
	steps: number;
	usage: IntegrityUsage;
}

function parseJsonObject(rawOutput: string): unknown | null {
	const trimmed = rawOutput.trim();
	if (trimmed === "") return null;
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(trimmed.slice(start, end + 1));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function sanitizeIssues(
	issues: Array<{ code: string; path: string }>,
): Array<{ code: string; path: string }> {
	return issues.slice(0, 50).map((issue) => ({
		code: issue.code.slice(0, 80),
		path: issue.path.slice(0, 200),
	}));
}

function buildTrace(input: {
	mode: IntegrityAgentMode;
	config: IntegrityConfig;
	result: RunnerResult;
	repairAttempted: boolean;
	repairSucceeded: boolean;
	evidenceHash: string;
	latencyMs: number;
}): MemoAgentTrace {
	return {
		writer: "agent",
		agentVersion: input.config.agentVersion,
		model: input.config.model,
		promptVersion:
			input.mode === "triage" ? input.config.triagePromptVersion : input.config.promptVersion,
		evidenceHash: input.evidenceHash.slice(0, 128),
		steps: input.result.steps,
		toolCalls: input.result.toolCalls.slice(0, 100).map((call) => ({
			step: call.step,
			name: call.name,
			resultCount: call.resultCount,
			sourceTypes: call.sourceTypes,
		})),
		sourceRefs: [...new Set(input.result.sourceRefs)].sort().slice(0, MAX_TOOL_REFS),
		repairAttempted: input.repairAttempted,
		repairSucceeded: input.repairSucceeded,
		fallbackReason: null,
		inputTokens: Math.max(0, Math.round(input.result.usage.inputTokens)),
		outputTokens: Math.max(0, Math.round(input.result.usage.outputTokens)),
		latencyMs: Math.max(0, Math.round(input.latencyMs)),
	};
}

function checkBounds(result: RunnerResult, config: IntegrityConfig): void {
	if (result.steps > config.maxSteps) throw new IntegrityAgentError("STEP_LIMIT");
	if (result.toolCalls.length > config.maxToolCalls) {
		throw new IntegrityAgentError("TOOL_CALL_LIMIT");
	}
	if (!Number.isFinite(result.usage.costUsd) || result.usage.costUsd > config.maxCostUsd) {
		throw new IntegrityAgentError("BUDGET_EXCEEDED");
	}
}

interface AgentLoopResult {
	result: RunnerResult;
	parsed: unknown | null;
	issues: Array<{ code: string; path: string }>;
	repairAttempted: boolean;
	repairSucceeded: boolean;
	latencyMs: number;
}

async function runLoop<T>(
	mode: IntegrityAgentMode,
	source: IntegritySource,
	runner: IntegrityAgentRunner,
	config: IntegrityConfig,
	validate: (parsed: unknown) => {
		ok: boolean;
		value?: T;
		issues: Array<{ code: string; path: string }>;
	},
	signal?: AbortSignal,
	generateBrief = false,
	conversationId?: string,
): Promise<AgentLoopResult & { value: T }> {
	const startedAt = Date.now();
	const timeout = AbortSignal.timeout(config.timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const runOnce = async (repair?: {
		previousOutput: string;
		issues: Array<{ code: string; path: string }>;
	}): Promise<{
		result: RunnerResult;
		issues: Array<{ code: string; path: string }>;
		value?: T;
	}> => {
		const raw = await runner.run({
			mode,
			generateBrief,
			source,
			maxTurns: config.maxSteps,
			conversationId,
			repair:
				repair === undefined
					? undefined
					: {
							previousOutput: repair.previousOutput.slice(0, MAX_PREVIOUS_OUTPUT),
							issues: sanitizeIssues(repair.issues),
							requireTools: true,
						},
			signal: combined,
		});
		const result: RunnerResult = {
			rawOutput: raw.rawOutput,
			toolCalls: raw.toolCalls,
			sourceRefs: [...new Set(raw.sourceRefs)].sort().slice(0, MAX_TOOL_REFS),
			steps: raw.steps,
			usage: raw.usage,
		};
		checkBounds(result, config);
		if (result.toolCalls.length === 0 && repair === undefined) {
			throw new IntegrityAgentError("NO_TOOL_USE");
		}
		const parsed = parseJsonObject(result.rawOutput);
		if (parsed === null) {
			return {
				result,
				issues: [{ code: "SCHEMA_INVALID", path: "_" }],
			};
		}
		const validated = validate(parsed);
		return { result, issues: validated.issues, value: validated.value };
	};

	let first: { result: RunnerResult; issues: Array<{ code: string; path: string }>; value?: T };
	try {
		first = await runOnce();
	} catch (err) {
		if (err instanceof IntegrityAgentError) throw err;
		if (combined.aborted) throw new IntegrityAgentError("TIMEOUT");
		throw new IntegrityAgentError("MODEL_ERROR");
	}
	const totalToolCalls = first.result.toolCalls.length;
	if (totalToolCalls > config.maxToolCalls) throw new IntegrityAgentError("TOOL_CALL_LIMIT");
	if (first.issues.length === 0 && first.value !== undefined) {
		return {
			result: first.result,
			parsed: parseJsonObject(first.result.rawOutput),
			issues: [],
			repairAttempted: false,
			repairSucceeded: false,
			latencyMs: Date.now() - startedAt,
			value: first.value,
		};
	}

	const repair = await runOnce({
		previousOutput: first.result.rawOutput,
		issues: first.issues,
	}).catch((err: unknown) => {
		if (err instanceof IntegrityAgentError) throw err;
		if (combined.aborted) throw new IntegrityAgentError("TIMEOUT");
		throw new IntegrityAgentError("MODEL_ERROR");
	});
	if (totalToolCalls + repair.result.toolCalls.length > config.maxToolCalls) {
		throw new IntegrityAgentError("TOOL_CALL_LIMIT");
	}
	if (repair.issues.length > 0 || repair.value === undefined) {
		throw new IntegrityAgentError("INVALID_OUTPUT", sanitizeIssues(repair.issues));
	}
	return {
		result: repair.result,
		parsed: parseJsonObject(repair.result.rawOutput),
		issues: [],
		repairAttempted: true,
		repairSucceeded: true,
		latencyMs: Date.now() - startedAt,
		value: repair.value,
	};
}

// --- Analysis ---

const candidateProposalSchema = z
	.object({
		documentFileId: z.uuid(),
		field: z.enum(INTEGRITY_CANDIDATE_FIELDS),
		value: z.string().min(1).max(200),
		pageNumber: z.number().int().min(1).max(100),
		quote: z.string().min(1).max(1_000),
		confidence: z.number().min(0).max(1),
	})
	.strict();

const consistencySideSchema = z
	.object({
		documentFileId: z.uuid(),
		pageNumber: z.number().int().min(1).max(100),
		value: z.string().min(1).max(200),
		label: z.string().min(1).max(100),
		currency: z.string().min(1).max(8).optional(),
		quote: z.string().min(1).max(1_000),
	})
	.strict();

const consistencyProposalSchema = z
	.object({
		field: z.enum(INTEGRITY_CONSISTENCY_FIELDS),
		proposedKind: z.enum(["match", "mismatch"]),
		left: consistencySideSchema,
		right: consistencySideSchema,
	})
	.strict();

const analysisOutputSchema = z
	.object({
		candidates: z.array(candidateProposalSchema).max(100),
		consistency: z.array(consistencyProposalSchema).max(50),
		/** Present only when the case is flagged and a brief is requested. */
		brief: z.unknown().optional(),
	})
	.strict();

function pageText(
	source: IntegritySource,
	documentFileId: string,
	pageNumber: number,
): string | null {
	const doc = source.documents.find((item) => item.documentFileId === documentFileId);
	return doc?.pages.find((page) => page.pageNumber === pageNumber)?.text ?? null;
}

function validateAnalysis(
	parsed: unknown,
	source: IntegritySource,
	now: Date,
	options: { generateBrief: boolean; forbiddenValues?: string[] },
): {
	ok: boolean;
	value?: {
		candidates: ValidatedCandidate[];
		consistency: ValidatedConsistency[];
		dropped: number;
		brief: IntegrityBriefResult | null;
	};
	issues: Array<{ code: string; path: string }>;
} {
	const schema = analysisOutputSchema.safeParse(parsed);
	if (!schema.success) {
		return {
			ok: false,
			issues: schema.error.issues.slice(0, 50).map((issue) => ({
				code: "SCHEMA_INVALID",
				path: issue.path.map(String).join(".") || "_",
			})),
		};
	}
	const input = schema.data as IntegrityAnalysisOutput;
	const issues: Array<{ code: string; path: string }> = [];
	const candidates: ValidatedCandidate[] = [];
	let dropped = 0;
	const seenCandidates = new Set<string>();
	for (const [index, proposal] of input.candidates.entries()) {
		const text = pageText(source, proposal.documentFileId, proposal.pageNumber);
		if (text === null) {
			dropped += 1;
			issues.push({ code: "CITATION_MISSING", path: `candidates.${index}` });
			continue;
		}
		const validated = validateCandidate({
			field: proposal.field,
			value: proposal.value,
			pageText: text,
			quote: proposal.quote,
			confidence: proposal.confidence,
			now,
		});
		if (validated.status === "rejected" || validated.quote === null) {
			dropped += 1;
			issues.push({
				code: validated.validationCodes.includes("quote_not_found")
					? "CITATION_QUOTE_MISMATCH"
					: "UNSUPPORTED_CLAIM",
				path: `candidates.${index}`,
			});
			continue;
		}
		const key = [
			proposal.documentFileId,
			proposal.field,
			validated.normalizedValue,
			proposal.pageNumber,
			validated.quote.offsetStart,
			validated.quote.offsetEnd,
		].join("|");
		if (seenCandidates.has(key)) continue;
		seenCandidates.add(key);
		candidates.push({
			documentFileId: proposal.documentFileId,
			field: proposal.field,
			value: proposal.value.trim(),
			normalizedValue: validated.normalizedValue,
			pageNumber: proposal.pageNumber,
			offsetStart: validated.quote.offsetStart,
			offsetEnd: validated.quote.offsetEnd,
			quote: proposal.quote.trim(),
			quoteHash: validated.quote.quoteHash,
			confidence: proposal.confidence,
			status: validated.status,
			validationCodes: validated.validationCodes,
		});
	}

	const consistency: ValidatedConsistency[] = [];
	const seenPairs = new Set<string>();
	for (const [index, proposal] of input.consistency.entries()) {
		const leftText = pageText(source, proposal.left.documentFileId, proposal.left.pageNumber);
		const rightText = pageText(source, proposal.right.documentFileId, proposal.right.pageNumber);
		if (leftText === null || rightText === null) {
			dropped += 1;
			issues.push({ code: "CITATION_MISSING", path: `consistency.${index}` });
			continue;
		}
		const validated = confirmConsistency({
			proposal: proposal as IntegrityConsistencyProposal,
			leftPageText: leftText,
			rightPageText: rightText,
		});
		if (validated.status === "rejected") {
			dropped += 1;
			issues.push({ code: "CITATION_QUOTE_MISMATCH", path: `consistency.${index}` });
			continue;
		}
		const key = [
			proposal.field,
			proposal.left.documentFileId,
			proposal.left.pageNumber,
			proposal.left.quote.trim(),
			proposal.right.documentFileId,
			proposal.right.pageNumber,
			proposal.right.quote.trim(),
		].join("|");
		if (seenPairs.has(key)) continue;
		seenPairs.add(key);
		consistency.push(validated);
	}

	let brief: IntegrityBriefResult | null = null;
	if (options.generateBrief) {
		if (input.brief === undefined) {
			issues.push({ code: "SCHEMA_INVALID", path: "brief" });
		} else {
			const validated = validateTriage(input.brief, source, options.forbiddenValues ?? []);
			if (!validated.ok || !validated.value) {
				issues.push(...validated.issues);
			} else {
				brief = validated.value;
			}
		}
	}

	const ok = dropped === 0 || candidates.length + consistency.length > 0;
	return { ok, value: { candidates, consistency, dropped, brief }, issues };
}

export async function runIntegrityAnalysis(input: {
	source: IntegritySource;
	runner: IntegrityAgentRunner;
	config: IntegrityConfig;
	evidenceHash?: string;
	signal?: AbortSignal;
	now?: Date;
	generateBrief?: boolean;
	forbiddenValues?: string[];
	/** Grafana Agent Observability conversation id (metadata only). */
	conversationId?: string;
}): Promise<AnalysisOutcome> {
	const generateBrief = input.generateBrief === true;
	const loop = await runLoop<{
		candidates: ValidatedCandidate[];
		consistency: ValidatedConsistency[];
		dropped: number;
		brief: IntegrityBriefResult | null;
	}>(
		"analysis",
		input.source,
		input.runner,
		input.config,
		(parsed) =>
			validateAnalysis(parsed, input.source, input.now ?? new Date(), {
				generateBrief,
				forbiddenValues: input.forbiddenValues,
			}),
		input.signal,
		generateBrief,
		input.conversationId,
	);
	const value = loop.value;
	const issues = loop.issues;
	const evidenceHash =
		input.evidenceHash ??
		hashCanonical({
			applicationId: input.source.applicationId,
			documents: input.source.documents.map((doc) => [doc.documentFileId, doc.sha256]),
		});
	return {
		rawOutput: loop.result.rawOutput,
		toolCalls: loop.result.toolCalls,
		sourceRefs: loop.result.sourceRefs,
		steps: loop.result.steps,
		usage: loop.result.usage,
		repairAttempted: loop.repairAttempted,
		repairSucceeded: loop.repairSucceeded,
		latencyMs: loop.latencyMs,
		issues,
		...value,
		droppedClaims: value.dropped,
		brief: value.brief,
		evidenceHash,
		trace: buildTrace({
			mode: "analysis",
			config: input.config,
			result: loop.result,
			repairAttempted: loop.repairAttempted,
			repairSucceeded: loop.repairSucceeded,
			evidenceHash,
			latencyMs: loop.latencyMs,
		}),
	};
}

// --- Triage ---

const citationTokenSchema = z
	.object({
		kind: z.enum(["document", "customer_document", "signal", "duplicate_document"]),
		documentFileId: z.uuid().optional(),
		customerDocumentId: z.uuid().optional(),
		matchingDocumentFileId: z.uuid().optional(),
		pageNumber: z.number().int().min(1).max(100).optional(),
		quote: z.string().min(1).max(1_000).optional(),
		signalCode: z.string().min(1).max(80).optional(),
	})
	.strict();

const briefClaimSchema = z
	.object({
		text: z.string().min(1).max(1_200),
		citations: z.array(citationTokenSchema).min(1).max(5),
	})
	.strict();

const briefOutputSchema = z
	.object({
		title: z.string().min(1).max(200),
		summary: briefClaimSchema,
		candidateContradictions: z.array(briefClaimSchema).max(20),
		missingEvidence: z
			.array(
				z
					.object({
						text: z.string().min(1).max(500),
						code: z.enum([
							"missing_document",
							"stale_document",
							"failed_rule",
							"unsupported_claim",
							"contradiction",
							"financials_unavailable",
							"other",
						]),
						sourceRef: z.string().min(1).max(500).optional(),
					})
					.strict(),
			)
			.max(20),
		alternativeExplanations: z.array(briefClaimSchema).max(10),
		questionsForReviewer: z.array(z.string().min(1).max(500)).max(10),
		suggestedPriority: z.enum(["low", "medium", "high"]),
	})
	.strict();

interface ResolvedCitation {
	ref: string;
	quote: string;
	item: EvidenceItem;
}

/** Exact quote first; then a whitespace-normalized locate for model-copied
 * hard wraps. The stored quote is always the canonical source substring. */
function locateVerifiedQuote(
	pageText: string,
	quote: string,
): { offsetStart: number; offsetEnd: number; quote: string; quoteHash: string } | null {
	const exact = verifyQuote(pageText, quote);
	if (exact) {
		return { ...exact, quote: quote.trim() };
	}
	const located = locateQuote(pageText, quote, { minLength: 3 });
	if (!located) return null;
	return {
		offsetStart: utf16IndexToCodePoint(pageText, located.quoteStart),
		offsetEnd: utf16IndexToCodePoint(pageText, located.quoteEnd),
		quote: located.quote,
		quoteHash: sha256Hex(Buffer.from(located.quote, "utf8")),
	};
}

function resolveCitation(
	token: IntegrityBriefCitationToken,
	source: IntegritySource,
): ResolvedCitation | null {
	if (token.kind === "signal") {
		const matches = source.signals.filter((item) => item.code === token.signalCode);
		const signal =
			matches.find(
				(item) =>
					token.documentFileId === undefined || item.documentFileId === token.documentFileId,
			) ?? matches[0];
		if (!signal) return null;
		const quote = signal.summary;
		return {
			ref: signal.sourceRef,
			quote,
			item: {
				ref: signal.sourceRef,
				sourceType: "context_signal",
				label: `deterministic signal ${signal.code}`,
				content: quote,
				access: { retentionUntil: null, legalHold: false },
				metadata: {
					code: signal.code,
					severity: signal.severity,
					documentFileId: signal.documentFileId,
				},
			},
		};
	}
	if (token.kind === "duplicate_document") {
		const match = source.duplicateMatches.find(
			(item) => item.matchingDocumentFileId === token.matchingDocumentFileId,
		);
		if (!match) return null;
		const ref = `context_signal:duplicate_document:${match.matchingDocumentFileId}`;
		const quote = "matching document hash in another application";
		return {
			ref,
			quote,
			item: {
				ref,
				sourceType: "context_signal",
				label: "duplicate document context",
				content: quote,
				access: { retentionUntil: null, legalHold: false },
				metadata: { relation: match.relation, kind: match.kind },
			},
		};
	}
	if (token.kind === "customer_document") {
		if (!source.includeCustomerEvidence) return null;
		const doc = source.customerDocuments.find(
			(item) => item.customerDocumentId === token.customerDocumentId,
		);
		if (!doc || !doc.readable || token.pageNumber === undefined || !token.quote) return null;
		const page = doc.pages.find((item) => item.pageNumber === token.pageNumber);
		if (!page) return null;
		const verified = locateVerifiedQuote(page.text, token.quote);
		if (!verified) return null;
		const ref = `context_signal:customer_document:${doc.customerDocumentId}:p${page.pageNumber}`;
		return {
			ref,
			quote: verified.quote,
			item: {
				ref,
				sourceType: "context_signal",
				label: `same-customer document ${doc.kind} page ${page.pageNumber}`,
				content: verified.quote,
				access: { retentionUntil: null, legalHold: false },
				metadata: { customerDocumentId: doc.customerDocumentId, pageNumber: page.pageNumber },
			},
		};
	}
	const doc = source.documents.find((item) => item.documentFileId === token.documentFileId);
	if (!doc || token.pageNumber === undefined || !token.quote) return null;
	const page = doc.pages.find((item) => item.pageNumber === token.pageNumber);
	if (!page) return null;
	const verified = locateVerifiedQuote(page.text, token.quote);
	if (!verified) return null;
	const ref = `document:${doc.documentFileId}:p${page.pageNumber}:${verified.offsetStart}-${verified.offsetEnd}`;
	return {
		ref,
		quote: verified.quote,
		item: {
			ref,
			sourceType: "document",
			label: `document ${doc.kind} page ${page.pageNumber}`,
			content: verified.quote,
			access: { retentionUntil: null, legalHold: false },
			metadata: {
				documentFileId: doc.documentFileId,
				pageNumber: page.pageNumber,
				offsetStart: verified.offsetStart,
				offsetEnd: verified.offsetEnd,
			},
		},
	};
}

function unavailableItems(source: IntegritySource): UnavailableSource[] {
	return source.unavailable.slice(0, 100).map((item, index) => ({
		ref: `context_signal:unavailable:${index}`,
		sourceType: "context_signal",
		code: item.code,
		detail: item.label.slice(0, 300),
	}));
}

function validateTriage(
	parsed: unknown,
	source: IntegritySource,
	forbiddenValues: string[],
): {
	ok: boolean;
	value?: {
		content: DocumentIntegrityBriefContent;
		citations: CitationRecord[];
		evidence: EvidenceBundle;
	};
	issues: Array<{ code: string; path: string }>;
} {
	const schema = briefOutputSchema.safeParse(parsed);
	if (!schema.success) {
		return {
			ok: false,
			issues: schema.error.issues.slice(0, 50).map((issue) => ({
				code: "SCHEMA_INVALID",
				path: issue.path.map(String).join(".") || "_",
			})),
		};
	}
	const output = schema.data as IntegrityBriefOutput;
	const issues: Array<{ code: string; path: string }> = [];
	const items = new Map<string, EvidenceItem>();
	const citations: CitationRecord[] = [];

	const resolveClaim = (
		claim: { text: string; citations: IntegrityBriefCitationToken[] },
		path: string,
	): { text: string; citations: Array<{ ref: string; quote: string }> } | null => {
		const resolved: ResolvedCitation[] = [];
		const seen = new Set<string>();
		for (const [index, token] of claim.citations.entries()) {
			const citation = resolveCitation(token, source);
			if (!citation) {
				issues.push({
					code:
						token.kind === "document" || token.kind === "customer_document"
							? "CITATION_QUOTE_MISMATCH"
							: "CITATION_MISSING",
					path: `${path}.citations.${index}`,
				});
				continue;
			}
			if (seen.has(citation.ref)) {
				issues.push({
					code: "CITATION_MALFORMED",
					path: `${path}.citations.${index}`,
				});
				continue;
			}
			seen.add(citation.ref);
			resolved.push(citation);
			items.set(citation.ref, citation.item);
		}
		if (resolved.length === 0) {
			issues.push({ code: "UNSUPPORTED_CLAIM", path });
			return null;
		}
		for (const [index, citation] of resolved.entries()) {
			citations.push({
				path: `${path}.citations.${index}`,
				ref: citation.ref,
				quote: citation.quote,
			});
		}
		return {
			text: claim.text,
			citations: resolved.map((citation) => ({
				ref: citation.ref,
				quote: citation.quote,
			})),
		};
	};

	const summary = resolveClaim(output.summary, "summary");
	if (!summary) return { ok: false, issues };
	const contradictions: Array<{ text: string; citations: Array<{ ref: string; quote: string }> }> =
		[];
	for (const [index, claim] of output.candidateContradictions.entries()) {
		const resolved = resolveClaim(claim, `candidateContradictions.${index}`);
		if (resolved) contradictions.push(resolved);
	}
	const alternatives: Array<{ text: string; citations: Array<{ ref: string; quote: string }> }> =
		[];
	for (const [index, claim] of output.alternativeExplanations.entries()) {
		const resolved = resolveClaim(claim, `alternativeExplanations.${index}`);
		if (resolved) alternatives.push(resolved);
	}

	// Case facts are not citations, but the validator's known-PII scan needs
	// them in the bundle (and the brief must not repeat them).
	for (const fact of source.caseFacts) {
		if (
			fact.field !== "applicantName" &&
			fact.field !== "companyName" &&
			fact.field !== "registrationNumber"
		) {
			continue;
		}
		const ref = `case_fact:${source.applicationId}:${fact.field}`;
		items.set(ref, {
			ref,
			sourceType: "case_fact",
			label: fact.label,
			content: fact.value,
			access: { retentionUntil: null, legalHold: false },
			metadata: { field: fact.field },
		});
	}
	const evidence: EvidenceBundle = {
		applicationId: source.applicationId,
		asOf: new Date().toISOString(),
		assembledAt: new Date().toISOString(),
		items: [...items.values()].slice(0, 500),
		unavailable: unavailableItems(source),
	};
	const forbidden = [
		...(forbiddenValues ?? []),
		...source.caseFacts
			.filter((fact) =>
				[
					"applicantName",
					"companyName",
					"registrationNumber",
					"customerCompanyName",
					"customerRegistrationNumber",
				].includes(fact.field),
			)
			.map((fact) => fact.value),
	];
	const content = {
		title: output.title,
		summary,
		candidateContradictions: contradictions,
		alternativeExplanations: alternatives,
		missingEvidence: output.missingEvidence,
		questionsForReviewer: output.questionsForReviewer,
		suggestedPriority: output.suggestedPriority,
	};
	if (issues.length > 0) return { ok: false, issues };
	const validation = validateGeneratedText({
		artifactType: "document_integrity_brief",
		content,
		evidence,
		forbiddenValues: forbidden,
	});
	if (!validation.ok) {
		return {
			ok: false,
			issues: validation.issues.map((issue) => ({ code: issue.code, path: issue.path })),
		};
	}
	return {
		ok: true,
		value: {
			content: validation.content as DocumentIntegrityBriefContent,
			citations: validation.citations,
			evidence,
		},
		issues: [],
	};
}

export async function runIntegrityTriage(input: {
	source: IntegritySource;
	runner: IntegrityAgentRunner;
	config: IntegrityConfig;
	evidenceHash: string;
	forbiddenValues?: string[];
	signal?: AbortSignal;
	conversationId?: string;
}): Promise<TriageOutcome> {
	// Thin compatibility wrapper for the eval harness/tests: one combined
	// agent call, brief required. Production uses runIntegrityAnalysis directly.
	const outcome = await runIntegrityAnalysis({
		source: input.source,
		runner: input.runner,
		config: input.config,
		evidenceHash: input.evidenceHash,
		forbiddenValues: input.forbiddenValues,
		signal: input.signal,
		generateBrief: true,
		conversationId: input.conversationId,
	});
	if (!outcome.brief) {
		throw new IntegrityAgentError("INVALID_OUTPUT", [{ code: "SCHEMA_INVALID", path: "brief" }]);
	}
	return {
		rawOutput: outcome.rawOutput,
		toolCalls: outcome.toolCalls,
		sourceRefs: outcome.sourceRefs,
		steps: outcome.steps,
		usage: outcome.usage,
		repairAttempted: outcome.repairAttempted,
		repairSucceeded: outcome.repairSucceeded,
		latencyMs: outcome.latencyMs,
		issues: outcome.issues,
		...outcome.brief,
		evidenceHash: outcome.evidenceHash,
		trace: outcome.trace,
	};
}
