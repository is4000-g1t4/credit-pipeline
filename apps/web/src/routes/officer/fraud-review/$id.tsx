// EN-05 fraud-review detail (assigned officer only). The assigned officer sees
// signals, document refs, and the advisory brief; there is no separate reviewer
// user. Stored quotes render as text nodes (never dangerouslySetInnerHTML);
// nothing case-derived reaches console, logs, or URLs.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
	CodeTag,
	EmptyState,
	ErrorBox,
	Field,
	Page,
	PageHead,
	Panel,
	SectionHead,
	Skeleton,
	StatusBadge,
	Tag,
	inputCls,
} from "../../../components/ubs";
import {
	ApiError,
	fetchFraudReview,
	fetchResolutionDraft,
	formatDateTime,
	resolveFraudReview,
	retryIntegrityBrief,
	type FraudBriefCitation,
	type FraudBriefClaim,
	type FraudBriefContent,
	type FraudReview,
} from "../../../lib/api";
import { RequireAuth } from "../../../lib/auth";
import { clean, friendlyMessage } from "../../../lib/format";

export const Route = createFileRoute("/officer/fraud-review/$id")({
	component: () => (
		<RequireAuth allow="officer">
			<FraudDetail />
		</RequireAuth>
	),
});

/** Defensive read: unexpected brief shapes render as unavailable, never crash. */
function asBriefContent(content: unknown): FraudBriefContent | null {
	if (typeof content !== "object" || content === null) return null;
	const c = content as Record<string, unknown>;
	if (typeof c.title !== "string") return null;
	const claim = (v: unknown): FraudBriefClaim | null => {
		if (typeof v !== "object" || v === null) return null;
		const r = v as Record<string, unknown>;
		if (typeof r.text !== "string" || !Array.isArray(r.citations)) return null;
		return v as FraudBriefClaim;
	};
	const claims = (v: unknown): FraudBriefClaim[] =>
		Array.isArray(v) ? v.map(claim).filter((x): x is FraudBriefClaim => x !== null) : [];
	const summary = claim(c.summary);
	return {
		title: c.title,
		summary: summary ?? { text: "", citations: [] },
		candidateContradictions: claims(c.candidateContradictions),
		alternativeExplanations: claims(c.alternativeExplanations),
		missingEvidence: Array.isArray(c.missingEvidence)
			? (c.missingEvidence as Array<{ text: string; code: string; sourceRef?: string }>).filter(
					(m) => typeof m.text === "string" && typeof m.code === "string",
				)
			: [],
		questionsForReviewer: Array.isArray(c.questionsForReviewer)
			? c.questionsForReviewer.filter((q): q is string => typeof q === "string")
			: [],
		suggestedPriority: typeof c.suggestedPriority === "string" ? c.suggestedPriority : "—",
	};
}

function CitationChip({ citation }: { citation: FraudBriefCitation }) {
	return (
		<li className="border border-rule bg-raised px-2 py-1">
			<p className="text-xs text-slate tabular" title={clean(citation.ref)}>
				{clean(citation.ref)}
			</p>
			<blockquote className="mt-0.5 border-l-2 border-rule-strong pl-2 text-xs text-slate italic">
				“{clean(citation.quote)}”
			</blockquote>
		</li>
	);
}

function ClaimBlock({ claim }: { claim: FraudBriefClaim }) {
	return (
		<div className="text-sm text-ink">
			<p>{clean(claim.text)}</p>
			{claim.citations.length > 0 && (
				<ul className="mt-1 space-y-1">
					{claim.citations.map((citation, j) => (
						<CitationChip key={`${citation.ref}-${j}`} citation={citation} />
					))}
				</ul>
			)}
		</div>
	);
}

