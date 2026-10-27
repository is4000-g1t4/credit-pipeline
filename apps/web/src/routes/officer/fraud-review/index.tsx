// EN-05 fraud-review queue (officer-only): open reviews with brief state,
// plus a case-scoped duplicate-hash lookup with per-case explanations.
// Hides itself while the flag is off (404); applicant access is blocked by
// RequireAuth. Nothing case-derived reaches console, logs, or URLs.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
	EmptyState,
	ErrorBox,
	Page,
	PageHead,
	Panel,
	SectionHead,
	Skeleton,
	StatusBadge,
	inputCls,
} from "../../../components/ubs";
import {
	ApiError,
	explainDuplicateDocument,
	formatDateTime,
	lookupDuplicateDocuments,
	fetchFraudQueue,
	type DuplicateLookupResult,
} from "../../../lib/api";
import { RequireAuth } from "../../../lib/auth";
import { clean, friendlyMessage } from "../../../lib/format";

export const Route = createFileRoute("/officer/fraud-review/")({
	component: () => (
		<RequireAuth allow="officer">
			<FraudQueue />
		</RequireAuth>
	),
});

function DuplicateLookup() {
	const [sha256, setSha256] = useState("");
	const [applicationId, setApplicationId] = useState("");
	const [result, setResult] = useState<DuplicateLookupResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [note, setNote] = useState("");
	const [explaining, setExplaining] = useState(false);
	const [explained, setExplained] = useState(false);

	const shaValid = /^[a-f0-9]{64}$/i.test(sha256.trim());
	const appId = applicationId.trim();

	async function lookup() {
		setBusy(true);
		setError("");
		setExplained(false);
		try {
			const res = await lookupDuplicateDocuments({
				sha256: sha256.trim(),
				applicationId: appId,
			});
			setResult(res);
		} catch (err) {
			setResult(null);
			setError(friendlyMessage(err));
		} finally {
			setBusy(false);
		}
	}

	async function explain() {
		if (result === null || appId === "") return;
		setExplaining(true);
		setError("");
		try {
			await explainDuplicateDocument({
				sha256: sha256.trim(),
				applicationId: appId,
				note: note.trim(),
			});
			setExplained(true);
		} catch (err) {
			setError(friendlyMessage(err));
		} finally {
			setExplaining(false);
		}
	}

	return (
		<section aria-label="Duplicate lookup">
			<SectionHead title="Duplicate lookup" tight />
			<p className="mb-4 text-sm text-slate">
				Hash-only: rows carry references and kinds, never document text or applicant details.
			</p>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor="dup-sha">SHA-256</Label>
					<input
						id="dup-sha"
						type="text"
						value={sha256}
						onChange={(e) => setSha256(e.target.value)}
						placeholder="64 hex characters"
						spellCheck={false}
						className={inputCls}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="dup-app">Application id (required for case-scoped counts)</Label>
					<input
						id="dup-app"
						type="text"
						value={applicationId}
						onChange={(e) => setApplicationId(e.target.value)}
						spellCheck={false}
						className={inputCls}
					/>
				</div>
			</div>
			{error && (
				<div className="mt-4">
					<ErrorBox message={error} />
				</div>
			)}
			<Button
				type="button"
				onClick={() => void lookup()}
				disabled={busy || !shaValid || appId === ""}
				className="mt-4"
			>
				{busy ? "Looking up…" : "Look up hash"}
			</Button>
			{result !== null && (
				<div className="mt-4" aria-live="polite">
					<p className="text-sm text-ink tabular">
						<span>{clean(result.sha256Prefix)}…</span> · {result.count} match
						{result.count === 1 ? "" : "es"}
						{result.counts !== null && (
							<span className="text-slate">
								{" "}
								(same case: {result.counts.sameApplication} · same applicant:{" "}
								{result.counts.sameApplicantOther} · cross-applicant: {result.counts.crossApplicant}
								)
							</span>
						)}
					</p>
					{result.rows.length === 0 ? (
						<p className="mt-1 text-sm text-slate">No matching documents.</p>
					) : (
						<div className="mt-2 overflow-x-auto">
							<table className="w-full min-w-140 text-left text-sm">
								<thead>
									<tr className="border-b border-rule-illustrative">
										<th className="overline px-3 py-2">Application</th>
										<th className="overline px-3 py-2">Document</th>
										<th className="overline px-3 py-2">Kind</th>
										<th className="overline px-3 py-2">Uploaded</th>
										<th className="overline px-3 py-2">Note</th>
									</tr>
								</thead>
								<tbody>
									{result.rows.map((row) => (
										<tr
											key={row.documentFileId}
											className="border-b border-rule-illustrative last:border-0 hover:bg-raised"
										>
											<td className="px-3 py-2">{clean(row.applicationReference)}</td>
											<td className="px-3 py-2 text-xs tabular">
												{row.documentFileId.slice(0, 8)}
											</td>
											<td className="px-3 py-2">{clean(row.kind)}</td>
											<td className="px-3 py-2 tabular">{formatDateTime(row.uploadedAt)}</td>
											<td className="px-3 py-2 text-xs text-slate">
												{row.explanationNote ? clean(row.explanationNote) : "—"}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
					<Panel title="Attach explanation" tone="warm" className="mt-4">
						<p className="text-sm text-slate">
							Records a note against this hash for the application below.
						</p>
						<div className="mt-3 space-y-2">
							<Label htmlFor="dup-note">Note (≥5 characters)</Label>
							<Textarea
								id="dup-note"
								value={note}
								onChange={(e) => setNote(e.target.value)}
								rows={2}
							/>
						</div>
						{appId === "" && (
							<p className="mt-1 text-xs text-warning-ink">
								Enter an application id above to attach the note.
							</p>
						)}
						{explained && (
							<p className="mt-1 text-sm text-success-ink" aria-live="polite">
								Explanation recorded.
							</p>
						)}
						<Button
							type="button"
							variant="outline"
							onClick={() => void explain()}
							disabled={explaining || appId === "" || note.trim().length < 5}
							className="mt-3"
						>
							{explaining ? "Recording…" : "Explain duplicate"}
						</Button>
					</Panel>
				</div>
			)}
		</section>
	);
}

function FraudQueue() {
	const queryClient = useQueryClient();
	const queue = useQuery({
		queryKey: ["fraud-queue"],
		queryFn: fetchFraudQueue,
		refetchInterval: 5000,
		retry: false,
	});

	// Flag off → hide the whole page.
	if (queue.isError && queue.error instanceof ApiError && queue.error.status === 404) {
		return null;
	}

	return (
		<Page>
			<PageHead
				title="Fraud review"
				subtitle="Escalated integrity findings. A human decides whether the case returns to the queue."
				actions={
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void queryClient.invalidateQueries({ queryKey: ["fraud-queue"] })}
					>
						Refresh
					</Button>
				}
			/>
			{queue.isPending ? (
				<Skeleton label="Loading fraud reviews" />
			) : queue.isError ? (
				<ErrorBox message={friendlyMessage(queue.error)} onRetry={() => void queue.refetch()} />
			) : queue.data.items.length === 0 ? (
				<EmptyState
					title="No open fraud reviews"
					hint="Escalated integrity findings will appear here."
				/>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full min-w-190 text-left text-base">
						<thead>
							<tr className="border-b border-rule-illustrative">
								<th className="overline px-3 py-2">Case</th>
								<th className="overline px-3 py-2">Status</th>
								<th className="overline px-3 py-2">Severity</th>
								<th className="overline px-3 py-2">Reason</th>
								<th className="overline px-3 py-2">Brief</th>
								<th className="overline px-3 py-2 text-right">Created</th>
							</tr>
						</thead>
						<tbody>
							{queue.data.items.map((item) => (
								<tr
									key={item.id}
									className="border-b border-rule-illustrative last:border-0 hover:bg-raised"
								>
									<td className="px-3 py-3">
										<Link
											to="/officer/fraud-review/$id"
											params={{ id: item.id }}
											className="text-red-link hover:underline"
										>
											{clean(item.applicationReference)}
										</Link>
									</td>
									<td className="px-3 py-3">
										<StatusBadge status={item.status} />
									</td>
									<td className="px-3 py-3">
										<StatusBadge status={item.severity} />
									</td>
									<td className="px-3 py-3 text-xs text-slate tabular">{clean(item.reasonCode)}</td>
									<td className="px-3 py-3">
										<StatusBadge status={item.briefState} />
									</td>
									<td className="px-3 py-3 text-right text-sm text-slate tabular">
										{formatDateTime(item.createdAt)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			<div className="mt-12">
				<DuplicateLookup />
			</div>
		</Page>
	);
}
