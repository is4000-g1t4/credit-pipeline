// E2 document integrity panel (officer-only): per-document fingerprint and
// deterministic signals, officer-confirmed field candidates, consistency
// findings with fraud-review escalation, and the agent analysis trace.
// Hides itself while the feature flag is off (404); other errors surface
// via ErrorBox. Stored quotes and page text render as React text nodes
// (never dangerouslySetInnerHTML); bidi/zero-width controls are stripped
// in display; nothing document-derived reaches console, logs, or URLs.
import { codePointSlice } from "@credit/core/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	actOnIntegrityCandidate,
	escalateIntegrityConsistency,
	evaluateIntegrity,
	fetchDocumentPages,
	fetchIntegrityPanel,
	fetchIntegrityRun,
	flagIntegrity,
	formatDateTime,
	requestIntegrityAnalysis,
	type IntegrityCandidate,
	type IntegrityConsistency,
	type IntegrityDocumentPanel,
	type IntegrityFlagReason,
	type IntegritySeverity,
	type IntegritySignal,
} from "../lib/api";
import { Button } from "./ui/button";
import { clean, friendlyMessage, shortId } from "../lib/format";
import { TraceDetails } from "./trace-details";
import { Card, ErrorBox, StatusBadge } from "./ui";

function unknown(value: string | null | undefined): string {
	return value && value.length > 0 ? value : "unknown";
}

function SignalChips({ signals }: { signals: IntegritySignal[] }) {
	if (signals.length === 0) return <p className="text-xs text-slate">No signals.</p>;
	return (
		<ul className="flex flex-wrap gap-1.5">
			{signals.map((s, i) => (
				<li
					key={`${s.code}-${s.documentFileId ?? "case"}-${i}`}
					title={clean(s.summary)}
					className="flex items-center gap-1.5 rounded border border-rule bg-raised px-2 py-1 text-xs"
				>
					<StatusBadge status={s.severity} />
					<span className="font-mono">{clean(s.code)}</span>
					{s.count !== undefined && s.count > 1 && (
						<span className="tabular-nums text-slate">×{s.count}</span>
					)}
				</li>
			))}
		</ul>
	);
}

function SourceView({
	applicationId,
	fileId,
	pageNumber,
	offsetStart,
	offsetEnd,
}: {
	applicationId: string;
	fileId: string;
	pageNumber: number;
	offsetStart: number;
	offsetEnd: number;
}) {
	const pages = useQuery({
		queryKey: ["document-pages", applicationId, fileId],
		queryFn: () => fetchDocumentPages(applicationId, fileId),
		retry: false,
	});
	if (pages.isPending) return <p className="mt-1 text-xs text-slate">Loading source…</p>;
	if (pages.isError)
		return (
			<div className="mt-1">
				<ErrorBox message={friendlyMessage(pages.error)} onRetry={() => void pages.refetch()} />
			</div>
		);
	const page = pages.data.pages.find((p) => p.pageNumber === pageNumber);
	if (!page) return <p className="mt-1 text-xs text-slate">Page {pageNumber} is not available.</p>;
	// Window around the cited range; the highlight is located live from the
	// stored offsets (code points, never UTF-16) rather than trusting quotes.
	const from = Math.max(0, offsetStart - 400);
	const length = Array.from(page.text).length;
	const to = Math.min(length, offsetEnd + 400);
	const before = codePointSlice(page.text, from, offsetStart);
	const hit = codePointSlice(page.text, offsetStart, offsetEnd);
	const after = codePointSlice(page.text, offsetEnd, to);
	return (
		<div className="mt-1 rounded bg-raised p-2 text-xs" aria-live="polite">
			<p className="text-slate">
				Page {page.pageNumber} · {clean(page.source)}
				{from > 0 ? " · …" : ""}
			</p>
			<p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-ink">
				{clean(before)}
				<mark className="bg-tag-amber">{clean(hit)}</mark>
				{clean(after)}
				{to < length ? "…" : ""}
			</p>
		</div>
	);
}

