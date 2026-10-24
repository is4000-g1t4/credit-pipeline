// T02 deterministic cross-check + draft chase (SPEC-t01-t02 §7, D2).
//
// In-process only: no model call, no external I/O, no decision change.
// Supported comparisons are name/registration only — never address, amount,
// term, revenue, or balance. Every mismatch cites an exact raw-page
// substring with code-point offsets; anything unusable (missing/ambiguous
// labels, low confidence, text-layer risk, no pages, unsupported kind) is
// `needs_chase` with null citation. Document instruction text is inert:
// extraction is fixed label regexes, so injected prose cannot add findings,
// change a rule, or create a chase.
//
// Pure core (`planCrosscheckFindings` + normalizers) is unit-tested without
// a DB; `runDocumentCrosscheck` adds the lock/snapshot/transaction shell.
import { randomUUID } from "node:crypto";
import {
	applications,
	auditLog,
	caseAccessGrants,
	chaseRequestFindings,
	chaseRequests,
	documentCrosschecks,
	documentFiles,
	documentFindings,
	documentPages,
	withTx,
	type Db,
	type Tx,
} from "@credit/db/applications";
import { HttpError, writeAudit } from "@credit/service-kit";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { lockApplication } from "./access.js";
import { sha256Hex } from "./crypto.js";
import { LockTimeout } from "./pipeline.js";

export const CROSSCHECK_VALIDATOR_VERSION = "document-crosscheck-v1";

export interface CrosscheckConfig {
	lockTimeoutMs: number;
	minConfidence: number;
}

// --- Code-point offsets (quotes index raw `document_pages.text` by Unicode
// code point, never UTF-16 — surrogate pairs count as one) ---

/** Slice `text` by Unicode code-point indices (String.prototype tolerant). */
export function codePointSlice(text: string, start: number, end: number): string {
	return [...text].slice(start, end).join("");
}

export function codePointLength(text: string): number {
	return [...text].length;
}

/** UTF-16 index (e.g. RegExp `match.index`) → code-point index. */
export function utf16IndexToCodePoint(text: string, utf16Index: number): number {
	return Array.from(text.slice(0, utf16Index)).length;
}

export function quoteHashFor(quote: string): string {
	return sha256Hex(Buffer.from(quote, "utf8"));
}

// --- Name normalization + comparison ---

// Corporate suffixes whose sole difference downgrades mismatch →
// needs_chase (safe direction: a human decides). Over-inclusion only ever
// softens a mismatch, never hardens one.
const CORPORATE_SUFFIXES = new Set([
	"pte",
	"ltd",
	"limited",
	"inc",
	"incorporated",
	"corp",
	"corporation",
	"llc",
	"plc",
	"sdn",
	"bhd",
	"co",
	"company",
	"pvt",
	"private",
	"holdings",
	"group",
	"llp",
	"lp",
	"ltda",
	"gmbh",
]);

/** NFKC → lowercase → punctuation to spaces → collapsed tokens. */
export function normalizeNameTokens(raw: string): string[] {
	return raw
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((t) => t.length > 0);
}

function tokenSet(tokens: string[]): Set<string> {
	return new Set(tokens);
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const t of a) if (!b.has(t)) return false;
	return true;
}

function stripCorporateSuffix(tokens: Set<string>): Set<string> {
	const out = new Set<string>();
	for (const t of tokens) if (!CORPORATE_SUFFIXES.has(t)) out.add(t);
	return out;
}

/** Every token in `short` is a single initial matching the first letter of
 * a distinct token in `long` ("Tan W M" vs "Tan Wei Ming"). */
function isInitialsOf(short: Set<string>, long: Set<string>): boolean {
	if (short.size === 0 || short.size > long.size) return false;
	const pool = [...long];
	const used = new Set<number>();
	for (const initial of short) {
		if (codePointLength(initial) !== 1) return false;
		const at = pool.findIndex((w, i) => !used.has(i) && w.startsWith(initial));
		if (at < 0) return false;
		used.add(at);
	}
	return true;
}

export type NameVerdict = "match" | "mismatch" | "initials" | "suffix";

