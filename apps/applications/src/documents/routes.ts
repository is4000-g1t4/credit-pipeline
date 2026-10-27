// T01 document routes (SPEC-t01-t02 §5): upload, list, metadata,
// pages, download, retry-ocr, claim. Every nested lookup joins
// application_id and 404s on mismatch; feature-off 404s; missing consent
// is 403 CONSENT_REQUIRED; cross-applicant/officer is a non-leaking 404.
// T02 cross-check/chase (D2) live here too: assigned-officer only, no-store,
// ids-only audits.
import { withTx, applications, type Db } from "@credit/db/applications";
import {
	HttpError,
	readJson,
	writeAudit,
	zodFields,
	type Logger,
	type ServiceApp,
} from "@credit/service-kit";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { claimAssignedOfficer, resolveDocumentAccess } from "./access.js";
import { createChaseDraft, getLatestCrosscheck, runDocumentCrosscheck } from "./crosscheck.js";
import { LockTimeout, parseKind } from "./pipeline.js";
import { contentDispositionFor } from "./storage.js";
import { isUuid, UUID_RE } from "../ids.js";
import {
	getCustomerProfile,
	reuseCustomerDocuments,
	type CustomerConfig,
} from "../customer/index.js";
import { effectiveAsOf } from "../customer/requirements.js";
import { DocumentService, type DocumentsConfig, type DocumentFileRow } from "./service.js";

const chaseDraftSchema = z
	.object({
		findingIds: z.array(z.string().regex(UUID_RE)).min(1).max(100),
		inspectedOriginal: z.literal(true),
	})
	.strict();

// T17 reuse selection: explicit customer evidence ids (1–10) with an
// optional kind filter that every selected row must match (422).
const reuseSchema = z
	.object({
		customerDocumentIds: z.array(z.string().regex(UUID_RE)).min(1).max(10),
		kind: z.string().min(1).max(50).optional(),
	})
	.strict();

export interface DocumentRouteDeps {
	db: Db;
	config: DocumentsConfig;
	service: DocumentService;
	logger: Logger;
	/** T17 customer evidence root/keys for copy-on-attach reuse. */
	customer: CustomerConfig;
	t17: { demoMode: boolean; demoAsOf: Date };
	/** Application blob retention for reuse copies. */
	appRetentionDays: number;
	/** E2 hook: re-evaluate integrity after an officer/service mutation. */
	onDocumentMutation?: (input: {
		applicationId: string;
		actor: { id: string; role: string };
		action: "upload" | "reuse" | "crosscheck" | "retry_ocr";
	}) => Promise<void>;
}

/** Metadata only — never page text, nonces, tags, or storage keys. */
export function presentFile(row: DocumentFileRow): Record<string, unknown> {
	return {
		id: row.id,
		applicationId: row.applicationId,
		kind: row.kind,
		status: row.status,
		ocrStatus: row.ocrStatus,
		textLayerRisk: row.textLayerRisk,
		originalFilename: row.originalFilename,
		mimeType: row.mimeType,
		sizeBytes: row.sizeBytes,
		sha256: row.sha256,
		pageCount: row.pageCount,
		ocrConfidence: row.ocrConfidence,
		uploadedBy: row.uploadedBy,
		uploadedAt: row.uploadedAt.toISOString(),
		retentionUntil: row.retentionUntil.toISOString(),
		errorCode: row.errorCode,
	};
}

function noStore(c: { header: (name: string, value: string) => void }): void {
	c.header("Cache-Control", "no-store");
	c.header("X-Content-Type-Options", "nosniff");
}

