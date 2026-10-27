// E3 case policy/exception navigator (officer-only): deterministic rule
// failures with observed/threshold plus the exception/approval path, a
// tool-grounded per-rule explanation, a case-scoped follow-up, and the
// editable/approvable exception memo. Hides itself while the flag is off
// (404); other errors surface via ErrorBox. Advisory only — nothing here
// decides the case.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	ApiError,
	apiErrorMessage,
	apiErrorWithCode,
	approvePolicyExceptionMemo,
	askPolicyException,
	draftPolicyExceptionMemo,
	explainPolicyException,
	fetchPolicyException,
	fetchPolicyExceptionMemo,
	formatDateTime,
	updatePolicyExceptionMemo,
	type PolicyAnswerSegment,
	type PolicyCitation,
	type PolicyExceptionArtifactSummary,
	type PolicyExceptionCitation,
	type PolicyExceptionExplanation,
	type PolicyExceptionFailure,
	type PolicyExceptionFollowUp,
	type PolicyExceptionMemoContent,
	type PolicyExceptionSection,
	type PolicyExceptionSectionRef,
} from "../lib/api";
import { Button } from "./ui/button";
import { asMemoContent } from "./memo-content";
import { PolicyCitationButton, PolicySectionDrawer } from "./policy-citations";
import { TraceDetails } from "./trace-details";
import { Card, EmptyState, ErrorBox, Skeleton, StatusBadge } from "./ui";

function approverLabel(approver: string | null): string {
	switch (approver) {
		case "single_officer":
			return "single officer";
		case "team_manager":
			return "team manager";
		case "credit_committee":
			return "credit committee";
		default:
			return "—";
	}
}

/** Rule/exception refs as buttons opening the shared section drawer when the
 * catalog carries a drawer token; otherwise plain text + "source unavailable". */
function RefButtons({
	refs,
	sections,
}: {
	refs: PolicyExceptionSectionRef[];
	sections: PolicyExceptionSection[];
}) {
	const [open, setOpen] = useState<PolicyCitation | null>(null);
	if (refs.length === 0) return <span className="text-xs text-slate">No policy refs.</span>;
	return (
		<>
			<span className="flex flex-wrap gap-1.5">
				{refs.map((ref) => {
					const key = `${ref.policyKey}#${ref.sectionId}`;
					const section = sections.find(
						(s) => s.policyKey === ref.policyKey && s.sectionId === ref.sectionId,
					);
					const citation: PolicyCitation | null =
						section?.drawerToken && section.policyVersionId
							? {
									policyKey: section.policyKey,
									policyVersionId: section.policyVersionId,
									sectionId: section.sectionId,
									heading: section.heading,
									version: section.version ?? "",
									effectiveFrom: section.effectiveFrom ?? "",
									quote: section.body.slice(0, 500),
									drawerToken: section.drawerToken,
								}
							: null;
					return citation ? (
						<button
							key={key}
							type="button"
							onClick={() => setOpen(citation)}
							aria-label={`Open policy ${ref.policyKey} section ${ref.sectionId}`}
							title={`${ref.policyKey} §${ref.sectionId} — ${section?.heading ?? ""}`}
							className="rounded bg-tag-blue px-1.5 py-0.5 font-mono text-xs font-medium text-red-link hover:bg-warm hover:underline"
						>
							{ref.policyKey} §{ref.sectionId}
						</button>
					) : (
						<span
							key={key}
							title="source unavailable"
							className="rounded bg-warm px-1.5 py-0.5 font-mono text-xs text-slate"
						>
							{ref.policyKey} §{ref.sectionId} · source unavailable
						</span>
					);
				})}
			</span>
			{open && <PolicySectionDrawer citation={open} onClose={() => setOpen(null)} />}
		</>
	);
}

function toPolicyCitation(c: PolicyExceptionCitation): PolicyCitation {
	return {
		policyKey: c.policyKey,
		policyVersionId: c.policyVersionId ?? "",
		sectionId: c.sectionId,
		heading: c.heading ?? c.sectionId,
		version: c.version ?? "",
		effectiveFrom: c.effectiveFrom ?? "",
		quote: c.quote,
		drawerToken: c.drawerToken ?? "",
	};
}

