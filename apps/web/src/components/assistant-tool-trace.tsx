// Tool activity under each assistant answer: a visible, collapsible
// timeline (dot/line) with the tool label and result count. Metadata only —
// never raw args or tool output.
import type { CaseAssistantToolCall } from "../lib/api";

/** Known case-assistant tools; anything else humanizes via the fallback. */
const TOOL_LABELS: Record<string, string> = {
	get_case_facts: "Application facts",
	get_case_assessment: "Score and policy assessment",
	get_documents: "Documents on file",
	get_customer_summary: "Customer summary",
	list_accounts: "Accounts",
	get_transactions: "Transactions",
	get_cashflow_metrics: "Cashflow signals",
	get_application_financials: "Declared financials",
	get_document_findings: "Document findings",
	get_credit_history: "Credit history",
	get_external_reports: "Bureau and bank reports",
	get_kyc_checks: "KYC checks",
	get_loans: "Existing loans and EWS",
	get_external_research_summary: "External research brief",
	search_policy: "Policy search",
};

function toolLabel(name: string): string {
	return TOOL_LABELS[name] ?? humanize(name);
}

function humanize(name: string): string {
	const spaced = name.replace(/_/g, " ").trim();
	return spaced === "" ? name : spaced;
}

function resultNoun(count: number): string {
	return count === 1 ? "result" : "results";
}

export function AssistantToolTrace({
	calls,
	pending,
}: {
	calls: CaseAssistantToolCall[];
	pending?: boolean;
}) {
	if (pending) {
		return (
			<output className="block text-sm text-slate" aria-live="polite">
				Reading case data…
			</output>
		);
	}
	if (calls.length === 0) return null;
	return (
		<details className="mt-3">
			<summary className="cursor-pointer text-sm text-slate hover:text-ink hover:underline">
				Tool activity · {calls.length} {calls.length === 1 ? "call" : "calls"}
			</summary>
			<ol className="mt-2 space-y-2 border-l-2 border-rule pl-0">
				{calls.map((call, i) => (
					<li
						key={`${call.name}-${i}`}
						className="relative ml-1.5 border-l-0 pl-4 before:absolute before:top-1.5 before:-left-[5px] before:size-2 before:rounded-full before:bg-rule-strong"
					>
						<p className="text-sm text-ink">
							{toolLabel(call.name)}{" "}
							<span className="text-xs text-slate tabular">
								· {call.resultCount} {resultNoun(call.resultCount)}
							</span>
						</p>
						{call.sourceTypes.length > 0 && (
							<p className="text-xs text-slate">{call.sourceTypes.join(" · ")}</p>
						)}
					</li>
				))}
			</ol>
		</details>
	);
}
