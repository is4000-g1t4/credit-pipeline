// Activity DTOs + the Activities interface proxied by workflows.
// Plain JSON only: no DB or Temporal imports here (workflows import this
// file for the type, and workflow bundles stay free of Node-only code).
import type {
	CheckReasonCode,
	Grade,
	MonitoringCounts,
	OfficerDecisionInput,
	OfficerDecisionResult,
	OfficerReasonCode,
	PolicyReason,
	Product,
	ResearchBundle,
} from "@credit/core";

// Single home for the decision/update + monitoring contracts is
// @credit/core (see contracts.ts) — this file re-exports them so
// workflows/activities/tests keep importing from here.
export type { MonitoringCounts, OfficerDecisionInput, OfficerDecisionResult };
/** Monitoring sweep counts — one name (`MonitoringCounts`) from @credit/core. */
export type MonitoringResult = MonitoringCounts;

export interface ApplicationWorkflowInput {
	applicationId: string;
}

export interface ApplicationDto {
	id: string;
	reference: string;
	type: "individual" | "sme";
	product: Product;
	status: string;
	amountCents: number;
	termMonths: number;
	purpose: string;
	identity: unknown;
	financial: unknown;
	business: unknown;
	// T17: null for drafts; worker paths only run post-submit (non-null).
	submittedAt: string | null;
	decidedAt: string | null;
}

export interface VerificationResult {
	check: "identity" | "sanctions";
	passed: boolean;
}

export interface DocumentResult {
	verified: boolean;
	kinds: string[];
}

export interface DataFetchInput {
	applicationId: string;
	forcedFailure?: boolean;
}

/** Everything the officer-update validator needs, synchronously. */
export interface ScoringSummary {
	kind: "individual" | "sme";
	score: number;
	grade: Grade;
	product: Product;
	requestedAmountCents: number;
	requestedTermMonths: number;
	rateBps: number;
	newPaymentCents: number;
	monthlyIncomeCents: number | null;
	existingDebtCents: number | null;
	monthlyFcfCents: number | null;
	existingDebtServiceCents: number | null;
}

export interface PolicyDecision {
	outcome: "auto_approve" | "refer" | "decline";
	reasons: PolicyReason[];
	maxAmountCents: number;
}

export interface BookLoanInput {
	applicationId: string;
	route: "auto" | "officer";
	approvedAmountCents?: number;
	termMonths?: number;
	requestId?: string | null;
	officerUserId?: string | null;
	notes?: string | null;
	research?: ResearchBundle;
}

export interface BookLoanResult {
	decisionId: string;
	loanId: string;
	replayed: boolean;
	approvedAmountCents: number;
	termMonths: number;
	rateBps: number;
}

export interface PersistCheckOnlyDeclineInput {
	applicationId: string;
	reasons: CheckReasonCode[];
}

export interface PersistOfficerDeclineInput {
	applicationId: string;
	requestId: string;
	officerUserId?: string | null;
	reasonCode: OfficerReasonCode;
	notes: string;
	research?: ResearchBundle;
}

export interface PersistDecisionResult {
	decisionId: string;
	replayed: boolean;
	status: string;
}

export interface MarkFailedResult {
	marked: boolean;
}

export interface PendingReviewResult {
	status: string;
}

export interface ExpireReviewResult {
	expired: boolean;
}

export interface ApplicationWorkflowResult {
	applicationId: string;
	outcome: "booked" | "declined" | "expired" | "already_terminal";
	kind: "auto" | "officer" | "policy" | "check_only" | null;
	decisionId: string | null;
	loanId: string | null;
	/** Present only for already_terminal (the untouched terminal status). */
	status?: string;
}

export interface Activities {
	loadApplicationAndSetProcessing(input: { applicationId: string }): Promise<ApplicationDto | null>;
	loadApplication(input: { applicationId: string }): Promise<ApplicationDto>;
	runIdentityCheck(input: { applicationId: string }): Promise<VerificationResult>;
	runSanctionsCheck(input: { applicationId: string }): Promise<VerificationResult>;
	runDocumentCheck(input: { applicationId: string }): Promise<DocumentResult>;
	fetchBureauReport(input: DataFetchInput): Promise<unknown>;
	fetchBankData(input: DataFetchInput): Promise<unknown>;
	scoreAndPersist(input: { applicationId: string }): Promise<ScoringSummary>;
	evaluateAndPersistPolicy(input: { applicationId: string }): Promise<PolicyDecision>;
	persistDecline(input: { applicationId: string }): Promise<PersistDecisionResult>;
	persistCheckOnlyDecline(input: PersistCheckOnlyDeclineInput): Promise<PersistDecisionResult>;
	persistOfficerDecline(input: PersistOfficerDeclineInput): Promise<PersistDecisionResult>;
	markPendingReview(input: { applicationId: string }): Promise<PendingReviewResult>;
	expireReview(input: { applicationId: string }): Promise<ExpireReviewResult>;
	bookLoan(input: BookLoanInput): Promise<BookLoanResult>;
	runMonitoring(input: { todayUtc: string }): Promise<MonitoringResult>;
	markFailed(input: { applicationId: string; reason: string }): Promise<MarkFailedResult>;
}