function BriefSection({ review, onRetry }: { review: FraudReview; onRetry: () => void }) {
	const pending =
		review.briefUnavailable === "pending" ||
		review.briefState === "queued" ||
		review.briefState === "running";
	if (pending) {
		return (
			<div className="mt-3 border border-rule bg-tag-blue px-4 py-3" aria-live="polite">
				<p className="text-sm font-medium text-ink">Integrity brief in progress</p>
				<p className="mt-0.5 text-xs text-slate">
					The agent is gathering evidence, drafting the brief, and validating citations. The
					deterministic signals below are already available.
				</p>
			</div>
		);
	}
	if (review.briefUnavailable === "stale" || review.briefStale === true) {
		return (
			<div className="mt-3 border border-rule bg-tag-amber px-4 py-3">
				<p className="text-sm font-medium text-warning-ink">Brief stale - re-running</p>
				<p className="mt-0.5 text-xs text-warning-ink">
					The evidence changed after this brief was written. Signals below still apply.
				</p>
				<Button type="button" variant="outline" size="sm" onClick={onRetry} className="mt-2">
					Retry brief
				</Button>
			</div>
		);
	}
	if (review.briefUnavailable === "failed") {
		return (
			<div className="mt-3 border border-rule bg-tag-red px-4 py-3">
				<p className="text-sm font-medium text-danger-ink">Brief unavailable</p>
				<p className="mt-0.5 text-xs text-danger-ink">
					The agent failed or timed out. The review stays open; resolve manually or retry.
				</p>
				<Button type="button" variant="outline" size="sm" onClick={onRetry} className="mt-2">
					Retry brief
				</Button>
			</div>
		);
	}
	if (!review.brief) {
		return <p className="mt-2 text-sm text-slate">No brief for this review.</p>;
	}
	const content = asBriefContent(review.brief.content);
	if (!content) {
		return <p className="mt-2 text-sm text-slate">Brief unavailable.</p>;
	}
	return (
		<div className="mt-2 space-y-4">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="text-base font-light text-ink">{clean(content.title || review.brief.id)}</h3>
				<p className="text-xs text-slate">
					<StatusBadge status={review.brief.status} /> ·{" "}
					<span className="tabular">{clean(review.brief.model)}</span> ·{" "}
					<span className="tabular">{clean(review.brief.promptVersion)}</span> ·{" "}
					{formatDateTime(review.brief.createdAt)}
				</p>
			</div>
			{content.summary.text !== "" && (
				<section aria-label="Summary">
					<h4 className="text-sm font-medium text-ink">Summary</h4>
					<div className="mt-1">
						<ClaimBlock claim={content.summary} />
					</div>
				</section>
			)}
			{content.candidateContradictions.length > 0 && (
				<section aria-label="Candidate contradictions">
					<h4 className="text-sm font-medium text-ink">Candidate contradictions</h4>
					<ul className="mt-1 space-y-2">
						{content.candidateContradictions.map((claim, i) => (
							<li key={i}>
								<ClaimBlock claim={claim} />
							</li>
						))}
					</ul>
				</section>
			)}
			{content.alternativeExplanations.length > 0 && (
				<section aria-label="Alternative explanations">
					<h4 className="text-sm font-medium text-ink">Alternative explanations</h4>
					<ul className="mt-1 space-y-2">
						{content.alternativeExplanations.map((claim, i) => (
							<li key={i}>
								<ClaimBlock claim={claim} />
							</li>
						))}
					</ul>
				</section>
			)}
			{content.missingEvidence.length > 0 && (
				<section aria-label="Missing evidence">
					<h4 className="text-sm font-medium text-ink">Missing evidence</h4>
					<ul className="mt-1 list-disc pl-5 text-sm text-ink">
						{content.missingEvidence.map((m, i) => (
							<li key={i}>
								{clean(m.text)}{" "}
								<span className="text-xs text-slate tabular">[{clean(m.code)}]</span>
								{m.sourceRef && (
									<span className="text-xs text-slate tabular"> {clean(m.sourceRef)}</span>
								)}
							</li>
						))}
					</ul>
				</section>
			)}
			{content.questionsForReviewer.length > 0 && (
				<section aria-label="Questions for reviewer">
					<h4 className="text-sm font-medium text-ink">Questions for reviewer</h4>
					<ul className="mt-1 list-disc pl-5 text-sm text-ink">
						{content.questionsForReviewer.map((q) => (
							<li key={q}>{clean(q)}</li>
						))}
					</ul>
				</section>
			)}
			<p className="text-xs text-slate">
				Suggested priority: <StatusBadge status={content.suggestedPriority} />
			</p>
		</div>
	);
}