export function compareNames(expected: string, observed: string): NameVerdict {
	const e = tokenSet(normalizeNameTokens(expected));
	const o = tokenSet(normalizeNameTokens(observed));
	if (setsEqual(e, o)) return "match";
	if (setsEqual(stripCorporateSuffix(e), stripCorporateSuffix(o))) return "suffix";
	const eDiff = new Set([...e].filter((t) => !o.has(t)));
	const oDiff = new Set([...o].filter((t) => !e.has(t)));
	if (isInitialsOf(eDiff, oDiff) || isInitialsOf(oDiff, eDiff)) return "initials";
	return "mismatch";
}

// --- Registration comparison ---

/** Uppercase alphanumeric only ("2018-12345K" ≡ "201812345K"). */
export function normalizeRegistration(raw: string): string {
	return raw
		.normalize("NFKC")
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
}

const CONFUSABLE_PAIRS = new Set(["O0", "00", "0O", "I1", "11", "1I", "S5", "55", "5S"]);

function isConfusablePair(a: string, b: string): boolean {
	return CONFUSABLE_PAIRS.has(`${a}${b}`);
}

export type RegistrationVerdict = "match" | "mismatch" | "confusable";

export function compareRegistration(expected: string, observed: string): RegistrationVerdict {
	const e = normalizeRegistration(expected);
	const o = normalizeRegistration(observed);
	if (e !== "" && e === o) return "match";
	if (e.length !== o.length || e.length === 0) return "mismatch";
	let diffs = 0;
	for (let i = 0; i < e.length; i++) {
		if (e[i] === o[i]) continue;
		diffs++;
		if (diffs > 1 || !isConfusablePair(e[i] as string, o[i] as string)) return "mismatch";
	}
	return diffs === 1 ? "confusable" : "match";
}

// --- Deterministic label extraction ---

export type FindingField = "company_name" | "registration_number" | "account_holder_name" | "other";

// One label set per field; the value is the rest of the line. No other
// document text (instructions, prose, amounts) can produce a candidate.
const FIELD_PATTERNS: Record<Exclude<FindingField, "other">, RegExp> = {
	company_name:
		/(company\s+name|business\s+name|registered\s+name|entity\s+name)\s*[:=]\s*([^\r\n]+)/i,
	registration_number:
		/(registration(?:\s+(?:number|no\.?|num\.?))?|reg\.?\s*no\.?|company\s+reg(?:istration)?(?:\s+(?:number|no\.?))?|uen)\s*[:=]\s*([^\r\n]+)/i,
	account_holder_name:
		/(account\s+holder(?:\s+name)?|holder\s+name|account\s+name)\s*[:=]\s*([^\r\n]+)/i,
};

export interface ExtractedCandidate {
	observed: string;
	pageNumber: number;
	quote: string;
	quoteStart: number;
	quoteEnd: number;
	quoteHash: string;
	confidence: number;
	source: "pdf_text" | "ocr";
}

export interface PlanPage {
	pageNumber: number;
	text: string;
	confidence: number;
	textSource: "pdf_text" | "ocr";
}

/** All label hits across pages (page order, then position). Empty/blank
 * values are not candidates — they read as `missing`. */
export function extractCandidates(
	field: Exclude<FindingField, "other">,
	pages: PlanPage[],
): ExtractedCandidate[] {
	const pattern = new RegExp(FIELD_PATTERNS[field].source, "gdi");
	const out: ExtractedCandidate[] = [];
	for (const page of pages) {
		pattern.lastIndex = 0;
		for (const match of page.text.matchAll(pattern)) {
			const raw = (match[2] ?? "").trim();
			if (raw === "") continue;
			if (field === "registration_number" && normalizeRegistration(raw) === "") continue;
			const quote = match[0] as string;
			const start = utf16IndexToCodePoint(page.text, match.index ?? 0);
			out.push({
				observed: raw,
				pageNumber: page.pageNumber,
				quote,
				quoteStart: start,
				quoteEnd: start + codePointLength(quote),
				quoteHash: quoteHashFor(quote),
				confidence: page.confidence,
				source: page.textSource,
			});
		}
	}
	return out;
}

export type ExtractionOutcome =
	| { status: "ok"; candidate: ExtractedCandidate }
	| { status: "missing" }
	| { status: "ambiguous" };

/** Distinct observed values (field-normalized) decide ambiguity: repeats of
 * one value cite the first hit; two values need a human. */
