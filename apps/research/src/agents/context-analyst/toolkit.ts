// T18 context tools (SPEC-t17-t18 §3.2, D3b): fixed read-only allowlist over
// the signed applications context endpoints, plus the loans service's
// service-only applicant lookup. `applicationId` is bound in the closure —
// never a model-supplied arg. No web, SQL, or writes; every call revalidates
// args and the target endpoint revalidates ownership, consent, and as-of
// bounds. Model-visible transaction rows strip descriptions and counterparties
// (injection/PII surface); metadata-only logging, never args or results.
//
// The tool definitions live one per file in ./tools; this module assembles
// them over one `ToolContext` (shared run state, budget, signed GET). The
// case assistant reuses the same toolkit for its case-screen reads.
import { getApplicationFinancials } from "./tools/get-application-financials.js";
import { getCaseFacts } from "./tools/get-case-facts.js";
import { getCashflowMetrics } from "./tools/get-cashflow-metrics.js";
import { getCreditHistory } from "./tools/get-credit-history.js";
import { getCustomerSummary } from "./tools/get-customer-summary.js";
import { getDocumentFindings } from "./tools/get-document-findings.js";
import { getExternalReports } from "./tools/get-external-reports.js";
import { getExternalResearchSummary } from "./tools/get-external-research-summary.js";
import { getKycChecks } from "./tools/get-kyc-checks.js";
import { getLoans } from "./tools/get-loans.js";
import { getTransactions } from "./tools/get-transactions.js";
import { listAccounts } from "./tools/list-accounts.js";
import {
	createToolContext,
	type ContextToolSpec,
	type ContextToolState,
	type ToolContext,
	type ToolDeps,
} from "./tool-context.js";

export { ContextToolError, type CandidateSnapshot, type ContextToolState } from "./tool-context.js";

/** The model-callable tools, in the order they are offered to the model. */
export const CONTEXT_TOOL_SPECS = [
	getCaseFacts,
	getCustomerSummary,
	listAccounts,
	getTransactions,
	getCashflowMetrics,
	getApplicationFinancials,
	getDocumentFindings,
	getCreditHistory,
	getExternalReports,
	getKycChecks,
	getLoans,
	getExternalResearchSummary,
] as const satisfies readonly ContextToolSpec<never>[];

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

export interface ContextTools extends ContextToolState {
	/** Shared run state and signed-GET helper the tool specs run against. */
	readonly ctx: ToolContext;
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

export function createContextTools(deps: ToolDeps): ContextTools {
	const ctx = createToolContext(deps);
	const { state } = ctx;
	// Internal routing data, never returned to the model. The loans tool
	// always resolves the applicant id fresh via /context/applicant (see
	// the get_loans spec).
	return {
		ctx,
		snapshots: state.snapshots,
		seenEvidence: state.seenEvidence,
		get toolCalls() {
			return state.toolCalls;
		},
		beginModelPhase() {
			state.modelPhase = true;
		},
		getCaseFacts: () => getCaseFacts.run(ctx),
		getCustomerSummary: () => getCustomerSummary.run(ctx),
		listAccounts: () => listAccounts.run(ctx),
		getTransactions: (input) => getTransactions.run(ctx, input),
		// accountIds stays for server-side scoping/tests; the model tool
		// exposes no args (emptyParams) and always calls with {} — the
		// preflight and validator anchor on the unscoped candidate set.
		getCashflowMetrics: (input) => getCashflowMetrics.run(ctx, input),
		getApplicationFinancials: () => getApplicationFinancials.run(ctx),
		getDocumentFindings: () => getDocumentFindings.run(ctx),
		getCreditHistory: () => getCreditHistory.run(ctx),
		getExternalReports: () => getExternalReports.run(ctx),
		getKycChecks: () => getKycChecks.run(ctx),
		getLoans: () => getLoans.run(ctx),
		getExternalResearchSummary: () => getExternalResearchSummary.run(ctx),
	};
}