function CandidateRow({
	applicationId,
	candidate,
	onChanged,
}: {
	applicationId: string;
	candidate: IntegrityCandidate;
	onChanged: () => void;
}) {
	const [sourceOpen, setSourceOpen] = useState(false);
	const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
	const [error, setError] = useState("");
	const active = candidate.status === "candidate" || candidate.status === "validated";

	async function act(action: "confirm" | "reject") {
		setBusy(action);
		setError("");
		try {
			await actOnIntegrityCandidate(applicationId, candidate.id, action);
			onChanged();
		} catch (err) {
			setError(friendlyMessage(err));
		} finally {
			setBusy(null);
		}
	}

	return (
		<li className="rounded border border-rule p-2">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<StatusBadge status={candidate.status} />
				<span className="font-mono">{clean(candidate.field)}</span>
				{candidate.stale && (
					<span className="rounded bg-tag-amber px-1.5 py-0.5 text-xs text-warning-ink">
						stale — refresh
					</span>
				)}
			</div>
			<p className="mt-1 break-words text-sm text-ink">{clean(candidate.value)}</p>
			<p className="mt-0.5 text-xs text-slate">
				Page {candidate.pageNumber} · confidence {Number(candidate.confidence).toFixed(2)}
				{candidate.validationCodes.length > 0 && (
					<> · {candidate.validationCodes.map(clean).join(", ")}</>
				)}
				{candidate.confirmedAt && <> · decided {formatDateTime(candidate.confirmedAt)}</>}
			</p>
			{error && (
				<div className="mt-1">
					<ErrorBox message={error} />
				</div>
			)}
			<div className="mt-1.5 flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => setSourceOpen((v) => !v)}
					aria-expanded={sourceOpen}
				>
					{sourceOpen ? "Hide source" : "View source"}
				</Button>
				{active && (
					<>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void act("confirm")}
							disabled={busy !== null || candidate.stale}
							title={candidate.stale ? "The source changed — refresh first" : undefined}
						>
							{busy === "confirm" ? "Confirming…" : "Confirm"}
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void act("reject")}
							disabled={busy !== null}
						>
							{busy === "reject" ? "Rejecting…" : "Reject"}
						</Button>
					</>
				)}
			</div>
			{sourceOpen && (
				<SourceView
					applicationId={applicationId}
					fileId={candidate.documentFileId}
					pageNumber={candidate.pageNumber}
					offsetStart={candidate.offsetStart}
					offsetEnd={candidate.offsetEnd}
				/>
			)}
		</li>
	);
}

