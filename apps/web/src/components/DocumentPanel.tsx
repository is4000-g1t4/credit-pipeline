// T01/T02 document panel (SPEC-t01-t02 §9, D3 UI only): applicant consent +
// upload/list/download/retry, officer claim/upload/pages/cross-check/draft
// chase. Deterministic only — no send path, no model call, no decision
// effect. All document text renders as React text nodes (never
// dangerouslySetInnerHTML); bidi/zero-width controls are stripped in
// display; nothing document-derived reaches console, logs, or URLs.
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
	ApiError,
	apiErrorMessage,
	claimDocuments,
	createChaseDraft,
	downloadDocument,
	fetchCrosscheck,
	fetchDocumentFiles,
	fetchDocumentPages,
	retryDocumentOcr,
	runCrosscheck,
	toast,
	updateDocumentConsent,
	uploadDocument,
	type ChaseDraft,
	type DocumentCrosscheck,
	type DocumentFile,
	type DocumentKind,
	type DocumentsList,
} from "../lib/api";
import { Card, ErrorBox, StatusBadge } from "./ui";

/** Strip bidi/zero-width controls so pasted document text cannot reorder UI. */
function clean(value: string): string {
	return value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "");
}

function shortId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id;
}

function friendlyMessage(err: unknown): string {
	if (!(err instanceof ApiError)) return apiErrorMessage(err);
	switch (err.code) {
		case "CONSENT_REQUIRED":
			return "Document processing consent is required before documents can be used.";
		case "FILE_TOO_LARGE":
			return "That file is too large — the limit is 10 MB.";
		case "UNSUPPORTED_TYPE":
			return "Unsupported file type — upload a PDF, PNG, or JPEG.";
		case "MALWARE_DETECTED":
			return "That file failed the malware scan and was rejected.";
		case "DOCUMENTS_NOT_READY":
			return "No ready documents to check yet — upload a supported file first.";
		case "NO_TEXT":
			return "ID documents carry no page text — they always need a manual check.";
		case "OCR_NOT_RETRYABLE":
			return "Only failed or unsupported extractions can be retried.";
		case "ORIGINAL_NOT_OPENED":
			return "Open the original document before drafting a chase.";
		case "LOCK_TIMEOUT":
			return "The case is busy — retry in a moment.";
		case "OCR_BUSY":
			return "Text extraction is saturated — retry shortly.";
		case "ENCRYPTION_UNAVAILABLE":
		case "UPLOAD_TIMEOUT":
			return "The document service is temporarily unavailable — retry shortly.";
		default:
			break;
	}
	switch (err.status) {
		case 404:
			return "Documents are not available for this case.";
		case 413:
			return "That file is too large — the limit is 10 MB.";
		case 415:
			return "Unsupported file type — upload a PDF, PNG, or JPEG.";
		case 422:
			return "That file was rejected — try a different file.";
		case 429:
			return "The service is busy — retry in a moment.";
		case 503:
			return "The document service is temporarily unavailable — retry shortly.";
		default:
			return apiErrorMessage(err);
	}
}

const KINDS: DocumentKind[] = [
	"business_registration",
	"bank_statement",
	"payslip",
	"financial_statements",
	"id",
	"other",
];

function ocrLabel(file: DocumentFile): string {
	if (file.kind === "id") return "no text (ID)";
	return file.ocrStatus.replaceAll("_", " ");
}

