// T17 requirements panel (SPEC-t17-t18 §2.6, D2b): server checklist for
// draft/submitted cases — ready state, blockers, warnings, required docs,
// reusable evidence with explicit attach, KYC status, and the draft Submit
// button. Metadata only (ids/kinds/dates/reasons); no document text, no
// dangerous HTML, nothing document-derived logged.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	ApiError,
	apiErrorMessage,
	fetchCustomerProfile,
	fetchRequirements,
	formatDate,
	formatDateOnly,
	isTerminal,
	queryKeys,
	reuseCustomerDocuments,
	submitDraft,
	toast,
	type RequirementsResponse,
} from "../lib/api";
import { Card, ErrorBox } from "./ui";

/** Reason code → applicant-facing action. Unknown codes render as-is. */
function actionFor(kind: string, reason: string): string {
	if (reason === "missing") return "Upload or reuse a document of this kind.";
	if (reason === "stale")
		return "The latest copy is too old — upload a fresh statement or reuse fresh evidence.";
	if (reason === "unknown_date" || reason === "invalid")
		return "Its date could not be verified from a trusted source — reuse verified evidence instead.";
	if (reason === "rejected") return "The latest copy was rejected — upload a new file.";
	if (reason === "expired")
		return "KYC has expired — contact the bank to refresh it before submitting.";
	if (reason === "identity_mismatch")
		return "The application identity differs from the verified profile — correct it or provide identity evidence.";
	if (reason === "consent") return "Give the missing consent to continue.";
	return `Needs attention (${kind}: ${reason}).`;
}

function BlockerList({ requirements }: { requirements: RequirementsResponse }) {
	const entries = Object.entries(requirements.blockers);
	if (entries.length === 0) {
		return <p className="text-sm text-green-800">All hard requirements are met.</p>;
	}
	return (
		<ul className="space-y-1.5">
			{entries.map(([key, reasons]) => (
				<li key={key} className="rounded border border-red-200 bg-red-50 p-2 text-sm">
					<span className="font-medium">{key}</span>
					<span className="text-red-800"> — {reasons.join(", ")}</span>
					<p className="mt-0.5 text-xs text-gray-600">{actionFor(key, reasons[0] ?? "")}</p>
				</li>
			))}
		</ul>
	);
}

