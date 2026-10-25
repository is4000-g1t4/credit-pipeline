// EN-05 fraud-review queue (officer-only): open reviews with brief state,
// plus a reviewer-only duplicate-hash lookup with per-case explanations.
// Hides itself while the flag is off (404); applicant access is blocked by
// RequireAuth. Nothing case-derived reaches console, logs, or URLs.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState, ErrorBox, Page, Skeleton, StatusBadge } from "../../../components/ui";
import {
	ApiError,
	apiErrorMessage,
	explainDuplicateDocument,
	formatDateTime,
	lookupDuplicateDocuments,
	fetchFraudQueue,
	type DuplicateLookupResult,
} from "../../../lib/api";
import { RequireAuth } from "../../../lib/auth";

export const Route = createFileRoute("/officer/fraud-review/")({
	component: () => (
		<RequireAuth allow="officer">
			<FraudQueue />
		</RequireAuth>
	),
});

function clean(value: string): string {
	return value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "");
}

function friendlyMessage(err: unknown): string {
	if (err instanceof ApiError) {
		switch (err.code) {
			case "REVIEWER_REQUIRED":
				return "Fraud reviewer access is required for that action.";
			default:
				break;
		}
	}
	return apiErrorMessage(err);
}

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
			const res = await lookupDuplicateDocuments(
				appId === "" ? { sha256: sha256.trim() } : { sha256: sha256.trim(), applicationId: appId },
			);
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
		<section
			aria-label="Duplicate lookup"
			className="mt-6 rounded-lg border border-gray-200 bg-white p-4"
		>
			<h2 className="text-base font-semibold">Duplicate lookup</h2>
			<p className="mt-0.5 text-xs text-gray-500">
				Hash-only: rows carry references and kinds, never document text or applicant details.
			</p>
			<div className="mt-3 grid gap-3 sm:grid-cols-2">
				<div>
					<label htmlFor="dup-sha" className="mb-1 block text-sm font-medium text-gray-700">
						SHA-256
					</label>
					<input
						id="dup-sha"
						type="text"
						value={sha256}
						onChange={(e) => setSha256(e.target.value)}
						placeholder="64 hex characters"
						spellCheck={false}
						className="w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none"
					/>
				</div>
				<div>
					<label htmlFor="dup-app" className="mb-1 block text-sm font-medium text-gray-700">
						Application id (optional, adds counts)
					</label>
					<input
						id="dup-app"
						type="text"
						value={applicationId}
						onChange={(e) => setApplicationId(e.target.value)}
						spellCheck={false}
						className="w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none"
					/>
				</div>
			</div>
			{error && (
				<div className="mt-3">
					<ErrorBox message={error} />
				</div>
			)}
			<button
				type="button"
				onClick={() => void lookup()}
				disabled={busy || !shaValid}
				className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
			>
				{busy ? "Looking up…" : "Look up hash"}
			</button>
			{result !== null && (
				<div className="mt-3" aria-live="polite">
					<p className="text-sm text-gray-700">
						<span className="font-mono">{result.sha256Prefix}…</span> · {result.count} match
						{result.count === 1 ? "" : "es"}
						{result.counts !== null && (
							<span className="text-gray-500">
								{" "}
								(same case: {result.counts.sameApplication} · same applicant:{" "}
								{result.counts.sameApplicantOther} · cross-applicant: {result.counts.crossApplicant}
								)
							</span>
						)}
					</p>
					{result.rows.length === 0 ? (
						<p className="mt-1 text-sm text-gray-500">No matching documents.</p>
					) : (
						<div className="mt-2 overflow-x-auto rounded border border-gray-200">
							<table className="w-full min-w-[560px] text-left text-sm">
								<thead className="border-b border-gray-200 text-gray-500">
									<tr>
										<th className="px-3 py-2">Application</th>
										<th className="px-3 py-2">Document</th>
										<th className="px-3 py-2">Kind</th>
										<th className="px-3 py-2">Uploaded</th>
										<th className="px-3 py-2">Note</th>
									</tr>
								</thead>
								<tbody>
									{result.rows.map((row) => (
										<tr key={row.documentFileId} className="border-b border-gray-100 last:border-0">
											<td className="px-3 py-2 font-mono">{clean(row.applicationReference)}</td>
											<td className="px-3 py-2 font-mono text-xs">
												{row.documentFileId.slice(0, 8)}
											</td>
											<td className="px-3 py-2">{clean(row.kind)}</td>
											<td className="px-3 py-2 tabular-nums">{formatDateTime(row.uploadedAt)}</td>
											<td className="px-3 py-2 text-xs text-gray-600">
												{row.explanationNote ? clean(row.explanationNote) : "—"}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
					<div className="mt-3 rounded border border-gray-200 p-3">
						<h3 className="text-sm font-semibold">Attach explanation</h3>
						<p className="mt-0.5 text-xs text-gray-500">
							Records a reviewer note against this hash for the application below.
						</p>
						<label htmlFor="dup-note" className="mt-2 mb-1 block text-sm font-medium text-gray-700">
							Note (≥5 characters)
						</label>
						<textarea
							id="dup-note"
							value={note}
							onChange={(e) => setNote(e.target.value)}
							rows={2}
							className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
						/>
						{appId === "" && (
							<p className="mt-1 text-xs text-amber-800">
								Enter an application id above to attach the note.
							</p>
						)}
						{explained && (
							<p className="mt-1 text-sm text-green-800" aria-live="polite">
								Explanation recorded.
							</p>
						)}
						<button
							type="button"
							onClick={() => void explain()}
							disabled={explaining || appId === "" || note.trim().length < 5}
							className="mt-2 rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
						>
							{explaining ? "Recording…" : "Explain duplicate"}
						</button>
					</div>
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
			<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-bold">Fraud review</h1>
				<button
					type="button"
					onClick={() => void queryClient.invalidateQueries({ queryKey: ["fraud-queue"] })}
					className="rounded border border-gray-300 px-3 py-1 text-sm"
				>
					Refresh
				</button>
			</div>
			{queue.isPending ? (
				<Skeleton />
			) : queue.isError ? (
				<ErrorBox message={friendlyMessage(queue.error)} onRetry={() => void queue.refetch()} />
			) : queue.data.items.length === 0 ? (
				<EmptyState
					title="No open fraud reviews"
					hint="Escalated integrity findings will appear here."
				/>
			) : (
				<div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
					<table className="w-full min-w-[760px] text-left text-sm">
						<thead className="border-b border-gray-200 text-gray-500">
							<tr>
								<th className="px-3 py-2">Application</th>
								<th className="px-3 py-2">Status</th>
								<th className="px-3 py-2">Severity</th>
								<th className="px-3 py-2">Reason</th>
								<th className="px-3 py-2">Brief</th>
								<th className="px-3 py-2">Updated</th>
							</tr>
						</thead>
						<tbody>
							{queue.data.items.map((item) => (
								<tr key={item.id} className="border-b border-gray-100 last:border-0">
									<td className="px-3 py-2">
										<Link
											to="/officer/fraud-review/$id"
											params={{ id: item.id }}
											className="font-mono text-blue-700 hover:underline"
										>
											{clean(item.applicationReference)}
										</Link>
									</td>
									<td className="px-3 py-2">
										<StatusBadge status={item.status} />
									</td>
									<td className="px-3 py-2">
										<StatusBadge status={item.severity} />
									</td>
									<td className="px-3 py-2 font-mono text-xs text-gray-600">
										{clean(item.reasonCode)}
									</td>
									<td className="px-3 py-2 text-xs text-gray-600">
										{item.briefAvailable ? (
											<>
												available
												{item.briefStale && (
													<span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
														stale
													</span>
												)}
											</>
										) : (
											"—"
										)}
									</td>
									<td className="px-3 py-2 tabular-nums">{formatDateTime(item.updatedAt)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{queue.data?.reviewer === true && <DuplicateLookup />}
		</Page>
	);
}
