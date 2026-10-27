// Advisory agent research panel (Phase 2, SPEC §5/§8): officer- or
// auto-triggered cited brief. Polls until terminal; records one view after
// success; accept/reject is append-only. Only `verified` findings render.
// The panel hides itself while the feature flag is off and explains
// consent/empty/error states. Auto runs show their trigger badge; when
// latest 404s the auto-audit endpoint surfaces skip reasons, and
// cross-officer reads render assigned-to-another-officer (never raw
// errors). It reports the accepted selection upward — the decision
// sends only the selection, never a browser-built bundle.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
	ApiError,
	apiErrorMessage,
	apiErrorWithCode,
	ensureResearch,
	fetchResearch,
	fetchResearchAudit,
	formatDateOnly,
	formatDateTime,
	retryResearchContext,
	reviewContextSignal,
	reviewResearchFinding,
	viewResearch,
	type PolicyReviewItem,
	type ResearchAggregate,
	type ResearchAuditEntry,
	type ResearchContext,
	type ResearchContextSignal,
	type ResearchEvidenceItem,
	type ResearchFindingItem,
	type ResearchPolicy,
	type ResearchSelection,
} from "../lib/api";
import { CitedSegments } from "./PolicyCitations";
import { shortId } from "../lib/format";
import { EmptyState, ErrorBox, Skeleton } from "./ui";

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** Visible host + interstitial: never auto-opens, non-http(s) renders inert. */
function SourceLink({ url }: { url: string }) {
	const [confirm, setConfirm] = useState(false);
	const host = hostOf(url);
	if (!/^https?:\/\//i.test(url)) return <span className="text-gray-500">{host}</span>;
	if (!confirm) {
		return (
			<button
				type="button"
				onClick={() => setConfirm(true)}
				className="text-sm text-blue-700 hover:underline"
			>
				Open source · {host}
			</button>
		);
	}
	return (
		<span className="text-sm">
			Leave to {host}?{" "}
			<a
				href={url}
				target="_blank"
				rel="noopener noreferrer"
				className="text-blue-700 hover:underline"
			>
				Open {host}
			</a>{" "}
			<button
				type="button"
				onClick={() => setConfirm(false)}
				className="text-gray-500 hover:underline"
			>
				Cancel
			</button>
		</span>
	);
}

function SourceCard({ evidence, support }: { evidence: ResearchEvidenceItem; support: string }) {
	return (
		<li className="rounded border border-gray-200 bg-gray-50 p-3">
			<p className="text-sm font-medium text-gray-800">{evidence.title || hostOf(evidence.url)}</p>
			<dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-gray-600 sm:grid-cols-2">
				<div>
					<dt className="inline font-medium">Publisher: </dt>
					<dd className="inline">{evidence.publisher}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Published: </dt>
					<dd className="inline">
						{evidence.publishedAt
							? `${formatDateOnly(evidence.publishedAt)} (${evidence.dateBasis ?? "unknown"})`
							: `undated (${evidence.dateBasis ?? "unknown"})`}
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Retrieved: </dt>
					<dd className="inline">{formatDateTime(evidence.retrievedAt)}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Tier: </dt>
					<dd className="inline">{evidence.sourceTier ?? "other"}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Support: </dt>
					<dd className="inline">{support}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Host: </dt>
					<dd className="inline break-all">{hostOf(evidence.finalUrl || evidence.url)}</dd>
				</div>
			</dl>
			<blockquote className="mt-2 border-l-2 border-gray-300 pl-2 text-sm text-gray-700 italic">
				“{evidence.quote}”
			</blockquote>
			<div className="mt-1">
				<SourceLink url={evidence.finalUrl || evidence.url} />
			</div>
		</li>
	);
}

function entityLabel(entityMatch: unknown): string {
	if (typeof entityMatch !== "object" || entityMatch === null) return "—";
	const m = entityMatch as Record<string, unknown>;
	const idType = typeof m.identifierType === "string" ? m.identifierType : "?";
	const value = typeof m.value === "string" ? m.value : "?";
	const conf = typeof m.confidence === "string" ? ` (${m.confidence})` : "";
	return `${idType}: ${value}${conf}`;
}

/** Machine skip reason → officer copy. Ids/codes only in, sentences out. */
function skipReasonLabel(reason: unknown): string {
	switch (reason) {
		case "consent_required":
			return "AI research consent was not given for this case.";
		case "not_pending":
			return "The case was not awaiting review when the referral fired.";
		case "application_not_found":
			return "The case was not found when the referral fired.";
		case "applicant_daily_cap":
			return "Automatic research reached the per-applicant daily limit.";
		case "global_daily_cap":
			return "Automatic research reached the daily limit.";
		case "daily_cost_budget":
			return "Automatic research reached the daily cost budget.";
		case "invalid_application_id":
			return "Automatic research skipped an invalid referral.";
		case "context_invalid":
			return "Automatic research could not read the case when the referral fired.";
		case "context_mismatch":
			return "Automatic research got case details for a different case and stopped.";
		case "invalid_applicant":
			return "Automatic research got an invalid applicant reference and stopped.";
		default:
			return typeof reason === "string" && reason.length > 0
				? `Automatic research skipped: ${reason}.`
				: "Automatic research did not run for this referral.";
	}
}

function auditActionLabel(action: string): string {
	switch (action) {
		case "auto.skip":
			return "Skipped";
		case "auto.ensure":
			return "Started automatically";
		case "auto.duplicate":
			return "Duplicate referral — reused the existing run";
		default:
			return action;
	}
}

/** Auto-trigger history: ids and codes only, never case facts or quotes. */
function AuditEntries({ entries }: { entries: ResearchAuditEntry[] }) {
	if (entries.length === 0) {
		return <p className="text-sm text-gray-600">No automatic-research history for this case.</p>;
	}
	return (
		<ul className="space-y-1.5">
			{entries.map((e) => {
				const meta =
					e.metadata !== null && typeof e.metadata === "object"
						? (e.metadata as Record<string, unknown>)
						: undefined;
				const reason = meta?.reason;
				const eventId = typeof meta?.triggerEventId === "string" ? meta.triggerEventId : null;
				return (
					<li
						key={`${e.action}-${e.createdAt}-${e.runId ?? "no-run"}-${eventId ?? "no-event"}`}
						className="text-sm text-gray-700"
					>
						{" "}
						<span className="font-medium">{auditActionLabel(e.action)}</span>
						{e.action === "auto.skip" && reason !== undefined
							? ` — ${skipReasonLabel(reason)}`
							: ""}
						{e.runId ? ` · run ${shortId(e.runId)}` : ""}{" "}
						<span className="text-xs text-gray-500">· {formatDateTime(e.createdAt)}</span>
					</li>
				);
			})}
		</ul>
	);
}

function FindingCard({
	applicationId,
	finding,
}: {
	applicationId: string;
	finding: ResearchFindingItem;
}) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState<"accepted" | "rejected" | null>(null);
	const [error, setError] = useState("");
	const status = finding.reviewStatus ?? "pending";

	async function review(action: "accepted" | "rejected") {
		setBusy(action);
		setError("");
		try {
			await reviewResearchFinding(applicationId, finding.id, action);
			await queryClient.invalidateQueries({ queryKey: ["research", applicationId] });
		} catch (err) {
			setError(apiErrorMessage(err));
		} finally {
			setBusy(null);
		}
	}

	return (
		<li className="rounded border border-gray-200 p-3">
			<p className="text-sm font-medium text-gray-900">{finding.claim}</p>
			<dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-600">
				<div>
					<dt className="inline font-medium">Category: </dt>
					<dd className="inline">{finding.category}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Allegation: </dt>
					<dd className="inline">{finding.allegationStatus ?? "unknown"}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Entity: </dt>
					<dd className="inline">{entityLabel(finding.entityMatch)}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Confidence: </dt>
					<dd className="inline">
						{finding.confidence ?? "?"}{" "}
						<details className="inline">
							<summary className="inline cursor-pointer text-blue-700 hover:underline">
								why?
							</summary>
							<p className="mt-1 max-w-full overflow-auto whitespace-pre-wrap break-words">
								{typeof finding.confidenceBasis === "string"
									? finding.confidenceBasis
									: JSON.stringify(finding.confidenceBasis ?? {}, null, 2)}
							</p>
						</details>
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Review: </dt>
					<dd className="inline" aria-live="polite">
						<span
							className={`rounded px-1.5 py-0.5 font-medium ${status === "accepted" ? "bg-green-100 text-green-800" : status === "rejected" ? "bg-gray-200 text-gray-700" : "bg-yellow-100 text-yellow-800"}`}
						>
							{status}
						</span>
					</dd>
				</div>
			</dl>
			{finding.whyItMatters && <p className="mt-1 text-sm text-gray-600">{finding.whyItMatters}</p>}
			{finding.evidence.length > 0 && (
				<ul className="mt-2 space-y-2">
					{finding.evidence.map((e) => (
						<SourceCard key={e.id} evidence={e} support={finding.support} />
					))}
				</ul>
			)}
			{error && (
				<div className="mt-2">
					<ErrorBox message={error} />
				</div>
			)}
			<div className="mt-2 flex gap-2">
				<button
					type="button"
					onClick={() => void review("accepted")}
					disabled={busy !== null}
					aria-label={`Accept finding: ${finding.claim}`}
					className="rounded border border-green-600 px-3 py-1 text-sm text-green-800 disabled:opacity-50"
				>
					{busy === "accepted" ? "Accepting…" : "Accept"}
				</button>
				<button
					type="button"
					onClick={() => void review("rejected")}
					disabled={busy !== null}
					aria-label={`Reject finding: ${finding.claim}`}
					className="rounded border border-gray-400 px-3 py-1 text-sm text-gray-700 disabled:opacity-50"
				>
					{busy === "rejected" ? "Rejecting…" : "Reject"}
				</button>
			</div>
		</li>
	);
}

