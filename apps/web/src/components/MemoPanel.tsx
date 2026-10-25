// Officer credit-memo panel (assist EN-01/02): draft from the case evidence,
// render sections/claims with citation chips, approve with an explicit
// confirm, and show the agent trace as metadata only. Hides itself while the
// assist flag is off (404); other errors surface via ErrorBox.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	ApiError,
	apiErrorMessage,
	approveMemo,
	draftMemo,
	formatDateTime,
	listMemoArtifacts,
	updateMemo,
	type AssistArtifact,
	type CreditMemoContent,
	type MemoCitation,
} from "../lib/api";
import { Card, EmptyState, ErrorBox, Skeleton, StatusBadge } from "./ui";

/** Defensive read: old or unexpected rows render as "no content", never crash. */
function asMemoContent(content: unknown): CreditMemoContent | null {
	if (typeof content !== "object" || content === null) return null;
	const c = content as Record<string, unknown>;
	if (typeof c.title !== "string" || !Array.isArray(c.sections)) return null;
	return content as CreditMemoContent;
}

/** `case_fact:…` → `case fact`; unknown refs render raw. */
function sourceLabel(ref: string): string {
	const head = ref.split(":")[0] ?? ref;
	return head.replace(/_/g, " ").trim() || ref;
}

function CitationChip({ citation }: { citation: MemoCitation }) {
	return (
		<li className="rounded border border-gray-200 bg-gray-50 px-2 py-1">
			<p className="font-mono text-xs text-gray-700" title={citation.ref}>
				<span className="mr-1 rounded bg-gray-200 px-1 py-0.5 font-sans font-medium">
					{sourceLabel(citation.ref)}
				</span>
				{citation.ref}
			</p>
			<blockquote className="mt-0.5 border-l-2 border-gray-300 pl-2 text-xs text-gray-600 italic">
				“{citation.quote}”
			</blockquote>
		</li>
	);
}