function ResolveForm({ review }: { review: FraudReview }) {
	const queryClient = useQueryClient();
	const [status, setStatus] = useState<"cleared" | "confirmed" | "needs_info">("cleared");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState<"draft" | "resolve" | null>(null);
	const [error, setError] = useState("");

	async function draft() {
		setBusy("draft");
		setError("");
		try {
			const res = await fetchResolutionDraft(review.id);
			setNote(res.note);
		} catch (err) {
			setError(friendlyMessage(err));
		} finally {
			setBusy(null);
		}
	}

	async function resolve() {
		setBusy("resolve");
		setError("");
		try {
			await resolveFraudReview(review.id, {
				status,
				note: note.trim(),
				expectedVersion: review.version,
			});
			void queryClient.invalidateQueries({ queryKey: ["fraud-review", review.id] });
			void queryClient.invalidateQueries({ queryKey: ["fraud-queue"] });
		} catch (err) {
			setError(friendlyMessage(err));
		} finally {
			setBusy(null);
		}
	}

	const terminal = review.status === "cleared" || review.status === "confirmed";

	return (
		<Panel title="Resolve" tone="cream" className="mt-6" outline>
			{terminal ? (
				<p className="text-sm text-slate">
					Resolved{review.resolvedAt ? ` · ${formatDateTime(review.resolvedAt)}` : ""}
					{review.resolutionNote ? `: ${clean(review.resolutionNote)}.` : "."}
				</p>
			) : (
				<>
					<div className="grid gap-4 sm:grid-cols-2">
						<Field label="Outcome">
							<select
								id="field-outcome"
								value={status}
								onChange={(e) =>
									setStatus(e.target.value as "cleared" | "confirmed" | "needs_info")
								}
								className={inputCls}
							>
								<option value="cleared">cleared</option>
								<option value="confirmed">confirmed</option>
								<option value="needs_info">needs_info</option>
							</select>
						</Field>
					</div>
					<div className="mt-4">
						<Field label="Resolution note" hint="At least 10 characters.">
							<Textarea
								id="field-resolution-note"
								value={note}
								onChange={(e) => setNote(e.target.value)}
								rows={4}
							/>
						</Field>
					</div>
					{error && (
						<div className="mt-3">
							<ErrorBox message={error} />
						</div>
					)}
					<div className="mt-3 flex flex-wrap gap-2">
						<Button
							type="button"
							variant="outline"
							onClick={() => void draft()}
							disabled={busy !== null}
						>
							{busy === "draft" ? "Drafting…" : "Draft resolution note"}
						</Button>
						<Button
							type="button"
							onClick={() => void resolve()}
							disabled={busy !== null || note.trim().length < 10}
						>
							{busy === "resolve" ? "Resolving…" : "Resolve review"}
						</Button>
					</div>
				</>
			)}
		</Panel>
	);
}

function FraudDetail() {
	const { id } = Route.useParams();
	const queryClient = useQueryClient();
	const review = useQuery({
		queryKey: ["fraud-review", id],
		queryFn: () => fetchFraudReview(id),
		retry: false,
		refetchInterval: (query) => {
			const current = query.state.data?.review;
			if (!current) return false;
			if (current.briefState === "queued" || current.briefState === "running") return 3000;
			if (current.briefUnavailable === "pending" || current.briefUnavailable === "stale") {
				return 3000;
			}
			return false;
		},
	});

	return (
		<Page>
			<p className="mb-4">
				<Link to="/officer/fraud-review" className="text-sm text-red-link hover:underline">
					← Fraud review queue
				</Link>
			</p>
			{review.isPending ? (
				<Skeleton label="Loading fraud review" />
			) : review.isError ? (
				review.error instanceof ApiError && review.error.status === 404 ? (
					<EmptyState
						title="Review not found"
						action={
							<Link to="/officer/fraud-review" className="text-sm text-red-link hover:underline">
								Back to queue
							</Link>
						}
					/>
				) : (
					<ErrorBox message={friendlyMessage(review.error)} onRetry={() => void review.refetch()} />
				)
			) : (
				<ReviewBody
					review={review.data.review}
					onRefresh={() => void queryClient.invalidateQueries({ queryKey: ["fraud-review", id] })}
				/>
			)}
		</Page>
	);
}

