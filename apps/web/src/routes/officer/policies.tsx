// Officer credit-policy Q&A (advisory only): one question at a time, cited
// answer, no chat history or persistence — state resets on navigation.
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CitedSegments, PolicySources } from "../../components/PolicyCitations";
import { Card, ErrorBox, Page } from "../../components/ui";
import {
	apiErrorMessage,
	askPolicy,
	type PolicyAskResponse,
	type PolicyProduct,
} from "../../lib/api";
import { RequireAuth } from "../../lib/auth";

export const Route = createFileRoute("/officer/policies")({
	validateSearch: (search: Record<string, unknown>): { question?: string } => ({
		question: typeof search.question === "string" ? search.question : undefined,
	}),
	component: () => (
		<RequireAuth allow="officer">
			<PolicyAsk />
		</RequireAuth>
	),
});

const SUGGESTED = [
	"What is the maximum loan amount for a personal loan?",
	"What income documents are required for an SME term loan?",
	"Which applications must be referred to a policy owner?",
];

/** Officer copy per ask status; succeeded renders the answer card instead. */
function statusCopy(status: PolicyAskResponse["status"]): string {
	switch (status) {
		case "no_match":
			return "No matching policy section found. Try rephrasing the question.";
		case "needs_policy_owner":
			return "This question needs a policy owner to answer — escalate through the usual review route.";
		case "out_of_scope":
			return "Out of scope — credit-policy Q&A only answers questions about personal loans and SME term loans.";
		case "identifier_blocked":
			return "Blocked — the question contains an identifier. Re-ask without account numbers, names, or ID numbers.";
		case "rate_limited":
			return "Too many requests — wait a moment and try again.";
		case "budget_exceeded":
			return "The policy Q&A budget is exhausted for now — try again later.";
		case "failed":
			return "Policy lookup failed. The case remains fully decidable without it.";
		default:
			return "";
	}
}

function PolicyAsk() {
	const { question: prefill } = Route.useSearch();
	const [question, setQuestion] = useState(prefill ?? "");
	const [product, setProduct] = useState<PolicyProduct>("personal_loan");
	const [jurisdiction, setJurisdiction] = useState("SG");
	const [asking, setAsking] = useState(false);
	const [error, setError] = useState("");
	const [answer, setAnswer] = useState<PolicyAskResponse | null>(null);

	async function ask() {
		if (!question.trim() || asking) return;
		setAsking(true);
		setError("");
		try {
			setAnswer(await askPolicy(question.trim(), product, jurisdiction.trim() || "SG"));
		} catch (err) {
			setError(apiErrorMessage(err));
			setAnswer(null);
		} finally {
			setAsking(false);
		}
	}

	return (
		<Page>
			<h1 className="mb-1 text-xl font-bold">Credit policy</h1>
			<p className="mb-4 text-xs text-gray-500">
				Advisory only — cited policy sections for context. It never decides a case.
			</p>
			<div className="space-y-4">
				<Card title="Ask a policy question">
					<div className="space-y-3">
						<div>
							<label
								htmlFor="policy-question"
								className="mb-1 block text-sm font-medium text-gray-700"
							>
								Question
							</label>
							<textarea
								id="policy-question"
								value={question}
								maxLength={2000}
								rows={3}
								onChange={(e) => setQuestion(e.target.value)}
								placeholder="e.g. What is the maximum loan amount for a personal loan?"
								className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
							/>
						</div>
						<div className="flex flex-wrap gap-3">
							<div>
								<label
									htmlFor="policy-product"
									className="mb-1 block text-sm font-medium text-gray-700"
								>
									Product
								</label>
								<select
									id="policy-product"
									value={product}
									onChange={(e) => setProduct(e.target.value as PolicyProduct)}
									className="rounded border border-gray-300 px-3 py-2 text-sm"
								>
									<option value="personal_loan">Personal loan</option>
									<option value="sme_term_loan">SME term loan</option>
								</select>
							</div>
							<div>
								<label
									htmlFor="policy-jurisdiction"
									className="mb-1 block text-sm font-medium text-gray-700"
								>
									Jurisdiction
								</label>
								<input
									id="policy-jurisdiction"
									type="text"
									value={jurisdiction}
									maxLength={10}
									onChange={(e) => setJurisdiction(e.target.value)}
									className="w-24 rounded border border-gray-300 px-3 py-2 text-sm"
								/>
							</div>
						</div>
						<button
							type="button"
							onClick={() => void ask()}
							disabled={asking || !question.trim()}
							className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
						>
							{asking ? "Asking…" : "Ask"}
						</button>
						<div className="flex flex-wrap gap-2">
							{SUGGESTED.map((s) => (
								<button
									key={s}
									type="button"
									onClick={() => setQuestion(s)}
									className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
								>
									{s}
								</button>
							))}
						</div>
					</div>
				</Card>

				{asking && (
					<output className="block text-sm text-gray-600" aria-live="polite">
						Checking cited policy sections… This panel updates automatically.
					</output>
				)}
				{error && <ErrorBox message={error} onRetry={() => void ask()} />}

				{!asking && !error && answer && answer.status === "succeeded" && (
					<Card title="Answer">
						<div className="space-y-3">
							<CitedSegments segments={answer.segments} citations={answer.citations} />
							<PolicySources citations={answer.citations} />
							{answer.limitations.length > 0 && (
								<div>
									<h4 className="text-sm font-semibold">Limitations</h4>
									<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
										{answer.limitations.map((l) => (
											<li key={l}>{l}</li>
										))}
									</ul>
								</div>
							)}
							{answer.usage?.costUsd !== undefined && (
								<p className="text-xs text-gray-500">Cost ${answer.usage.costUsd.toFixed(4)}</p>
							)}
						</div>
					</Card>
				)}
				{!asking && !error && answer && answer.status !== "succeeded" && (
					<p className="text-sm text-gray-600" aria-live="polite">
						{statusCopy(answer.status)}
					</p>
				)}
			</div>
		</Page>
	);
}