function FileRow({
	applicationId,
	file,
	onChanged,
	inspected,
	onInspected,
	showPages,
}: {
	applicationId: string;
	file: DocumentFile;
	onChanged: () => void;
	inspected?: Set<string>;
	onInspected?: (fileId: string) => void;
	showPages?: boolean;
}) {
	const [pagesOpen, setPagesOpen] = useState(false);
	const [busy, setBusy] = useState<"download" | "open" | "retry" | null>(null);
	const [error, setError] = useState("");
	const pages = useQuery({
		queryKey: ["document-pages", applicationId, file.id],
		queryFn: () => fetchDocumentPages(applicationId, file.id),
		retry: false,
		enabled: showPages === true && pagesOpen,
	});
	const retryable =
		file.status === "ready" &&
		file.kind !== "id" &&
		(file.ocrStatus === "failed" || file.ocrStatus === "unsupported");

	async function save(openInTab: boolean) {
		setBusy(openInTab ? "open" : "download");
		setError("");
		let url = "";
		try {
			const { blob, filename } = await downloadDocument(applicationId, file.id);
			url = URL.createObjectURL(blob);
			if (openInTab) {
				window.open(url, "_blank", "noopener");
				// Keep the blob URL alive for the new tab, then release it.
				window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
			} else {
				const a = document.createElement("a");
				a.href = url;
				a.download = filename;
				document.body.appendChild(a);
				a.click();
				a.remove();
				URL.revokeObjectURL(url);
				url = "";
			}
			onInspected?.(file.id);
		} catch (err) {
			if (url !== "") URL.revokeObjectURL(url);
			setError(friendlyMessage(err));
		} finally {
			setBusy(null);
		}
	}

	async function retry() {
		setBusy("retry");
		setError("");
		try {
			await retryDocumentOcr(applicationId, file.id);
			onChanged();
		} catch (err) {
			setError(friendlyMessage(err));
		} finally {
			setBusy(null);
		}
	}

	return (
		<li className="rounded border border-gray-200 p-3">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<StatusBadge status={file.status} />
				<span className="font-medium">{clean(file.kind)}</span>
				<span className="text-xs text-gray-500" aria-live="polite">
					OCR: {clean(ocrLabel(file))}
					{file.textLayerRisk ? " · hidden-text risk" : ""}
				</span>
				{inspected?.has(file.id) && (
					<span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800">
						original opened
					</span>
				)}
			</div>
			<dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-600">
				<div>
					<dt className="inline font-medium">Pages: </dt>
					<dd className="inline">{file.pageCount}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Size: </dt>
					<dd className="inline">{(file.sizeBytes / 1024).toFixed(1)} KB</dd>
				</div>
				<div>
					<dt className="inline font-medium">Keep until: </dt>
					<dd className="inline">{new Date(file.retentionUntil).toLocaleDateString()}</dd>
				</div>
				{file.errorCode && (
					<div>
						<dt className="inline font-medium">Reason: </dt>
						<dd className="inline">{clean(file.errorCode)}</dd>
					</div>
				)}
			</dl>
			{error && (
				<div className="mt-2">
					<ErrorBox message={error} />
				</div>
			)}
			<div className="mt-2 flex flex-wrap gap-2">
				<button
					type="button"
					onClick={() => void save(false)}
					disabled={busy !== null}
					aria-label={`Download document ${shortId(file.id)}`}
					className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
				>
					{busy === "download" ? "Preparing…" : "Download"}
				</button>
				<button
					type="button"
					onClick={() => void save(true)}
					disabled={busy !== null}
					aria-label={`Open original document ${shortId(file.id)}`}
					className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
				>
					{busy === "open" ? "Opening…" : "Open original"}
				</button>
				{showPages === true && file.kind !== "id" && (
					<button
						type="button"
						onClick={() => setPagesOpen((v) => !v)}
						aria-expanded={pagesOpen}
						aria-label={`View page text for document ${shortId(file.id)}`}
						className="rounded border border-gray-300 px-3 py-1 text-sm"
					>
						{pagesOpen ? "Hide pages" : "View pages"}
					</button>
				)}
				{retryable && (
					<button
						type="button"
						onClick={() => void retry()}
						disabled={busy !== null}
						aria-label={`Retry text extraction for document ${shortId(file.id)}`}
						className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
					>
						{busy === "retry" ? "Retrying…" : "Retry OCR"}
					</button>
				)}
			</div>
			{showPages === true && pagesOpen && (
				<div className="mt-2" aria-live="polite">
					{pages.isPending ? (
						<p className="text-sm text-gray-500">Loading pages…</p>
					) : pages.isError ? (
						<ErrorBox message={friendlyMessage(pages.error)} onRetry={() => void pages.refetch()} />
					) : pages.data.pages.length === 0 ? (
						<p className="text-sm text-gray-500">No page text — this file needs a manual check.</p>
					) : (
						<ol className="space-y-2">
							{pages.data.pages.map((p) => (
								<li key={p.pageNumber} className="rounded bg-gray-50 p-2 text-sm">
									<p className="text-xs text-gray-500">
										Page {p.pageNumber} · {clean(p.source)} · confidence{" "}
										{Number(p.confidence).toFixed(2)}
									</p>
									<p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-gray-800">
										{clean(p.text)}
									</p>
								</li>
							))}
						</ol>
					)}
				</div>
			)}
		</li>
	);
}

