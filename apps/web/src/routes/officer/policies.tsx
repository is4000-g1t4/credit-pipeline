// Officer credit-policy Q&A (advisory only): one question at a time, cited
// answer, no chat history or persistence — state resets on navigation.
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CitedSegments, PolicySources } from "../../components/policy-citations";
import {
	CodeTag,
	EmptyState,
	ErrorBox,
	Page,
	PageHead,
	Panel,
	SectionHead,
	Skeleton,
	Tag,
	inputCls,
} from "../../components/ubs";
import {
	api,
	apiErrorMessage,
	askPolicy,
	formatDateOnly,
	valueLabel,
	type PolicyAskResponse,
	type PolicyProduct,
} from "../../lib/api";
import { RequireAuth } from "../../lib/auth";
import { clean } from "../../lib/format";

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

interface PolicyRegisterItem {
	policyKey: string;
	title: string;
	version: string;
	versionId: string;
	effectiveFrom: string;
	effectiveTo: string | null;
	productScope: string;
	jurisdiction: string;
	sectionCount: number;
}

function PolicyRegister() {
	const register = useQuery({
		queryKey: ["policy-register"],
		queryFn: () => api<{ items: PolicyRegisterItem[] }>("/api/policy/register"),
		retry: false,
	});

	if (register.isPending) return <Skeleton label="Loading policy register" />;
	if (register.isError)
		return (
			<ErrorBox message={apiErrorMessage(register.error)} onRetry={() => void register.refetch()} />
		);
	if (register.data.items.length === 0)
		return <EmptyState title="No approved policies" hint="The register is empty." />;

	return (
		<ul className="divide-y divide-rule">
			{register.data.items.map((item) => (
				<li key={item.policyKey} className="py-4 first:pt-0 last:pb-0">
					<div className="flex flex-wrap items-center gap-2">
						<CodeTag code={item.policyKey} />
						<Tag tone="info">{clean(item.version)}</Tag>
					</div>
					<p className="mt-2 text-lg leading-7 text-ink">{clean(item.title)}</p>
					<p className="mt-1 text-sm text-slate tabular">
						Effective {formatDateOnly(item.effectiveFrom)} →{" "}
						{item.effectiveTo ? formatDateOnly(item.effectiveTo) : "current"} ·{" "}
						{valueLabel("productScope", clean(item.productScope))} · {clean(item.jurisdiction)} ·{" "}
						{item.sectionCount} sections
					</p>
				</li>
			))}
		</ul>
	);
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
			<PageHead
				title="Credit policy"
				subtitle="Advisory only — cited policy sections for context. It never decides a case."
			/>
			<div className="grid gap-8 lg:grid-cols-3">
				<div className="space-y-8 lg:col-span-2">
					<Panel title="Ask a policy question" outline>
						<div className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="policy-question">Question</Label>
								<Textarea
									id="policy-question"
									value={question}
									maxLength={2000}
									rows={3}
									onChange={(e) => setQuestion(e.target.value)}
									placeholder="e.g. What is the maximum loan amount for a personal loan?"
								/>
							</div>
							<div className="flex flex-wrap gap-4">
								<div className="space-y-2">
									<Label htmlFor="policy-product">Product</Label>
									<select
										id="policy-product"
										value={product}
										onChange={(e) => setProduct(e.target.value as PolicyProduct)}
										className={inputCls}
									>
										<option value="personal_loan">Personal loan</option>
										<option value="sme_term_loan">SME term loan</option>
									</select>
								</div>
								<div className="space-y-2">
									<Label htmlFor="policy-jurisdiction">Jurisdiction</Label>
									<input
										id="policy-jurisdiction"
										type="text"
										value={jurisdiction}
										maxLength={10}
										onChange={(e) => setJurisdiction(e.target.value)}
										className={inputCls}
									/>
								</div>
							</div>
							<Button
								type="button"
								onClick={() => void ask()}
								disabled={asking || !question.trim()}
							>
								{asking ? "Asking…" : "Ask"}
							</Button>
							<div className="flex flex-wrap gap-2">
								{SUGGESTED.map((s) => (
									<Button
										key={s}
										type="button"
										variant="outline"
										size="sm"
										onClick={() => setQuestion(s)}
									>
										{s}
									</Button>
								))}
							</div>
						</div>
					</Panel>

					{asking && (
						<output className="block text-sm text-slate" aria-live="polite">
							Checking cited policy sections… This panel updates automatically.
						</output>
					)}
					{error && <ErrorBox message={error} onRetry={() => void ask()} />}

					{!asking && !error && answer && answer.status === "succeeded" && (
						<Panel title="Answer" outline>
							<div className="space-y-4">
								<CitedSegments segments={answer.segments} citations={answer.citations} />
								<PolicySources citations={answer.citations} />
								{answer.limitations.length > 0 && (
									<div>
										<h4 className="text-sm font-medium text-ink">Limitations</h4>
										<ul className="mt-1 list-disc pl-5 text-sm text-slate">
											{answer.limitations.map((l) => (
												<li key={l}>{clean(l)}</li>
											))}
										</ul>
									</div>
								)}
								{answer.usage?.costUsd !== undefined && (
									<p className="text-xs text-slate tabular">
										Cost ${answer.usage.costUsd.toFixed(4)}
									</p>
								)}
							</div>
						</Panel>
					)}
					{!asking && !error && answer && answer.status !== "succeeded" && (
						<p className="text-sm text-slate" aria-live="polite">
							{statusCopy(answer.status)}
						</p>
					)}
				</div>

				<aside>
					<Panel title="Policy register" tone="warm">
						<p className="mb-4 text-sm text-slate">
							Current approved documents. Answers cite exact sections; sections outside this
							register are not shown.
						</p>
						<PolicyRegister />
					</Panel>
					<div className="mt-8">
						<SectionHead title="Advisory only" tight />
						<p className="text-sm text-slate">
							The register explains the rule and leaves the decision to an officer.
						</p>
					</div>
				</aside>
			</div>
		</Page>
	);
}