function ReuseList({
	applicationId,
	requirements,
	onChanged,
}: {
	applicationId: string;
	requirements: RequirementsResponse;
	onChanged: () => void;
}) {
	const [busyId, setBusyId] = useState<string | null>(null);
	const [error, setError] = useState("");
	const queryClient = useQueryClient();

	async function reuse(customerDocumentId: string, kind: string) {
		setBusyId(customerDocumentId);
		setError("");
		try {
			await reuseCustomerDocuments(applicationId, [customerDocumentId], kind);
			onChanged();
			void queryClient.invalidateQueries({ queryKey: ["documents", applicationId] });
		} catch (err) {
			const message =
				err instanceof ApiError &&
				(err.code === "STALE_EVIDENCE" || err.code === "EXPIRED_EVIDENCE")
					? "That evidence is no longer fresh — upload a new statement instead."
					: apiErrorMessage(err);
			setError(message);
			if (!(err instanceof ApiError) || (err.status !== 409 && err.status !== 422)) toast(message);
		} finally {
			setBusyId(null);
		}
	}

	if (requirements.reusableDocuments.length === 0) {
		return <p className="text-sm text-gray-500">No reusable evidence — upload fresh documents.</p>;
	}
	return (
		<div>
			{error && (
				<div className="mb-2">
					<ErrorBox message={error} />
				</div>
			)}
			<ul className="space-y-1.5">
				{requirements.reusableDocuments.map((d) => (
					<li
						key={d.customerDocumentId}
						className="flex flex-wrap items-center justify-between gap-2 rounded border border-gray-200 p-2 text-sm"
					>
						<span>
							<span className="font-medium">{d.kind}</span>{" "}
							<span className="text-xs text-gray-500">
								period {d.periodEnd ?? d.documentDate ?? "unknown"} · reusable
							</span>
						</span>
						<button
							type="button"
							onClick={() => void reuse(d.customerDocumentId, d.kind)}
							disabled={busyId !== null}
							aria-label={`Reuse ${d.kind} evidence`}
							className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
						>
							{busyId === d.customerDocumentId ? "Attaching…" : "Reuse"}
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

function SubmitButton({
	applicationId,
	ready,
	onChanged,
}: {
	applicationId: string;
	ready: boolean;
	onChanged: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	// ONE key per submission intent — retries reuse it.
	const [idemKey] = useState(() => crypto.randomUUID());

	async function submit() {
		setBusy(true);
		setError("");
		try {
			await submitDraft(applicationId, idemKey);
			onChanged();
		} catch (err) {
			if (err instanceof ApiError && err.code === "REQUIREMENTS_INCOMPLETE") {
				setError("Requirements are still incomplete — the checklist below is refreshed.");
			} else {
				const message = apiErrorMessage(err);
				setError(message);
				toast(message);
			}
			onChanged();
		} finally {
			setBusy(false);
		}
	}

	return (
		<div>
			{error && (
				<div className="mb-2">
					<ErrorBox message={error} />
				</div>
			)}
			<button
				type="button"
				onClick={() => void submit()}
				disabled={!ready || busy}
				aria-label="Submit draft application"
				title={ready ? undefined : "Blocked until all hard requirements are met"}
				className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
			>
				{busy ? "Submitting…" : "Submit application"}
			</button>
			{!ready && (
				<p className="mt-1 text-xs text-gray-500">
					Blocked until every hard requirement above is met.
				</p>
			)}
		</div>
	);
}

export function RequirementsPanel({
	applicationId,
	status,
}: {
	applicationId: string;
	status: string;
}) {
	const queryClient = useQueryClient();
	const requirements = useQuery({
		queryKey: ["requirements", applicationId],
		queryFn: () => fetchRequirements(applicationId),
		retry: false,
		// Drafts change only on explicit attach/submit; poll submitted ones
		// alongside the case view, stop on terminal.
		refetchInterval: status === "draft" || isTerminal(status) ? false : 2000,
	});
	const refresh = (): void => {
		void queryClient.invalidateQueries({ queryKey: ["requirements", applicationId] });
		void queryClient.invalidateQueries({ queryKey: queryKeys.case(applicationId) });
	};

	return (
		<Card title="Requirements">
			<div aria-live="polite">
				{requirements.isPending ? (
					<p className="text-sm text-gray-500">Loading checklist…</p>
				) : requirements.isError ? (
					<ErrorBox
						message={apiErrorMessage(requirements.error)}
						onRetry={() => void requirements.refetch()}
					/>
				) : (
					<div className="space-y-3">
						<p className="text-sm">
							{requirements.data.readyToSubmit ? (
								<span className="font-medium text-green-800">Ready to submit.</span>
							) : (
								<span className="font-medium text-red-700">Not ready to submit.</span>
							)}{" "}
							<span className="text-xs text-gray-500">
								Policy {requirements.data.policyVersion} · as of{" "}
								{formatDate(requirements.data.asOf)}
							</span>
						</p>
						<div>
							<h3 className="mb-1 text-sm font-semibold">Hard requirements</h3>
							<BlockerList requirements={requirements.data} />
						</div>
						{requirements.data.warnings.length > 0 && (
							<div>
								<h3 className="mb-1 text-sm font-semibold">Warnings (do not block submit)</h3>
								<ul className="space-y-1 text-sm text-gray-600">
									{requirements.data.warnings.map((w, i) => (
										<li key={`${w.code}-${w.kind ?? w.field ?? i}`}>
											{w.code}
											{w.kind ? ` · ${w.kind}` : ""}
											{w.field ? ` · ${w.field}` : ""}
										</li>
									))}
								</ul>
							</div>
						)}
						<div>
							<h3 className="mb-1 text-sm font-semibold">Reusable evidence</h3>
							<ReuseList
								applicationId={applicationId}
								requirements={requirements.data}
								onChanged={refresh}
							/>
						</div>
						<div className="text-sm">
							<h3 className="mb-1 text-sm font-semibold">KYC</h3>
							<p className="text-gray-600">
								{requirements.data.kyc.status ?? "no profile"} ·{" "}
								{requirements.data.kyc.expiresAt
									? `expires ${formatDateOnly(requirements.data.kyc.expiresAt)}`
									: "no expiry on file"}
							</p>
							{requirements.data.prefill.reused.length > 0 && (
								<p className="mt-1 text-xs text-gray-500">
									Reused profile fields: {requirements.data.prefill.reused.join(", ")}
								</p>
							)}
							{requirements.data.prefill.edited.length > 0 && (
								<p className="mt-1 text-xs text-gray-500">
									Edited fields: {requirements.data.prefill.edited.join(", ")}
								</p>
							)}
						</div>
						{status === "draft" && (
							<SubmitButton
								applicationId={applicationId}
								ready={requirements.data.readyToSubmit}
								onChanged={refresh}
							/>
						)}
					</div>
				)}
			</div>
		</Card>
	);
}

/** Masked customer snapshot for the applicant case page: KYC state,
 * masked accounts, and evidence metadata. No raw numbers, no blobs. */
export function CustomerSnapshot() {
	const profile = useQuery({
		queryKey: ["customer-profile"],
		queryFn: fetchCustomerProfile,
		retry: false,
	});
	if (profile.isPending || profile.isError || !profile.data) return null;
	const { profile: p, accounts, documents } = profile.data;
	return (
		<Card title="Your customer profile">
			<dl className="divide-y divide-gray-100 text-sm">
				<div className="flex flex-wrap justify-between gap-2 py-1">
					<dt className="text-gray-500">KYC</dt>
					<dd className="font-medium">
						{p.kycStatus}
						{p.kycFresh ? "" : " (not fresh)"} ·{" "}
						{p.kycExpiresAt
							? `expires ${formatDateOnly(p.kycExpiresAt)}`
							: "no expiry on file"}
					</dd>
				</div>
				<div className="flex flex-wrap justify-between gap-2 py-1">
					<dt className="text-gray-500">Accounts</dt>
					<dd className="font-medium">
						{accounts.length === 0
							? "none on file"
							: accounts.map((a) => `${a.bankName} ${a.maskedNumber}`).join("; ")}
					</dd>
				</div>
				<div className="flex flex-wrap justify-between gap-2 py-1">
					<dt className="text-gray-500">Evidence on file</dt>
					<dd className="font-medium">
						{documents.length === 0
							? "none"
							: documents
									.map(
										(d) =>
											`${d.kind} (${d.reusable ? "reusable" : (d.reuseReason ?? "not reusable")})`,
									)
									.join("; ")}
					</dd>
				</div>
			</dl>
		</Card>
	);
}