function UploadForm({
	applicationId,
	disabled,
	disabledHint,
	onUploaded,
}: {
	applicationId: string;
	disabled: boolean;
	disabledHint: string | null;
	onUploaded: () => void;
}) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [kind, setKind] = useState<DocumentKind>("business_registration");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function upload() {
		const picked = inputRef.current?.files?.[0];
		if (!picked) {
			setError("Choose a PDF, PNG, or JPEG first.");
			return;
		}
		setBusy(true);
		setError("");
		try {
			await uploadDocument(applicationId, picked, kind);
			if (inputRef.current) inputRef.current.value = "";
			onUploaded();
		} catch (err) {
			const message = friendlyMessage(err);
			setError(message);
			if (!(err instanceof ApiError) || (err.status !== 409 && err.status !== 422)) toast(message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="rounded border border-gray-200 p-3">
			<div className="grid gap-3 sm:grid-cols-2">
				<div>
					<label htmlFor="document-kind" className="mb-1 block text-sm font-medium text-gray-700">
						Document kind
					</label>
					<select
						id="document-kind"
						value={kind}
						onChange={(e) => setKind(e.target.value as DocumentKind)}
						disabled={disabled || busy}
						className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
					>
						{KINDS.map((k) => (
							<option key={k} value={k}>
								{k}
							</option>
						))}
					</select>
				</div>
				<div>
					<label htmlFor="document-file" className="mb-1 block text-sm font-medium text-gray-700">
						File (PDF, PNG, JPEG · ≤10 MB)
					</label>
					<input
						ref={inputRef}
						id="document-file"
						type="file"
						accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
						disabled={disabled || busy}
						className="w-full text-sm disabled:opacity-50"
					/>
				</div>
			</div>
			{disabledHint && <p className="mt-2 text-sm text-gray-600">{disabledHint}</p>}
			{error && (
				<div className="mt-2">
					<ErrorBox message={error} />
				</div>
			)}
			<button
				type="button"
				onClick={() => void upload()}
				disabled={disabled || busy}
				className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
			>
				{busy ? "Uploading…" : "Upload document"}
			</button>
		</div>
	);
}

function DocumentFileList({
	applicationId,
	files,
	onChanged,
	inspected,
	onInspected,
	showPages,
}: {
	applicationId: string;
	files: UseQueryResult<DocumentsList>;
	onChanged: () => void;
	inspected?: Set<string>;
	onInspected?: (fileId: string) => void;
	showPages?: boolean;
}) {
	return (
		<div className="mt-3" aria-live="polite">
			{files.isPending ? (
				<p className="text-sm text-gray-500">Loading documents…</p>
			) : files.isError ? (
				<ErrorBox message={friendlyMessage(files.error)} onRetry={() => void files.refetch()} />
			) : files.data.files.length === 0 ? (
				<p className="text-sm text-gray-500">No documents uploaded yet.</p>
			) : (
				<ul className="space-y-2">
					{files.data.files.map((f) => (
						<FileRow
							key={f.id}
							applicationId={applicationId}
							file={f}
							onChanged={onChanged}
							inspected={inspected}
							onInspected={onInspected}
							showPages={showPages}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function ApplicantDocuments({
	applicationId,
	consent,
}: {
	applicationId: string;
	consent: boolean;
}) {
	const queryClient = useQueryClient();
	const [checked, setChecked] = useState(consent);
	const [saving, setSaving] = useState(false);
	const [consentError, setConsentError] = useState("");
	const files = useQuery({
		queryKey: ["documents", applicationId],
		queryFn: () => fetchDocumentFiles(applicationId),
		retry: false,
	});
	const refresh = (): void => {
		void queryClient.invalidateQueries({ queryKey: ["documents", applicationId] });
		void queryClient.invalidateQueries({ queryKey: ["application", applicationId] });
		void queryClient.invalidateQueries({ queryKey: ["integrity", applicationId] });
	};

	async function saveConsent() {
		setSaving(true);
		setConsentError("");
		try {
			await updateDocumentConsent(applicationId, checked);
			refresh();
		} catch (err) {
			setConsentError(friendlyMessage(err));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Card title="Documents">
			<p className="mb-3 text-xs text-gray-500">
				Your files are scanned, encrypted, and kept for 90 days. Withdrawing consent blocks future
				uploads and schedules deletion.
			</p>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={checked}
						onChange={(e) => setChecked(e.target.checked)}
						aria-label="Consent to document processing"
					/>
					I consent to document processing
				</label>
				<button
					type="button"
					onClick={() => void saveConsent()}
					disabled={saving || checked === consent}
					className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
				>
					{saving ? "Saving…" : "Update consent"}
				</button>
			</div>
			{consentError && (
				<div className="mb-3">
					<ErrorBox message={consentError} />
				</div>
			)}
			<UploadForm
				applicationId={applicationId}
				disabled={!consent}
				disabledHint={
					!consent
						? "Uploads need document-processing consent — tick the box and update first."
						: null
				}
				onUploaded={refresh}
			/>
			<DocumentFileList applicationId={applicationId} files={files} onChanged={refresh} />
		</Card>
	);
}

function FindingItem({
	finding,
	fileKind,
	selected,
	onToggle,
}: {
	finding: DocumentCrosscheck["findings"][number];
	fileKind: (fileId: string | null) => string;
	selected: boolean;
	onToggle: () => void;
}) {
	return (
		<li className="rounded border border-gray-200 p-3">
			<label className="flex cursor-pointer items-start gap-2 text-sm">
				<input
					type="checkbox"
					checked={selected}
					onChange={onToggle}
					aria-label={`Select finding ${finding.field} for chase draft`}
					className="mt-1"
				/>
				<span>
					<span className="font-medium">{clean(finding.field)}</span>{" "}
					<StatusBadge status={finding.status} />
					<span className="ml-2 text-xs text-gray-500">{clean(finding.reason)}</span>
				</span>
			</label>
			<dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-gray-600 sm:grid-cols-2">
				<div>
					<dt className="inline font-medium">Expected: </dt>
					<dd className="inline break-words">{clean(finding.expected ?? "not available")}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Observed: </dt>
					<dd className="inline break-words">{clean(finding.observed ?? "not available")}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Document: </dt>
					<dd className="inline">
						{finding.documentFileId
							? `${clean(fileKind(finding.documentFileId))} · ${shortId(finding.documentFileId)}`
							: "no usable document — manual review"}
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Page: </dt>
					<dd className="inline">{finding.pageNumber ?? "—"}</dd>
				</div>
			</dl>
			{finding.quote !== null ? (
				<blockquote className="mt-2 border-l-2 border-gray-300 pl-2 text-sm text-gray-700 italic">
					{clean(finding.quote)}
				</blockquote>
			) : (
				<p className="mt-1 text-xs text-gray-500">No citable quote — needs a manual check.</p>
			)}
		</li>
	);
}

function OfficerDocuments({ applicationId }: { applicationId: string }) {
	const queryClient = useQueryClient();
	const [claimConflict, setClaimConflict] = useState(false);
	const [claiming, setClaiming] = useState(false);
	const [claimError, setClaimError] = useState("");
	const [inspected, setInspected] = useState<Set<string>>(new Set());
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [crossBusy, setCrossBusy] = useState(false);
	const [crossError, setCrossError] = useState("");
	const [chaseBusy, setChaseBusy] = useState(false);
	const [chaseError, setChaseError] = useState("");
	const [draft, setDraft] = useState<ChaseDraft | null>(null);

	const files = useQuery({
		queryKey: ["documents", applicationId],
		queryFn: () => fetchDocumentFiles(applicationId),
		retry: false,
	});
	const crosscheck = useQuery({
		queryKey: ["document-crosscheck", applicationId],
		queryFn: () => fetchCrosscheck(applicationId),
		retry: false,
		// Cross-check reads need an assignment first; skip until the file
		// list settles so an unassigned officer makes no extra call.
		enabled: files.isSuccess || files.isError,
	});
	const refresh = (): void => {
		void queryClient.invalidateQueries({ queryKey: ["documents", applicationId] });
		void queryClient.invalidateQueries({ queryKey: ["document-crosscheck", applicationId] });
		void queryClient.invalidateQueries({ queryKey: ["integrity", applicationId] });
	};

	async function claim() {
		setClaiming(true);
		setClaimError("");
		try {
			await claimDocuments(applicationId);
			refresh();
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) setClaimConflict(true);
			else setClaimError(friendlyMessage(err));
		} finally {
			setClaiming(false);
		}
	}

	async function run() {
		setCrossBusy(true);
		setCrossError("");
		try {
			await runCrosscheck(applicationId);
			refresh();
		} catch (err) {
			setCrossError(friendlyMessage(err));
		} finally {
			setCrossBusy(false);
		}
	}

	const unassigned = files.isError && files.error instanceof ApiError && files.error.status === 404;
	const consentBlocked =
		(files.isError && files.error instanceof ApiError && files.error.status === 403) ||
		(crosscheck.isError && crosscheck.error instanceof ApiError && crosscheck.error.status === 403);

	if (claimConflict) {
		return (
			<Card title="Documents">
				<p className="text-sm text-gray-600">Documents are not available for this case.</p>
			</Card>
		);
	}

	if (unassigned) {
		return (
			<Card title="Documents">
				<p className="mb-3 text-sm text-gray-600">
					This case is not assigned yet. Claim it to work with its documents.
				</p>
				{claimError && (
					<div className="mb-3">
						<ErrorBox message={claimError} />
					</div>
				)}
				<button
					type="button"
					onClick={() => void claim()}
					disabled={claiming}
					className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
				>
					{claiming ? "Claiming…" : "Assign to me"}
				</button>
			</Card>
		);
	}

	const data: DocumentCrosscheck | null | undefined = crosscheck.data;
	const findings = data?.findings ?? [];
	const fileKind = (fileId: string | null): string =>
		files.data?.files.find((f) => f.id === fileId)?.kind ?? "document";
	const toggleSelect = (id: string): void => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const chosen = findings.filter((f) => selected.has(f.id));
	const citedIds = [
		...new Set(chosen.flatMap((f) => (f.documentFileId ? [f.documentFileId] : []))),
	];
	const unopened = citedIds.filter((id) => !inspected.has(id));
	const chaseReady = chosen.length > 0 && citedIds.length > 0 && unopened.length === 0;

	async function createDraft() {
		if (!data) return;
		setChaseBusy(true);
		setChaseError("");
		try {
			const result = await createChaseDraft(applicationId, (data.crosscheck as { id: string }).id, [
				...selected,
			]);
			setDraft(result);
		} catch (err) {
			setChaseError(friendlyMessage(err));
		} finally {
			setChaseBusy(false);
		}
	}

	return (
		<Card title="Documents">
			{consentBlocked && (
				<p className="mb-3 text-sm text-gray-600" aria-live="polite">
					Document processing consent is required before documents can be used — the applicant has
					not granted it.
				</p>
			)}
			<UploadForm
				applicationId={applicationId}
				disabled={false}
				disabledHint={null}
				onUploaded={refresh}
			/>
			<DocumentFileList
				applicationId={applicationId}
				files={files}
				onChanged={refresh}
				inspected={inspected}
				onInspected={(id) => setInspected((prev) => new Set(prev).add(id))}
				showPages
			/>

			<div className="mt-4 border-t border-gray-100 pt-3">
				<h3 className="text-sm font-semibold">Cross-check</h3>
				{crosscheck.isPending ? (
					<p className="mt-1 text-sm text-gray-500">Loading cross-check…</p>
				) : crosscheck.isError ? (
					<div className="mt-1">
						<ErrorBox
							message={friendlyMessage(crosscheck.error)}
							onRetry={() => void crosscheck.refetch()}
						/>
					</div>
				) : data === null || data === undefined ? (
					<p className="mt-1 text-sm text-gray-600">No cross-check run yet.</p>
				) : (
					<div className="mt-1 text-xs text-gray-500">
						<p>
							Run {shortId((data.crosscheck as { id: string }).id)} ·{" "}
							{(data.crosscheck as { status: string }).status} ·{" "}
							{(data.crosscheck as { findingCount: number }).findingCount} finding
							{(data.crosscheck as { findingCount: number }).findingCount === 1 ? "" : "s"}
						</p>
						{findings.length > 0 && (
							<ul className="mt-2 space-y-2">
								{findings.map((f) => (
									<FindingItem
										key={f.id}
										finding={f}
										fileKind={fileKind}
										selected={selected.has(f.id)}
										onToggle={() => toggleSelect(f.id)}
									/>
								))}
							</ul>
						)}
					</div>
				)}
				{crossError && (
					<div className="mt-2">
						<ErrorBox message={crossError} />
					</div>
				)}
				<div className="mt-2 flex flex-wrap gap-2">
					<button
						type="button"
						onClick={() => void run()}
						disabled={crossBusy}
						className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
					>
						{crossBusy ? "Checking…" : "Run cross-check"}
					</button>
				</div>

				{findings.length > 0 && (
					<div className="mt-3">
						<h4 className="text-sm font-semibold">Draft chase</h4>
						<p className="mt-0.5 text-xs text-gray-500">
							Select findings above, open the cited original{citedIds.length > 1 ? "s" : ""}, then
							draft. Drafts are never sent from here.
						</p>
						{chosen.length > 0 && unopened.length > 0 && (
							<p className="mt-1 text-sm text-amber-800" aria-live="polite">
								Open the original{unopened.length > 1 ? "s" : ""} for the selected cited file
								{unopened.length > 1 ? "s" : ""} before drafting.
							</p>
						)}
						{chosen.length > 0 && citedIds.length === 0 && (
							<p className="mt-1 text-sm text-amber-800" aria-live="polite">
								The selected findings cite no openable document — a draft needs at least one cited
								file.
							</p>
						)}
						{chaseError && (
							<div className="mt-2">
								<ErrorBox message={chaseError} />
							</div>
						)}
						<button
							type="button"
							onClick={() => void createDraft()}
							disabled={!chaseReady || chaseBusy}
							aria-label="Create draft chase request"
							className="mt-2 rounded border border-gray-400 px-4 py-2 text-sm disabled:opacity-50"
						>
							{chaseBusy ? "Drafting…" : "Create draft chase"}
						</button>
						{draft && (
							<div
								className="mt-2 rounded border border-green-200 bg-green-50 p-3"
								aria-live="polite"
							>
								<p className="text-sm font-medium text-green-900">Draft created — not sent</p>
								<p className="mt-1 whitespace-pre-wrap break-words text-sm text-green-900">
									{clean((draft.chase as { body: string | null }).body ?? "")}
								</p>
							</div>
						)}
					</div>
				)}
			</div>
		</Card>
	);
}

/** Case-level document workflow. Applicant pages pass `mode="applicant"`;
 * the officer review page passes `mode="officer"`. When the feature flag is
 * off the officer sees nothing (the mock Verification card in CaseView is
 * untouched); applicants get a one-line unavailable note. */
export function DocumentPanel({
	applicationId,
	mode,
	documentsEnabled,
	documentProcessingConsent,
}: {
	applicationId: string;
	mode: "applicant" | "officer";
	documentsEnabled: boolean;
	documentProcessingConsent: boolean;
}) {
	if (!documentsEnabled) {
		return null;
	}
	if (mode === "applicant") {
		return <ApplicantDocuments applicationId={applicationId} consent={documentProcessingConsent} />;
	}
	return (
		<section aria-label="Case documents">
			<OfficerDocuments applicationId={applicationId} />
		</section>
	);
}
