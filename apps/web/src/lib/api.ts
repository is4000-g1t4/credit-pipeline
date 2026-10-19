// Shared API client (SPEC §6): same-origin /api proxy, cookie session,
// JSON-only, typed errors. All queries run client-side (SSR renders shells).
import { isTerminal as coreIsTerminal, type ApplicationStatus } from "@credit/core/browser";
export class ApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
		public fields?: Record<string, string[]>,
	) {
		super(message);
	}
}

export async function api<T>(
	path: string,
	opts?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
	const res = await fetch(path, {
		method: opts?.method ?? "GET",
		credentials: "include",
		headers: {
			...(opts?.body !== undefined ? { "content-type": "application/json" } : {}),
			...opts?.headers,
		},
		body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
	});
	if (res.status === 204) return undefined as T;
	let data: unknown = null;
	try {
		data = await res.json();
	} catch {
		throw new ApiError(res.status, "BAD_RESPONSE", `request failed (${res.status})`);
	}
	if (!res.ok) {
		const err = (
			data as {
				error?: {
					code?: string;
					message?: string;
					fields?: Record<string, string[]>;
				};
			}
		)?.error;
		throw new ApiError(
			res.status,
			err?.code ?? "REQUEST_FAILED",
			err?.message ?? `request failed (${res.status})`,
			err?.fields,
		);
	}
	return data as T;
}

// --- Types (mirror the API responses; fields read defensively in views). ---

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
	submittedAt: string;
	decidedAt: string | null;
}

export interface Factor {
	code: string;
	label: string;
	points: number;
	impact: string;
}
export interface TimelineEntry {
	at: string;
	kind: "audit" | "feed";
	action?: string;
	actor?: string;
	entity?: string;
	type?: string;
	message?: string;
	payload: unknown;
}
export interface CaseDetail {
	application: AppSummary & {
		identity: Record<string, unknown>;
		financial: Record<string, unknown> | null;
		business: Record<string, unknown> | null;
		consents: unknown;
		purpose: string;
		workflowStartedAt: string | null;
		failedReason: string | null;
	};
	checks: Array<{ type: string; status: string; details: unknown }>;
	externalReports: Array<{
		provider: string;
		kind: string;
		version: string;
		payload: Record<string, unknown>;
	}>;
	documents: Array<{ kind: string; status: string; note: string | null }>;
	score: {
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
	policyEvaluation: {
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
		notes: string | null;
		snapshot: { kind?: string } & Record<string, unknown>;
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
}

export interface QueueItem {
	id: string;
	reference: string;
	type: string;
	product: string;
	amountCents: number;
	termMonths: number;
	submittedAt: string;
	waitMs: number;
	score: number | null;
	grade: string | null;
	reasons: string[];
	topReasons: string[];
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
	recentFeed: Array<{
		id: string;
		type: string;
		message: string;
		applicationId: string | null;
		loanId: string | null;
		occurredAt: string;
	}>;
}

// --- Formatting / status helpers. ---

const usd = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

/** Null-safe cents → USD; check-only decisions carry null amounts (SPEC §2.2). */
export function formatMoney(cents: number | null | undefined): string {
	return cents === null || cents === undefined ? "—" : usd.format(cents / 100);
}

export function formatDate(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export function formatWait(ms: number): string {
	const mins = Math.floor(ms / 60000);
	if (mins < 1) return "<1m";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** Terminal application statuses — single source of truth in @credit/core. */
export function isTerminal(status: string): boolean {
	return coreIsTerminal(status as ApplicationStatus);
}

export const DEMO_PASSWORD = "demo1234";
export const DEMO_ACCOUNTS: Array<{ email: string; label: string }> = [
	{ email: "maria@example.com", label: "Maria (auto-approve)" },
	{ email: "alex@example.com", label: "Alex (refer)" },
	{ email: "sam@example.com", label: "Sam (decline)" },
	{ email: "tomas@cafe-aurora.example", label: "Tomás SME (refer)" },
	{ email: "lena@bakery.example", label: "Lena SME (auto)" },
	{ email: "officer@example.com", label: "Officer" },
];

/** Minimal toast bus — the Toaster in __root listens for these. */
export function toast(message: string): void {
	window.dispatchEvent(new CustomEvent<string>("app-toast", { detail: message }));
}

export function apiErrorMessage(err: unknown): string {
	return err instanceof ApiError ? err.message : "something went wrong";
}