// --- T18 internal context (SPEC-t17-t18 §3.6, D4). Renders `latest.context`
// after the external brief: stage status (not_run/pending/ready/failed/
// skipped — never implying "no anomalies"), the server-composed summary and
// claims, signals with evidence *ids* only, gaps/limitations, and the policy
// version. Per-signal accept/dismiss with an optional note is append-only.
// A failed stage shows the sanitized error code plus an officer Retry (202,
// then poll); no Retry when the case is decided or consent is off. Advisory
// only — no decision, chase, score, or status change. ---

function SignalEvidence({ signal }: { signal: ResearchContextSignal }) {
	const items = Array.isArray(signal.evidence) ? signal.evidence : [];
	if (items.length === 0) return <span className="text-gray-400">none listed</span>;
	return (
		<span>
			{items.map((e, i) => (
				<span key={`${e.kind ?? "?"}-${e.id ?? i}`}>
					{i > 0 ? "; " : ""}
					<span className="font-mono text-xs">
						{e.kind ?? "?"}:{typeof e.id === "string" ? e.id.slice(0, 8) : "?"}
					</span>
				</span>
			))}
		</span>
	);
}

function SignalCard({
	applicationId,
	signal,
}: {
	applicationId: string;
	signal: ResearchContextSignal;
}) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState<"accepted" | "rejected" | null>(null);
	const [note, setNote] = useState("");
	const [error, setError] = useState("");
	const status = signal.reviewStatus ?? "pending";

	async function review(action: "accepted" | "rejected") {
		setBusy(action);
		setError("");
		try {
			await reviewContextSignal(applicationId, signal.id, action, note.trim() || undefined);
			setNote("");
			await queryClient.invalidateQueries({ queryKey: ["research", applicationId] });
		} catch (err) {
			setError(apiErrorMessage(err));
		} finally {
			setBusy(null);
		}
	}

	return (
		<li className="rounded border border-gray-200 p-3">
			<p className="text-sm font-medium text-gray-900">
				{signal.type}{" "}
				<span className="font-normal text-gray-500">
					· {signal.metric} · observed {signal.observed ?? "—"} · expected {signal.expected ?? "—"}
				</span>
			</p>
			<dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-600">
				<div>
					<dt className="inline font-medium">Period: </dt>
					<dd className="inline">
						{signal.periodStart ?? "—"} → {signal.periodEnd ?? "—"}
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Confidence: </dt>
					<dd className="inline">{signal.confidence}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Signal: </dt>
					<dd className="inline">{signal.status}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Policy: </dt>
					<dd className="inline font-mono">{signal.policyVersion}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Scope: </dt>
					<dd className="inline font-mono">
						{signal.accountScope === "all" ? "all accounts" : signal.accountScope.slice(0, 8)}
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Evidence: </dt>
					<dd className="inline">
						<SignalEvidence signal={signal} />
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Review: </dt>
					<dd className="inline" aria-live="polite">
						<span
							className={`rounded px-1.5 py-0.5 font-medium ${status === "accepted" ? "bg-green-100 text-green-800" : status === "rejected" ? "bg-gray-200 text-gray-700" : "bg-yellow-100 text-yellow-800"}`}
						>
							{status}
						</span>
					</dd>
				</div>
			</dl>
			{signal.explanation && <p className="mt-1 text-sm text-gray-600">{signal.explanation}</p>}
			{error && (
				<div className="mt-2">
					<ErrorBox message={error} />
				</div>
			)}
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<label className="sr-only" htmlFor={`signal-note-${signal.id}`}>
					Note for signal {signal.type} (optional)
				</label>
				<input
					id={`signal-note-${signal.id}`}
					type="text"
					value={note}
					maxLength={1000}
					onChange={(e) => setNote(e.target.value)}
					placeholder="Note (optional)"
					className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
				/>
				<button
					type="button"
					onClick={() => void review("accepted")}
					disabled={busy !== null}
					aria-label={`Accept signal: ${signal.type}`}
					className="rounded border border-green-600 px-3 py-1 text-sm text-green-800 disabled:opacity-50"
				>
					{busy === "accepted" ? "Accepting…" : "Accept"}
				</button>
				<button
					type="button"
					onClick={() => void review("rejected")}
					disabled={busy !== null}
					aria-label={`Dismiss signal: ${signal.type}`}
					className="rounded border border-gray-400 px-3 py-1 text-sm text-gray-700 disabled:opacity-50"
				>
					{busy === "rejected" ? "Dismissing…" : "Dismiss"}
				</button>
			</div>
		</li>
	);
}