export function selectCandidate(
	field: Exclude<FindingField, "other">,
	candidates: ExtractedCandidate[],
): ExtractionOutcome {
	if (candidates.length === 0) return { status: "missing" };
	const keyOf = (observed: string): string =>
		field === "registration_number"
			? normalizeRegistration(observed)
			: [...normalizeNameTokens(observed)].sort().join(" ");
	if (new Set(candidates.map((c) => keyOf(c.observed))).size > 1) return { status: "ambiguous" };
	return { status: "ok", candidate: candidates[0] as ExtractedCandidate };
}

// --- Finding planner (pure: no DB, no I/O) ---

export interface PlanApp {
	type: "individual" | "sme";
	identityFullName: string | null;
	companyName: string | null;
	registrationNumber: string | null;
}

/** Defensive read of the application's jsonb identity/business blocks —
 * legacy/corrupt shapes yield nulls (→ needs_chase), never a throw. */
const textOf = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export function planAppFromRow(row: {
	type: string;
	identity: unknown;
	business: unknown;
}): PlanApp {
	const identityRaw: unknown = row.identity;
	const identity =
		identityRaw !== null && typeof identityRaw === "object"
			? (identityRaw as Record<string, unknown>)
			: {};
	const business =
		row.business !== null && typeof row.business === "object"
			? (row.business as Record<string, unknown>)
			: null;
	return {
		type: row.type === "sme" ? "sme" : "individual",
		identityFullName: textOf(identity["fullName"]),
		companyName: business ? textOf(business["companyName"]) : null,
		registrationNumber: business ? textOf(business["registrationNumber"]) : null,
	};
}

export interface PlanFile {
	file: {
		id: string;
		kind: string;
		ocrStatus: string;
		textLayerRisk: boolean;
	};
	pages: PlanPage[];
}

export type FindingConfidence = "low" | "medium" | "high";
export type FindingStatus = "mismatch" | "needs_chase";

export interface FindingDraft {
	documentFileId: string | null;
	field: FindingField;
	expected: string | null;
	observed: string | null;
	pageNumber: number | null;
	quote: string | null;
	quoteStart: number | null;
	quoteEnd: number | null;
	quoteHash: string | null;
	confidence: FindingConfidence;
	status: FindingStatus;
	reason: string;
}

function cited(
	draft: Omit<
		FindingDraft,
		"observed" | "pageNumber" | "quote" | "quoteStart" | "quoteEnd" | "quoteHash"
	>,
	candidate: ExtractedCandidate,
	observed: string,
): FindingDraft {
	return {
		...draft,
		observed,
		pageNumber: candidate.pageNumber,
		quote: candidate.quote,
		quoteStart: candidate.quoteStart,
		quoteEnd: candidate.quoteEnd,
		quoteHash: candidate.quoteHash,
	};
}

function uncited(
	documentFileId: string | null,
	field: FindingField,
	expected: string | null,
	reason: string,
): FindingDraft {
	return {
		documentFileId,
		field,
		expected,
		observed: null,
		pageNumber: null,
		quote: null,
		quoteStart: null,
		quoteEnd: null,
		quoteHash: null,
		confidence: "low",
		status: "needs_chase",
		reason,
	};
}

function mismatchConfidence(candidate: ExtractedCandidate): FindingConfidence {
	if (candidate.source === "pdf_text") return "high";
	return candidate.confidence >= 0.9 ? "high" : "medium";
}

/** File-level usability gate: anything failing here yields per-field
 * needs_chase with no citation (null when the whole file is unusable). */
function fileGateReason(file: PlanFile["file"], pages: PlanPage[]): string | null {
	if (file.textLayerRisk) return "needs_chase_text_layer_risk";
	if (file.ocrStatus === "low_confidence") return "needs_chase_low_confidence";
	if (file.ocrStatus !== "ready") return "needs_chase_unsupported_ocr";
	if (pages.length === 0) return "needs_chase_no_text";
	return null;
}

interface PlannedField {
	field: FindingField;
	expected: string | null;
	pattern: Exclude<FindingField, "other">;
	isName: boolean;
}

