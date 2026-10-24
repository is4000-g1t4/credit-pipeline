// T18 context tools (SPEC-t17-t18 §3.2, D3b): fixed read-only allowlist over
// the signed applications context endpoints, plus the loans service's
// service-only applicant lookup. `applicationId` is bound in the closure —
// never a model-supplied arg. No web, SQL, or writes; every call revalidates
// args and the target endpoint revalidates ownership, consent, and as-of
// bounds. Model-visible transaction rows strip descriptions and counterparties
// (injection/PII surface); metadata-only logging, never args or results.
import { signInternalHeaders } from "@credit/service-kit";
import { isUuid } from "./ids.js";
import type { ResearchEnv } from "./env.js";

export class ContextToolError extends Error {}

export interface CandidateSnapshot {
	localId: string;
	type: string;
	periodStart: string;
	periodEnd: string;
	metric: string;
	observed: number | null;
	expected: number | null;
	confidence: "low" | "medium" | "high";
	status: "review" | "needs_chase" | "insufficient_data";
	policyVersion: string;
	accountScope: string;
	evidenceIds: string[];
}

export interface ContextToolState {
	snapshots: CandidateSnapshot[];
	/** Evidence id → kinds seen across tool results. */
	seenEvidence: Map<string, Set<string>>;
	toolCalls: number;
}