function ContextSection({
	applicationId,
	context,
	canRetry,
}: {
	applicationId: string;
	context: ResearchContext | null | undefined;
	canRetry: boolean;
}) {
	const queryClient = useQueryClient();
	const [retrying, setRetrying] = useState(false);
	const [retryError, setRetryError] = useState("");

	async function retry() {
		setRetrying(true);
		setRetryError("");
		try {
			// 202: the stage runs in the background; the poll above picks up
			// the new stage version. No long synchronous wait here.
			await retryResearchContext(applicationId);
			await queryClient.invalidateQueries({ queryKey: ["research", applicationId] });
		} catch (err) {
			setRetryError(apiErrorMessage(err));
		} finally {
			setRetrying(false);
		}
	}

	const claims = context?.brief?.claims ?? [];
	const gaps = context?.brief?.dataGaps ?? [];
	const limitations = context?.brief?.limitations ?? [];

	let body: React.ReactNode;
	switch (context?.status) {
		case "succeeded":
			body = (
				<div className="space-y-3">
					{context.brief?.summary ? (
						<p className="text-sm text-gray-800">{context.brief.summary}</p>
					) : (
						<p className="text-sm text-gray-600">No summary — nothing supported was found.</p>
					)}
					{claims.length > 0 && (
						<div>
							<h4 className="text-sm font-semibold">Claims</h4>
							<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
								{claims.map((claim) => (
									<li key={claim.text}>{claim.text}</li>
								))}
							</ul>
						</div>
					)}
					{context.signals.length === 0 ? (
						<p className="text-sm text-gray-600">
							No signals met the evidence bar — this is not an all-clear; see gaps below.
						</p>
					) : (
						<ul className="space-y-3">
							{context.signals.map((s) => (
								<SignalCard key={s.id} applicationId={applicationId} signal={s} />
							))}
						</ul>
					)}
					{gaps.length > 0 && (
						<div>
							<h4 className="text-sm font-semibold">Data gaps</h4>
							<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
								{gaps.map((g) => (
									<li key={g}>{g}</li>
								))}
							</ul>
						</div>
					)}
					{limitations.length > 0 && (
						<div>
							<h4 className="text-sm font-semibold">Limitations</h4>
							<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
								{limitations.map((l) => (
									<li key={l}>{l}</li>
								))}
							</ul>
						</div>
					)}
				</div>
			);
			break;
		case "failed":
			body = (
				<div className="space-y-3">
					<ErrorBox
						message={`Internal context ${context.errorCode ? `failed (${context.errorCode})` : "failed"}. The case remains fully decidable without it.`}
					/>
					{canRetry ? (
						<button
							type="button"
							onClick={() => void retry()}
							disabled={retrying}
							className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
						>
							{retrying ? "Retrying…" : "Retry internal context"}
						</button>
					) : (
						<p className="text-sm text-gray-600">
							Retry is unavailable — context analysis consent was not given or the case no longer
							awaits review.
						</p>
					)}
					{retryError && <ErrorBox message={retryError} />}
				</div>
			);
			break;
		case "queued":
		case "running":
			body = (
				<output className="block text-sm text-gray-600" aria-live="polite">
					Internal context is being analysed… This section updates automatically.
				</output>
			);
			break;
		case "skipped":
			body = (
				<p className="text-sm text-gray-600">
					Internal context was skipped — context analysis consent was not given or the stage is
					disabled. External research above is unaffected.
				</p>
			);
			break;
		default:
			body = (
				<p className="text-sm text-gray-600">
					Internal context did not run for this case. This is not an all-clear.
				</p>
			);
	}

	return (
		<section
			aria-label="Internal context"
			className="rounded-lg border border-gray-200 bg-gray-50 p-4 sm:p-5"
		>
			<h3 className="text-base font-semibold">Internal context</h3>
			<p className="mt-0.5 text-xs text-gray-500">
				Advisory only — evidence-backed cashflow and behaviour signals. It never decides the case,
				requests documents, or changes any status.
			</p>
			<div className="mt-3">{body}</div>
		</section>
	);
}