function openable(c: PolicyExceptionCitation): boolean {
	return Boolean(c.drawerToken && c.policyVersionId);
}

/** Minimal cited-segments renderer: inline [n] buttons only when the citation
 * carries a drawer token, otherwise an inert marker; quotes listed below. */
function ExceptionSegments({
	segments,
	citations,
}: {
	segments: PolicyAnswerSegment[];
	citations: PolicyExceptionCitation[];
}) {
	const [open, setOpen] = useState<PolicyCitation | null>(null);
	return (
		<>
			<div className="space-y-2">
				{segments.map((s, i) => (
					<p key={`${i}-${s.citationIndexes.join(",")}-${s.text}`} className="text-sm text-ink">
						{s.text}{" "}
						{s.citationIndexes.map((ci) => {
							const cited = citations[ci];
							if (!cited) return null;
							return openable(cited) ? (
								<PolicyCitationButton
									key={ci}
									citation={toPolicyCitation(cited)}
									index={ci}
									onSelect={setOpen}
								/>
							) : (
								<span
									key={ci}
									title={cited.quote}
									className="mx-0.5 rounded bg-warm px-1 font-mono text-xs text-slate"
								>
									[{ci + 1}]
								</span>
							);
						})}
					</p>
				))}
			</div>
			{citations.length > 0 && (
				<ol className="mt-2 space-y-1 text-xs text-slate">
					{citations.map((c, i) => (
						<li key={`${c.policyKey}-${c.sectionId}-${i}`}>
							<span className="font-mono">
								[{i + 1}] {c.policyKey} §{c.sectionId}
							</span>
							{openable(c) && (
								<button
									type="button"
									onClick={() => setOpen(toPolicyCitation(c))}
									className="ml-1 text-red-link hover:underline"
								>
									open
								</button>
							)}
							<blockquote className="border-l-2 border-rule-strong pl-2 italic">
								“{c.quote}”
							</blockquote>
						</li>
					))}
				</ol>
			)}
			{open && <PolicySectionDrawer citation={open} onClose={() => setOpen(null)} />}
		</>
	);
}

function FailureCard({
	failure,
	sections,
}: {
	failure: PolicyExceptionFailure;
	sections: PolicyExceptionSection[];
}) {
	const ex = failure.exception;
	return (
		<li className="rounded border border-rule p-3">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-sm font-semibold">{failure.ruleId}</span>
				<StatusBadge status={failure.effect} />
				<StatusBadge status={ex.state} />
				{failure.persisted && failure.decisionRelevant && (
					<span className="rounded bg-tag-amber px-1.5 py-0.5 text-xs font-medium text-warning-ink">
						decision driver
					</span>
				)}
				{!failure.evaluated && (
					<span className="rounded bg-warm px-1.5 py-0.5 text-xs text-slate">not evaluated</span>
				)}
			</div>
			<dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-slate sm:grid-cols-2">
				<div>
					<dt className="inline font-medium">Reason: </dt>
					<dd className="inline font-mono">{failure.reasonCode}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Observed: </dt>
					<dd className="inline tabular-nums">{failure.observed || "—"}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Threshold: </dt>
					<dd className="inline tabular-nums">{failure.threshold || "—"}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Mapping: </dt>
					<dd className="inline font-mono">{failure.mappingState}</dd>
				</div>
			</dl>
			{failure.explanationLimitation && (
				<p className="mt-1 text-xs text-slate">Limitation: {failure.explanationLimitation}</p>
			)}
			<div className="mt-1.5">
				<RefButtons refs={failure.ruleSectionRefs} sections={sections} />
			</div>
			<div className="mt-2 rounded bg-raised p-2 text-xs text-slate">
				{ex.state === "mapping_unavailable" ? (
					<p className="font-medium">
						No exception route recorded — policy owner required. No approver or mitigant is stated.
					</p>
				) : (
					<>
						<p>
							<span className="font-medium">Exception route: </span>
							{ex.state.replaceAll("_", " ")} · approver {approverLabel(ex.approver)}
							{ex.committeeCheckRequired ? " · committee check required" : ""}
							{ex.dualSignoff ? " · dual sign-off" : ""}
						</p>
						{ex.approver !== null && ex.approverVerification === "minimum" && (
							<p className="mt-0.5 text-warning-ink">
								Minimum approver only — verify committee routing (staff/PEP/connected status is
								unavailable).
							</p>
						)}
						{ex.mitigants.length > 0 && (
							<ul className="mt-1 list-disc pl-5">
								{ex.mitigants.map((m) => (
									<li key={m.code}>
										{m.label}{" "}
										<span className="font-mono text-slate">
											[{m.code}
											{m.citations.map((c) => ` ${c.policyKey}#${c.sectionId}`).join(",")}]
										</span>
									</li>
								))}
							</ul>
						)}
						{ex.conditions.length > 0 && (
							<ul className="mt-1 list-disc pl-5">
								{ex.conditions.map((c) => (
									<li key={c}>{c}</li>
								))}
							</ul>
						)}
						{ex.regularisationPlanMaxMonths !== null && (
							<p className="mt-1">Regularisation plan ≤ {ex.regularisationPlanMaxMonths} months.</p>
						)}
						{ex.reason && <p className="mt-1 text-slate">{ex.reason}</p>}
					</>
				)}
			</div>
		</li>
	);
}

