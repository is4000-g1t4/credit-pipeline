import type { CitationRecord } from "@credit/core";
import type { generatedArtifacts } from "@credit/db/applications";

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
