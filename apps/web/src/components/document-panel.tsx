// T01/T02 document panel (SPEC-t01-t02 §9, D3 UI only): applicant consent +
// upload/list/download/retry, officer claim/upload/pages/cross-check/draft
// chase. Deterministic only — no send path, no model call, no decision
// effect. All document text renders as React text nodes (never
// dangerouslySetInnerHTML); bidi/zero-width controls are stripped in
// display; nothing document-derived reaches console, logs, or URLs.
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	ApiError,
	claimDocuments,
	createChaseDraft,
	downloadDocument,
	fetchCrosscheck,
	fetchDocumentFiles,
	fetchDocumentPages,
	fieldLabel,
	formatDate,
	queryKeys,
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
import { clean, friendlyMessage, shortId } from "../lib/format";
import { ErrorBox, Panel, StatusBadge, inputCls } from "./ubs";

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
		<li className="rounded-sm border border-rule p-3">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<StatusBadge status={file.status} />
				<span className="font-medium text-ink">{fieldLabel(file.kind)}</span>
				<span className="text-xs text-slate" aria-live="polite">
					OCR: {clean(ocrLabel(file))}
					{file.textLayerRisk ? " · hidden-text risk" : ""}
				</span>
				{inspected?.has(file.id) && (
					<span className="rounded-sm bg-tag-green px-1.5 py-0.5 text-xs text-success-ink">
						original opened
					</span>
				)}
			</div>
			<dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate">
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
					<dd className="inline">{formatDate(file.retentionUntil)}</dd>
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
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void save(false)}
					disabled={busy !== null}
					aria-label={`Download document ${shortId(file.id)}`}
				>
					{busy === "download" ? "Preparing…" : "Download"}
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void save(true)}
					disabled={busy !== null}
					aria-label={`Open original document ${shortId(file.id)}`}
				>
					{busy === "open" ? "Opening…" : "Open original"}
				</Button>
				{showPages === true && file.kind !== "id" && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setPagesOpen((v) => !v)}
						aria-expanded={pagesOpen}
						aria-label={`View page text for document ${shortId(file.id)}`}
					>
						{pagesOpen ? "Hide pages" : "View pages"}
					</Button>
				)}
				{retryable && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void retry()}
						disabled={busy !== null}
						aria-label={`Retry text extraction for document ${shortId(file.id)}`}
					>
						{busy === "retry" ? "Retrying…" : "Retry OCR"}
					</Button>
				)}
			</div>
			{showPages === true && pagesOpen && (
				<div className="mt-2" aria-live="polite">
					{pages.isPending ? (
						<p className="text-sm text-slate">Loading pages…</p>
					) : pages.isError ? (
						<ErrorBox message={friendlyMessage(pages.error)} onRetry={() => void pages.refetch()} />
					) : pages.data.pages.length === 0 ? (
						<p className="text-sm text-slate">No page text — this file needs a manual check.</p>
					) : (
						<ol className="space-y-2">
							{pages.data.pages.map((p) => (
								<li key={p.pageNumber} className="rounded-sm bg-raised p-2 text-sm">
									<p className="text-xs text-slate">
										Page {p.pageNumber} · {clean(p.source)} · confidence{" "}
										{Number(p.confidence).toFixed(2)}
									</p>
									<p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-ink">
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
		<div className="rounded-sm border border-rule p-4">
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor="document-kind">Document kind</Label>
					<select
						id="document-kind"
						value={kind}
						onChange={(e) => setKind(e.target.value as DocumentKind)}
						disabled={disabled || busy}
						className={inputCls}
					>
						{KINDS.map((k) => (
							<option key={k} value={k}>
								{fieldLabel(k)}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-2">
					<Label htmlFor="document-file">File (PDF, PNG, JPEG · ≤10 MB)</Label>
					<input
						ref={inputRef}
						id="document-file"
						type="file"
						accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
						disabled={disabled || busy}
						className="w-full text-sm text-ink disabled:opacity-50"
					/>
				</div>
			</div>
			{disabledHint && <p className="mt-2 text-sm text-slate">{disabledHint}</p>}
			{error && (
				<div className="mt-2">
					<ErrorBox message={error} />
				</div>
			)}
			<div className="mt-3">
				<Button
					type="button"
					variant="outline"
					onClick={() => void upload()}
					disabled={disabled || busy}
				>
					{busy ? "Uploading…" : "Upload document"}
				</Button>
			</div>
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
				<p className="text-sm text-slate">Loading documents…</p>
			) : files.isError ? (
				<ErrorBox message={friendlyMessage(files.error)} onRetry={() => void files.refetch()} />
			) : files.data.files.length === 0 ? (
				<p className="text-sm text-slate">No documents uploaded yet.</p>
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
		enabled: consent,
	});
	const refresh = (): void => {
		void queryClient.invalidateQueries({ queryKey: ["documents", applicationId] });
		void queryClient.invalidateQueries({ queryKey: queryKeys.case(applicationId) });
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
		<Panel title="Documents" outline>
			<p className="mb-3 text-xs text-slate">
				Your files are scanned, encrypted, and kept for 90 days. Withdrawing consent blocks future
				uploads and schedules deletion.
			</p>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<label className="flex items-center gap-2 text-sm text-ink">
					<input
						type="checkbox"
						checked={checked}
						onChange={(e) => setChecked(e.target.checked)}
						aria-label="Consent to document processing"
						className="size-5"
					/>
					I consent to document processing
				</label>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void saveConsent()}
					disabled={saving || checked === consent}
				>
					{saving ? "Saving…" : "Update consent"}
				</Button>
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
			{consent ? (
				<DocumentFileList applicationId={applicationId} files={files} onChanged={refresh} />
			) : (
				<p className="text-sm text-slate">
					Consent to document processing to view uploaded documents.
				</p>
			)}
		</Panel>
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
		<li className="rounded-sm border border-rule p-3">
			<label className="flex cursor-pointer items-start gap-2 text-sm text-ink">
				<input
					type="checkbox"
					checked={selected}
					onChange={onToggle}
					aria-label={`Select finding ${finding.field} for chase draft`}
					className="mt-1 size-4"
				/>
				<span>
					<span className="font-medium">{clean(finding.field)}</span>{" "}
					<StatusBadge status={finding.status} />
					<span className="ml-2 text-xs text-slate">{clean(finding.reason)}</span>
				</span>
			</label>
			<dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-slate sm:grid-cols-2">
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
				<blockquote className="mt-2 border-l-2 border-rule-strong pl-2 text-sm text-ink italic">
					{clean(finding.quote)}
				</blockquote>
			) : (
				<p className="mt-1 text-xs text-slate">No citable quote — needs a manual check.</p>
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
			<Panel title="Documents" outline>
				<p className="text-sm text-slate">Documents are not available for this case.</p>
			</Panel>
		);
	}

	if (unassigned) {
		return (
			<Panel title="Documents" outline>
				<p className="mb-3 text-sm text-slate">
					This case is not assigned yet. Claim it to work with its documents.
				</p>
				{claimError && (
					<div className="mb-3">
						<ErrorBox message={claimError} />
					</div>
				)}
				<Button type="button" variant="outline" onClick={() => void claim()} disabled={claiming}>
					{claiming ? "Claiming…" : "Assign to me"}
				</Button>
			</Panel>
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
		<Panel title="Documents" outline>
			{consentBlocked && (
				<p className="mb-3 text-sm text-slate" aria-live="polite">
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

			<div className="mt-4 border-t border-rule pt-3">
				<h3 className="text-sm font-medium text-ink">Cross-check</h3>
				{crosscheck.isPending ? (
					<p className="mt-1 text-sm text-slate">Loading cross-check…</p>
				) : crosscheck.isError ? (
					<div className="mt-1">
						<ErrorBox
							message={friendlyMessage(crosscheck.error)}
							onRetry={() => void crosscheck.refetch()}
						/>
					</div>
				) : data === null || data === undefined ? (
					<p className="mt-1 text-sm text-slate">No cross-check run yet.</p>
				) : (
					<div className="mt-1 text-xs text-slate">
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
					<Button type="button" variant="outline" onClick={() => void run()} disabled={crossBusy}>
						{crossBusy ? "Checking…" : "Run cross-check"}
					</Button>
				</div>

				{findings.length > 0 && (
					<div className="mt-3">
						<h4 className="text-sm font-medium text-ink">Draft chase</h4>
						<p className="mt-0.5 text-xs text-slate">
							Select findings above, open the cited original{citedIds.length > 1 ? "s" : ""}, then
							draft. Drafts are never sent from here.
						</p>
						{chosen.length > 0 && unopened.length > 0 && (
							<p className="mt-1 text-sm text-warning-ink" aria-live="polite">
								Open the original{unopened.length > 1 ? "s" : ""} for the selected cited file
								{unopened.length > 1 ? "s" : ""} before drafting.
							</p>
						)}
						{chosen.length > 0 && citedIds.length === 0 && (
							<p className="mt-1 text-sm text-warning-ink" aria-live="polite">
								The selected findings cite no openable document — a draft needs at least one cited
								file.
							</p>
						)}
						{chaseError && (
							<div className="mt-2">
								<ErrorBox message={chaseError} />
							</div>
						)}
						<div className="mt-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => void createDraft()}
								disabled={!chaseReady || chaseBusy}
								aria-label="Create draft chase request"
							>
								{chaseBusy ? "Drafting…" : "Create draft chase"}
							</Button>
						</div>
						{draft && (
							<div
								className="mt-2 rounded-sm border border-rule bg-tag-green p-3"
								aria-live="polite"
							>
								<p className="text-sm font-medium text-success-ink">Draft created — not sent</p>
								<p className="mt-1 whitespace-pre-wrap break-words text-sm text-success-ink">
									{clean((draft.chase as { body: string | null }).body ?? "")}
								</p>
							</div>
						)}
					</div>
				)}
			</div>
		</Panel>
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
