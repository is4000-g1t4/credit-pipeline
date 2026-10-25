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

/** Build the typed error for a non-2xx JSON body; unknown shapes fall
 * back to REQUEST_FAILED with the status in the message. */
function parseApiError(res: Response, data?: unknown): ApiError {
	const err = (
		data as {
			error?: {
				code?: string;
				message?: string;
				fields?: Record<string, string[]>;
			};
		} | null
	)?.error;
	return new ApiError(
		res.status,
		err?.code ?? "REQUEST_FAILED",
		err?.message ?? `request failed (${res.status})`,
		err?.fields,
	);
}

/** 404 → null ("not present yet"); every other error throws. */
async function nullOn404<T>(fn: () => Promise<T>): Promise<T | null> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof ApiError && err.status === 404) return null;
		throw err;
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
		throw parseApiError(res, data);
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
	// T17: null for drafts; submitted rows stay non-null.
	submittedAt: string | null;
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
		/** Officer-visible flag gating the research Run button. */
		aiResearchConsent: boolean | null;
		/** T01 document workflow consent (D0: intake + detail only). */
		documentProcessingConsent: boolean;
		documentConsentAt: string | null;
		documentConsentVersion: string | null;
		/** T01 feature flag (SPEC-t01-t02 §10): false hides DocumentPanel. */
		documentsEnabled: boolean;
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
	submittedAt: string | null;
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

// --- Advisory agentic research (Phase 2, SPEC §5/§8). Officer-only.
// The browser never sends a frozen bundle: decisions carry only the
// selection ({agentRunId, acceptedFindingIds}); review resolves the
// server-built bundle. Unverified findings are never rendered.

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

// --- Officer credit-policy Q&A (policy service via gateway). Advisory only:
// answers cite exact policy sections; the drawer loads the full section body.
export type PolicyProduct = "personal_loan" | "sme_term_loan";

export interface PolicyCitation {
	policyKey: string;
	policyVersionId: string;
	sectionId: string;
	heading: string;
	version: string;
	effectiveFrom: string;
	quote: string;
	drawerToken: string;
}

export type PolicyAskStatus =
	| "succeeded"
	| "no_match"
	| "needs_policy_owner"
	| "out_of_scope"
	| "identifier_blocked"
	| "rate_limited"
	| "budget_exceeded"
	| "failed";

export interface PolicyAnswerSegment {
	text: string;
	citationIndexes: number[];
}

export interface PolicyAskResponse {
	status: PolicyAskStatus;
	segments: PolicyAnswerSegment[];
	citations: PolicyCitation[];
	limitations: string[];
	usage?: { costUsd?: number; latencyMs?: number };
}

export interface PolicySection {
	policyKey: string;
	sectionId: string;
	heading: string;
	version: string;
	effectiveFrom: string;
	effectiveTo: string | null;
	body: string;
	neighbours?: Array<{ sectionId: string; heading: string }>;
}

export function askPolicy(
	question: string,
	product: PolicyProduct,
	jurisdiction = "SG",
): Promise<PolicyAskResponse> {
	return api<PolicyAskResponse>("/api/policy/ask", {
		method: "POST",
		body: { question, product, jurisdiction },
	});
}

export function fetchPolicySection(
	versionId: string,
	sectionId: string,
	token: string,
): Promise<PolicySection> {
	return api<PolicySection>(
		`/api/policy/sections/${encodeURIComponent(versionId)}/${encodeURIComponent(sectionId)}?token=${encodeURIComponent(token)}`,
	);
}

// --- Policy review stage on the research aggregate (case-scoped, advisory).
// Renders inside ResearchPanel after internal context; never decides.

export type ResearchPolicyStatus =
	| "not_applicable"
	| "running"
	| "succeeded"
	| "no_match"
	| "needs_policy_owner"
	| "budget_exceeded"
	| "failed"
	| "skipped";

export interface PolicyReviewSegment {
	text: string;
	citationIndexes: number[];
}

export interface PolicyReviewItem {
	ref: string;
	explanationSegments: PolicyReviewSegment[];
	citations: PolicyCitation[];
	confidence: "low" | "medium" | "high";
}

