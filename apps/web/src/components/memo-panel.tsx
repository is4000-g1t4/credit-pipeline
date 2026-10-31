// Officer credit-memo panel (assist EN-01/02): draft from the case evidence,
// render sections/claims with citation chips, approve with an explicit
// confirm, and show the agent trace as metadata only. Hides itself while the
// assist flag is off (404); other errors surface via ErrorBox.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	ApiError,
	apiErrorMessage,
	apiErrorWithCode,
	approveMemo,
	draftMemo,
	formatDateTime,
	listMemoArtifacts,
	updateMemo,
	type CreditMemoContent,
	type MemoCitation,
} from "../lib/api";
import { asMemoContent } from "./memo-content";
import { TraceDetails } from "./trace-details";
import { ToolActivity } from "./tool-activity";
import { Button } from "./ui/button";
import { Card, EmptyState, ErrorBox, Skeleton, StatusBadge } from "./ui";

/** `case_fact:…` → `case fact`; unknown refs render raw. */
function sourceLabel(ref: string): string {
	const head = ref.split(":")[0] ?? ref;
	return head.replace(/_/g, " ").trim() || ref;
}

function CitationChip({ citation }: { citation: MemoCitation }) {
	return (
		<li className="rounded border border-rule bg-raised px-2 py-1">
			<p className="font-mono text-xs text-slate" title={citation.ref}>
				<span className="mr-1 rounded bg-warm px-1 py-0.5 font-sans font-medium">
					{sourceLabel(citation.ref)}
				</span>
				{citation.ref}
			</p>
			<blockquote className="mt-0.5 border-l-2 border-rule-strong pl-2 text-xs text-slate italic">
				“{citation.quote}”
			</blockquote>
		</li>
	);
}