function ReviewBody({ review, onRefresh }: { review: FraudReview; onRefresh: () => void }) {
	async function retryBrief(): Promise<void> {
		await retryIntegrityBrief(review.id);
		onRefresh();
	}

	return (
		<div className="space-y-8">
			<PageHead
				title="Fraud review"
				subtitle="Signal, not proof — the officer reads the evidence and records the decision."
				actions={
					<Button type="button" variant="outline" size="sm" onClick={onRefresh}>
						Refresh
					</Button>
				}
			/>
			<div className="flex flex-wrap items-center gap-2">
				<StatusBadge status={review.status} />
				<StatusBadge status={review.severity} />
				<CodeTag code={review.reasonCode} />
			</div>

			<Panel title="Case" outline>
				<dl className="grid gap-x-4 gap-y-1 text-sm text-slate sm:grid-cols-2">
					<div>
						<dt className="inline font-medium text-ink">Application: </dt>
						<dd className="inline">
							<Link
								to="/officer/review/$id"
								params={{ id: review.applicationId }}
								className="text-red-link hover:underline"
							>
								Open case file
							</Link>
						</dd>
					</div>
					<div>
						<dt className="inline font-medium text-ink">Version: </dt>
						<dd className="inline tabular">{review.version}</dd>
					</div>
					<div>
						<dt className="inline font-medium text-ink">Created: </dt>
						<dd className="inline tabular">{formatDateTime(review.createdAt)}</dd>
					</div>
					<div>
						<dt className="inline font-medium text-ink">Updated: </dt>
						<dd className="inline tabular">{formatDateTime(review.updatedAt)}</dd>
					</div>
				</dl>
			</Panel>

			{(review.signalCodes?.length ?? 0) > 0 && (
				<Panel title="Signals" tone="warm">
					<ul className="flex flex-wrap gap-2">
						{review.signalCodes?.map((code) => (
							<li key={code}>
								<CodeTag code={code} />
							</li>
						))}
					</ul>
				</Panel>
			)}
			{(review.documentRefs?.length ?? 0) > 0 && (
				<Panel title="Documents" tone="warm">
					<ul className="flex flex-wrap gap-2">
						{review.documentRefs?.map((ref) => (
							<li key={ref} title={ref}>
								<Tag tone="neutral">
									<span className="tabular">{ref.slice(0, 8)}</span>
								</Tag>
							</li>
						))}
					</ul>
				</Panel>
			)}
			{review.note !== null && review.note !== undefined && review.note !== "" && (
				<p className="text-base text-ink">{clean(review.note)}</p>
			)}

			<Panel title="Integrity brief" outline>
				<BriefSection review={review} onRetry={() => void retryBrief()} />
				{(review.model || review.agentVersion) && (
					<p className="mt-3 text-xs text-slate">
						Agent: <span className="tabular">{clean(review.model ?? "—")}</span> ·{" "}
						<span className="tabular">{clean(review.promptVersion ?? "—")}</span> ·{" "}
						<span className="tabular">{clean(review.agentVersion ?? "—")}</span>
					</p>
				)}
			</Panel>

			<ResolveForm review={review} />
			{review.status === "confirmed" && (
				<p>
					<Link
						to="/officer/review/$id"
						params={{ id: review.applicationId }}
						className="text-red-link hover:underline"
					>
						Open the case decision path
					</Link>
				</p>
			)}
			<SectionHead title="Signal, not proof" tight />
			<p className="max-w-2xl text-sm text-slate">
				Integrity signals mark evidence for a human to read. Nothing here establishes fraud.
			</p>
		</div>
	);
}