function fieldsFor(app: PlanApp, kind: string): PlannedField[] | "unsupported" {
	if (kind === "business_registration") {
		return [
			{ field: "company_name", expected: app.companyName, pattern: "company_name", isName: true },
			{
				field: "registration_number",
				expected: app.registrationNumber,
				pattern: "registration_number",
				isName: false,
			},
		];
	}
	if (kind === "bank_statement") {
		return [
			{
				field: "account_holder_name",
				expected: app.type === "sme" ? app.companyName : app.identityFullName,
				pattern: "account_holder_name",
				isName: true,
			},
		];
	}
	return "unsupported";
}

export function planCrosscheckFindings(
	app: PlanApp,
	files: PlanFile[],
	minConfidence: number,
): FindingDraft[] {
	const drafts: FindingDraft[] = [];
	for (const { file, pages } of files) {
		const planned = fieldsFor(app, file.kind);
		if (planned === "unsupported") {
			drafts.push(uncited(file.id, "other", null, "needs_chase_unsupported_kind"));
			continue;
		}
		const gate = fileGateReason(file, pages);
		for (const target of planned) {
			if (!target.expected) {
				drafts.push(uncited(file.id, target.field, null, "needs_chase_no_expected"));
				continue;
			}
			if (gate) {
				drafts.push(uncited(file.id, target.field, target.expected, gate));
				continue;
			}
			const outcome = selectCandidate(target.pattern, extractCandidates(target.pattern, pages));
			if (outcome.status === "missing") {
				drafts.push(uncited(file.id, target.field, target.expected, "needs_chase_missing_label"));
				continue;
			}
			if (outcome.status === "ambiguous") {
				drafts.push(uncited(file.id, target.field, target.expected, "needs_chase_ambiguous_label"));
				continue;
			}
			const candidate = outcome.candidate;
			if (candidate.confidence < minConfidence) {
				drafts.push(uncited(file.id, target.field, target.expected, "needs_chase_low_confidence"));
				continue;
			}
			if (target.isName) {
				const verdict = compareNames(target.expected, candidate.observed);
				if (verdict === "match") continue;
				if (verdict === "mismatch") {
					drafts.push(
						cited(
							{
								documentFileId: file.id,
								field: target.field,
								expected: target.expected,
								confidence: mismatchConfidence(candidate),
								status: "mismatch",
								reason: "value_mismatch",
							},
							candidate,
							candidate.observed,
						),
					);
				} else {
					drafts.push(
						cited(
							{
								documentFileId: file.id,
								field: target.field,
								expected: target.expected,
								confidence: "low",
								status: "needs_chase",
								reason: verdict === "initials" ? "needs_chase_initials" : "needs_chase_suffix",
							},
							candidate,
							candidate.observed,
						),
					);
				}
			} else {
				const verdict = compareRegistration(target.expected, candidate.observed);
				if (verdict === "match") continue;
				if (verdict === "mismatch") {
					drafts.push(
						cited(
							{
								documentFileId: file.id,
								field: target.field,
								expected: target.expected,
								confidence: mismatchConfidence(candidate),
								status: "mismatch",
								reason: "value_mismatch",
							},
							candidate,
							candidate.observed,
						),
					);
				} else {
					drafts.push(
						cited(
							{
								documentFileId: file.id,
								field: target.field,
								expected: target.expected,
								confidence: "low",
								status: "needs_chase",
								reason: "needs_chase_confusable",
							},
							candidate,
							candidate.observed,
						),
					);
				}
			}
		}
	}
	return drafts;
}

// --- Presenters (rows → JSON; findings carry the cited text by design,
// routes add `no-store` and audits stay ids-only) ---

type CrosscheckRow = typeof documentCrosschecks.$inferSelect;
type FindingRow = typeof documentFindings.$inferSelect;
type ChaseRow = typeof chaseRequests.$inferSelect;

export function presentCrosscheck(row: CrosscheckRow): Record<string, unknown> {
	return {
		id: row.id,
		applicationId: row.applicationId,
		status: row.status,
		validatorVersion: row.validatorVersion,
		documentsChecked: row.documentsChecked,
		findingCount: row.findingCount,
		requestedBy: row.requestedBy,
		startedAt: row.startedAt.toISOString(),
		finishedAt: row.finishedAt?.toISOString() ?? null,
		errorCode: row.errorCode,
	};
}