export function MemoPanel({
	applicationId,
	caseStatus,
}: {
	applicationId: string;
	/** Draft/approve run only while the case awaits review. */
	caseStatus: string;
}) {
	const queryClient = useQueryClient();
	const [drafting, setDrafting] = useState(false);
	const [draftError, setDraftError] = useState("");
	const [acting, setActing] = useState(false);
	const [actionError, setActionError] = useState("");
	const [confirming, setConfirming] = useState(false);
	const [editing, setEditing] = useState<CreditMemoContent | null>(null);

	const memos = useQuery({
		queryKey: ["memo", applicationId],
		queryFn: () => listMemoArtifacts(applicationId),
		retry: false,
	});
	const invalidate = () => queryClient.invalidateQueries({ queryKey: ["memo", applicationId] });

	// Feature off → invisible; any other failure surfaces below.
	if (memos.isError && memos.error instanceof ApiError && memos.error.status === 404) {
		return null;
	}

	const artifact = memos.data?.items[0] ?? null;
	const content = artifact ? asMemoContent<CreditMemoContent>(artifact.content) : null;
	const canDraft = caseStatus === "pending_review";
	const isDraft = artifact?.status === "draft";
	const shown = editing ?? content;

	async function draft() {
		setDrafting(true);
		setDraftError("");
		try {
			await draftMemo(applicationId);
			await invalidate();
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
			await approveMemo(artifact.id, artifact.revision);
			setConfirming(false);
			await invalidate();
		} catch (err) {
			setActionError(apiErrorWithCode(err));
		} finally {
			setActing(false);
		}
	}

	function startEdit() {
		if (!content) return;
		setEditing(JSON.parse(JSON.stringify(content)) as CreditMemoContent);
		setActionError("");
	}

	function updateClaim(sectionIndex: number, claimIndex: number, text: string) {
		setEditing((current) => {
			if (!current) return current;
			const next = JSON.parse(JSON.stringify(current)) as CreditMemoContent;
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
			await updateMemo(artifact.id, artifact.revision, editing);
			setEditing(null);
			await invalidate();
		} catch (err) {
			setActionError(apiErrorWithCode(err));
		} finally {
			setActing(false);
		}
	}

	return (
		<Card
			title="Credit memo"
			actions={artifact ? <StatusBadge status={artifact.status} /> : undefined}
		>
			{drafting && <ToolActivity entries={[]} running pendingLabel="Reading case evidence…" />}
			{memos.isPending ? (
				<Skeleton label="Loading credit memo" />
			) : memos.isError ? (
				<ErrorBox message={apiErrorMessage(memos.error)} onRetry={() => void memos.refetch()} />
			) : !artifact || !content ? (
				<EmptyState
					title="No credit memo yet"
					hint={
						canDraft
							? "Draft one from the current case evidence — identical evidence replays the same draft."
							: "The case no longer awaits review, so no memo can be drafted."
					}
					action={
						canDraft ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void draft()}
								disabled={drafting}
							>
								{drafting ? "Drafting…" : "Draft memo"}
							</Button>
						) : undefined
					}
				/>
			) : (
				<div>
					<div className="flex flex-wrap items-baseline justify-between gap-2">
						<h3 className="text-sm font-semibold">{content.title}</h3>
						<p className="text-xs text-slate">
							v{artifact.version} · r{artifact.revision}
						</p>
					</div>
					<div className="mt-3 space-y-4">
						{shown?.sections.map((section, si) => (
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
														className="w-full rounded border border-rule-strong px-2 py-1 text-sm"
													/>
												) : (
													<p>{claim.text}</p>
												)}
												{claim.citations.length > 0 && (
													<ul className="mt-1 space-y-1">
														{claim.citations.map((citation, j) => (
															<CitationChip key={`${citation.ref}-${j}`} citation={citation} />
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
					{content.openItems.length > 0 && (
						<div className="mt-4">
							<h4 className="text-sm font-semibold">Open items</h4>
							<ul className="mt-1 list-disc pl-5 text-sm text-slate">
								{content.openItems.map((item, i) => (
									<li key={i}>
										{item.text} <span className="font-mono text-xs text-slate">[{item.code}]</span>
									</li>
								))}
							</ul>
						</div>
					)}
					{content.officerQuestions.length > 0 && (
						<div className="mt-4">
							<h4 className="text-sm font-semibold">Officer questions</h4>
							<ul className="mt-1 list-disc pl-5 text-sm text-slate">
								{content.officerQuestions.map((q) => (
									<li key={q}>{q}</li>
								))}
							</ul>
						</div>
					)}
					<TraceDetails
						trace={
							artifact.agentTrace
								? {
										writer: artifact.agentTrace.writer,
										model: artifact.agentTrace.model,
										promptVersion: artifact.agentTrace.promptVersion,
										agentVersion: artifact.agentTrace.agentVersion,
										evidenceHash: artifact.agentTrace.evidenceHash,
										steps: artifact.agentTrace.steps,
										toolCalls: artifact.agentTrace.toolCalls,
										sourceRefs: artifact.agentTrace.sourceRefs,
										repairAttempted: artifact.agentTrace.repairAttempted,
										repairSucceeded: artifact.agentTrace.repairSucceeded,
										fallbackReason: artifact.agentTrace.fallbackReason,
										inputTokens: artifact.agentTrace.inputTokens,
										outputTokens: artifact.agentTrace.outputTokens,
										latencyMs: artifact.agentTrace.latencyMs,
									}
								: null
						}
					/>
					{artifact.status === "approved" ? (
						<p className="mt-4 text-sm text-slate">
							Approved{artifact.approvedBy ? ` by ${artifact.approvedBy}` : ""}
							{artifact.approvedAt ? ` · ${formatDateTime(artifact.approvedAt)}` : ""}.
						</p>
					) : editing ? (
						<div className="mt-4 flex flex-wrap gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void saveEdit()}
								disabled={acting}
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
					) : (
						<div className="mt-4 flex flex-wrap gap-2">
							{canDraft && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void draft()}
									disabled={drafting}
								>
									{drafting ? "Drafting…" : "Re-draft memo"}
								</Button>
							)}
							{isDraft && (
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
										disabled={acting || !isDraft}
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
									disabled={!isDraft}
								>
									Approve memo
								</Button>
							)}
						</div>
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
		</Card>
	);
}
