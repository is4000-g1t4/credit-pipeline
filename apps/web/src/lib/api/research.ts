// --- Advisory agentic research (Phase 2, SPEC §5/§8). Officer-only.
// The browser never sends a frozen bundle: decisions carry only the
// selection ({agentRunId, acceptedFindingIds}); review resolves the
// server-built bundle. Unverified findings are never rendered.

import { api } from "./client";
import type { ResearchPolicy } from "./policy";

export type ResearchRunStatus = "queued" | "running" | "succeeded" | "failed";

export interface ResearchRunSummary {
	id: string;
	applicationId: string;
	feature: string;
	status: ResearchRunStatus;
	/** How the run started: officer click or automatic referral trigger. */
	trigger?: string;
	requestedBy?: string;
	/** Who requested it: officer id or the service automation principal. */
	requestedByRole?: string;
	model?: string;
	agentVersion?: string;
	promptVersion?: string;
	asOf?: string;
	observability?: string;
	errorCode?: string | null;
	createdAt?: string;
	startedAt?: string | null;
	finishedAt?: string | null;
}

export interface ResearchEvidenceItem {
	id: string;
	url: string;
	finalUrl?: string;
	title?: string | null;
	publisher: string;
	publishedAt?: string | null;
	dateBasis?: string;
	retrievedAt?: string | null;
	quote: string;
	sourceTier?: string;
}

export interface ResearchFindingItem {
	id: string;
	claim: string;
	category: string;
	whyItMatters?: string;
	allegationStatus?: string;
	support: string;
	confidence?: string;
	confidenceBasis?: unknown;
	entityMatch?: unknown;
	evidence: ResearchEvidenceItem[];
	evidenceIds?: string[];
	reviewStatus?: string;
	reviewedAt?: string | null;
}

export interface ResearchBrief {
	summary?: string;
	contradictions?: Array<{ description: string; evidenceIds?: string[] }>;
	unknowns?: string[];
	questionsForOfficer?: string[];
}

// --- T18 internal context (SPEC-t17-t18 §3.6, D4). Metadata only: signal
// type/period/metric/confidence/status/policy version plus evidence *ids*.
// Never transaction descriptions, counterparties, or document text. ---

export interface ResearchContextSignal {
	id: string;
	stageVersion: number;
	accountScope: string;
	type: string;
	periodStart: string | null;
	periodEnd: string | null;
	metric: string;
	observed: number | null;
	expected: number | null;
	confidence: string;
	status: string;
	policyVersion: string;
	explanation: string | null;
	evidence: Array<{ kind: string; id: string; page?: number }>;
	reviewStatus?: string;
	reviewedAt?: string | null;
}

export interface ResearchContext {
	status: string;
	stageVersion: number;
	errorCode: string | null;
	model: string | null;
	brief: {
		summary?: string;
		claims?: Array<{ text: string; signalRefs: number[] }>;
		dataGaps?: string[];
		limitations?: string[];
	} | null;
	validation: unknown;
	usage: { costUsd?: number } | null;
	startedAt: string | null;
	finishedAt: string | null;
	signals: ResearchContextSignal[];
}

export interface ResearchUsage {
	toolCalls?: number;
	searches?: number;
	extracts?: number;
	costUsd?: number;
}

export interface ResearchAggregate {
	run: ResearchRunSummary;
	brief?: ResearchBrief | null;
	validation?: unknown;
	usage?: ResearchUsage | null;
	evidence?: ResearchEvidenceItem[];
	findings?: ResearchFindingItem[];
	/** T18 context stage; absent on runs from before the stage existed. */
	context?: ResearchContext | null;
	/** Policy review stage; absent on runs from before the stage existed. */
	policy?: ResearchPolicy | null;
	viewedAt?: string | null;
}

export interface ResearchSelection {
	agentRunId: string;
	acceptedFindingIds: string[];
}

// --- Auto-trigger audit (T11): skip/ensure/duplicate history with ids and
// codes only — never case facts, quotes, or applicant data. ---

export interface ResearchAuditEntry {
	action: string;
	actorRole: string;
	runId: string | null;
	metadata: Record<string, unknown>;
	createdAt: string;
}

export interface ResearchAudit {
	applicationId: string;
	entries: ResearchAuditEntry[];
}

export function ensureResearch(applicationId: string): Promise<{ runId: string; status: string }> {
	return api<{ runId: string; status: string }>(`/api/review/${applicationId}/research`, {
		method: "POST",
	});
}

export function fetchResearch(applicationId: string): Promise<ResearchAggregate> {
	return api<ResearchAggregate>(`/api/review/${applicationId}/research`);
}

export function fetchResearchAudit(applicationId: string): Promise<ResearchAudit> {
	return api<ResearchAudit>(`/api/review/${applicationId}/research/audit`);
}

export function viewResearch(
	applicationId: string,
	runId: string,
): Promise<{ runId: string; viewedAt: string; deduped: boolean }> {
	return api<{ runId: string; viewedAt: string; deduped: boolean }>(
		`/api/review/${applicationId}/research/view`,
		{ method: "POST", body: { runId } },
	);
}

export function reviewResearchFinding(
	applicationId: string,
	findingId: string,
	action: "accepted" | "rejected",
	note?: string,
): Promise<{ id: string; findingId: string; action: string }> {
	return api<{ id: string; findingId: string; action: string }>(
		`/api/review/${applicationId}/research/findings/${findingId}`,
		{ method: "POST", body: note === undefined ? { action } : { action, note } },
	);
}

/** T18 context retry (officer-only): 202 with the stage token/version; the
 * stage runs in the background — poll latest until the stage settles. */
export function retryResearchContext(
	applicationId: string,
): Promise<{ runId: string; contextStageToken: string; contextStageVersion: number }> {
	return api<{ runId: string; contextStageToken: string; contextStageVersion: number }>(
		`/api/review/${applicationId}/research/context/retry`,
		{ method: "POST", body: {} },
	);
}

/** T18 signal review (officer-only, append-only): accept/dismiss one live
 * signal with an optional note; returns the updated signal. */
export function reviewContextSignal(
	applicationId: string,
	signalId: string,
	action: "accepted" | "rejected",
	note?: string,
): Promise<{
	id: string;
	signalId: string;
	action: string;
	signal: ResearchContextSignal;
}> {
	return api<{
		id: string;
		signalId: string;
		action: string;
		signal: ResearchContextSignal;
	}>(`/api/review/${applicationId}/research/context/signals/${signalId}/review`, {
		method: "POST",
		body: note === undefined ? { action } : { action, note },
	});
}
