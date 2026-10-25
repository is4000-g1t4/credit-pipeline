import type { CitationRecord } from "@credit/core";
import type { generatedArtifacts } from "@credit/db/applications";
import type { MemoAgentRunner } from "./memo-agent.js";
import type { MemoAgentTrace } from "./memo-trace.js";

export type { MemoAgentTrace } from "./memo-trace.js";

export type ArtifactType = (typeof generatedArtifacts.$inferSelect)["type"];
export type ArtifactStatus = (typeof generatedArtifacts.$inferSelect)["status"];

export interface AssistConfig {
	enabled: boolean;
	retentionDays: number;
	researchUrl: string | null;
	researchTimeoutMs: number;
	internalSecret: string;
	model: string;
	promptVersion: string;
	/** Agentic memo writer selection; `agent` requires an OpenRouter key. */
	memoWriter: "deterministic" | "agent";
	memoModel: string;
	memoPromptVersion: string;
	memoAgentVersion: string;
	memoMaxSteps: number;
	memoMaxToolCalls: number;
	memoTimeoutMs: number;
	memoMaxCostUsd: number;
	memoMaxOutputTokens: number;
	openRouterApiKey: string | null;
	openRouterBaseUrl: string;
	/** EN-08 adverse-action profile selection. */
	adverseJurisdiction: string;
	adverseContactPath: string;
	adversePromptVersion: string;
}

/** Metadata-only audit additions. Never include generated text, document
 * text, or applicant PII. */
export type ArtifactAuditMetadata = Record<string, string | number | boolean | string[] | null>;

export interface AssistRuntime {
	config: AssistConfig;
	documentsEnabled: boolean;
	/** Test seam; production uses the wall clock. */
	now: () => Date;
	researchFetchImpl?: typeof fetch;
	/** Test seam for the agentic memo writer; routes build the SDK runner. */
	memoAgentRunner?: MemoAgentRunner;
}

/** Public artifact shape. Content is whatever the validated type schema
 * produced; citations are the server-extracted citation records. */
export interface ArtifactDto {
	id: string;
	applicationId: string;
	type: ArtifactType;
	version: number;
	revision: number;
	status: ArtifactStatus;
	/** True when the artifact cites document evidence; reads then require the
	 * active assigned-officer grant. */
	documentDerived: boolean;
	content: unknown;
	citations: CitationRecord[];
	/** Agentic provenance; null for deterministic artifacts. */
	agentTrace: MemoAgentTrace | null;
	/** Indexed replay key mirroring `agentTrace.evidenceHash`; null when untraced. */
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
