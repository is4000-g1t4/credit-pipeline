// EN-05 fraud-review detail (assigned officer only). The assigned officer sees
// signals, document refs, and the advisory brief; there is no separate reviewer
// user. Stored quotes render as text nodes (never dangerouslySetInnerHTML);
// nothing case-derived reaches console, logs, or URLs.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
	EmptyState,
	ErrorBox,
	Field,
	Page,
	Skeleton,
	StatusBadge,
	inputCls,
} from "../../../components/ui";
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
		<li className="rounded border border-gray-200 bg-gray-50 px-2 py-1">
			<p className="font-mono text-xs text-gray-700" title={clean(citation.ref)}>
				{clean(citation.ref)}
			</p>
			<blockquote className="mt-0.5 border-l-2 border-gray-300 pl-2 text-xs text-gray-600 italic">
				“{clean(citation.quote)}”
			</blockquote>
		</li>
	);
}

function ClaimBlock({ claim }: { claim: FraudBriefClaim }) {
	return (
		<div className="text-sm text-gray-800">
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
			<div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3" aria-live="polite">
				<p className="text-sm font-medium text-blue-900">Integrity brief in progress</p>
				<p className="mt-0.5 text-xs text-blue-800">
					The agent is gathering evidence, drafting the brief, and validating citations. The
					deterministic signals below are already available.
				</p>
			</div>
		);
	}
	if (review.briefUnavailable === "stale" || review.briefStale === true) {
		return (
			<div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3">
				<p className="text-sm font-medium text-amber-900">Brief stale - re-running</p>
				<p className="mt-0.5 text-xs text-amber-800">
					The evidence changed after this brief was written. Signals below still apply.
				</p>
				<button
					type="button"
					onClick={onRetry}
					className="mt-2 rounded border border-amber-400 px-3 py-1 text-xs text-amber-900"
				>
					Retry brief
				</button>
			</div>
		);
	}
	if (review.briefUnavailable === "failed") {
		return (
			<div className="mt-3 rounded border border-red-200 bg-red-50 p-3">
				<p className="text-sm font-medium text-red-900">Brief unavailable</p>
				<p className="mt-0.5 text-xs text-red-800">
					The agent failed or timed out. The review stays open; resolve manually or retry.
				</p>
				<button
					type="button"
					onClick={onRetry}
					className="mt-2 rounded border border-red-300 px-3 py-1 text-xs text-red-900"
				>
					Retry brief
				</button>
			</div>
		);
	}
	if (!review.brief) {
		return <p className="mt-2 text-sm text-gray-500">No brief for this review.</p>;
	}
	const content = asBriefContent(review.brief.content);
	if (!content) {
		return <p className="mt-2 text-sm text-gray-500">Brief unavailable.</p>;
	}
	return (
		<div className="mt-2 space-y-4">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="text-sm font-semibold">{clean(content.title || review.brief.id)}</h3>
				<p className="text-xs text-gray-500">
					<StatusBadge status={review.brief.status} /> ·{" "}
					<span className="font-mono">{clean(review.brief.model)}</span> ·{" "}
					<span className="font-mono">{clean(review.brief.promptVersion)}</span> ·{" "}
					{formatDateTime(review.brief.createdAt)}
				</p>
			</div>
			{content.summary.text !== "" && (
				<section aria-label="Summary">
					<h4 className="text-sm font-semibold">Summary</h4>
					<div className="mt-1">
						<ClaimBlock claim={content.summary} />
					</div>
				</section>
			)}
			{content.candidateContradictions.length > 0 && (
				<section aria-label="Candidate contradictions">
					<h4 className="text-sm font-semibold">Candidate contradictions</h4>
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
					<h4 className="text-sm font-semibold">Alternative explanations</h4>
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
					<h4 className="text-sm font-semibold">Missing evidence</h4>
					<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
						{content.missingEvidence.map((m, i) => (
							<li key={i}>
								{clean(m.text)}{" "}
								<span className="font-mono text-xs text-gray-500">[{clean(m.code)}]</span>
								{m.sourceRef && (
									<span className="font-mono text-xs text-gray-500"> {clean(m.sourceRef)}</span>
								)}
							</li>
						))}
					</ul>
				</section>
			)}
			{content.questionsForReviewer.length > 0 && (
				<section aria-label="Questions for reviewer">
					<h4 className="text-sm font-semibold">Questions for reviewer</h4>
					<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
						{content.questionsForReviewer.map((q) => (
							<li key={q}>{clean(q)}</li>
						))}
					</ul>
				</section>
			)}
			<p className="text-xs text-gray-500">
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
		<div className="mt-4 rounded border border-gray-200 p-3">
			<h3 className="text-sm font-semibold">Resolve</h3>
			{terminal ? (
				<p className="mt-1 text-sm text-gray-600">
					Resolved{review.resolvedAt ? ` · ${formatDateTime(review.resolvedAt)}` : ""}
					{review.resolutionNote ? `: ${clean(review.resolutionNote)}` : "."}
				</p>
			) : (
				<>
					<div className="mt-2 grid gap-3 sm:grid-cols-2">
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
					<div className="mt-3">
						<Field label="Resolution note (≥10 characters)">
							<textarea
								id="field-resolution-note-≥10-characters"
								value={note}
								onChange={(e) => setNote(e.target.value)}
								rows={4}
								className={inputCls}
							/>
						</Field>
					</div>
					{error && (
						<div className="mt-2">
							<ErrorBox message={error} />
						</div>
					)}
					<div className="mt-2 flex flex-wrap gap-2">
						<button
							type="button"
							onClick={() => void draft()}
							disabled={busy !== null}
							className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
						>
							{busy === "draft" ? "Drafting…" : "Draft resolution note"}
						</button>
						<button
							type="button"
							onClick={() => void resolve()}
							disabled={busy !== null || note.trim().length < 10}
							className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
						>
							{busy === "resolve" ? "Resolving…" : "Resolve review"}
						</button>
					</div>
				</>
			)}
		</div>
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
			<p className="mb-3">
				<Link to="/officer/fraud-review" className="text-sm text-blue-700 hover:underline">
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
							<Link to="/officer/fraud-review" className="text-sm text-blue-700 hover:underline">
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
		<div className="space-y-4">
			<section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
				<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
					<h1 className="text-base font-semibold">Fraud review</h1>
					<button
						type="button"
						onClick={onRefresh}
						className="rounded border border-gray-300 px-3 py-1 text-sm"
					>
						Refresh
					</button>
				</div>
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<StatusBadge status={review.status} />
					<StatusBadge status={review.severity} />
					<span className="font-mono text-xs text-gray-600">{clean(review.reasonCode)}</span>
				</div>
				<dl className="mt-2 grid gap-x-4 gap-y-0.5 text-xs text-gray-600 sm:grid-cols-2">
					<div>
						<dt className="inline font-medium">Application: </dt>
						<dd className="inline">
							<Link
								to="/officer/review/$id"
								params={{ id: review.applicationId }}
								className="font-mono text-blue-700 hover:underline"
							>
								case
							</Link>
						</dd>
					</div>
					<div>
						<dt className="inline font-medium">Version: </dt>
						<dd className="inline tabular-nums">{review.version}</dd>
					</div>
					<div>
						<dt className="inline font-medium">Created: </dt>
						<dd className="inline">{formatDateTime(review.createdAt)}</dd>
					</div>
					<div>
						<dt className="inline font-medium">Updated: </dt>
						<dd className="inline">{formatDateTime(review.updatedAt)}</dd>
					</div>
				</dl>

				{(review.signalCodes?.length ?? 0) > 0 && (
					<div className="mt-3">
						<h2 className="text-sm font-semibold">Signals</h2>
						<ul className="mt-1 flex flex-wrap gap-1.5">
							{review.signalCodes?.map((code) => (
								<li
									key={code}
									className="rounded border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-xs"
								>
									{clean(code)}
								</li>
							))}
						</ul>
					</div>
				)}
				{(review.documentRefs?.length ?? 0) > 0 && (
					<div className="mt-3">
						<h2 className="text-sm font-semibold">Documents</h2>
						<ul className="mt-1 flex flex-wrap gap-1.5">
							{review.documentRefs?.map((ref) => (
								<li
									key={ref}
									className="rounded border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-xs"
									title={ref}
								>
									{ref.slice(0, 8)}
								</li>
							))}
						</ul>
					</div>
				)}
				{review.note !== null && review.note !== undefined && review.note !== "" && (
					<p className="mt-3 text-sm text-gray-700">{clean(review.note)}</p>
				)}
				<BriefSection review={review} onRetry={() => void retryBrief()} />
				{(review.model || review.agentVersion) && (
					<p className="mt-3 text-xs text-gray-500">
						Agent: <span className="font-mono">{clean(review.model ?? "—")}</span> ·{" "}
						<span className="font-mono">{clean(review.promptVersion ?? "—")}</span> ·{" "}
						<span className="font-mono">{clean(review.agentVersion ?? "—")}</span>
					</p>
				)}
				<ResolveForm review={review} />
				{review.status === "confirmed" && (
					<p className="mt-3 text-sm">
						<Link
							to="/officer/review/$id"
							params={{ id: review.applicationId }}
							className="text-blue-700 hover:underline"
						>
							Open the case decision path
						</Link>
					</p>
				)}
			</section>
		</div>
	);
}