export function presentFinding(row: FindingRow): Record<string, unknown> {
	return {
		id: row.id,
		crosscheckId: row.crosscheckId,
		applicationId: row.applicationId,
		documentFileId: row.documentFileId,
		field: row.field,
		expected: row.expected,
		observed: row.observed,
		pageNumber: row.pageNumber,
		quote: row.quote,
		quoteStart: row.quoteStart,
		quoteEnd: row.quoteEnd,
		quoteHash: row.quoteHash,
		confidence: row.confidence,
		status: row.status,
		reason: row.reason,
		createdAt: row.createdAt.toISOString(),
	};
}

export function presentChase(row: ChaseRow, findingIds: string[]): Record<string, unknown> {
	return {
		id: row.id,
		applicationId: row.applicationId,
		crosscheckId: row.crosscheckId,
		status: row.status,
		body: row.body,
		createdBy: row.createdBy,
		createdAt: row.createdAt.toISOString(),
		sentAt: row.sentAt?.toISOString() ?? null,
		inspectedOriginalAt: row.inspectedOriginalAt.toISOString(),
		findingIds,
	};
}

// --- Transactional runs ---

export interface CrosscheckActor {
	applicationId: string;
	officerId: string;
}

async function requireAssignedOfficer(
	tx: Tx,
	applicationId: string,
	officerId: string,
): Promise<typeof applications.$inferSelect> {
	const apps = await tx.select().from(applications).where(eq(applications.id, applicationId));
	const app = apps[0];
	if (!app) throw new HttpError(404, "NOT_FOUND", "not found");
	const grants = await tx
		.select({ id: caseAccessGrants.id })
		.from(caseAccessGrants)
		.where(
			and(
				eq(caseAccessGrants.applicationId, applicationId),
				eq(caseAccessGrants.userId, officerId),
				eq(caseAccessGrants.accessRole, "assigned_officer"),
				isNull(caseAccessGrants.revokedAt),
			),
		)
		.limit(1);
	if (!grants[0]) throw new HttpError(404, "NOT_FOUND", "not found");
	if (!app.documentProcessingConsent) {
		throw new HttpError(403, "CONSENT_REQUIRED", "document processing consent is required");
	}
	return app;
}

/** Latest `ready` file per kind, `(uploaded_at, id)` order — the losers are
 * superseded, never compared. */
function latestPerKind<T extends { kind: string }>(files: T[]): T[] {
	const latest = new Map<string, T>();
	for (const file of files) latest.set(file.kind, file);
	return [...latest.values()];
}

function failCrosscheck(tx: Tx, input: CrosscheckActor, crosscheckId: string): Promise<void> {
	return (async () => {
		await tx.insert(documentCrosschecks).values({
			id: crosscheckId,
			applicationId: input.applicationId,
			status: "failed",
			validatorVersion: CROSSCHECK_VALIDATOR_VERSION,
			documentsChecked: [],
			findingCount: 0,
			requestedBy: input.officerId,
			finishedAt: new Date(),
			errorCode: "INTERNAL_ERROR",
		});
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: input.officerId,
			action: "document.crosscheck_completed",
			entity: "document_crosscheck",
			payload: { crosscheckId, errorCode: "INTERNAL_ERROR" },
		});
	})();
}

/** Deterministic run: advisory lock + repeatable-read snapshot, then ONE
 * transaction persisting the crosscheck, its findings, and ids-only audits.
 * Assigned officer only (else non-leaking 404); withdrawn consent 403s;
 * zero ready files 409s. Unexpected failures persist a `failed` row and
 * throw typed — logs carry codes, never content. */
