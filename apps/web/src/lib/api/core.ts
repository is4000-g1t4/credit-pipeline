// --- Core application/loan/review/dashboard types + typed fetchers. ---
// Query keys are the single source of truth for these entities; the VALUES
// match the previous ad-hoc literals so invalidation behavior is unchanged.

import { api } from "./client";

export interface SessionUser {
	id: string;
	email: string;
	fullName: string;
	role: "applicant" | "officer";
}
export interface MeResponse {
	user: SessionUser;
	demoMode: boolean;
}

export interface AppSummary {
	id: string;
	reference: string;
	type: string;
	product: string;
	status: string;
	amountCents: number;
	termMonths: number;
	// T17: null for drafts; submitted rows stay non-null.
	submittedAt: string | null;
	decidedAt: string | null;
	updatedAt: string;
}

export interface Factor {
	code: string;
	label: string;
	points: number;
	impact: string;
}
export interface TimelineEntry {
	at: string;
	kind?: "audit" | "feed";
	action?: string;
	actor?: string;
	entity?: string;
	type?: string;
	message?: string;
	payload?: unknown;
}
export interface CaseDetail {
	application: AppSummary & {
		identity: Record<string, unknown>;
		financial: Record<string, unknown> | null;
		business: Record<string, unknown> | null;
		consents: unknown;
		/** Officer-visible flag gating the research Run button. */
		aiResearchConsent: boolean | null;
		/** T01 document workflow (D0: intake + detail only). */
		documentProcessingConsent: boolean;
		documentConsentAt: string | null;
		documentConsentVersion: string | null;
		contextAnalysisConsent: boolean;
		contextConsentAt: string | null;
		contextConsentVersion: string | null;
		/** T01 feature flag (SPEC-t01-t02 §10): false hides DocumentPanel. */
		documentsEnabled: boolean;
		purpose: string;
		workflowStartedAt: string | null;
		failedReason: string | null;
	};
	checks: Array<{ type: string; status: string; details?: unknown }>;
	externalReports?: Array<{
		provider: string;
		kind: string;
		version: string;
		payload: Record<string, unknown>;
	}>;
	documents: Array<{ kind: string; status: string; note: string | null }>;
	score?: {
		score: number;
		grade: string;
		modelVersion: string;
		components: Record<string, unknown> | null;
		factors: Factor[];
		affordability: {
			kind?: string;
			newPaymentCents?: number;
			dti?: number;
			dscr?: number;
		};
	} | null;
	policyEvaluation?: {
		outcome: string;
		reasons: Array<{ code: string; text?: string }>;
		maxAmountCents: number;
		policyVersion: string;
	} | null;
	decision: {
		id: string;
		outcome: string;
		decidedBy: string;
		approvedAmountCents: number | null;
		termMonths: number | null;
		rateBps: number | null;
		reasons: Array<string | { code: string }>;
		notes?: string | null;
		snapshot?: { kind?: string } & Record<string, unknown>;
		decidedAt: string;
	} | null;
	loan: {
		id: string;
		principalCents: number;
		termMonths: number;
		rateBps: number;
		monthlyPaymentCents: number;
		status: string;
		outstandingCents: number;
		nextDueDate: string | null;
		disbursedAt: string;
		installments: { total: number; paid: number; overdue: number };
	} | null;
	timeline: TimelineEntry[];
	failure?: { code: string; message: string } | null;
	fraudReview?: { id: string; status: string; severity: string; reasonCode: string } | null;
}

export interface QueueItem {
	id: string;
	reference: string;
	clientName: string;
	city: string | null;
	type: string;
	product: string;
	amountCents: number;
	termMonths: number;
	submittedAt: string | null;
	waitMs: number;
	score: number | null;
	grade: string | null;
	risk: "low" | "medium" | "high";
	flags: { referred: boolean; aboveAutoLimit: boolean };
	reasons: string[];
	topReasons: string[];
}

export interface QueueSummary {
	total: number;
	shown: number;
	truncated: boolean;
	medianWaitMs: number;
	over24hCount: number;
	referredCount: number;
	aboveAutoLimitCount: number;
	oldestCaseId: string | null;
}

export interface LoanSummary {
	id: string;
	applicationId: string;
	reference: string;
	principalCents: number;
	termMonths: number;
	rateBps: number;
	monthlyPaymentCents: number;
	status: string;
	outstandingCents: number;
	nextDueDate: string | null;
	disbursedAt: string;
}
export interface LoanDetail {
	loan: LoanSummary;
	installments: Array<{
		id: string;
		number: number;
		dueDate: string;
		principalCents: number;
		interestCents: number;
		totalCents: number;
		status: string;
		paidAt: string | null;
	}>;
	payments: Array<{
		id: string;
		installmentId: string;
		amountCents: number;
		paidAt: string;
		source: string;
	}>;
	alerts: Array<{
		id: string;
		loanId: string;
		installmentId: string | null;
		type: string;
		severity: string;
		status: string;
		details: unknown;
	}>;
}

export interface DashboardSummary {
	applications: Record<string, number>;
	loans: Record<string, number>;
	avgDecisionSeconds: number | null;
	decidedApplications: number;
	decisionsToday: number | null;
	recentFeed: Array<{
		id: string;
		type: string;
		message: string;
		applicationId: string | null;
		loanId: string | null;
		occurredAt: string;
	}>;
}

export const queryKeys = {
	case: (id: string) => ["application", id] as const,
	loan: (id: string) => ["loan", id] as const,
	reviewQueue: ["review-queue"] as const,
};

export function fetchCase(id: string): Promise<CaseDetail> {
	return api<CaseDetail>(`/api/applications/${id}`);
}

export function fetchLoan(id: string): Promise<LoanDetail> {
	return api<LoanDetail>(`/api/loans/${id}`);
}

export function fetchReviewQueue(): Promise<{ items: QueueItem[]; summary: QueueSummary }> {
	return api<{ items: QueueItem[]; summary: QueueSummary }>("/api/review/queue");
}