export interface ResearchPolicy {
	status: ResearchPolicyStatus;
	errorCode?: string | null;
	brief?: {
		summary?: string;
		items: PolicyReviewItem[];
		limitations: string[];
	} | null;
	usage?: { costUsd?: number } | null;
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

/** Date-only values (YYYY-MM-DD or date-only ISO) render in UTC: parsing
 * them as local midnight shifts the day for negative offsets. */
export function formatDateOnly(iso: string | null | undefined): string {
	if (!iso) return "—";
	const datePart = iso.length >= 10 ? iso.slice(0, 10) : iso;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return formatDate(iso);
	const d = new Date(`${datePart}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString("en-US", { timeZone: "UTC" });
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

// --- T01/T02 document workflow (SPEC-t01-t02 §5, D3 UI only). ---
// Metadata only — page text travels via fetchDocumentPages and the
// original bytes via downloadDocument (blob, never logged).

export type DocumentKind =
	| "id"
	| "business_registration"
	| "bank_statement"
	| "payslip"
	| "financial_statements"
	| "other";

export interface DocumentFile {
	id: string;
	applicationId: string;
	kind: string;
	status: "ready" | "rejected" | "deleted";
	ocrStatus: "not_applicable" | "ready" | "low_confidence" | "unsupported" | "failed";
	textLayerRisk: boolean;
	originalFilename: string | null;
	mimeType: string;
	sizeBytes: number;
	sha256: string;
	pageCount: number;
	ocrConfidence: number | null;
	uploadedBy: string;
	uploadedAt: string;
	retentionUntil: string;
	errorCode: string | null;
}

export interface DocumentsList {
	files: DocumentFile[];
}

export interface DocumentPageItem {
	pageNumber: number;
	text: string;
	source: string;
	confidence: number;
	charCount: number;
}

export interface DocumentPages {
	pages: DocumentPageItem[];
}

export interface DocumentCrosscheckSummary {
	id: string;
	applicationId: string;
	status: string;
	validatorVersion: string;
	documentsChecked: string[];
	findingCount: number;
	requestedBy: string;
	startedAt: string;
	finishedAt: string | null;
	errorCode: string | null;
}

export interface DocumentFinding {
	id: string;
	crosscheckId: string;
	applicationId: string;
	documentFileId: string | null;
	field: string;
	expected: string | null;
	observed: string | null;
	pageNumber: number | null;
	quote: string | null;
	quoteStart: number | null;
	quoteEnd: number | null;
	quoteHash: string | null;
	confidence: string;
	status: "mismatch" | "needs_chase";
	reason: string;
	createdAt: string;
}

export interface DocumentCrosscheck {
	crosscheck: DocumentCrosscheckSummary;
	findings: DocumentFinding[];
}

export interface ChaseDraft {
	chase: {
		id: string;
		applicationId: string;
		crosscheckId: string;
		status: string;
		body: string | null;
		createdBy: string;
		createdAt: string;
		sentAt: string | null;
		inspectedOriginalAt: string;
		findingIds: string[];
	};
	findings: DocumentFinding[];
}

export function fetchDocumentFiles(applicationId: string): Promise<DocumentsList> {
	return api<DocumentsList>(`/api/applications/${applicationId}/documents`);
}

/** Multipart upload — fetch sets the boundary; never set content-type here. */
export async function uploadDocument(
	applicationId: string,
	file: File,
	kind: DocumentKind,
): Promise<{ file: DocumentFile }> {
	const form = new FormData();
	form.append("file", file);
	form.append("kind", kind);
	const res = await fetch(`/api/applications/${applicationId}/documents`, {
		method: "POST",
		credentials: "include",
		body: form,
	});
	let data: unknown = null;
	try {
		data = await res.json();
	} catch {
		throw new ApiError(res.status, "BAD_RESPONSE", `request failed (${res.status})`);
	}
	if (!res.ok) {
		throw parseApiError(res, data);
	}
	return data as { file: DocumentFile };
}

export function fetchDocumentPages(applicationId: string, fileId: string): Promise<DocumentPages> {
	return api<DocumentPages>(`/api/applications/${applicationId}/documents/${fileId}/pages`);
}

/** 404 → null ("no crosscheck yet"); every other error throws. */
export function fetchCrosscheck(applicationId: string): Promise<DocumentCrosscheck | null> {
	return nullOn404(() =>
		api<DocumentCrosscheck>(`/api/applications/${applicationId}/documents/crosscheck`),
	);
}

export function runCrosscheck(applicationId: string): Promise<DocumentCrosscheck> {
	return api<DocumentCrosscheck>(`/api/applications/${applicationId}/documents/crosscheck`, {
		method: "POST",
	});
}

export function createChaseDraft(
	applicationId: string,
	crosscheckId: string,
	findingIds: string[],
): Promise<ChaseDraft> {
	return api<ChaseDraft>(
		`/api/applications/${applicationId}/documents/crosscheck/${crosscheckId}/chase`,
		{ method: "POST", body: { findingIds, inspectedOriginal: true } },
	);
}

export function claimDocuments(
	applicationId: string,
): Promise<{ assignment: unknown; idempotent: boolean }> {
	return api<{ assignment: unknown; idempotent: boolean }>(
		`/api/applications/${applicationId}/documents/claim`,
		{ method: "POST" },
	);
}

export function updateDocumentConsent(
	applicationId: string,
	consent: boolean,
): Promise<{ documentProcessingConsent: boolean }> {
	return api<{ documentProcessingConsent: boolean }>(
		`/api/applications/${applicationId}/document-consent`,
		{ method: "PATCH", body: { consent } },
	);
}

export function retryDocumentOcr(
	applicationId: string,
	fileId: string,
): Promise<{ file: DocumentFile }> {
	return api<{ file: DocumentFile }>(
		`/api/applications/${applicationId}/documents/${fileId}/retry-ocr`,
		{ method: "POST" },
	);
}

// --- Agentic credit memo (assist EN-01/02, officer-only). Draft + version
// history + approval ride the assist routes; the panel hides while the flag
// is off (404). The trace is metadata only — never prompts or
// chain-of-thought. ---

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

export function getMemoArtifact(id: string): Promise<{ artifact: AssistArtifact }> {
	return api<{ artifact: AssistArtifact }>(`/api/assist/artifacts/${id}`);
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

// --- T17 customer intake: drafts, requirements, reuse (SPEC-t17-t18 §2.3).
// Metadata only — masked numbers, freshness, ids. Never storage keys,
// page text, or full account numbers. ---

export interface CustomerAccountMeta {
	id: string;
	bankName: string;
	accountType: string;
	maskedNumber: string;
	currency: string;
	openedAt: string;
	status: string;
}

export interface CustomerDocMeta {
	id: string;
	kind: string;
	status: string;
	scanStatus: string;
	mimeType: string;
	sizeBytes: number;
	sha256: string;
	pageCount: number;
	ocrStatus: string;
	ocrConfidence: number | null;
	documentDate: string | null;
	periodEnd: string | null;
	freshness: string;
	reusable: boolean;
	reuseReason: string | null;
	retentionUntil: string;
	uploadedAt: string;
}

export interface CustomerProfileResponse {
	profile: {
		id: string;
		segment: string;
		customerSince: string;
		kycStatus: string;
		kycVerifiedAt: string | null;
		kycExpiresAt: string | null;
		kycFresh: boolean;
		identity: Record<string, unknown>;
		business: Record<string, unknown> | null;
		source: string;
	};
	accounts: CustomerAccountMeta[];
	documents: CustomerDocMeta[];
	asOf: string;
}

/** 404 (no profile — legacy demo users) → null; every other error throws. */
export function fetchCustomerProfile(): Promise<CustomerProfileResponse | null> {
	return nullOn404(() => api<CustomerProfileResponse>("/api/customer/profile"));
}

export interface RequirementsResponse {
	policyVersion: string;
	asOf: string;
	readyToSubmit: boolean;
	blockers: Record<string, string[]>;
	warnings: Array<{ code: string; kind?: string; field?: string }>;
	requiredDocuments: Array<{ kind: string; reason: string }>;
	reusableDocuments: Array<{
		customerDocumentId: string;
		kind: string;
		periodEnd: string | null;
		documentDate: string | null;
	}>;
	prefill: { reused: string[]; edited: string[]; unconfirmed: string[] };
	kyc: { status: string | null; expiresAt: string | null };
}

export function fetchRequirements(applicationId: string): Promise<RequirementsResponse> {
	return api<RequirementsResponse>(`/api/applications/${applicationId}/requirements`);
}

export function createDraft(
	body: unknown,
	idempotencyKey: string,
): Promise<{ id: string; reference: string }> {
	return api<{ id: string; reference: string }>("/api/applications/drafts", {
		method: "POST",
		body,
		headers: { "Idempotency-Key": idempotencyKey },
	});
}

export function submitDraft(
	applicationId: string,
	idempotencyKey: string,
): Promise<{ id: string; reference: string }> {
	return api<{ id: string; reference: string }>(`/api/applications/${applicationId}/submit`, {
		method: "POST",
		body: {},
		headers: { "Idempotency-Key": idempotencyKey },
	});
}

export function reuseCustomerDocuments(
	applicationId: string,
	customerDocumentIds: string[],
	kind?: string,
): Promise<{ files: DocumentFile[] }> {
	return api<{ files: DocumentFile[] }>(`/api/applications/${applicationId}/documents/reuse`, {
		method: "POST",
		body: kind === undefined ? { customerDocumentIds } : { customerDocumentIds, kind },
	});
}

export function updateContextConsent(
	applicationId: string,
	consent: boolean,
): Promise<{ contextAnalysisConsent: boolean }> {
	return api<{ contextAnalysisConsent: boolean }>(
		`/api/applications/${applicationId}/context-consent`,
		{ method: "PATCH", body: { consent } },
	);
}
/** Authenticated download via blob + object URL; the caller opens/saves and
 * revokes. Returns the blob and a safe filename (id-based, never logged). */
export async function downloadDocument(
	applicationId: string,
	fileId: string,
): Promise<{ blob: Blob; filename: string }> {
	const res = await fetch(`/api/applications/${applicationId}/documents/${fileId}/file`, {
		credentials: "include",
	});
	if (!res.ok) {
		let data: unknown;
		try {
			data = await res.json();
		} catch {
			// Binary error body — parseApiError falls back to the status message.
			data = undefined;
		}
		throw parseApiError(res, data);
	}
	const blob = await res.blob();
	const disposition = res.headers.get("content-disposition") ?? "";
	const match = /filename="([^"]+)"/.exec(disposition);
	return { blob, filename: match?.[1] ?? `${fileId}.bin` };
}