export async function runDocumentCrosscheck(
	db: Db,
	config: CrosscheckConfig,
	input: CrosscheckActor,
): Promise<{ crosscheck: Record<string, unknown>; findings: Record<string, unknown>[] }> {
	const crosscheckId = randomUUID();
	const run = async (): Promise<{
		crosscheck: Record<string, unknown>;
		findings: Record<string, unknown>[];
	}> =>
		db.transaction(
			async (tx) => {
				await lockApplication(tx, input.applicationId, config.lockTimeoutMs);
				const app = await requireAssignedOfficer(tx, input.applicationId, input.officerId);
				await writeAudit(tx, {
					applicationId: input.applicationId,
					actor: input.officerId,
					action: "document.crosscheck_started",
					entity: "document_crosscheck",
					payload: { crosscheckId },
				});
				const ready = await tx
					.select()
					.from(documentFiles)
					.where(
						and(
							eq(documentFiles.applicationId, input.applicationId),
							eq(documentFiles.status, "ready"),
						),
					)
					.orderBy(documentFiles.uploadedAt, documentFiles.id);
				const selected = latestPerKind(ready);
				if (selected.length === 0) {
					throw new HttpError(409, "DOCUMENTS_NOT_READY", "no ready documents to cross-check");
				}
				const documentsChecked = selected.map((f) => f.id);
				const planFiles: PlanFile[] = [];
				for (const file of selected) {
					const pages = await tx
						.select()
						.from(documentPages)
						.where(eq(documentPages.documentFileId, file.id))
						.orderBy(documentPages.pageNumber);
					planFiles.push({
						file: {
							id: file.id,
							kind: file.kind,
							ocrStatus: file.ocrStatus,
							textLayerRisk: file.textLayerRisk,
						},
						pages: pages.map((p) => ({
							pageNumber: p.pageNumber,
							text: p.text,
							confidence: p.confidence,
							textSource: p.textSource,
						})),
					});
				}
				const drafts = planCrosscheckFindings(planAppFromRow(app), planFiles, config.minConfidence);
				// Citation invariant inside the insert transaction: every
				// cited quote must be an exact code-point substring of its
				// page, with matching hash, on a file of this application.
				const pagesByKey = new Map(
					planFiles.flatMap((pf) => pf.pages.map((p) => [`${pf.file.id}:${p.pageNumber}`, p])),
				);
				for (const draft of drafts) {
					if (draft.status === "mismatch") {
						if (
							!draft.documentFileId ||
							draft.pageNumber === null ||
							draft.quote === null ||
							draft.quoteStart === null ||
							draft.quoteEnd === null ||
							draft.quoteHash === null
						) {
							throw new Error("mismatch citation incomplete");
						}
					}
					if (draft.quote !== null) {
						const page = pagesByKey.get(`${draft.documentFileId}:${draft.pageNumber}`);
						if (!page) throw new Error("citation page not in snapshot");
						if (
							codePointSlice(page.text, draft.quoteStart as number, draft.quoteEnd as number) !==
							draft.quote
						) {
							throw new Error("citation quote mismatch");
						}
						if (quoteHashFor(draft.quote) !== draft.quoteHash)
							throw new Error("citation hash mismatch");
					}
				}
				const [crosscheck] = await tx
					.insert(documentCrosschecks)
					.values({
						id: crosscheckId,
						applicationId: input.applicationId,
						status: "succeeded",
						validatorVersion: CROSSCHECK_VALIDATOR_VERSION,
						documentsChecked,
						findingCount: drafts.length,
						requestedBy: input.officerId,
						finishedAt: new Date(),
						errorCode: null,
					})
					.returning();
				const inserted =
					drafts.length === 0
						? []
						: await tx
								.insert(documentFindings)
								.values(
									drafts.map((d) => ({
										crosscheckId,
										applicationId: input.applicationId,
										documentFileId: d.documentFileId,
										field: d.field,
										expected: d.expected,
										observed: d.observed,
										pageNumber: d.pageNumber,
										quote: d.quote,
										quoteStart: d.quoteStart,
										quoteEnd: d.quoteEnd,
										quoteHash: d.quoteHash,
										confidence: d.confidence,
										status: d.status,
										reason: d.reason,
									})),
								)
								.returning();
				await writeAudit(tx, {
					applicationId: input.applicationId,
					actor: input.officerId,
					action: "document.crosscheck_completed",
					entity: "document_crosscheck",
					payload: {
						crosscheckId,
						findingCount: drafts.length,
						documentCount: documentsChecked.length,
					},
				});
				return {
					crosscheck: presentCrosscheck(crosscheck),
					findings: inserted.map(presentFinding),
				};
			},
			{ isolationLevel: "repeatable read" },
		);
	try {
		return await run();
	} catch (err) {
		if (err instanceof HttpError) throw err;
		if (err instanceof LockTimeout) {
			throw new HttpError(409, "LOCK_TIMEOUT", "the case is busy; retry the request");
		}
		try {
			await withTx(db, async (tx) => {
				await lockApplication(tx, input.applicationId, config.lockTimeoutMs);
				await failCrosscheck(tx, input, crosscheckId);
			});
		} catch {
			// Best-effort: the typed 500 below is the contract.
		}
		throw new HttpError(500, "INTERNAL_ERROR", "internal error");
	}
}