export function documentRoutes(deps: DocumentRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db, config, service, logger } = deps;

	const auditDenied = async (
		applicationId: string,
		user: { id: string; role: string },
		action: string,
	): Promise<void> => {
		const exists = await db
			.select({ id: applications.id })
			.from(applications)
			.where(eq(applications.id, applicationId))
			.limit(1);
		if (exists.length === 0) return;
		await withTx(db, async (tx) => {
			await writeAudit(tx, {
				applicationId,
				actor: user.id,
				action: "access.denied",
				entity: "document_file",
				payload: { applicationId, role: user.role, attemptedAction: action },
			});
		});
	};

	/** Best-effort integrity evaluation after a successful mutation. The
	 * primary document action must never fail because a review item could not
	 * be created; the route-level `evaluate` endpoint is the retry. */
	const notifyMutation = async (
		applicationId: string,
		user: { id: string; role: string },
		action: "upload" | "reuse" | "crosscheck" | "retry_ocr",
	): Promise<void> => {
		try {
			await deps.onDocumentMutation?.({ applicationId, actor: user, action });
		} catch (err) {
			logger.warn(
				{
					applicationId,
					action,
					errorCode: err instanceof HttpError ? err.code : "unknown",
				},
				"integrity evaluation failed",
			);
		}
	};

	/** Shared uuid → feature → resolve prefix for the document gates.
	 * Draft/consent checks stay in the wrappers: the owner gate 404s
	 * drafts for non-owners while the officer gate 404s every draft and
	 * 403s the owner — intentionally different. */
	const resolveCaseGate = async (
		c: {
			req: { param: (name: string) => string };
			var: { user: { id: string; role: string } };
		},
		attemptedAction: string,
	) => {
		const applicationId = c.req.param("id");
		if (!isUuid(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!config.featureEnabled) throw new HttpError(404, "NOT_FOUND", "not found");
		const resolved = await resolveDocumentAccess(db, applicationId, c.var.user);
		if (!resolved) {
			await auditDenied(applicationId, c.var.user, attemptedAction);
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		return { applicationId, resolved };
	};

	/** Feature → access → consent gate shared by every document route.
	 * T17: drafts are owner-only — officers (even assigned) 404, so drafts
	 * never surface in document access, claim, or crosscheck. */
	const gate = async (c: {
		req: { param: (name: string) => string };
		var: { user: { id: string; role: string } };
	}) => {
		const { applicationId, resolved } = await resolveCaseGate(c, "document_read");
		if (resolved.application.status === "draft" && resolved.access !== "owner") {
			await auditDenied(applicationId, c.var.user, "document_read");
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		if (!resolved.application.documentProcessingConsent) {
			throw new HttpError(403, "CONSENT_REQUIRED", "document processing consent is required");
		}
		return { applicationId, application: resolved.application };
	};

	const auditViewed = async (
		applicationId: string,
		actor: string,
		payload: Record<string, unknown>,
	): Promise<void> => {
		await withTx(db, async (tx) => {
			await writeAudit(tx, {
				applicationId,
				actor,
				action: "document.viewed",
				entity: "document_file",
				payload,
			});
		});
	};

	/** Crosscheck/chase gate: assigned officer only. The applicant owner
	 * is a 403 (they own the case but may never cross-check); everyone
	 * else is a non-leaking 404. Consent follows assignment. */
	const gateOfficer = async (c: {
		req: { param: (name: string) => string };
		var: { user: { id: string; role: string } };
	}) => {
		const { applicationId, resolved } = await resolveCaseGate(c, "document_crosscheck");
		// Drafts never cross-check (claim is draft-blocked, so no grant can
		// exist — this is the belt to that suspenders).
		if (resolved.application.status === "draft") {
			await auditDenied(applicationId, c.var.user, "document_crosscheck");
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		if (resolved.access !== "assigned") {
			await auditDenied(applicationId, c.var.user, "document_crosscheck");
			throw new HttpError(403, "FORBIDDEN", "assigned officers only");
		}
		if (!resolved.application.documentProcessingConsent) {
			throw new HttpError(403, "CONSENT_REQUIRED", "document processing consent is required");
		}
		return { applicationId };
	};

	// NOTE: static D2 routes register BEFORE the `:fileId` param routes
	// below — otherwise `crosscheck` matches `:fileId` and 404s.

	// Deterministic cross-check (SPEC §7, D2): synchronous, cites
	// document/page/quote. 200 {crosscheck,findings}; 409 only when no
	// ready document exists (or the lock times out).
	app.post("/api/applications/:id/documents/crosscheck", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gateOfficer(c);
		const result = await runDocumentCrosscheck(db, config, {
			applicationId,
			officerId: me.id,
		});
		noStore(c);
		logger.info({ crosscheckId: (result.crosscheck as { id: string }).id }, "document crosscheck");
		await notifyMutation(applicationId, me, "crosscheck");
		return c.json(result, 200);
	});

	app.get("/api/applications/:id/documents/crosscheck", async (c) => {
		const { applicationId } = await gateOfficer(c);
		const latest = await getLatestCrosscheck(db, applicationId);
		if (!latest) throw new HttpError(404, "NOT_FOUND", "not found");
		noStore(c);
		return c.json(latest);
	});

	// Draft-only chase (SPEC §7, D2): strict body, nested ids validated,
	// server-recorded original-open required. Draft status, sent_at null —
	// there is no send path.
	app.post("/api/applications/:id/documents/crosscheck/:crosscheckId/chase", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gateOfficer(c);
		const crosscheckId = c.req.param("crosscheckId");
		if (!isUuid(crosscheckId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = chaseDraftSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid chase draft", zodFields(parsed.error));
		}
		const result = await createChaseDraft(db, config, {
			applicationId,
			crosscheckId,
			officerId: me.id,
			findingIds: parsed.data.findingIds,
			inspectedOriginal: true,
		});
		noStore(c);
		logger.info(
			{ chaseRequestId: (result.chase as { id: string }).id, crosscheckId },
			"document chase drafted",
		);
		return c.json(result, 201);
	});

	// Synchronous multipart upload: `file` + `kind` (SPEC §5/§6).
	app.post("/api/applications/:id/documents", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gate(c);
		let body: Record<string, string | File>;
		try {
			body = await c.req.parseBody();
		} catch {
			throw new HttpError(400, "INVALID_MULTIPART", "request must be multipart with file+kind");
		}
		const kind = parseKind(typeof body.kind === "string" ? body.kind : undefined);
		const file = body.file;
		if (!(file instanceof File)) {
			throw new HttpError(400, "MISSING_FILE", "multipart field 'file' is required");
		}
		const bytes = Buffer.from(await file.arrayBuffer());
		const outcome = await service.upload({
			applicationId,
			userId: me.id,
			kind,
			originalFilename: file.name || null,
			bytes,
		});
		noStore(c);
		logger.info({ documentFileId: outcome.file.id, replayed: outcome.replayed }, "document upload");
		if (!outcome.replayed) await notifyMutation(applicationId, me, "upload");
		return c.json({ file: presentFile(outcome.file) }, outcome.httpStatus as 200 | 201);
	});

	// T17 copy-on-attach reuse (SPEC-t17-t18 §2.3): owner-only, explicit
	// `{customerDocumentIds, kind?}`. Clean/fresh evidence copies into new
	// app-scoped blobs with provenance; stale/rejected/expired/unknown is
	// 409/422 and a kind mismatch is 422. Idempotent per
	// (application, source kind, bytes): 201 on copy, 200 on replay.
	app.post("/api/applications/:id/documents/reuse", async (c) => {
		const me = c.var.user;
		const { applicationId, application } = await gate(c);
		if (me.role !== "applicant" || application.applicantUserId !== me.id) {
			await auditDenied(applicationId, me, "document_reuse");
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const parsed = reuseSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid reuse", zodFields(parsed.error));
		}
		const kindFilter = parsed.data.kind === undefined ? undefined : parseKind(parsed.data.kind);
		const profile = await getCustomerProfile(db, me.id);
		if (!profile) throw new HttpError(404, "NOT_FOUND", "not found");
		const asOf = effectiveAsOf({
			appSource: application.source,
			profileSource: profile.source,
			demoMode: deps.t17.demoMode,
			demoAsOf: deps.t17.demoAsOf,
		});
		const outcome = await reuseCustomerDocuments(
			db,
			{
				storageDir: config.storageDir,
				encryptionKey: config.encryptionKey,
				keyId: config.keyId,
				previousKeys: config.previousKeys,
				lockTimeoutMs: config.lockTimeoutMs,
			},
			deps.customer,
			{
				applicationId,
				userId: me.id,
				customerDocumentIds: parsed.data.customerDocumentIds,
				kindFilter,
				asOf,
				appRetentionDays: deps.appRetentionDays,
			},
		);
		noStore(c);
		logger.info(
			{ applicationId, reused: outcome.files.length, created: outcome.created },
			"document reuse",
		);
		if (outcome.created) await notifyMutation(applicationId, me, "reuse");
		return c.json({ files: outcome.files }, outcome.created ? 201 : 200);
	});

	app.get("/api/applications/:id/documents", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gate(c);
		const files = await service.listFiles(applicationId);
		await auditViewed(applicationId, me.id, { fileCount: files.length });
		noStore(c);
		return c.json({ files: files.map(presentFile) });
	});

	app.get("/api/applications/:id/documents/:fileId", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gate(c);
		const fileId = c.req.param("fileId");
		if (!isUuid(fileId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const file = await service.getFile(applicationId, fileId);
		if (!file) throw new HttpError(404, "NOT_FOUND", "not found");
		const pages = await service.getPages(file.id);
		await auditViewed(applicationId, me.id, { documentFileId: file.id, fileCount: 1 });
		noStore(c);
		return c.json({
			file: presentFile(file),
			pages: pages.map((p) => ({
				pageNumber: p.pageNumber,
				source: p.textSource,
				confidence: p.confidence,
				charCount: [...p.text].length,
			})),
		});
	});

	app.get("/api/applications/:id/documents/:fileId/pages", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gate(c);
		const fileId = c.req.param("fileId");
		if (!isUuid(fileId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const file = await service.getFile(applicationId, fileId);
		if (!file) throw new HttpError(404, "NOT_FOUND", "not found");
		if (file.kind === "id") throw new HttpError(409, "NO_TEXT", "id documents carry no page text");
		const pages = await service.getPages(file.id);
		await auditViewed(applicationId, me.id, {
			documentFileId: file.id,
			pageCount: pages.length,
		});
		noStore(c);
		return c.json({
			pages: pages.map((p) => ({
				pageNumber: p.pageNumber,
				text: p.text,
				source: p.textSource,
				confidence: p.confidence,
				charCount: [...p.text].length,
			})),
		});
	});

	app.get("/api/applications/:id/documents/:fileId/file", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gate(c);
		const fileId = c.req.param("fileId");
		if (!isUuid(fileId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const file = await service.getFile(applicationId, fileId);
		if (!file) throw new HttpError(404, "NOT_FOUND", "not found");
		const bytes = await service.openOriginal(file);
		await withTx(db, async (tx) => {
			await writeAudit(tx, {
				applicationId,
				actor: me.id,
				action: "document.original_opened",
				entity: "document_file",
				payload: { documentFileId: file.id, sizeBytes: bytes.length },
			});
		});
		c.header("Cache-Control", "no-store");
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Content-Disposition", contentDispositionFor(file.id, file.mimeType));
		c.header("Content-Length", String(bytes.length));
		return c.body(new Uint8Array(bytes), 200, { "Content-Type": file.mimeType });
	});

	app.post("/api/applications/:id/documents/:fileId/retry-ocr", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gate(c);
		const fileId = c.req.param("fileId");
		if (!isUuid(fileId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const { file } = await service.retryOcr({ applicationId, fileId, userId: me.id });
		noStore(c);
		logger.info({ documentFileId: file.id }, "document retry-ocr");
		await notifyMutation(applicationId, me, "retry_ocr");
		return c.json({ file: presentFile(file) }, 200);
	});

	// Explicit case assignment (SPEC §5/§8): officer-only, idempotent for
	// self. Any other outcome — missing case, another active officer, a
	// revoked self-grant, non-officer caller — is a non-leaking 404. Claim
	// deliberately skips the consent gate (assignment precedes access).
	app.post("/api/applications/:id/documents/claim", async (c) => {
		const me = c.var.user;
		const applicationId = c.req.param("id");
		if (!isUuid(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!config.featureEnabled) throw new HttpError(404, "NOT_FOUND", "not found");
		if (me.role !== "officer") throw new HttpError(404, "NOT_FOUND", "not found");
		// T17: drafts are owner-only — officers cannot claim or read a draft.
		const target = await db
			.select({ status: applications.status })
			.from(applications)
			.where(eq(applications.id, applicationId))
			.limit(1);
		if (!target[0] || target[0].status === "draft") {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		try {
			const { assignment, idempotent } = await claimAssignedOfficer(db, {
				applicationId,
				userId: me.id,
				lockTimeoutMs: config.lockTimeoutMs,
			});
			noStore(c);
			logger.info({ applicationId, idempotent }, "document claim");
			return c.json(
				{
					assignment: {
						applicationId: assignment.applicationId,
						userId: assignment.userId,
						accessRole: assignment.accessRole,
						grantedAt: assignment.grantedAt.toISOString(),
					},
					idempotent,
				},
				200,
			);
		} catch (err) {
			if (err instanceof LockTimeout) {
				throw new HttpError(409, "LOCK_TIMEOUT", "the case is busy; retry the request");
			}
			throw err;
		}
	});

	return app;
}