/** Sanitized follow-up: item ref + lead segment only (server-composed
 * policy text, no case facts or identifiers). Truncated for the URL. */
function followUpQuestion(item: PolicyReviewItem, summary?: string): string {
	const lead = item.explanationSegments[0]?.text ?? summary ?? "";
	return `${item.ref}: ${lead}`.slice(0, 300);
}

// --- Policy review (case-scoped advisory brief). Renders `latest.policy`
// after internal context: cited items with inline citation buttons opening
// the shared section drawer, plus an "Ask follow-up" link carrying a
// sanitized question to /officer/policies. Advisory only — no decision,
// chase, score, or status change. ---
function PolicyReviewSection({
	applicationId,
	policy,
}: {
	applicationId: string;
	policy?: ResearchPolicy | null;
}) {
	let body: React.ReactNode;
	switch (policy?.status) {
		case "succeeded": {
			const items = policy.brief?.items ?? [];
			const limitations = policy.brief?.limitations ?? [];
			body = (
				<div className="space-y-3">
					{policy.brief?.summary ? (
						<p className="text-sm text-gray-800">{policy.brief.summary}</p>
					) : (
						items.length === 0 && (
							<p className="text-sm text-gray-600">No summary — nothing supported was found.</p>
						)
					)}
					{items.length === 0 ? (
						<p className="text-sm text-gray-600">
							No policy items met the citation bar — this is not an all-clear.
						</p>
					) : (
						<ul className="space-y-3">
							{items.map((item) => (
								<li key={item.ref} className="rounded border border-gray-200 bg-white p-3">
									<p className="text-sm font-medium text-gray-900">
										<span className="font-mono text-xs">{item.ref}</span>{" "}
										<span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800">
											{item.confidence} confidence
										</span>
									</p>
									<div className="mt-1">
										<CitedSegments segments={item.explanationSegments} citations={item.citations} />
									</div>
									<Link
										to="/officer/policies"
										search={{ question: followUpQuestion(item, policy.brief?.summary) }}
										className="mt-1 inline-block text-sm text-blue-700 hover:underline"
									>
										Ask follow-up
									</Link>
								</li>
							))}
						</ul>
					)}
					{limitations.length > 0 && (
						<div>
							<h4 className="text-sm font-semibold">Limitations</h4>
							<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
								{limitations.map((l) => (
									<li key={l}>{l}</li>
								))}
							</ul>
						</div>
					)}
				</div>
			);
			break;
		}
		case "failed":
			body = (
				<ErrorBox
					message={`Policy review ${policy.errorCode ? `failed (${policy.errorCode})` : "failed"}. The case remains fully decidable without it.`}
				/>
			);
			break;
		case "running":
			body = (
				<output className="block text-sm text-gray-600" aria-live="polite">
					Policy review is running… This section updates automatically.
				</output>
			);
			break;
		case "no_match":
			body = (
				<p className="text-sm text-gray-600">
					No matching policy section found for this case — this is not an all-clear.
				</p>
			);
			break;
		case "needs_policy_owner":
			body = (
				<p className="text-sm text-gray-600">
					Policy review needs a policy owner to answer — escalate through the usual review route.
				</p>
			);
			break;
		case "budget_exceeded":
			body = (
				<p className="text-sm text-gray-600">
					Policy review hit its budget — the case remains fully decidable without it.
				</p>
			);
			break;
		case "skipped":
			body = (
				<p className="text-sm text-gray-600">
					Policy review was skipped — AI research consent was not given or the stage is disabled.
				</p>
			);
			break;
		case "not_applicable":
			body = <p className="text-sm text-gray-600">Policy review did not apply to this case.</p>;
			break;
		default:
			body = (
				<p className="text-sm text-gray-600">
					Policy review did not run for this case. This is not an all-clear.
				</p>
			);
	}

	return (
		<section
			aria-label="Policy review"
			className="rounded-lg border border-gray-200 bg-gray-50 p-4 sm:p-5"
		>
			<h3 className="text-base font-semibold">
				Policy review{" "}
				<span className="rounded bg-gray-200 px-1.5 py-0.5 align-middle text-xs font-medium text-gray-700">
					Advisory only
				</span>
			</h3>
			<p className="mt-0.5 text-xs text-gray-500">
				Advisory only — cited credit-policy sections for context. It never decides the case.
			</p>
			<div className="mt-3">{body}</div>
		</section>
	);
}