/** Re-check citations against current page text. Findings are immutable in
 * normal operation, but OCR retry/retention or DB tampering must never make
 * the API or a chase draft cite a quote that is no longer present. */
async function validFindings(
	db: Db | Tx,
	findings: Array<typeof documentFindings.$inferSelect>,
): Promise<Array<typeof documentFindings.$inferSelect>> {
	const fileIds = [
		...new Set(findings.flatMap((f) => (f.documentFileId ? [f.documentFileId] : []))),
	];
	if (fileIds.length === 0) return findings;
	const pages = await db
		.select({
			documentFileId: documentPages.documentFileId,
			pageNumber: documentPages.pageNumber,
			text: documentPages.text,
		})
		.from(documentPages)
		.where(inArray(documentPages.documentFileId, fileIds));
	const byPage = new Map(pages.map((p) => [`${p.documentFileId}:${p.pageNumber}`, p.text]));
	return findings.filter((f) => {
		if (!f.documentFileId || f.pageNumber === null) {
			return f.status === "needs_chase";
		}
		if (f.quote === null || f.quoteStart === null || f.quoteEnd === null || f.quoteHash === null) {
			return f.status === "needs_chase";
		}
		const page = byPage.get(`${f.documentFileId}:${f.pageNumber}`);
		if (page === undefined) return false;
		return (
			codePointSlice(page, f.quoteStart, f.quoteEnd) === f.quote &&
			quoteHashFor(f.quote) === f.quoteHash
		);
	});
}

/** Latest run for an application (null when never run). Findings are scoped
 * to the same application — a cross-app id can never match. */
export async function getLatestCrosscheck(
	db: Db,
	applicationId: string,
): Promise<{ crosscheck: Record<string, unknown>; findings: Record<string, unknown>[] } | null> {
	const rows = await db
		.select()
		.from(documentCrosschecks)
		.where(eq(documentCrosschecks.applicationId, applicationId))
		.orderBy(desc(documentCrosschecks.startedAt), desc(documentCrosschecks.id))
		.limit(1);
	const crosscheck = rows[0];
	if (!crosscheck) return null;
	const findings = await db
		.select()
		.from(documentFindings)
		.where(
			and(
				eq(documentFindings.crosscheckId, crosscheck.id),
				eq(documentFindings.applicationId, applicationId),
			),
		)
		.orderBy(documentFindings.createdAt, documentFindings.id);
	const valid = await validFindings(db, findings);
	const presented = presentCrosscheck(crosscheck);
	presented.findingCount = valid.length;
	return { crosscheck: presented, findings: valid.map(presentFinding) };
}

// --- Draft chase ---

export interface ChaseInput extends CrosscheckActor {
	crosscheckId: string;
	findingIds: string[];
	inspectedOriginal: boolean;
}

function describeCitation(f: typeof documentFindings.$inferSelect): string {
	const doc = f.documentFileId ?? "no document";
	if (f.quote === null || f.pageNumber === null) {
		return `${doc} (no usable citation — manual review)`;
	}
	return `${doc} page ${f.pageNumber}: ${JSON.stringify(f.quote)}`;
}

/** Draft body cites field + expected/observed + document/page/quote per
 * finding (the draft is the officer's working paper — audit stays ids-only). */
export function buildChaseBody(findings: Array<typeof documentFindings.$inferSelect>): string {
	const lines = findings.map((f) => {
		const expected = f.expected === null ? "not available" : JSON.stringify(f.expected);
		const observed = f.observed === null ? "not available" : JSON.stringify(f.observed);
		return `- Field ${f.field} (${f.status}, ${f.reason}): expected ${expected}, observed ${observed} — ${describeCitation(f)}`;
	});
	return `Document chase draft — please provide a clearer copy or confirm the following:\n${lines.join("\n")}`;
}

