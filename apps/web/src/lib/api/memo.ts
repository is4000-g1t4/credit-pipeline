// --- Agentic credit memo (assist EN-01/02, officer-only). Draft + version
// history + approval ride the assist routes; the panel hides while the flag
// is off (404). The trace is metadata only — never prompts or
// chain-of-thought. ---

import { api } from "./client";

export interface MemoTraceToolCall {
	step: number;
	name: string;
	resultCount: number;
	sourceTypes: string[];
}

export interface MemoAgentTrace {
	writer: "deterministic" | "agent";
	agentVersion: string;
	model: string;
	promptVersion: string;
	evidenceHash: string;
	steps: number;
	toolCalls: MemoTraceToolCall[];
	sourceRefs: string[];
	repairAttempted: boolean;
	repairSucceeded: boolean | null;
	fallbackReason: string | null;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
	/** E3 policy-exception provenance; absent on credit-memo traces. */
	registryVersion?: string;
	registryHash?: string;
	validatorVersion?: string;
	artifactType?: string;
}

export interface MemoCitation {
	ref: string;
	quote: string;
}

export interface MemoClaim {
	text: string;
	citations: MemoCitation[];
}

export interface MemoSection {
	key: string;
	title: string;
	claims: MemoClaim[];
	notAvailable: boolean;
}

export interface MemoOpenItem {
	text: string;
	code: string;
	sourceRef?: string;
}

export interface CreditMemoContent {
	title: string;
	sections: MemoSection[];
	openItems: MemoOpenItem[];
	officerQuestions: string[];
}

export interface AssistArtifact {
	id: string;
	applicationId: string;
	type: string;
	version: number;
	revision: number;
	status: string;
	documentDerived: boolean;
	content: CreditMemoContent;
	citations: MemoCitation[];
	/** Null for artifacts written before trace persistence existed. */
	agentTrace: MemoAgentTrace | null;
	evidenceHash: string | null;
	model: string;
	promptVersion: string;
	createdBy: string;
	approvedBy: string | null;
	createdAt: string;
	updatedAt: string;
	approvedAt: string | null;
	deletedAt: string | null;
	retentionUntil: string;
}

/** 201 on a fresh draft, 200 `{ artifact, replayed: true }` on identical evidence. */
export function draftMemo(
	applicationId: string,
): Promise<{ artifact: AssistArtifact; replayed?: boolean }> {
	return api<{ artifact: AssistArtifact; replayed?: boolean }>(
		`/api/assist/cases/${applicationId}/memos`,
		{ method: "POST" },
	);
}

export function listMemoArtifacts(applicationId: string): Promise<{ items: AssistArtifact[] }> {
	return api<{ items: AssistArtifact[] }>(
		`/api/assist/cases/${applicationId}/artifacts?type=credit_memo`,
	);
}

export function approveMemo(
	id: string,
	expectedRevision: number,
): Promise<{ artifact: AssistArtifact }> {
	return api<{ artifact: AssistArtifact }>(`/api/assist/artifacts/${id}/approve`, {
		method: "POST",
		body: { expectedRevision, confirm: true },
	});
}

export function updateMemo(
	id: string,
	expectedRevision: number,
	content: CreditMemoContent,
): Promise<{ artifact: AssistArtifact; createdVersion: boolean }> {
	return api<{ artifact: AssistArtifact; createdVersion: boolean }>(`/api/assist/artifacts/${id}`, {
		method: "PATCH",
		body: { expectedRevision, content },
	});
}
