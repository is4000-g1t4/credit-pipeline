// Shared live/settled tool activity. Rows appear while an agent runs
// (present tense + spinner), then settle to result count and duration.
// Metadata only — never raw args or tool output.
import { Check, ChevronDown, Loader2, Wrench, X } from "lucide-react";
import { useState } from "react";
import type { ToolActivityEntry } from "../lib/api";

const TOOL_ACTIONS: Record<string, { running: string; done: string }> = {
	// Case assistant
	get_case_facts: { running: "Reading case facts", done: "Read case facts" },
	get_case_assessment: {
		running: "Reading score and policy assessment",
		done: "Read score and policy assessment",
	},
	get_documents: { running: "Reading document list", done: "Read document list" },
	get_customer_summary: { running: "Reading customer summary", done: "Read customer summary" },
	list_accounts: { running: "Listing accounts", done: "Listed accounts" },
	get_transactions: { running: "Reading transactions", done: "Read transactions" },
	get_cashflow_metrics: { running: "Reading cashflow signals", done: "Read cashflow signals" },
	get_application_financials: {
		running: "Reading declared financials",
		done: "Read declared financials",
	},
	get_document_findings: { running: "Reading document findings", done: "Read document findings" },
	get_credit_history: { running: "Reading credit history", done: "Read credit history" },
	get_external_reports: {
		running: "Reading bureau and bank reports",
		done: "Read bureau and bank reports",
	},
	get_kyc_checks: { running: "Reading KYC checks", done: "Read KYC checks" },
	get_loans: { running: "Reading existing loans", done: "Read existing loans" },
	get_external_research_summary: {
		running: "Reading external research",
		done: "Read external research",
	},
	search_policy: { running: "Searching policy", done: "Searched policy" },
	// Memo writer
	list_evidence: { running: "Listing evidence", done: "Listed evidence" },
	search_evidence: { running: "Searching evidence", done: "Searched evidence" },
	get_evidence: { running: "Reading evidence", done: "Read evidence" },
	list_unavailable: {
		running: "Listing unavailable sources",
		done: "Listed unavailable sources",
	},
	// Policy exception
	list_failed_rules: { running: "Listing failed rules", done: "Listed failed rules" },
	get_rule_mapping: { running: "Reading rule mapping", done: "Read rule mapping" },
	get_exception_path: { running: "Reading exception path", done: "Read exception path" },
	get_policy_section: { running: "Reading policy section", done: "Read policy section" },
	// Document integrity
	list_documents: { running: "Listing documents", done: "Listed documents" },
	search_pages: { running: "Searching document pages", done: "Searched document pages" },
	get_page: { running: "Reading document page", done: "Read document page" },
	list_customer_evidence: {
		running: "Listing customer evidence",
		done: "Listed customer evidence",
	},
	get_customer_page: { running: "Reading customer page", done: "Read customer page" },
	list_signals: { running: "Listing integrity signals", done: "Listed integrity signals" },
	get_duplicate_context: { running: "Reading duplicate context", done: "Read duplicate context" },
};

function actionsFor(name: string): { running: string; done: string } {
	const known = TOOL_ACTIONS[name];
	if (known) return known;
	const fallback = name.replace(/_/g, " ").trim() || name;
	return { running: `Reading ${fallback}`, done: `Read ${fallback}` };
}

function resultNoun(count: number): string {
	return count === 1 ? "result" : "results";
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function labelFor(entry: ToolActivityEntry): string {
	const actions = actionsFor(entry.name);
	if (entry.status === "running") return actions.running;
	if (entry.status === "error") {
		return `Failed: ${actions.running.charAt(0).toLowerCase()}${actions.running.slice(1)}`;
	}
	return actions.done;
}

export function ToolActivity({
	entries,
	running = false,
	pendingLabel = "Reading case data…",
}: {
	entries: ToolActivityEntry[];
	running?: boolean;
	pendingLabel?: string;
}) {
	const [open, setOpen] = useState(true);
	if (entries.length === 0) {
		if (!running) return null;
		return (
			<output className="mt-3 flex items-center gap-2 text-sm text-slate" aria-live="polite">
				<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
				{pendingLabel}
			</output>
		);
	}
	const count = entries.length;
	return (
		<div className="mt-3 overflow-hidden rounded-sm border border-rule bg-warm/40">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="flex w-full items-center gap-2 px-3 py-2 text-left"
			>
				<span className="flex size-6 shrink-0 items-center justify-center rounded-sm border border-rule bg-card text-slate">
					<Wrench className="size-3.5" aria-hidden="true" />
				</span>
				<span className="text-sm font-medium text-ink">
					{running ? "Using" : "Used"} {count} {count === 1 ? "tool" : "tools"}
				</span>
				<ChevronDown
					className={`ml-auto size-4 shrink-0 text-slate transition-transform ${open ? "rotate-180" : ""}`}
					aria-hidden="true"
				/>
			</button>
			{open && (
				<ol className="border-t border-rule" aria-label="Tool activity">
					{entries.map((entry, i) => (
						<li
							key={entry.callId ?? `${entry.name}-${i}`}
							className={`flex items-center gap-2 border-b border-rule/60 px-3 py-2 text-sm last:border-b-0 ${
								entry.status === "running" ? "bg-warm/70" : ""
							}`}
						>
							{entry.status === "running" ? (
								<Loader2 className="size-3.5 shrink-0 animate-spin text-slate" aria-hidden="true" />
							) : entry.status === "error" ? (
								<X className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
							) : (
								<Check className="size-3.5 shrink-0 text-success-ink" aria-hidden="true" />
							)}
							<span
								className={`min-w-0 break-words ${entry.status === "running" ? "text-slate" : entry.status === "error" ? "text-danger-ink" : "text-ink"}`}
							>
								{labelFor(entry)}
							</span>
							{entry.status === "complete" && entry.resultCount !== undefined && (
								<span className="ml-auto shrink-0 text-xs text-slate tabular">
									{entry.resultCount} {resultNoun(entry.resultCount)}
									{entry.durationMs !== undefined && ` · ${formatDuration(entry.durationMs)}`}
								</span>
							)}
							{entry.status === "error" && (
								<span className="ml-auto shrink-0 text-xs text-danger">unavailable</span>
							)}
						</li>
					))}
				</ol>
			)}
		</div>
	);
}