function ConsistencyItem({
	applicationId,
	item,
	onChanged,
}: {
	applicationId: string;
	item: IntegrityConsistency;
	onChanged: () => void;
}) {
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [escalatedId, setEscalatedId] = useState<string | null>(null);
	const canEscalate = item.findingState === "mismatch" && escalatedId === null;

	async function escalate() {
		setBusy(true);
		setError("");
		try {
			const result = await escalateIntegrityConsistency(
				applicationId,
				item.id,
				note.trim() === "" ? undefined : note.trim(),
			);
			setEscalatedId(result.review.id);
			onChanged();
		} catch (err) {
			setError(friendlyMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<li className="rounded border border-rule p-2">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<StatusBadge status={item.findingState} />
				<span className="font-mono">{clean(item.field)}</span>
				<StatusBadge status={item.severity} />
				<span className="text-xs text-slate">proposed: {item.proposedKind}</span>
			</div>
			<dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-slate sm:grid-cols-2">
				<div>
					<dt className="inline font-medium">Left ({clean(item.left.label)}): </dt>
					<dd className="inline break-words">{clean(item.left.value)}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Right ({clean(item.right.label)}): </dt>
					<dd className="inline break-words">{clean(item.right.value)}</dd>
				</div>
			</dl>
			<div className="mt-1 grid gap-2 sm:grid-cols-2">
				<blockquote className="border-l-2 border-rule-strong pl-2 text-xs text-slate italic">
					{clean(item.left.quote)}
				</blockquote>
				<blockquote className="border-l-2 border-rule-strong pl-2 text-xs text-slate italic">
					{clean(item.right.quote)}
				</blockquote>
			</div>
			{item.explanation && <p className="mt-1 text-xs text-slate">{clean(item.explanation)}</p>}
			<p className="mt-0.5 font-mono text-xs text-slate">{clean(item.reason)}</p>
			{error && (
				<div className="mt-1">
					<ErrorBox message={error} />
				</div>
			)}
			{escalatedId !== null ? (
				<p className="mt-1.5 text-xs">
					<Link
						to="/officer/fraud-review/$id"
						params={{ id: escalatedId }}
						className="text-red-link hover:underline"
					>
						Escalated — open fraud review
					</Link>
				</p>
			) : (
				canEscalate && (
					<div className="mt-1.5 flex flex-wrap items-center gap-2">
						<input
							type="text"
							value={note}
							onChange={(e) => setNote(e.target.value)}
							placeholder="Escalation note (optional, ≥5 chars)"
							aria-label="Escalation note"
							className="h-8 min-w-52 flex-1 rounded-sm border border-rule-strong bg-card px-2 text-xs text-ink"
						/>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void escalate()}
							disabled={busy}
						>
							{busy ? "Escalating…" : "Escalate to fraud review"}
						</Button>
					</div>
				)
			)}
		</li>
	);
}

function DocumentCard({
	applicationId,
	doc,
	onChanged,
}: {
	applicationId: string;
	doc: IntegrityDocumentPanel;
	onChanged: () => void;
}) {
	const fp = doc.fingerprint;
	return (
		<li className="rounded border border-rule p-3">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<StatusBadge status={doc.status} />
				<span className="font-medium">{clean(doc.kind)}</span>
				<span className="text-xs text-slate">OCR: {clean(doc.ocrStatus.replaceAll("_", " "))}</span>
				{doc.originalFilename && (
					<span className="text-xs text-slate">{clean(doc.originalFilename)}</span>
				)}
			</div>

			<div className="mt-2">
				<h4 className="text-xs font-semibold text-slate">
					Fingerprint <span className="font-normal text-slate">(signal, not proof)</span>
				</h4>
				{fp === null ? (
					<p className="mt-0.5 text-xs text-slate">No fingerprint yet.</p>
				) : (
					<dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-slate sm:grid-cols-2">
						<div>
							<dt className="inline font-medium">SHA-256: </dt>
							<dd className="inline font-mono" title={fp.sha256}>
								{fp.sha256.slice(0, 12)}…
							</dd>
						</div>
						<div>
							<dt className="inline font-medium">Size: </dt>
							<dd className="inline tabular-nums">{(fp.sizeBytes / 1024).toFixed(1)} KB</dd>
						</div>
						<div>
							<dt className="inline font-medium">Type: </dt>
							<dd className="inline font-mono">{clean(fp.mimeType)}</dd>
						</div>
						<div>
							<dt className="inline font-medium">Pages: </dt>
							<dd className="inline tabular-nums">{fp.pageCount}</dd>
						</div>
						<div>
							<dt className="inline font-medium">OCR confidence: </dt>
							<dd className="inline tabular-nums">
								{fp.ocrConfidence === null ? "—" : Number(fp.ocrConfidence).toFixed(2)}
							</dd>
						</div>
						<div>
							<dt className="inline font-medium">Metadata source: </dt>
							<dd className="inline font-mono">{clean(fp.metadataSource)}</dd>
						</div>
						<div>
							<dt className="inline font-medium">Producer: </dt>
							<dd className="inline">{clean(unknown(fp.producer))}</dd>
						</div>
						<div>
							<dt className="inline font-medium">Creator: </dt>
							<dd className="inline">{clean(unknown(fp.creator))}</dd>
						</div>
						<div>
							<dt className="inline font-medium">Created: </dt>
							<dd className="inline">{unknown(fp.metadataCreatedAt)}</dd>
						</div>
						<div>
							<dt className="inline font-medium">Modified: </dt>
							<dd className="inline">{unknown(fp.metadataModifiedAt)}</dd>
						</div>
						<div>
							<dt className="inline font-medium">Edit signal: </dt>
							<dd className="inline font-mono">
								{clean(fp.editSignal)}
								{fp.editCodes.length > 0 && ` (${fp.editCodes.map(clean).join(", ")})`}
							</dd>
						</div>
						<div>
							<dt className="inline font-medium">Version: </dt>
							<dd className="inline font-mono">{clean(fp.fingerprintVersion)}</dd>
						</div>
					</dl>
				)}
			</div>

			<div className="mt-2">
				<h4 className="text-xs font-semibold text-slate">Signals</h4>
				<div className="mt-1">
					<SignalChips signals={doc.signals} />
				</div>
				<div className="mt-1 flex flex-wrap gap-2 text-xs text-slate">
					{doc.duplicateCount > 0 && (
						<span className="rounded bg-tag-amber px-1.5 py-0.5 text-warning-ink">
							{doc.duplicateCount} same-case duplicate{doc.duplicateCount === 1 ? "" : "s"}
						</span>
					)}
					{doc.crossApplicationRestricted && (
						<span
							className="rounded bg-warm px-1.5 py-0.5 text-slate"
							title="A cross-application match exists but is shown only to the assigned officer"
						>
							restricted cross-application match
						</span>
					)}
				</div>
			</div>

			{doc.candidates.length > 0 && (
				<div className="mt-2">
					<h4 className="text-xs font-semibold text-slate">Field candidates</h4>
					<ul className="mt-1 space-y-1.5">
						{doc.candidates.map((c) => (
							<CandidateRow
								key={c.id}
								applicationId={applicationId}
								candidate={c}
								onChanged={onChanged}
							/>
						))}
					</ul>
				</div>
			)}

			{doc.consistency.length > 0 && (
				<div className="mt-2">
					<h4 className="text-xs font-semibold text-slate">Consistency</h4>
					<ul className="mt-1 space-y-1.5">
						{doc.consistency.map((item) => (
							<ConsistencyItem
								key={item.id}
								applicationId={applicationId}
								item={item}
								onChanged={onChanged}
							/>
						))}
					</ul>
				</div>
			)}
		</li>
	);
}

const FLAG_REASONS: IntegrityFlagReason[] = [
	"document_integrity",
	"duplicate_document",
	"metadata_inconsistency",
	"other",
];

function FlagControls({
	applicationId,
	onChanged,
}: {
	applicationId: string;
	onChanged: () => void;
}) {
	const [reason, setReason] = useState<IntegrityFlagReason>("document_integrity");
	const [severity, setSeverity] = useState<IntegritySeverity>("medium");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState<"flag" | "evaluate" | null>(null);
	const [error, setError] = useState("");
	const [result, setResult] = useState<string | null>(null);
	const [reviewId, setReviewId] = useState<string | null>(null);

	async function flag() {
		setBusy("flag");
		setError("");
		setResult(null);
		setReviewId(null);
		try {
			const res = await flagIntegrity(applicationId, {
				reasonCode: reason,
				note: note.trim(),
				severity,
			});
			setReviewId(res.review.id);
			setResult(`Flagged for fraud review (reason: ${res.review.reasonCode}).`);
			onChanged();
		} catch (err) {
			setError(friendlyMessage(err));
		} finally {
			setBusy(null);
		}
	}

	async function evaluate() {
		setBusy("evaluate");
		setError("");
		setResult(null);
		setReviewId(null);
		try {
			const res = await evaluateIntegrity(applicationId);
			if (res.result.flagged) {
				setReviewId(res.result.reviewId);
				setResult(
					`Evaluation flagged the case${res.result.severity ? ` (${res.result.severity})` : ""}.`,
				);
			} else {
				setResult("Evaluation found nothing to flag.");
			}
			onChanged();
		} catch (err) {
			setError(friendlyMessage(err));
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="mt-3 rounded border border-rule p-3">
			<h4 className="text-sm font-semibold">Flag for fraud review</h4>
			<div className="mt-2 grid gap-2 sm:grid-cols-2">
				<div>
					<label
						htmlFor="integrity-flag-reason"
						className="mb-1 block text-xs font-medium text-slate"
					>
						Reason
					</label>
					<select
						id="integrity-flag-reason"
						value={reason}
						onChange={(e) => setReason(e.target.value as IntegrityFlagReason)}
						className="w-full rounded-sm border border-rule-strong bg-card px-2 py-1 text-sm text-ink"
					>
						{FLAG_REASONS.map((r) => (
							<option key={r} value={r}>
								{r}
							</option>
						))}
					</select>
				</div>
				<div>
					<label
						htmlFor="integrity-flag-severity"
						className="mb-1 block text-xs font-medium text-slate"
					>
						Severity
					</label>
					<select
						id="integrity-flag-severity"
						value={severity}
						onChange={(e) => setSeverity(e.target.value as IntegritySeverity)}
						className="w-full rounded-sm border border-rule-strong bg-card px-2 py-1 text-sm text-ink"
					>
						<option value="low">low</option>
						<option value="medium">medium</option>
						<option value="high">high</option>
					</select>
				</div>
			</div>
			<label
				htmlFor="integrity-flag-note"
				className="mt-2 mb-1 block text-xs font-medium text-slate"
			>
				Note (≥5 characters)
			</label>
			<textarea
				id="integrity-flag-note"
				value={note}
				onChange={(e) => setNote(e.target.value)}
				rows={2}
				className="w-full rounded border border-rule-strong px-2 py-1 text-sm"
			/>
			{error && (
				<div className="mt-2">
					<ErrorBox message={error} />
				</div>
			)}
			{result && (
				<p className="mt-2 text-sm text-slate" aria-live="polite">
					{result}{" "}
					{reviewId !== null && (
						<Link
							to="/officer/fraud-review/$id"
							params={{ id: reviewId }}
							className="text-red-link hover:underline"
						>
							Open fraud review
						</Link>
					)}
				</p>
			)}
			<div className="mt-2 flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void flag()}
					disabled={busy !== null || note.trim().length < 5}
				>
					{busy === "flag" ? "Flagging…" : "Flag for fraud review"}
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void evaluate()}
					disabled={busy !== null}
				>
					{busy === "evaluate" ? "Evaluating…" : "Re-evaluate signals"}
				</Button>
			</div>
		</div>
	);
}

export function IntegrityPanel({ applicationId }: { applicationId: string }) {
	const queryClient = useQueryClient();
	const [runId, setRunId] = useState<string | null>(null);
	const [analyseBusy, setAnalyseBusy] = useState(false);
	const [analyseError, setAnalyseError] = useState("");

	const panel = useQuery({
		queryKey: ["integrity", applicationId],
		queryFn: () => fetchIntegrityPanel(applicationId),
		retry: false,
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data?.openReview) return false;
			const status = data.latestAnalysis?.status;
			return status === "queued" || status === "running" ? 3000 : false;
		},
	});
	const liveRun = useQuery({
		queryKey: ["integrity-run", applicationId, runId],
		queryFn: () => fetchIntegrityRun(applicationId, runId ?? ""),
		enabled: runId !== null,
		retry: false,
		refetchInterval: (query) => {
			const status = query.state.data?.run.status;
			return status === "queued" || status === "running" ? 3000 : false;
		},
	});
	const invalidate = (): void => {
		void queryClient.invalidateQueries({ queryKey: ["integrity", applicationId] });
	};

	// A finished background run changes candidates/consistency — reload once.
	useEffect(() => {
		const status = liveRun.data?.run.status;
		if (runId !== null && status !== undefined && status !== "queued" && status !== "running") {
			invalidate();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [liveRun.data, runId]);

	// Feature off (or caller not assigned) → invisible. A 404 never reaches
	// panel.isError: fetchIntegrityPanel maps it to null data.
	if (panel.data === null) return null;

	async function analyse() {
		setAnalyseBusy(true);
		setAnalyseError("");
		try {
			const res = await requestIntegrityAnalysis(applicationId);
			setRunId(res.run.id);
			invalidate();
		} catch (err) {
			setAnalyseError(friendlyMessage(err));
		} finally {
			setAnalyseBusy(false);
		}
	}

	const data = panel.data;
	const live = liveRun.data?.run;
	const liveActive = live !== undefined && (live.status === "queued" || live.status === "running");

	return (
		<Card title="Document integrity">
			{panel.isPending ? (
				<p className="text-sm text-slate">Loading integrity…</p>
			) : panel.isError ? (
				<ErrorBox message={friendlyMessage(panel.error)} onRetry={() => void panel.refetch()} />
			) : data === null || data === undefined ? null : (
				<div>
					{data.openReview !== null && (
						<p className="mb-3 rounded-sm border border-warning bg-tag-amber px-3 py-2 text-sm text-warning-ink">
							Open fraud review ({clean(data.openReview.reasonCode)} ·{" "}
							{clean(data.openReview.status)}):{" "}
							<Link
								to="/officer/fraud-review/$id"
								params={{ id: data.openReview.id }}
								className="font-medium text-red-link hover:underline"
							>
								open review
							</Link>
							{data.latestAnalysis?.status === "queued" ||
							data.latestAnalysis?.status === "running" ? (
								<span aria-live="polite"> · Integrity brief in progress</span>
							) : data.latestAnalysis?.status === "failed" ? (
								<span> · Brief unavailable - retry from the review</span>
							) : null}
						</p>
					)}

					{data.caseSignals.length > 0 && (
						<div className="mb-3">
							<h3 className="text-sm font-semibold">Case signals</h3>
							<div className="mt-1">
								<SignalChips signals={data.caseSignals} />
							</div>
						</div>
					)}

					{data.documents.length === 0 ? (
						<p className="text-sm text-slate">No documents analysed yet.</p>
					) : (
						<ul className="space-y-2">
							{data.documents.map((doc) => (
								<DocumentCard
									key={doc.documentFileId}
									applicationId={applicationId}
									doc={doc}
									onChanged={invalidate}
								/>
							))}
						</ul>
					)}

					{data.latestAnalysis !== null && (
						<TraceDetails
							trace={{
								runId: data.latestAnalysis.id,
								runStatus: data.latestAnalysis.status,
								model: data.latestAnalysis.model,
								promptVersion: data.latestAnalysis.promptVersion,
								agentVersion: data.latestAnalysis.agentVersion,
								steps: data.latestAnalysis.steps,
								toolCalls: data.latestAnalysis.toolCalls,
								sourceRefs: data.latestAnalysis.sourceRefs,
								repairAttempted: data.latestAnalysis.repairAttempted,
								repairSucceeded: data.latestAnalysis.repairSucceeded,
								inputTokens: data.latestAnalysis.usage?.inputTokens,
								outputTokens: data.latestAnalysis.usage?.outputTokens,
								costUsd: data.latestAnalysis.usage?.costUsd,
								errorCode: data.latestAnalysis.errorCode,
							}}
						/>
					)}

					{analyseError && (
						<div className="mt-3">
							<ErrorBox message={analyseError} />
						</div>
					)}
					<div className="mt-3 flex flex-wrap items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void analyse()}
							disabled={analyseBusy || liveActive}
						>
							{analyseBusy ? "Requesting…" : liveActive ? "Analysis running…" : "Analyse documents"}
						</Button>
						{live !== undefined && (
							<span className="flex items-center gap-1.5 text-sm text-slate">
								Run {shortId(live.id)} <StatusBadge status={live.status} />
								{live.errorCode && (
									<span className="font-mono text-xs">({clean(live.errorCode)})</span>
								)}
							</span>
						)}
					</div>

					<FlagControls applicationId={applicationId} onChanged={invalidate} />
				</div>
			)}
		</Card>
	);
}