export function ResearchPanel({
	applicationId,
	caseStatus,
	aiResearchConsent,
	onSelectionChange,
}: {
	applicationId: string;
	/** Application status; Run is offered only while `pending_review`. */
	caseStatus?: string;
	/** Officer-visible consent flag; Run is hidden when consent is absent. */
	aiResearchConsent?: boolean | null;
	onSelectionChange: (selection: ResearchSelection | null) => void;
}) {
	const queryClient = useQueryClient();
	const viewedRun = useRef<string | null>(null);
	const [runError, setRunError] = useState("");
	const [running, setRunning] = useState(false);
	const [viewError, setViewError] = useState("");
	const [viewRetrying, setViewRetrying] = useState(false);
	const [auditOpen, setAuditOpen] = useState(false);

	const research = useQuery({
		queryKey: ["research", applicationId],
		queryFn: () => fetchResearch(applicationId),
		retry: false,
		// One poll covers the run and both stages: the context/policy stages
		// can still be active after the run itself settles.
		refetchInterval: (query) => {
			const latest = query.state.data;
			if (!latest) return false;
			if (latest.run.status === "queued" || latest.run.status === "running") return 2000;
			if (latest.context?.status === "queued" || latest.context?.status === "running") {
				return 2000;
			}
			if (latest.policy?.status === "running") return 2000;
			return false;
		},
	});

	const data: ResearchAggregate | undefined = research.data;
	const status = data?.run.status;
	const { refetch } = research;

	// Feature-disabled hides the panel (see below); the audit query stays
	// off there so a disabled deployment makes no research calls at all.
	const featureDisabled =
		research.isError &&
		research.error instanceof ApiError &&
		research.error.status === 404 &&
		research.error.code === "RESEARCH_DISABLED";

	// Auto-trigger audit: fetched automatically when latest fails (404 or
	// unavailable) so skip reasons surface, or on demand via the audit
	// <details> below. Read-only — it never starts a run.
	const audit = useQuery({
		queryKey: ["research-audit", applicationId],
		queryFn: () => fetchResearchAudit(applicationId),
		retry: false,
		enabled: !featureDisabled && (research.isError || auditOpen),
	});

	// Run is offered only for undecided, consented cases: a decided case or
	// a missing consent shows explanatory copy instead of the button.
	const consentMissing = aiResearchConsent === false;
	const caseDecided = caseStatus !== undefined && caseStatus !== "pending_review";
	const canRun = !consentMissing && !caseDecided;

	// Explicit view, once per run, after the panel has the succeeded brief.
	// The run is marked only after the view records: a failure leaves it
	// unmarked so a later refetch retries, and surfaces a bounded retry note.
	async function recordView(runId: string): Promise<void> {
		try {
			await viewResearch(applicationId, runId);
			viewedRun.current = runId;
			setViewError("");
		} catch {
			// Best-effort audit; the brief already renders. No automatic
			// retry is claimed — the officer retries explicitly, or a
			// refetch re-attempts once per fresh aggregate.
			setViewError("Research view was not recorded; refresh to retry.");
		}
	}

	useEffect(() => {
		if (status === "succeeded" && data && viewedRun.current !== data.run.id) {
			void recordView(data.run.id);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [status, data, applicationId]);

	async function retryView(): Promise<void> {
		if (!data || status !== "succeeded") return;
		setViewRetrying(true);
		try {
			await recordView(data.run.id);
		} finally {
			setViewRetrying(false);
		}
	}

	// Accepted (verified-only) findings feed the decision selection.
	useEffect(() => {
		if (!data || status !== "succeeded") {
			onSelectionChange(null);
			return;
		}
		const accepted = (data.findings ?? [])
			.filter((f) => f.support === "verified" && (f.reviewStatus ?? "pending") === "accepted")
			.map((f) => f.id);
		onSelectionChange(
			accepted.length > 0 ? { agentRunId: data.run.id, acceptedFindingIds: accepted } : null,
		);
	}, [data, status, onSelectionChange]);

	// Latest raced an auto run: the audit already records an ensured run
	// while latest still 404s — re-read once (bounded: only while latest
	// errors) so the auto run appears without the officer clicking Run.
	// Read-only: this never starts an officer run.
	const auditRunIds = (audit.data?.entries ?? [])
		.map((e) => e.runId)
		.filter((id): id is string => id !== null)
		.join(",");
	const autoRecovered = useRef<string | null>(null);
	useEffect(() => {
		if (research.isError && auditRunIds && autoRecovered.current !== auditRunIds) {
			autoRecovered.current = auditRunIds;
			void refetch();
		}
	}, [research.isError, auditRunIds, refetch]);

	async function run() {
		setRunning(true);
		setRunError("");
		try {
			await ensureResearch(applicationId);
			await queryClient.invalidateQueries({ queryKey: ["research", applicationId] });
		} catch (err) {
			setRunError(apiErrorWithCode(err));
		} finally {
			setRunning(false);
		}
	}

	// Feature disabled → hidden (SPEC AC-1). Applicants never reach here (403
	// at the gateway), so any other 404 means "no run yet".
	if (featureDisabled) {
		return null;
	}

	// A 403 consent error from any research call also hides Run: the case
	// props already say so, but the server is authoritative mid-flight.
	const consentBlocked =
		(research.isError &&
			research.error instanceof ApiError &&
			research.error.status === 403 &&
			research.error.code === "CONSENT_REQUIRED") ||
		runError.startsWith("CONSENT_REQUIRED:");
	const runAllowed = canRun && !consentBlocked;

	return (
		<section
			aria-label="Agent research"
			className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
		>
			<h2 className="text-base font-semibold">Agent research brief</h2>
			<p className="mt-0.5 text-xs text-gray-500">
				Advisory only — cited public sources for context. It never decides the case.
			</p>

			{research.isPending ? (
				<div className="mt-3">
					<Skeleton label="Loading research" />
				</div>
			) : research.isError ? (
				<div className="mt-3 space-y-3">
					{research.error instanceof ApiError && research.error.status === 404 ? (
						audit.isError && audit.error instanceof ApiError && audit.error.status === 404 ? (
							// Non-leaking: identical copy whether the case is
							// unknown or owned by another officer — never a raw
							// error, code, or id.
							<p className="mt-3 text-sm text-gray-600" aria-live="polite">
								Research is not available for this case — it may be assigned to another officer.
							</p>
						) : audit.data && audit.data.entries.length > 0 ? (
							<div className="space-y-3">
								<output className="block text-sm text-gray-600" aria-live="polite">
									No research run yet — automatic research did not start one.
								</output>
								<AuditEntries entries={audit.data.entries} />
								<div className="flex flex-wrap gap-2">
									{runAllowed && (
										<button
											type="button"
											onClick={() => void run()}
											disabled={running}
											className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
										>
											{running ? "Starting…" : "Run research"}
										</button>
									)}
									<button
										type="button"
										onClick={() => void audit.refetch()}
										disabled={audit.isFetching}
										aria-label="Refresh automatic-research status"
										className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
									>
										{audit.isFetching ? "Refreshing…" : "Refresh status"}
									</button>
								</div>
							</div>
						) : audit.isPending || audit.isFetching ? (
							<p className="text-sm text-gray-600" aria-live="polite">
								Checking automatic-research status…
							</p>
						) : audit.isError ? (
							<div className="space-y-3">
								<ErrorBox
									message={apiErrorMessage(audit.error)}
									onRetry={() => void audit.refetch()}
								/>
								{!runAllowed ? (
									<p className="text-sm text-gray-600">
										{consentMissing
											? "Research is unavailable — AI research consent was not given for this case."
											: `This case is ${caseStatus} — research runs only while a case awaits review.`}
									</p>
								) : (
									<button
										type="button"
										onClick={() => void run()}
										disabled={running}
										className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
									>
										{running ? "Starting…" : "Run research"}
									</button>
								)}
							</div>
						) : !runAllowed ? (
							<p className="mt-3 text-sm text-gray-600">
								{consentMissing
									? "Research is unavailable — AI research consent was not given for this case."
									: `This case is ${caseStatus} — research runs only while a case awaits review.`}
							</p>
						) : (
							<EmptyState
								title="No research run yet"
								hint="Run an advisory brief on cited public sources."
								action={
									<button
										type="button"
										onClick={() => void run()}
										disabled={running}
										className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
									>
										{running ? "Starting…" : "Run research"}
									</button>
								}
							/>
						)
					) : (
						<div className="space-y-3">
							<ErrorBox
								message={apiErrorMessage(research.error)}
								onRetry={() => void research.refetch()}
							/>
							{audit.data && audit.data.entries.length > 0 && (
								<div>
									<h3 className="text-sm font-semibold">Auto-trigger status</h3>
									<div className="mt-1">
										<AuditEntries entries={audit.data.entries} />
									</div>
								</div>
							)}
							{audit.isError &&
								!(audit.error instanceof ApiError && audit.error.status === 404) && (
									<ErrorBox
										message={apiErrorMessage(audit.error)}
										onRetry={() => void audit.refetch()}
									/>
								)}
						</div>
					)}
					{runError && <ErrorBox message={runError} />}
				</div>
			) : status === "queued" || status === "running" ? (
				<div className="mt-3">
					<output className="block text-sm text-gray-600" aria-live="polite">
						Research {status}… checking cited public sources. This panel updates automatically.
					</output>
					{data?.run.trigger === "auto" && (
						<p className="mt-1 text-xs text-gray-500">
							<span className="rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-800">
								auto
							</span>{" "}
							Started automatically on referral.
						</p>
					)}
				</div>
			) : status === "failed" ? (
				<div className="mt-3 space-y-3">
					<ErrorBox
						message={`Research ${data?.run.errorCode ? `failed (${data.run.errorCode})` : "failed"}. The case remains fully decidable without it.`}
					/>
					{runAllowed ? (
						<button
							type="button"
							onClick={() => void run()}
							disabled={running}
							className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
						>
							{running ? "Retrying…" : "Retry research"}
						</button>
					) : (
						<p className="text-sm text-gray-600">
							{consentMissing || consentBlocked
								? "Research is unavailable — AI research consent was not given for this case."
								: `This case is ${caseStatus} — research runs only while a case awaits review.`}
						</p>
					)}
					{runError && <ErrorBox message={runError} />}
					{/* External failure never hides a persisted context stage. */}
					<ContextSection
						applicationId={applicationId}
						context={data?.context}
						canRetry={runAllowed}
					/>
					<PolicyReviewSection applicationId={applicationId} policy={data?.policy} />
				</div>
			) : (
				<div className="mt-3 space-y-4">
					{data?.brief?.summary ? (
						<p className="text-sm text-gray-800">{data.brief.summary}</p>
					) : (
						<p className="text-sm text-gray-600">No summary — nothing supported was found.</p>
					)}

					{(() => {
						const verified = (data?.findings ?? []).filter((f) => f.support === "verified");
						return verified.length === 0 ? (
							<EmptyState
								title="No supported findings"
								hint={`Checked ${data?.usage?.searches ?? 0} searches across public sources; nothing met the citation bar.`}
							/>
						) : (
							<ul className="space-y-3">
								{verified.map((f) => (
									<FindingCard key={f.id} applicationId={applicationId} finding={f} />
								))}
							</ul>
						);
					})()}

					{(data?.brief?.contradictions?.length ?? 0) > 0 && (
						<div>
							<h3 className="text-sm font-semibold">Contradictions</h3>
							<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
								{data?.brief?.contradictions?.map((c) => (
									<li key={c.description}>{c.description}</li>
								))}
							</ul>
						</div>
					)}
					{(data?.brief?.unknowns?.length ?? 0) > 0 && (
						<div>
							<h3 className="text-sm font-semibold">Unknowns</h3>
							<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
								{data?.brief?.unknowns?.map((u) => (
									<li key={u}>{u}</li>
								))}
							</ul>
						</div>
					)}
					{(data?.brief?.questionsForOfficer?.length ?? 0) > 0 && (
						<div>
							<h3 className="text-sm font-semibold">Questions for the officer</h3>
							<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
								{data?.brief?.questionsForOfficer?.map((q) => (
									<li key={q}>{q}</li>
								))}
							</ul>
						</div>
					)}

					{/* Internal context (T18) rides the same run, after the external brief. */}
					<ContextSection
						applicationId={applicationId}
						context={data?.context}
						canRetry={runAllowed}
					/>
					<PolicyReviewSection applicationId={applicationId} policy={data?.policy} />

					<p className="text-xs text-gray-500">
						What was searched: {data?.usage?.searches ?? 0} queries · {data?.usage?.extracts ?? 0}{" "}
						sources read · model {data?.run.model ?? "?"} · as of {formatDateOnly(data?.run.asOf)} ·
						run {shortId(data?.run.id ?? "")}
						{data?.run.observability === "degraded" ? " · observability degraded" : ""}.
					</p>
					<p className="text-xs text-gray-500" aria-live="polite">
						{data?.run.trigger === "auto" ? (
							<span>
								<span className="rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-800">
									auto
								</span>{" "}
								Started automatically on referral · requested by{" "}
								{data?.run.requestedByRole ?? "service"}.
							</span>
						) : (
							<span>
								Started by an officer
								{data?.run.requestedByRole ? ` · requested by ${data.run.requestedByRole}` : ""}.
							</span>
						)}
					</p>
					<details
						onToggle={(e) => {
							if (e.currentTarget.open) setAuditOpen(true);
						}}
					>
						<summary className="cursor-pointer text-sm text-blue-700 hover:underline">
							View auto-trigger audit
						</summary>
						<div className="mt-2 space-y-2">
							{audit.isPending || audit.isFetching ? (
								<p className="text-sm text-gray-600">Loading automatic-research status…</p>
							) : audit.isError ? (
								<ErrorBox
									message={apiErrorMessage(audit.error)}
									onRetry={() => void audit.refetch()}
								/>
							) : (
								<>
									<AuditEntries entries={audit.data?.entries ?? []} />
									<button
										type="button"
										onClick={() => void audit.refetch()}
										disabled={audit.isFetching}
										aria-label="Refresh automatic-research status"
										className="text-sm text-blue-700 hover:underline disabled:opacity-50"
									>
										{audit.isFetching ? "Refreshing…" : "Refresh status"}
									</button>
								</>
							)}
						</div>
					</details>
					{viewError && (
						<p className="text-xs text-gray-500">
							{viewError}{" "}
							<button
								type="button"
								onClick={() => void retryView()}
								disabled={viewRetrying}
								className="text-blue-700 hover:underline disabled:opacity-50"
							>
								{viewRetrying ? "Retrying…" : "Retry now"}
							</button>
						</p>
					)}
				</div>
			)}
		</section>
	);
}