interface FollowUpEntry {
	question: string;
	answer: PolicyExceptionFollowUp | null;
	error: string;
}

function FollowUpSection({ applicationId }: { applicationId: string }) {
	const [question, setQuestion] = useState("");
	const [asking, setAsking] = useState(false);
	const [history, setHistory] = useState<FollowUpEntry[]>([]);
	const valid = question.trim().length >= 3 && question.trim().length <= 1000;

	async function ask() {
		if (!valid || asking) return;
		const q = question.trim();
		setAsking(true);
		try {
			const answer = await askPolicyException(applicationId, q);
			setHistory((h) => [...h, { question: q, answer, error: "" }]);
			setQuestion("");
		} catch (err) {
			setHistory((h) => [...h, { question: q, answer: null, error: apiErrorWithCode(err) }]);
		} finally {
			setAsking(false);
		}
	}

	return (
		<section aria-label="Policy follow-up" className="mt-4">
			<h3 className="text-sm font-semibold">Ask a follow-up</h3>
			<p className="mt-0.5 text-xs text-slate">
				Case-scoped only — answers cite this case&apos;s rules and sections.
			</p>
			<div className="mt-2 flex flex-wrap gap-2">
				<label htmlFor="policy-exception-question" className="sr-only">
					Policy follow-up question (3–1000 characters)
				</label>
				<input
					id="policy-exception-question"
					type="text"
					value={question}
					maxLength={1000}
					onChange={(e) => setQuestion(e.target.value)}
					placeholder="e.g. What mitigants apply to the score rule?"
					className="h-8 min-w-0 flex-1 rounded-sm border border-rule-strong bg-card px-2 text-sm text-ink"
				/>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void ask()}
					disabled={!valid || asking}
				>
					{asking ? "Asking…" : "Ask"}
				</Button>
			</div>
			{history.length > 0 && (
				<ul className="mt-2 space-y-2">
					{history.map((entry, i) => (
						<li key={i} className="rounded border border-rule p-2">
							<p className="text-sm font-medium text-ink">Q: {entry.question}</p>
							{entry.answer ? (
								<div className="mt-1">
									{entry.answer.status === "succeeded" ? (
										<ExceptionSegments
											segments={entry.answer.segments}
											citations={entry.answer.citations}
										/>
									) : entry.answer.status === "needs_policy_owner" ? (
										<p className="text-sm text-slate">
											Needs a policy owner to answer — escalate through the usual review route.
										</p>
									) : (
										<p className="text-sm text-slate">
											No matching policy section found for this question.
										</p>
									)}
									{entry.answer.limitations.length > 0 && (
										<ul className="mt-1 list-disc pl-5 text-xs text-slate">
											{entry.answer.limitations.map((l) => (
												<li key={l}>{l}</li>
											))}
										</ul>
									)}
									<TraceDetails trace={entry.answer.trace} />
								</div>
							) : (
								<div className="mt-1">
									<ErrorBox message={entry.error} />
								</div>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function MemoSection({
	applicationId,
	caseStatus,
	latestArtifact,
}: {
	applicationId: string;
	caseStatus: string;
	latestArtifact: PolicyExceptionArtifactSummary | null;
}) {
	const queryClient = useQueryClient();
	const [drafting, setDrafting] = useState(false);
	const [draftError, setDraftError] = useState("");
	const [acting, setActing] = useState(false);
	const [actionError, setActionError] = useState("");
	const [confirming, setConfirming] = useState(false);
	const [editing, setEditing] = useState<PolicyExceptionMemoContent | null>(null);

	const memoId = latestArtifact?.id ?? null;
	const memo = useQuery({
		queryKey: ["policy-exception-memo", memoId],
		queryFn: () => fetchPolicyExceptionMemo(memoId ?? ""),
		enabled: memoId !== null,
		retry: false,
	});

	const canMutate = caseStatus === "pending_review";
	const summary = latestArtifact;
	const artifact = memo.data?.artifact ?? null;
	const content = artifact ? asMemoContent<PolicyExceptionMemoContent>(artifact.content) : null;
	const shown = editing ?? content;

	function invalidate() {
		void queryClient.invalidateQueries({ queryKey: ["policy-exception", applicationId] });
		void queryClient.invalidateQueries({ queryKey: ["policy-exception-memo"] });
	}

	async function draft() {
		setDrafting(true);
		setDraftError("");
		try {
			await draftPolicyExceptionMemo(applicationId);
			invalidate();
		} catch (err) {
			setDraftError(apiErrorWithCode(err));
		} finally {
			setDrafting(false);
		}
	}

	async function approve() {
		if (!artifact) return;
		setActing(true);
		setActionError("");
		try {
			await approvePolicyExceptionMemo(artifact.id, artifact.revision);
			setConfirming(false);
			invalidate();
		} catch (err) {
			setActionError(apiErrorWithCode(err));
		} finally {
			setActing(false);
		}
	}

	function startEdit() {
		if (!content) return;
		setEditing(JSON.parse(JSON.stringify(content)) as PolicyExceptionMemoContent);
		setActionError("");
	}

	function updateClaim(sectionIndex: number, claimIndex: number, text: string) {
		setEditing((current) => {
			if (!current) return current;
			const next = JSON.parse(JSON.stringify(current)) as PolicyExceptionMemoContent;
			const claim = next.sections[sectionIndex]?.claims[claimIndex];
			if (claim) claim.text = text;
			return next;
		});
	}

	async function saveEdit() {
		if (!artifact || !editing) return;
		setActing(true);
		setActionError("");
		try {
			await updatePolicyExceptionMemo(artifact.id, artifact.revision, editing);
			setEditing(null);
			invalidate();
		} catch (err) {
			setActionError(apiErrorWithCode(err));
		} finally {
			setActing(false);
		}
	}

	if (!summary) {
		return (
			<section aria-label="Exception memo" className="mt-4">
				<h3 className="text-sm font-semibold">Exception memo</h3>
				<div className="mt-2">
					<EmptyState
						title="No exception memo yet"
						hint={
							canMutate
								? "Draft one from the current rule context — identical evidence replays the same draft."
								: `The case is ${caseStatus} — no memo can be drafted or approved.`
						}
						action={
							canMutate ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void draft()}
									disabled={drafting}
								>
									{drafting ? "Drafting…" : "Draft exception memo"}
								</Button>
							) : undefined
						}
					/>
				</div>
				{draftError && (
					<div className="mt-2">
						<ErrorBox message={draftError} />
					</div>
				)}
			</section>
		);
	}

	return (
		<section aria-label="Exception memo" className="mt-4">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="text-sm font-semibold">Exception memo</h3>
				{artifact && <StatusBadge status={artifact.status} />}
			</div>
			{memo.isPending ? (
				<div className="mt-2">
					<Skeleton label="Loading exception memo" />
				</div>
			) : memo.isError ? (
				<div className="mt-2">
					<ErrorBox message={apiErrorWithCode(memo.error)} onRetry={() => void memo.refetch()} />
				</div>
			) : !artifact || !content ? (
				<p className="mt-2 text-sm text-slate">The memo is not available.</p>
			) : (
				<div className="mt-2">
					<div className="flex flex-wrap items-baseline justify-between gap-2">
						<p className="text-sm font-medium">{shown?.title}</p>
						<p className="text-xs text-slate">
							v{artifact.version} · r{artifact.revision} · retained until{" "}
							{formatDateTime(summary.retentionUntil)}
						</p>
					</div>
					{(shown?.rules?.length ?? 0) > 0 && (
						<div className="mt-2">
							<h4 className="text-sm font-semibold">Rules (deterministic)</h4>
							<ul className="mt-1 space-y-1">
								{(shown?.rules ?? []).map((rule) => (
									<li
										key={rule.ruleId}
										className="rounded border border-rule bg-raised px-2 py-1 text-xs text-slate"
									>
										<span className="font-mono font-semibold">{rule.ruleId}</span> · observed{" "}
										{rule.observed || "—"} · threshold {rule.threshold || "—"} ·{" "}
										{rule.exceptionState.replaceAll("_", " ")} · approver{" "}
										{approverLabel(rule.approver)}
										{rule.mitigantCodes.length > 0 && (
											<> · mitigants {rule.mitigantCodes.join(", ")}</>
										)}
									</li>
								))}
							</ul>
						</div>
					)}
					<div className="mt-2 space-y-3">
						{(shown?.sections ?? []).map((section, si) => (
							<section key={section.key} aria-label={section.title}>
								<h4 className="text-sm font-semibold">{section.title}</h4>
								{section.notAvailable || section.claims.length === 0 ? (
									<p className="mt-1 text-sm text-slate">Not available.</p>
								) : (
									<ul className="mt-1 space-y-2">
										{section.claims.map((claim, ci) => (
											<li key={`${section.key}-${ci}`} className="text-sm text-ink">
												{editing ? (
													<textarea
														aria-label={`Edit claim ${ci + 1} in ${section.title}`}
														value={claim.text}
														onChange={(event) => updateClaim(si, ci, event.target.value)}
														rows={3}
														className="h-auto w-full rounded-sm border border-rule-strong bg-card px-2 py-1 text-sm text-ink"
													/>
												) : (
													<p>{claim.text}</p>
												)}
												{claim.citations.length > 0 && (
													<ul className="mt-1 space-y-1">
														{claim.citations.map((citation, j) => (
															<li
																key={`${citation.ref}-${j}`}
																className="rounded border border-rule bg-raised px-2 py-1"
															>
																<p className="font-mono text-xs text-slate">{citation.ref}</p>
																<blockquote className="mt-0.5 border-l-2 border-rule-strong pl-2 text-xs text-slate italic">
																	“{citation.quote}”
																</blockquote>
															</li>
														))}
													</ul>
												)}
											</li>
										))}
									</ul>
								)}
							</section>
						))}
					</div>
					{(shown?.openItems.length ?? 0) > 0 && (
						<div className="mt-3">
							<h4 className="text-sm font-semibold">Open items</h4>
							<ul className="mt-1 list-disc pl-5 text-sm text-slate">
								{(shown?.openItems ?? []).map((item, i) => (
									<li key={i}>
										{item.text} <span className="font-mono text-xs text-slate">[{item.code}]</span>
									</li>
								))}
							</ul>
						</div>
					)}
					{shown?.regularisationPlanMonths !== null &&
						shown?.regularisationPlanMonths !== undefined && (
							<p className="mt-3 text-sm text-slate">
								Regularisation plan ≤ {shown.regularisationPlanMonths} months.
							</p>
						)}
					<TraceDetails
						trace={
							artifact.agentTrace
								? {
										model: artifact.agentTrace.model,
										promptVersion: artifact.agentTrace.promptVersion,
										agentVersion: artifact.agentTrace.agentVersion,
										registryVersion: artifact.agentTrace.registryVersion,
										registryHash: artifact.agentTrace.registryHash,
										validatorVersion: artifact.agentTrace.validatorVersion,
										steps: artifact.agentTrace.steps,
										toolCalls: artifact.agentTrace.toolCalls,
										sourceRefs: artifact.agentTrace.sourceRefs,
										repairAttempted: artifact.agentTrace.repairAttempted,
										repairSucceeded: artifact.agentTrace.repairSucceeded,
										inputTokens: artifact.agentTrace.inputTokens,
										outputTokens: artifact.agentTrace.outputTokens,
										latencyMs: artifact.agentTrace.latencyMs,
									}
								: null
						}
					/>
					{artifact.status === "approved" ? (
						<p className="mt-3 text-sm text-slate">
							Approved{artifact.approvedBy ? ` by ${artifact.approvedBy}` : ""}
							{artifact.approvedAt ? ` · ${formatDateTime(artifact.approvedAt)}` : ""}.
						</p>
					) : editing ? (
						<div className="mt-3 flex flex-wrap gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void saveEdit()}
								disabled={acting || !canMutate}
							>
								{acting ? "Saving…" : "Save changes"}
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => {
									setEditing(null);
									setActionError("");
								}}
								disabled={acting}
							>
								Cancel edit
							</Button>
						</div>
					) : canMutate ? (
						<div className="mt-3 flex flex-wrap gap-2">
							{artifact.status === "draft" && (
								<Button type="button" variant="outline" size="sm" onClick={startEdit}>
									Edit memo
								</Button>
							)}
							{confirming ? (
								<>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => void approve()}
										disabled={acting || artifact.status !== "draft"}
									>
										{acting ? "Approving…" : "Confirm approval"}
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => {
											setConfirming(false);
											setActionError("");
										}}
										disabled={acting}
									>
										Cancel
									</Button>
								</>
							) : (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setConfirming(true)}
									disabled={artifact.status !== "draft"}
								>
									Approve memo
								</Button>
							)}
						</div>
					) : (
						<p className="mt-3 text-sm text-slate">
							The case is {caseStatus} — the memo can be viewed but not edited or approved.
						</p>
					)}
					{draftError && (
						<div className="mt-3">
							<ErrorBox message={draftError} />
						</div>
					)}
					{actionError && (
						<div className="mt-3">
							<ErrorBox message={actionError} />
						</div>
					)}
				</div>
			)}
		</section>
	);
}

function ExplainSection({
	applicationId,
	onExplained,
}: {
	applicationId: string;
	onExplained: () => void;
}) {
	const [explaining, setExplaining] = useState(false);
	const [explanation, setExplanation] = useState<PolicyExceptionExplanation | null>(null);
	const [explainError, setExplainError] = useState("");

	async function explain() {
		setExplaining(true);
		setExplainError("");
		try {
			const res = await explainPolicyException(applicationId);
			setExplanation(res);
			onExplained();
		} catch (err) {
			setExplainError(apiErrorWithCode(err));
		} finally {
			setExplaining(false);
		}
	}

	return (
		<section aria-label="Policy explanation" className="mt-4">
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => void explain()}
				disabled={explaining}
			>
				{explaining ? "Explaining…" : "Explain with policy"}
			</Button>
			{explainError && (
				<div className="mt-2">
					<ErrorBox message={explainError} />
				</div>
			)}
			{explanation && (
				<div className="mt-3 space-y-3">
					{explanation.status === "succeeded" ? (
						explanation.rules.length === 0 ? (
							<p className="text-sm text-slate">No mapped rules to explain.</p>
						) : (
							<ul className="space-y-3">
								{explanation.rules.map((rule) => (
									<li key={rule.ruleId} className="rounded border border-rule p-3">
										<p className="text-sm font-medium">
											<span className="font-mono">{rule.ruleId}</span>{" "}
											<span className="rounded bg-tag-blue px-1.5 py-0.5 text-xs font-medium text-ink">
												{rule.confidence} confidence
											</span>
										</p>
										<div className="mt-1">
											<ExceptionSegments segments={rule.segments} citations={rule.citations} />
										</div>
									</li>
								))}
							</ul>
						)
					) : explanation.status === "needs_policy_owner" ? (
						<p className="text-sm text-slate">
							The explanation needs a policy owner — escalate through the usual review route.
						</p>
					) : (
						<p className="text-sm text-slate">No matching policy section found for these rules.</p>
					)}
					{explanation.limitations.length > 0 && (
						<div>
							<h4 className="text-sm font-semibold">Limitations</h4>
							<ul className="mt-1 list-disc pl-5 text-sm text-slate">
								{explanation.limitations.map((l) => (
									<li key={l}>{l}</li>
								))}
							</ul>
						</div>
					)}
					<TraceDetails trace={explanation.trace} />
				</div>
			)}
		</section>
	);
}

export function PolicyExceptionPanel({
	applicationId,
	caseStatus,
}: {
	applicationId: string;
	/** Application status; memo draft/edit/approve run only while `pending_review`. */
	caseStatus: string;
}) {
	const queryClient = useQueryClient();
	const view = useQuery({
		queryKey: ["policy-exception", applicationId],
		queryFn: () => fetchPolicyException(applicationId),
		retry: false,
		staleTime: 60_000,
	});

	// Feature off → invisible; any other failure surfaces below.
	if (view.isError && view.error instanceof ApiError && view.error.status === 404) {
		return null;
	}

	const context = view.data?.context;
	const sections = view.data?.sections ?? [];

	return (
		<Card
			title="Policy & exception navigator"
			actions={
				view.data ? (
					<span className="text-xs text-slate">source: {view.data.sourceStatus}</span>
				) : undefined
			}
		>
			{view.isPending ? (
				<Skeleton label="Loading policy and exception details" />
			) : view.isError ? (
				<ErrorBox message={apiErrorMessage(view.error)} onRetry={() => void view.refetch()} />
			) : !context ? (
				<EmptyState title="Policy details unavailable" />
			) : (
				<div>
					<dl className="grid gap-x-4 gap-y-1 text-xs text-slate sm:grid-cols-2">
						<div>
							<dt className="inline font-medium">Outcome: </dt>
							<dd className="inline font-mono">{context.outcome}</dd>
						</div>
						<div>
							<dt className="inline font-medium">Score: </dt>
							<dd className="inline tabular-nums">
								{context.score ?? "—"}
								{context.grade ? ` (${context.grade})` : ""}
								{context.scoreBand ? ` · band ${context.scoreBand}` : ""}
							</dd>
						</div>
						<div>
							<dt className="inline font-medium">Policy version: </dt>
							<dd className="inline font-mono">{context.policyVersion ?? "—"}</dd>
						</div>
						<div>
							<dt className="inline font-medium">Registry: </dt>
							<dd className="inline font-mono">{context.registryVersion}</dd>
						</div>
					</dl>
					{context.limitations.length > 0 && (
						<div className="mt-2">
							<h3 className="text-sm font-semibold">Limitations</h3>
							<ul className="mt-1 list-disc pl-5 text-sm text-slate">
								{context.limitations.map((l) => (
									<li key={l}>{l}</li>
								))}
							</ul>
						</div>
					)}
					<div className="mt-3">
						<h3 className="text-sm font-semibold">Failed rules</h3>
						{context.failedRules.length === 0 ? (
							<p className="mt-1 text-sm text-slate">
								No failed rules — nothing to route for exception.
							</p>
						) : (
							<ul className="mt-1 space-y-2">
								{context.failedRules.map((failure: PolicyExceptionFailure) => (
									<FailureCard key={failure.ruleId} failure={failure} sections={sections} />
								))}
							</ul>
						)}
					</div>
					<ExplainSection
						applicationId={applicationId}
						onExplained={() =>
							void queryClient.invalidateQueries({ queryKey: ["policy-exception", applicationId] })
						}
					/>
					<FollowUpSection applicationId={applicationId} />
					<MemoSection
						applicationId={applicationId}
						caseStatus={caseStatus}
						latestArtifact={view.data?.latestArtifact ?? null}
					/>
				</div>
			)}
		</Card>
	);
}