/** Draft-only chase (v1 never sends): validates the nested ids, consent,
 * and a server-recorded `document.original_opened` audit event by this
 * officer for a cited file — the client flag alone is not enough. One
 * transaction inserts the draft + links + ids-only audit. */
export async function createChaseDraft(
	db: Db,
	config: Pick<CrosscheckConfig, "lockTimeoutMs">,
	input: ChaseInput,
): Promise<{ chase: Record<string, unknown>; findings: Record<string, unknown>[] }> {
	if (!input.inspectedOriginal) {
		throw new HttpError(400, "VALIDATION_ERROR", "inspectedOriginal must be true");
	}
	const findingIds = [...new Set(input.findingIds)];
	if (findingIds.length === 0) {
		throw new HttpError(400, "VALIDATION_ERROR", "findingIds must not be empty");
	}
	return withTx(db, async (tx) => {
		await lockApplication(tx, input.applicationId, config.lockTimeoutMs);
		await requireAssignedOfficer(tx, input.applicationId, input.officerId);
		const crossRows = await tx
			.select()
			.from(documentCrosschecks)
			.where(
				and(
					eq(documentCrosschecks.id, input.crosscheckId),
					eq(documentCrosschecks.applicationId, input.applicationId),
				),
			)
			.limit(1);
		const crosscheck = crossRows[0];
		if (!crosscheck) throw new HttpError(404, "NOT_FOUND", "not found");
		const selected = await tx
			.select()
			.from(documentFindings)
			.where(
				and(
					inArray(documentFindings.id, findingIds),
					eq(documentFindings.crosscheckId, input.crosscheckId),
					eq(documentFindings.applicationId, input.applicationId),
				),
			);
		if (
			selected.length !== findingIds.length ||
			selected.some((f) => f.status !== "mismatch" && f.status !== "needs_chase")
		) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const current = await validFindings(tx, selected);
		if (current.length !== selected.length) {
			throw new HttpError(
				409,
				"STALE_CITATION",
				"a selected citation no longer matches the document; rerun the cross-check",
			);
		}
		const selectedFileIds = [
			...new Set(selected.flatMap((f) => (f.documentFileId ? [f.documentFileId] : []))),
		];
		const openings = await tx
			.select({ payload: auditLog.payload })
			.from(auditLog)
			.where(
				and(
					eq(auditLog.applicationId, input.applicationId),
					eq(auditLog.actor, input.officerId),
					eq(auditLog.action, "document.original_opened"),
				),
			);
		const opened = new Set(
			openings.flatMap((row) => {
				const payload =
					row.payload !== null && typeof row.payload === "object"
						? (row.payload as Record<string, unknown>)
						: null;
				return typeof payload?.["documentFileId"] === "string" ? [payload["documentFileId"]] : [];
			}),
		);
		if (selectedFileIds.length === 0 || !selectedFileIds.every((id) => opened.has(id))) {
			throw new HttpError(
				409,
				"ORIGINAL_NOT_OPENED",
				"open every cited original document before drafting a chase",
			);
		}
		const now = new Date();
		const [chase] = await tx
			.insert(chaseRequests)
			.values({
				applicationId: input.applicationId,
				crosscheckId: input.crosscheckId,
				status: "draft",
				body: buildChaseBody(selected),
				createdBy: input.officerId,
				sentAt: null,
				inspectedOriginalAt: now,
			})
			.returning();
		await tx
			.insert(chaseRequestFindings)
			.values(selected.map((f) => ({ chaseRequestId: chase.id, findingId: f.id })));
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: input.officerId,
			action: "document.chase_drafted",
			entity: "chase_request",
			payload: {
				chaseRequestId: chase.id,
				crosscheckId: input.crosscheckId,
				findingIds,
				findingCount: selected.length,
			},
		});
		return { chase: presentChase(chase, findingIds), findings: selected.map(presentFinding) };
	}).catch((err: unknown) => {
		if (err instanceof HttpError) throw err;
		if (err instanceof LockTimeout) {
			throw new HttpError(409, "LOCK_TIMEOUT", "the case is busy; retry the request");
		}
		throw new HttpError(500, "INTERNAL_ERROR", "internal error");
	});
}
