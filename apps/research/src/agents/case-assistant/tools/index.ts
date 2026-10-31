// The case assistant's model-callable tools, in the order they are offered.
import { getApplicationFinancials } from "./get-application-financials.js";
import { getCaseAssessment } from "./get-case-assessment.js";
import { getCaseFacts } from "./get-case-facts.js";
import { getCashflowMetrics } from "./get-cashflow-metrics.js";
import { getCreditHistory } from "./get-credit-history.js";
import { getCustomerSummary } from "./get-customer-summary.js";
import { getDocumentFindings } from "./get-document-findings.js";
import { getDocuments } from "./get-documents.js";
import { getExternalReports } from "./get-external-reports.js";
import { getExternalResearchSummary } from "./get-external-research-summary.js";
import { getKycChecks } from "./get-kyc-checks.js";
import { getLoans } from "./get-loans.js";
import { getTransactions } from "./get-transactions.js";
import { listAccounts } from "./list-accounts.js";
import { searchPolicy } from "./search-policy.js";

export {
	getApplicationFinancials,
	getCaseAssessment,
	getCaseFacts,
	getCashflowMetrics,
	getCreditHistory,
	getCustomerSummary,
	getDocumentFindings,
	getDocuments,
	getExternalReports,
	getExternalResearchSummary,
	getKycChecks,
	getLoans,
	getTransactions,
	listAccounts,
	searchPolicy,
};

export const CASE_ASSISTANT_TOOLS = [
	getCaseFacts,
	getCaseAssessment,
	getDocuments,
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
	searchPolicy,
] as const;