export interface ContextTools extends ContextToolState {
	getCaseFacts(): unknown;
	beginModelPhase(): void;
	getCustomerSummary(): Promise<unknown>;
	listAccounts(): Promise<unknown>;
	getTransactions(input: { accountId: string; cursor?: string }): Promise<unknown>;
	getCashflowMetrics(input: { accountIds?: string[] }): Promise<unknown>;
	getApplicationFinancials(): Promise<unknown>;
	getDocumentFindings(): Promise<unknown>;
	getCreditHistory(): Promise<unknown>;
	getExternalReports(): Promise<unknown>;
	getKycChecks(): Promise<unknown>;
	getLoans(): Promise<unknown>;
	getExternalResearchSummary(): unknown;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface ToolDeps {
	env: ResearchEnv;
	applicationId: string;
	caseFacts: Record<string, unknown>;
	externalSummary: unknown;
	/** Preflight HTTP allowance (CONTEXT_AGENT_PREFLIGHT_TOOL_CALLS). Model
	 * invocations are capped separately in the runner; model-phase HTTP
	 * rides `modelHttpBackstop` and never consumes this pool. */
	maxCalls: number;
	/** Total-HTTP backstop once the model phase begins (generous: each
	 * model invocation spends ≤2 HTTP calls). Unset means unbounded. */
	modelHttpBackstop?: number;
	/** YYYY-MM-DD observation end; bounds the loans read. Falls back to
	 * caseFacts.asOf when absent. */
	asOfDate?: string;
	fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

function numNull(v: unknown): number | null {
	return typeof v === "number" ? v : null;
}

function strArr(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

/** Fixed allowlist from §3.2; anything outside this set is never a tool. */
export const CONTEXT_TOOL_NAMES = [
	"get_case_facts",
	"get_customer_summary",
	"list_accounts",
	"get_transactions",
	"get_cashflow_metrics",
	"get_application_financials",
	"get_document_findings",
	"get_credit_history",
	"get_external_reports",
	"get_kyc_checks",
	"get_loans",
	"get_external_research_summary",
] as const;

export type ContextToolName = (typeof CONTEXT_TOOL_NAMES)[number];

export function isContextToolName(v: string): v is ContextToolName {
	return (CONTEXT_TOOL_NAMES as readonly string[]).includes(v);
}

export function createContextTools(deps: ToolDeps): ContextTools {
	const state: ContextToolState & { modelPhase: boolean } = {
		snapshots: [],
		seenEvidence: new Map(),
		toolCalls: 0,
		modelPhase: false,
	};
	const metricsCache = new Map<string, unknown>();
	const seen = (id: string, kind: string): void => {
		const kinds = state.seenEvidence.get(id) ?? new Set<string>();
		kinds.add(kind);
		state.seenEvidence.set(id, kinds);
	};

	const budget = (): void => {
		state.toolCalls += 1;
		// Preflight HTTP counts against the preflight allowance. In the model
		// phase invocations are capped by the runner, so HTTP rides the
		// generous backstop only — a 2-call screen like getLoans cannot
		// exhaust the preflight pool.
		const limit = state.modelPhase ? (deps.modelHttpBackstop ?? Infinity) : deps.maxCalls;
		if (state.toolCalls > limit) throw new ContextToolError("tool budget exceeded");
	};

	const getFrom = async (baseUrl: string, path: string): Promise<unknown> => {
		budget();
		// The service HMAC signs the pathname only (`requireInternal`
		// verifies `c.req.path`, no query string) — the query rides the URL.
		const queryAt = path.indexOf("?");
		const signPath = queryAt < 0 ? path : path.slice(0, queryAt);
		const headers = signInternalHeaders(deps.env.internalSecret, {
			userId: deps.env.autoTriggerServiceUserId,
			role: "service",
			email: deps.env.autoTriggerServiceEmail,
			method: "GET",
			path: signPath,
		});
		const fetchImpl = deps.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
		let res: Response;
		try {
			// Bounded per call; the stage deadline owns the overall budget.
			res = await fetchImpl(`${baseUrl}${path}`, {
				headers,
				signal: AbortSignal.timeout(10_000),
			});
		} catch (err) {
			throw new ContextToolError(
				`context tool unreachable: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (!res.ok) {
			throw new ContextToolError(`context tool returned ${res.status}`, { cause: undefined });
		}
		try {
			return (await res.json()) as unknown;
		} catch {
			throw new ContextToolError("context tool returned invalid JSON");
		}
	};
	const get = (path: string): Promise<unknown> => getFrom(deps.env.applicationsUrl, path);

	// Internal routing data, never returned to the model. The loans tool
	// always resolves the applicant id fresh via /context/applicant (see
	// getLoans).

	const tools: ContextTools = {
		snapshots: state.snapshots,
		seenEvidence: state.seenEvidence,
		get toolCalls() {
			return state.toolCalls;
		},
		beginModelPhase() {
			state.modelPhase = true;
		},
		getCaseFacts() {
			budget();
			const f = deps.caseFacts;
			// Allowlisted case facts only — consent never rides the prompt.
			return {
				reference: f["reference"] ?? null,
				type: f["type"] ?? null,
				product: f["product"] ?? null,
				amountCents: f["amountCents"] ?? null,
				termMonths: f["termMonths"] ?? null,
				applicantName: f["applicantName"] ?? null,
				companyName: f["companyName"] ?? null,
				registrationNumber: f["registrationNumber"] ?? null,
				industry: f["industry"] ?? null,
				yearsTrading: f["yearsTrading"] ?? null,
				city: f["city"] ?? null,
				status: f["status"] ?? null,
				submittedAt: f["submittedAt"] ?? null,
				asOf: f["asOf"] ?? null,
			};
		},
		async getCustomerSummary() {
			const body = (await get(`/internal/applications/${deps.applicationId}/context/profile`)) as {
				customer?: unknown;
				city?: unknown;
				asOf?: unknown;
			};
			if (!body || typeof body !== "object" || !body.customer) {
				throw new ContextToolError("customer summary shape drift");
			}
			return { customer: body.customer, city: body.city ?? null, asOf: body.asOf ?? null };
		},
		async listAccounts() {
			const body = (await get(`/internal/applications/${deps.applicationId}/context/accounts`)) as {
				accounts?: Array<{ id?: unknown }>;
			};
			if (!body || !Array.isArray(body.accounts)) {
				throw new ContextToolError("accounts shape drift");
			}
			for (const a of body.accounts) {
				if (typeof a.id === "string") seen(a.id, "account");
			}
			return { accounts: body.accounts };
		},
		async getTransactions(input: { accountId: string; cursor?: string }) {
			if (!isUuid(input.accountId)) throw new ContextToolError("invalid accountId");
			if (
				input.cursor !== undefined &&
				(typeof input.cursor !== "string" || input.cursor.length > 2000)
			) {
				throw new ContextToolError("invalid cursor");
			}
			const q = new URLSearchParams({ accountId: input.accountId });
			if (input.cursor) q.set("cursor", input.cursor);
			const body = (await get(
				`/internal/applications/${deps.applicationId}/context/transactions?${q}`,
			)) as {
				items?: Array<Record<string, unknown>>;
				nextCursor?: unknown;
				window?: unknown;
			};
			if (!body || !Array.isArray(body.items)) {
				throw new ContextToolError("transactions shape drift");
			}
			// Strip free-text PII/injection surface: the model needs
			// amounts/dates/categories, never descriptions/counterparties.
			const items = body.items.map((tx) => {
				if (typeof tx["id"] === "string") seen(tx["id"] as string, "transaction");
				if (typeof tx["accountId"] === "string") seen(tx["accountId"] as string, "account");
				return {
					id: tx["id"] ?? null,
					accountId: tx["accountId"] ?? null,
					postedAt: tx["postedAt"] ?? null,
					amountCents: tx["amountCents"] ?? null,
					balanceAfterCents: tx["balanceAfterCents"] ?? null,
					currency: tx["currency"] ?? null,
					category: tx["category"] ?? null,
					returned: tx["returned"] ?? null,
				};
			});
			return { window: body.window ?? null, items, nextCursor: body.nextCursor ?? null };
		},
		// accountIds stays for server-side scoping/tests; the model tool
		// exposes no args (emptyParams) and always calls with {} — the
		// preflight and validator anchor on the unscoped candidate set.
		async getCashflowMetrics(input: { accountIds?: string[] }) {
			const ids = input.accountIds ?? [];
			if (!Array.isArray(ids) || ids.length > 10 || ids.some((id) => !isUuid(id))) {
				throw new ContextToolError("invalid accountIds: at most 10 UUIDs");
			}
			const cacheKey = [...ids].sort().join(",");
			const cached = metricsCache.get(cacheKey);
			if (cached !== undefined) return cached;
			const q = ids.length > 0 ? `?accountIds=${ids.map(encodeURIComponent).join(",")}` : "";
			const body = (await get(
				`/internal/applications/${deps.applicationId}/context/metrics${q}`,
			)) as { signals?: Array<Record<string, unknown>>; policyVersion?: unknown };
			if (!body || !Array.isArray(body.signals)) {
				throw new ContextToolError("metrics shape drift");
			}
			const signals = body.signals.map((s, i) => {
				const snap: CandidateSnapshot = {
					localId: `c${state.snapshots.length + i + 1}`,
					type: typeof s["type"] === "string" ? (s["type"] as string) : "",
					periodStart: typeof s["periodStart"] === "string" ? (s["periodStart"] as string) : "",
					periodEnd: typeof s["periodEnd"] === "string" ? (s["periodEnd"] as string) : "",
					metric: typeof s["metric"] === "string" ? (s["metric"] as string) : "",
					observed: numNull(s["observed"]),
					expected: numNull(s["expected"]),
					confidence:
						s["confidence"] === "low" || s["confidence"] === "medium" || s["confidence"] === "high"
							? s["confidence"]
							: "low",
					status:
						s["status"] === "review" ||
						s["status"] === "needs_chase" ||
						s["status"] === "insufficient_data"
							? s["status"]
							: "needs_chase",
					policyVersion:
						typeof s["policyVersion"] === "string" ? (s["policyVersion"] as string) : "",
					accountScope: typeof s["accountScope"] === "string" ? (s["accountScope"] as string) : "",
					evidenceIds: strArr(
						Array.isArray(s["evidence"])
							? (s["evidence"] as Array<Record<string, unknown>>).map((e) => e["id"])
							: [],
					),
				};
				return snap;
			});
			for (const snap of signals) {
				state.snapshots.push(snap);
				seen(snap.localId, "metric");
				for (const id of snap.evidenceIds) seen(id, "transaction");
			}
			const result = {
				policyVersion: body.policyVersion ?? null,
				signals: signals.map((s) => ({
					...s,
					evidence: s.evidenceIds.map((id) => ({ kind: "transaction", id })),
				})),
			};
			metricsCache.set(cacheKey, result);
			return result;
		},
		async getApplicationFinancials() {
			const body = (await get(
				`/internal/applications/${deps.applicationId}/context/financials`,
			)) as Record<string, unknown>;
			if (!body || typeof body !== "object") throw new ContextToolError("financials shape drift");
			return body;
		},
		async getDocumentFindings() {
			const body = (await get(
				`/internal/applications/${deps.applicationId}/context/document-findings`,
			)) as { findings?: unknown; crosscheck?: unknown; stale?: unknown };
			if (!body || !Array.isArray(body.findings)) {
				throw new ContextToolError("document-findings shape drift");
			}
			for (const f of body.findings as Array<Record<string, unknown>>) {
				if (typeof f["id"] === "string") seen(f["id"] as string, "finding");
			}
			return {
				crosscheck: body.crosscheck ?? null,
				findings: body.findings,
				stale: body.stale ?? false,
			};
		},
		async getCreditHistory() {
			const body = (await get(
				`/internal/applications/${deps.applicationId}/context/credit-history`,
			)) as { priorApplications?: unknown };
			if (!body || !Array.isArray(body.priorApplications)) {
				throw new ContextToolError("credit-history shape drift");
			}
			return body;
		},
		async getExternalReports() {
			const body = (await get(
				`/internal/applications/${deps.applicationId}/context/external-reports`,
			)) as { reports?: unknown };
			if (!body || !Array.isArray(body.reports)) {
				throw new ContextToolError("external-reports shape drift");
			}
			return body;
		},
		async getKycChecks() {
			const body = (await get(
				`/internal/applications/${deps.applicationId}/context/kyc-checks`,
			)) as { checks?: unknown };
			if (!body || !Array.isArray(body.checks)) {
				throw new ContextToolError("kyc-checks shape drift");
			}
			return body;
		},
		async getLoans() {
			// Fresh consent-gated applicant lookup immediately before the
			// loans fetch: the /context/applicant read narrows the race
			// window for a withdrawal racing the stage (it does not close
			// it — the loans service revalidates consent and the
			// application binding itself before any loan row is read).
			// Never served from cache here.
			const fresh = (await get(
				`/internal/applications/${deps.applicationId}/context/applicant`,
			)) as { applicantUserId?: unknown };
			const userId = typeof fresh?.applicantUserId === "string" ? fresh.applicantUserId : null;
			if (!userId) {
				// Fail closed but usable: the model sees an explicit data gap
				// rather than a silent empty exposure picture.
				return { loans: [], unavailable: "applicant id unavailable" };
			}
			const rawAsOf =
				typeof deps.asOfDate === "string" && deps.asOfDate !== ""
					? deps.asOfDate
					: typeof deps.caseFacts["asOf"] === "string"
						? (deps.caseFacts["asOf"] as string).slice(0, 10)
						: "";
			if (!DAY_RE.test(rawAsOf)) throw new ContextToolError("invalid asOf");
			const q = new URLSearchParams({ applicationId: deps.applicationId, asOf: rawAsOf });
			const body = (await getFrom(
				deps.env.loansUrl,
				`/internal/loans/by-applicant/${userId}?${q}`,
			)) as { loans?: unknown };
			if (!body || !Array.isArray(body.loans)) {
				throw new ContextToolError("loans shape drift");
			}
			return { loans: body.loans };
		},
		getExternalResearchSummary() {
			budget();
			// Structured validated claims only — never raw web text.
			return deps.externalSummary ?? null;
		},
	};
	return tools;
}
