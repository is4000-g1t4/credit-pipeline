import type { PolicySectionRow } from "@credit/core";
import type { PolicyCaseContext } from "./case-context.js";
import type { AnswerCitation, RetrievedSection } from "./answer.js";

export interface ActiveIndex {
	indexVersion: string;
	embeddingModel: string;
	embeddingDimensions: number;
	chunkingVersion: string;
}

export interface PolicyChunk extends RetrievedSection {
	chunkId: string;
	indexVersion: string;
	/** Section body hash; used by the bridge delivery and index freshness. */
	contentHash: string;
	embedding: number[];
	embeddingModel: string;
	embeddingDimensions: number;
	chunkingVersion: string;
}

export interface AclRow {
	policyId: string;
	principalType: "role" | "user" | "service";
	principal: string;
	permission: "read" | "case_explain" | "admin";
}

export interface PolicySectionDetail {
	policyId: string;
	policyKey: string;
	title: string;
	policyVersionId: string;
	version: string;
	status: string;
	effectiveFrom: string;
	effectiveTo: string | null;
	sectionId: string;
	heading: string;
	body: string;
	neighbours: Array<{ sectionId: string; heading: string }>;
}

export interface ApprovedPolicyDocument {
	policyId: string;
	policyKey: string;
	title: string;
	version: string;
	versionId: string;
	effectiveFrom: string;
	effectiveTo: string | null;
	productScope: string;
	jurisdiction: string;
	sectionCount: number;
}

export interface PolicyQueryRecord {
	id: string;
	actorId: string;
	actorRole: string;
	mode: "navigator" | "case_explain";
	budgetClass: "navigator" | "case" | "policy_exception";
	applicationId: string | null;
	runId: string | null;
	questionHmac: string | null;
	domain: "credit";
	asOf: string;
	status: string;
	errorCode: string | null;
	retrievedSectionIds: string[];
	usageCost: number;
}

export interface PolicyStore {
	getActiveIndex(): Promise<ActiveIndex | null>;
	loadChunks(input: {
		asOf: string;
		productScope: "individual" | "sme";
		jurisdiction: string;
		statuses: Array<"approved" | "retired">;
		indexVersion: string;
	}): Promise<PolicyChunk[]>;
	loadAcls(policyIds: string[]): Promise<AclRow[]>;
	loadPolicyRoles(userId: string): Promise<Array<"policy_owner" | "compliance">>;
	getSection(versionId: string, sectionId: string): Promise<PolicySectionDetail | null>;
	getSectionByRef(input: {
		policyKey: string;
		sectionId: string;
		asOf: string;
		productScope: "individual" | "sme";
		jurisdiction: string;
		versionId?: string;
	}): Promise<PolicySectionRow | null>;
	listVersionSectionIds(versionId: string): Promise<string[]>;
	listVersionCorpusSections(
		versionId: string,
	): Promise<
		Array<{ policyKey: string; sectionId: string; productScope: "individual" | "sme" | "all" }>
	>;
	listApprovedCorpusSections(): Promise<
		Array<{ policyKey: string; sectionId: string; productScope: "individual" | "sme" | "all" }>
	>;
	listApprovedPolicyDocuments(asOf: string): Promise<ApprovedPolicyDocument[]>;
	hasVersionChunks(versionId: string): Promise<boolean>;
	insertQuery(record: PolicyQueryRecord): Promise<void>;
	insertCitations(
		queryId: string,
		rows: Array<{ itemRef: string | null; segmentIndex: number; citation: AnswerCitation }>,
	): Promise<void>;
	consumeCaseToken(jti: string, runId: string, applicationId: string): Promise<boolean>;
	getVersion(versionId: string): Promise<{
		id: string;
		policyId: string;
		status: string;
		effectiveFrom: string;
		effectiveTo: string | null;
		submittedBy: string | null;
		createdByUserId: string | null;
		version: string;
	} | null>;
	approveVersion(versionId: string, actorId: string, effectiveFrom: string): Promise<void>;
	submitVersion(versionId: string, actorId: string): Promise<void>;
	retireVersion(versionId: string, actorId: string): Promise<void>;
	reserveBudget(input: {
		day: string;
		budgetClass: "navigator" | "case" | "policy_exception";
		actorId: string;
		maxCostUsd: number;
		dailyCapUsd: number;
		actorCapUsd: number;
		ttlSeconds: number;
	}): Promise<{ reservationId: string } | { error: "budget_exceeded" }>;
	settleBudget(reservationId: string, actualCostUsd: number): Promise<void>;
}

export interface PolicyDeps {
	store: PolicyStore;
	embedder: Embedder;
	answerer: PolicyAnswerer;
	env: {
		assistEnabled: boolean;
		citationSecret: string;
		auditHashSecret: string;
		jurisdiction: string;
		retrievalTopK: number;
		agentTimeoutMs: number;
		caseTimeoutMs: number;
		agentMaxCostUsd: number;
		caseMaxCostUsd: number;
		navDailyBudgetUsd: number;
		caseDailyBudgetUsd: number;
		actorDailyBudgetUsd: number;
		policyExceptionDailyBudgetUsd: number;
		reservationTtlSeconds: number;
		caseTokenSecret: string;
		embeddingModel: string;
		embeddingDimensions: number;
	};
	logger: {
		info: (obj: unknown, msg?: string) => void;
		warn: (obj: unknown, msg?: string) => void;
		error: (obj: unknown, msg?: string) => void;
	};
}

export interface Embedder {
	model: string;
	dimensions: number;
	embed(inputs: string[], opts?: { conversationId?: string }): Promise<number[][]>;
}

export interface PolicyAnswerer {
	answerNavigator(input: {
		question: string;
		sections: RetrievedSection[];
		signal: AbortSignal;
		conversationId?: string;
	}): Promise<AnswererResult>;
	answerCase(input: {
		context: PolicyCaseContext;
		sections: RetrievedSection[];
		signal: AbortSignal;
		conversationId?: string;
	}): Promise<AnswererResult>;
}

export interface AnswererUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	model: string;
}

export interface AnswererResult {
	output: unknown;
	usage: AnswererUsage;
}