function TraceSection({ artifact }: { artifact: AssistArtifact }) {
	const trace = artifact.agentTrace;
	if (!trace) return null;
	return (
		<section
			aria-label="Agent trace (metadata)"
			className="mt-4 rounded border border-gray-200 p-3"
		>
			<h4 className="text-sm font-semibold">Agent trace (metadata)</h4>
			<dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-gray-600 sm:grid-cols-2">
				<div>
					<dt className="inline font-medium">Writer: </dt>
					<dd className="inline font-mono">{trace.writer}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Model: </dt>
					<dd className="inline font-mono">{trace.model}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Prompt: </dt>
					<dd className="inline font-mono">{trace.promptVersion}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Agent: </dt>
					<dd className="inline font-mono">{trace.agentVersion}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Evidence: </dt>
					<dd className="inline font-mono" title={trace.evidenceHash}>
						{trace.evidenceHash.slice(0, 12)}…
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Steps: </dt>
					<dd className="inline">
						{trace.steps} · {trace.toolCalls.length} tool calls · {trace.sourceRefs.length} sources
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Repair: </dt>
					<dd className="inline">
						{trace.repairAttempted
							? trace.repairSucceeded === true
								? "attempted, succeeded"
								: "attempted, failed"
							: "not needed"}
						{trace.fallbackReason ? ` (${trace.fallbackReason})` : ""}
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Usage: </dt>
					<dd className="inline">
						{trace.inputTokens} in / {trace.outputTokens} out · {trace.latencyMs}ms
					</dd>
				</div>
			</dl>
			{trace.toolCalls.length > 0 && (
				<table className="mt-2 w-full text-xs">
					<thead>
						<tr className="text-left text-gray-500">
							<th className="py-1 pr-2 font-medium">Step</th>
							<th className="py-1 pr-2 font-medium">Tool</th>
							<th className="py-1 pr-2 font-medium">Results</th>
							<th className="py-1 font-medium">Source types</th>
						</tr>
					</thead>
					<tbody>
						{trace.toolCalls.map((call, i) => (
							<tr key={`${call.step}-${call.name}-${i}`} className="border-t border-gray-100">
								<td className="py-1 pr-2 tabular-nums">{call.step}</td>
								<td className="py-1 pr-2 font-mono">{call.name}</td>
								<td className="py-1 pr-2 tabular-nums">{call.resultCount}</td>
								<td className="py-1 text-gray-600">{call.sourceTypes.join(", ") || "—"}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
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
	const content = artifact ? asMemoContent(artifact.content) : null;
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
			setDraftError(
				err instanceof ApiError ? `${err.code}: ${apiErrorMessage(err)}` : apiErrorMessage(err),
			);
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
			setActionError(
				err instanceof ApiError ? `${err.code}: ${apiErrorMessage(err)}` : apiErrorMessage(err),
			);
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
			setActionError(
				err instanceof ApiError ? `${err.code}: ${apiErrorMessage(err)}` : apiErrorMessage(err),
			);
		} finally {
			setActing(false);
		}
	}

	return (
		<Card
			title="Credit memo"
			actions={artifact ? <StatusBadge status={artifact.status} /> : undefined}
		>
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
							<button
								type="button"
								onClick={() => void draft()}
								disabled={drafting}
								className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
							>
								{drafting ? "Drafting…" : "Draft memo"}
							</button>
						) : undefined
					}
				/>
			) : (
				<div>
					<div className="flex flex-wrap items-baseline justify-between gap-2">
						<h3 className="text-sm font-semibold">{content.title}</h3>
						<p className="text-xs text-gray-500">
							v{artifact.version} · r{artifact.revision}
						</p>
					</div>
					<div className="mt-3 space-y-4">
						{shown?.sections.map((section, si) => (
							<section key={section.key} aria-label={section.title}>
								<h4 className="text-sm font-semibold">{section.title}</h4>
								{section.notAvailable || section.claims.length === 0 ? (
									<p className="mt-1 text-sm text-gray-500">Not available.</p>
								) : (
									<ul className="mt-1 space-y-2">
										{section.claims.map((claim, ci) => (
											<li key={`${section.key}-${ci}`} className="text-sm text-gray-800">
												{editing ? (
													<textarea
														aria-label={`Edit claim ${ci + 1} in ${section.title}`}
														value={claim.text}
														onChange={(event) => updateClaim(si, ci, event.target.value)}
														rows={3}
														className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
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
							<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
								{content.openItems.map((item, i) => (
									<li key={i}>
										{item.text}{" "}
										<span className="font-mono text-xs text-gray-500">[{item.code}]</span>
									</li>
								))}
							</ul>
						</div>
					)}
					{content.officerQuestions.length > 0 && (
						<div className="mt-4">
							<h4 className="text-sm font-semibold">Officer questions</h4>
							<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
								{content.officerQuestions.map((q) => (
									<li key={q}>{q}</li>
								))}
							</ul>
						</div>
					)}
					<TraceSection artifact={artifact} />
					{artifact.status === "approved" ? (
						<p className="mt-4 text-sm text-gray-600">
							Approved{artifact.approvedBy ? ` by ${artifact.approvedBy}` : ""}
							{artifact.approvedAt ? ` · ${formatDateTime(artifact.approvedAt)}` : ""}.
						</p>
					) : editing ? (
						<div className="mt-4 flex flex-wrap gap-2">
							<button
								type="button"
								onClick={() => void saveEdit()}
								disabled={acting}
								className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
							>
								{acting ? "Saving…" : "Save changes"}
							</button>
							<button
								type="button"
								onClick={() => {
									setEditing(null);
									setActionError("");
								}}
								disabled={acting}
								className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
							>
								Cancel edit
							</button>
						</div>
					) : (
						<div className="mt-4 flex flex-wrap gap-2">
							{canDraft && (
								<button
									type="button"
									onClick={() => void draft()}
									disabled={drafting}
									className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
								>
									{drafting ? "Drafting…" : "Re-draft memo"}
								</button>
							)}
							{isDraft && (
								<button
									type="button"
									onClick={startEdit}
									className="rounded border border-gray-300 px-4 py-2 text-sm"
								>
									Edit memo
								</button>
							)}
							{confirming ? (
								<>
									<button
										type="button"
										onClick={() => void approve()}
										disabled={acting || !isDraft}
										className="rounded bg-green-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
									>
										{acting ? "Approving…" : "Confirm approval"}
									</button>
									<button
										type="button"
										onClick={() => {
											setConfirming(false);
											setActionError("");
										}}
										disabled={acting}
										className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
									>
										Cancel
									</button>
								</>
							) : (
								<button
									type="button"
									onClick={() => setConfirming(true)}
									disabled={!isDraft}
									className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
								>
									Approve memo
								</button>
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
