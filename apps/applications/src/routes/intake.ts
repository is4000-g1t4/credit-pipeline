// T17 customer/intake routes (SPEC-t17-t18 §2.3): drafts, submit,
// requirements, and context consent. Drafts carry no workflow, outbox, or
// T11 event; submit re-runs requirementsFor under the user + application
// locks and only then writes application.submitted + starts the workflow
// (the worker refer step still owns `review.requested`).
import {
	AI_RESEARCH_CONSENT_VERSION,
	CONTEXT_CONSENT_VERSION,
	DOCUMENT_CONSENT_VERSION,
	applicationCreateSchema,
	applicationDraftUpdateSchema,
	canonicalJson,
	dedupeApplicationSubmitted,
	generateReference,
	hashCanonical,
	isAdult,
} from "@credit/core";
import {
	applicationProfileConfirmations,
	applications,
	customerDocuments,
	documentFiles,
	idempotencyKeys,
	withTx,
	type Db,
} from "@credit/db/applications";
import {
	HttpError,
	insertOutbox,
	readJson,
	signInternalHeaders,
	writeAudit,
	zodFields,
	type Logger,
	type ServiceApp,
	type WorkflowGateway,
} from "@credit/service-kit";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getCustomerProfile, readConfirmations } from "../customer/service.js";
import {
	confirmationHmac,
	deriveConfirmations,
	effectiveAsOf,
	getConfirmableValue,
	isConfirmableField,
	requirementsFor,
} from "../customer/requirements.js";
import { isUniqueViolation } from "../documents/pipeline.js";
import { resolveDocumentAccess } from "../documents/access.js";
import { isUuid, readIdempotencyReplay } from "../ids.js";

const contextConsentSchema = z.object({ consent: z.boolean() }).strict();

export interface T17Clock {
	demoMode: boolean;
	demoAsOf: Date;
	/** Server HMAC key for profile-confirmation hashes (internal secret). */
	confirmationKey: string;
}

export interface IntakeRouteDeps {
	db: Db;
	gateway: WorkflowGateway;
	logger: Logger;
	t17: T17Clock;
	/** T18 purge callback target (optional): research service base URL. */
	researchUrl?: string;
	/** Internal secret for the service-HMAC purge callback. */
	internalSecret: string;
}

function asOfFor(
	t17: T17Clock,
	app: { source: "live" | "demo_case" } | null,
	profile: { source: "demo_seed" | "customer_master" } | null,
	now?: Date,
): Date {
	return effectiveAsOf({
		appSource: app?.source ?? null,
		profileSource: profile?.source ?? null,
		demoMode: t17.demoMode,
		demoAsOf: t17.demoAsOf,
		now,
	});
}

async function buildRequirements(
	db: Db,
	t17: T17Clock,
	applicationId: string,
	now?: Date,
): Promise<ReturnType<typeof requirementsFor>> {
	const appRows = await db.select().from(applications).where(eq(applications.id, applicationId));
	const app = appRows[0];
	if (!app) throw new HttpError(404, "NOT_FOUND", "not found");
	const profile = await getCustomerProfile(db, app.applicantUserId);
	const [confirmed, appDocs, customerDocs] = await Promise.all([
		readConfirmations(db, applicationId),
		db
			.select()
			.from(documentFiles)
			.where(
				and(
					eq(documentFiles.applicationId, applicationId),
					sql`${documentFiles.status} != 'deleted'`,
				),
			),
		profile
			? db.select().from(customerDocuments).where(eq(customerDocuments.customerId, profile.id))
			: Promise.resolve([]),
	]);
	const asOf = asOfFor(t17, app, profile, now);
	return requirementsFor({
		product: app.product,
		asOf,
		profile: profile
			? {
					kycStatus: profile.kycStatus,
					kycExpiresAt: profile.kycExpiresAt,
					identity: (profile.identity ?? {}) as Record<string, unknown>,
					business: (profile.business ?? null) as Record<string, unknown> | null,
				}
			: null,
		application: {
			identity: (app.identity ?? {}) as Record<string, unknown>,
			sme: (app.business ?? null) as Record<string, unknown> | null,
			consents: app.consents,
			documentProcessingConsent: app.documentProcessingConsent,
		},
		confirmedFields: confirmed,
		appDocs: appDocs.map((d) => ({
			kind: d.kind,
			status: d.status,
			periodEnd: d.periodEnd,
			documentDate: d.documentDate,
			uploadedAt: d.uploadedAt,
			id: d.id,
			documentDateSource: (d as { documentDateSource?: string | null }).documentDateSource ?? null,
		})),
		customerDocs: customerDocs.map((d) => ({
			id: d.id,
			kind: d.kind,
			status: d.status,
			scanStatus: d.scanStatus,
			retentionUntil: d.retentionUntil,
			blobPurgedAt: d.blobPurgedAt,
			periodEnd: d.periodEnd,
			documentDate: d.documentDate,
		})),
	});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

type DraftResponse = { id: string; reference: string; updatedAt: string };

function draftResponse(row: { id: string; reference: string; updatedAt: Date }): DraftResponse {
	return { id: row.id, reference: row.reference, updatedAt: row.updatedAt.toISOString() };
}

/** Idempotent draft replay with the §4 shape: legacy stored responses
 * (written before `updatedAt` existed) are filled in from the draft row. */
async function readDraftReplay(
	db: Db,
	input: { userId: string; key: string; requestHash: string },
): Promise<DraftResponse | null> {
	const found = await readIdempotencyReplay(db, input);
	if (!found) return null;
	if (typeof (found as { updatedAt?: unknown }).updatedAt === "string") {
		return found as DraftResponse;
	}
	const rows = await db
		.select({
			id: applications.id,
			reference: applications.reference,
			updatedAt: applications.updatedAt,
		})
		.from(applications)
		.where(eq(applications.id, found.id));
	const row = rows[0];
	if (!row) return found as DraftResponse;
	return draftResponse(row);
}

export function intakeRoutes(deps: IntakeRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db, gateway, logger, t17 } = deps;

	// Best-effort T18 purge callback on consent withdrawal: tells the
	// research service (service HMAC) to supersede signals and null stored
	// briefs. Never fails the consent update — research read-gating on the
	// live flag already hides prior context immediately. Retries briefly
	// (3 attempts); a terminal failure records a durable `context.purge_failed`
	// audit row (attempts/status) so the drop is visible and reconcilable,
	// never silent. No-op without a configured research URL.
	const requestContextPurge = async (applicationId: string, actor: string): Promise<void> => {
		const base = deps.researchUrl;
		if (!base) return;
		const path = `/internal/research/applications/${applicationId}/context/purge`;
		const headers = {
			"content-type": "application/json",
			...signInternalHeaders(deps.internalSecret, {
				// Nil service principal: the audit actor column is a
				// uuid; the purge audit carries counts, not identity.
				userId: "00000000-0000-0000-0000-000000000000",
				role: "service",
				email: "applications@internal.local",
				method: "POST",
				path,
				body: "{}",
			}),
		};
		let lastStatus: number | null = null;
		let lastError = "unknown";
		for (let attempt = 1; attempt <= 3; attempt++) {
			if (attempt > 1) {
				await new Promise((r) => setTimeout(r, 250 * attempt));
			}
			try {
				const res = await fetch(`${base}${path}`, {
					method: "POST",
					headers,
					body: "{}",
					signal: AbortSignal.timeout(10_000),
				});
				if (res.ok) return;
				lastStatus = res.status;
				lastError = `status ${res.status}`;
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
			}
		}
		logger.warn({ applicationId, lastStatus, lastError }, "context purge callback failed");
		try {
			await withTx(db, (tx) =>
				writeAudit(tx, {
					applicationId,
					actor,
					action: "context.purge_failed",
					entity: "application",
					payload: { attempts: 3, lastStatus, lastError },
				}),
			);
		} catch (err) {
			logger.warn(
				{ applicationId, err: err instanceof Error ? err.message : String(err) },
				"context purge failure marker failed",
			);
		}
	};

	// Draft create: same strict payload/profile confirmations as direct
	// create, but status=draft + submittedAt=null with no workflow, outbox,
	// or T11 event. Idempotency-Key scoped like create (409 on cross-app
	// reuse); max 3 active drafts under the applicant-user lock.
	app.post("/api/applications/drafts", async (c) => {
		const me = c.var.user;
		if (me.role !== "applicant") {
			throw new HttpError(403, "FORBIDDEN", "applicants only");
		}
		const key = c.req.header("Idempotency-Key")?.trim();
		if (!key) {
			throw new HttpError(400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required");
		}
		const body = await readJson(c);
		const parsed = applicationCreateSchema.safeParse(body);
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid application", zodFields(parsed.error));
		}
		const data = parsed.data;
		const now = new Date();
		if (!isAdult(data.identity.dob, now)) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid application", {
				"identity.dob": ["owner must be 18 or older"],
			});
		}
		if (data.identity.email.toLowerCase() !== me.email.toLowerCase()) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid application", {
				"identity.email": ["must match the signed-in email"],
			});
		}
		// Confirmation fields are allowlisted before any write (422).
		for (const entry of data.profileConfirmations ?? []) {
			if (!isConfirmableField(entry.field)) {
				throw new HttpError(422, "INVALID_FIELD", `unknown confirmation field: ${entry.field}`);
			}
		}
		const requestHash = hashCanonical(body);

		const fast = await readDraftReplay(db, { userId: me.id, key, requestHash });
		if (fast) return c.json(fast, 201);

		let outcome: DraftResponse;
		try {
			outcome = await withTx(db, async (tx) => {
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${me.id}))`);
				const rows = await tx
					.select()
					.from(idempotencyKeys)
					.where(and(eq(idempotencyKeys.userId, me.id), eq(idempotencyKeys.key, key)));
				const existing = rows[0];
				if (existing) {
					if (existing.requestHash !== requestHash) {
						throw new HttpError(
							409,
							"IDEMPOTENCY_CONFLICT",
							"Idempotency-Key was already used with a different payload",
						);
					}
					const stored = existing.response as DraftResponse;
					if (typeof stored.updatedAt === "string") return stored;
					const draftRows = await tx
						.select({
							id: applications.id,
							reference: applications.reference,
							updatedAt: applications.updatedAt,
						})
						.from(applications)
						.where(eq(applications.id, stored.id));
					const draftRow = draftRows[0];
					return draftRow ? draftResponse(draftRow) : stored;
				}
				const drafts = await tx
					.select({ id: applications.id })
					.from(applications)
					.where(and(eq(applications.applicantUserId, me.id), eq(applications.status, "draft")));
				if (drafts.length >= 3) {
					throw new HttpError(409, "TOO_MANY_DRAFTS", "at most 3 active drafts");
				}
				const profiles = await getCustomerProfile(tx as unknown as Db, me.id);
				const source =
					t17.demoMode && profiles?.source === "demo_seed"
						? ("demo_case" as const)
						: ("live" as const);
				let inserted: { id: string; reference: string; updatedAt: Date } | null = null;
				let lastErr: unknown = null;
				for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
					try {
						const [row] = await tx
							.insert(applications)
							.values({
								reference: generateReference(now.getUTCFullYear()),
								applicantUserId: me.id,
								type: data.type,
								product: data.product,
								status: "draft",
								amountCents: data.amountCents,
								termMonths: data.termMonths,
								purpose: data.purpose,
								identity: data.identity,
								financial: data.individual ?? null,
								business: data.sme ?? null,
								consents: data.consents,
								aiResearchConsent: data.aiResearchConsent,
								documentProcessingConsent: data.documentProcessingConsent,
								documentConsentAt: data.documentProcessingConsent ? now : null,
								documentConsentVersion: data.documentProcessingConsent
									? DOCUMENT_CONSENT_VERSION
									: null,
								contextAnalysisConsent: data.contextAnalysisConsent ?? false,
								contextConsentAt: data.contextAnalysisConsent ? now : null,
								contextConsentVersion: data.contextAnalysisConsent ? CONTEXT_CONSENT_VERSION : null,
								source,
								submittedAt: null,
							})
							.returning({
								id: applications.id,
								reference: applications.reference,
								updatedAt: applications.updatedAt,
							});
						inserted = row;
					} catch (err) {
						lastErr = err;
						if (!isUniqueViolation(err)) throw err;
					}
				}
				if (!inserted) throw lastErr;
				// Server-derived confirmations: canonical equality only —
				// client hashes are advisory and can never mark edited reused.
				let reused: string[] = [];
				let edited: string[] = [];
				if (profiles && data.profileConfirmations?.length) {
					const derived = deriveConfirmations({
						application: {
							identity: data.identity as Record<string, unknown>,
							sme: (data.sme ?? null) as Record<string, unknown> | null,
						},
						profile: {
							identity: (profiles.identity ?? {}) as Record<string, unknown>,
							business: (profiles.business ?? null) as Record<string, unknown> | null,
						},
						claimed: data.profileConfirmations,
					});
					reused = [...new Set(derived.reused)];
					edited = [...new Set(derived.edited)];
					if (reused.length > 0) {
						await tx.insert(applicationProfileConfirmations).values(
							reused.map((field) => ({
								applicationId: (inserted as { id: string }).id,
								customerProfileId: profiles.id,
								field,
								valueHash: confirmationHmac(
									getConfirmableValue(
										{
											identity: data.identity as Record<string, unknown>,
											sme: (data.sme ?? null) as Record<string, unknown> | null,
										},
										field,
									),
									t17.confirmationKey,
								),
							})),
						);
					}
					await writeAudit(tx, {
						applicationId: (inserted as { id: string }).id,
						actor: me.id,
						action: "customer.profile_confirmed",
						entity: "application",
						payload: { reused, edited },
					});
				}
				const response = draftResponse(inserted);
				await tx.insert(idempotencyKeys).values({
					userId: me.id,
					key,
					requestHash,
					applicationId: inserted.id,
					response,
				});
				await writeAudit(tx, {
					applicationId: inserted.id,
					actor: me.id,
					action: "application.draft_created",
					entity: "application",
					payload: {
						reference: inserted.reference,
						type: data.type,
						product: data.product,
					},
				});
				return response;
			});
		} catch (err) {
			if (err instanceof HttpError) throw err;
			if (!isUniqueViolation(err)) throw err;
			const winner = await readDraftReplay(db, { userId: me.id, key, requestHash });
			if (!winner) throw err;
			return c.json(winner, 201);
		}
		// No workflow start, no outbox: drafts are inert until submit.
		return c.json(outcome, 201);
	});

	// Draft update (SPEC §4): owner-only optimistic PATCH over the full
	// create payload plus the `expectedUpdatedAt` token. Absent consent
	// fields mean unchanged (merged from the stored row before parsing);
	// an explicitly differing document/context consent 409s to the
	// dedicated consent routes. No workflow, outbox, or idempotency key —
	// a retry after success 409s and the UI reloads.
	app.patch("/api/applications/:id/draft", async (c) => {
		const me = c.var.user;
		if (me.role !== "applicant") {
			throw new HttpError(403, "FORBIDDEN", "applicants only");
		}
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rawBody: unknown = await readJson(c);
		const bodyRec: Record<string, unknown> = isPlainObject(rawBody) ? rawBody : {};
		const rawApp: unknown = bodyRec.application;
		const suppliedApp: Record<string, unknown> | null = isPlainObject(rawApp)
			? { ...rawApp }
			: null;
		// Pre-read (outside the tx) for the ownership/status gates and the
		// absent-means-unchanged consent merge.
		const preRows = await db.select().from(applications).where(eq(applications.id, id));
		const pre = preRows[0];
		if (!pre || pre.applicantUserId !== me.id) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		if (pre.status !== "draft") {
			throw new HttpError(409, "NOT_DRAFT", "only drafts can be updated");
		}
		const docExplicit = suppliedApp !== null && "documentProcessingConsent" in suppliedApp;
		const ctxExplicit = suppliedApp !== null && "contextAnalysisConsent" in suppliedApp;
		if (suppliedApp !== null) {
			if (!("aiResearchConsent" in suppliedApp))
				suppliedApp.aiResearchConsent = pre.aiResearchConsent;
			if (!docExplicit) suppliedApp.documentProcessingConsent = pre.documentProcessingConsent;
			if (!ctxExplicit) suppliedApp.contextAnalysisConsent = pre.contextAnalysisConsent;
		}
		const parsed = applicationDraftUpdateSchema.safeParse({
			...bodyRec,
			application: suppliedApp ?? rawApp,
		});
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid application", zodFields(parsed.error));
		}
		const data = parsed.data.application;
		if (docExplicit && data.documentProcessingConsent !== pre.documentProcessingConsent) {
			throw new HttpError(
				409,
				"CONSENT_ROUTE_REQUIRED",
				"use the document-consent route to change document consent",
			);
		}
		if (ctxExplicit && (data.contextAnalysisConsent ?? false) !== pre.contextAnalysisConsent) {
			throw new HttpError(
				409,
				"CONSENT_ROUTE_REQUIRED",
				"use the context-consent route to change context consent",
			);
		}
		const now = new Date();
		if (!isAdult(data.identity.dob, now)) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid application", {
				"identity.dob": ["owner must be 18 or older"],
			});
		}
		if (data.identity.email.toLowerCase() !== me.email.toLowerCase()) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid application", {
				"identity.email": ["must match the signed-in email"],
			});
		}
		for (const entry of data.profileConfirmations ?? []) {
			if (!isConfirmableField(entry.field)) {
				throw new HttpError(422, "INVALID_FIELD", `unknown confirmation field: ${entry.field}`);
			}
		}
		const confirmationsSupplied = data.profileConfirmations !== undefined;
		const outcome = await withTx(db, async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
			const rows = await tx.select().from(applications).where(eq(applications.id, id));
			const row = rows[0];
			if (!row || row.applicantUserId !== me.id) {
				throw new HttpError(404, "NOT_FOUND", "not found");
			}
			if (row.status !== "draft") {
				throw new HttpError(409, "NOT_DRAFT", "only drafts can be updated");
			}
			if (row.updatedAt.getTime() !== Date.parse(parsed.data.expectedUpdatedAt)) {
				throw new HttpError(409, "DRAFT_CONFLICT", "draft changed since it was read", {
					updatedAt: [row.updatedAt.toISOString()],
				});
			}
			// Sample the new token inside the lock, after the CAS, and force it
			// past the token we validated: the pre-lock `now` must never write
			// a backwards `updated_at`.
			const updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
			const changed: string[] = [];
			if (row.type !== data.type) changed.push("type");
			if (row.product !== data.product) changed.push("product");
			if (row.amountCents !== data.amountCents) changed.push("amountCents");
			if (row.termMonths !== data.termMonths) changed.push("termMonths");
			if (row.purpose !== data.purpose) changed.push("purpose");
			if (canonicalJson(row.identity) !== canonicalJson(data.identity)) changed.push("identity");
			if (canonicalJson(row.financial) !== canonicalJson(data.individual ?? null)) {
				changed.push("individual");
			}
			if (canonicalJson(row.business) !== canonicalJson(data.sme ?? null)) changed.push("sme");
			if (canonicalJson(row.consents) !== canonicalJson(data.consents)) changed.push("consents");
			if (row.aiResearchConsent !== data.aiResearchConsent) changed.push("aiResearchConsent");
			if (confirmationsSupplied) changed.push("profileConfirmations");
			const [updated] = await tx
				.update(applications)
				.set({
					type: data.type,
					product: data.product,
					amountCents: data.amountCents,
					termMonths: data.termMonths,
					purpose: data.purpose,
					identity: data.identity,
					financial: data.individual ?? null,
					business: data.sme ?? null,
					consents: data.consents,
					aiResearchConsent: data.aiResearchConsent,
					updatedAt,
				})
				.where(eq(applications.id, id))
				.returning({
					id: applications.id,
					reference: applications.reference,
					updatedAt: applications.updatedAt,
				});
			if (!updated) {
				throw new HttpError(409, "NOT_DRAFT", "only drafts can be updated");
			}
			// Server-derived confirmations (canonical equality only), like
			// create: absent means unchanged, supplied (even []) replaces.
			// Unprofiled applicants ignore the field exactly as create does.
			if (confirmationsSupplied) {
				const profile = await getCustomerProfile(tx as unknown as Db, me.id);
				if (profile) {
					await tx
						.delete(applicationProfileConfirmations)
						.where(eq(applicationProfileConfirmations.applicationId, id));
					const derived = deriveConfirmations({
						application: {
							identity: data.identity as Record<string, unknown>,
							sme: (data.sme ?? null) as Record<string, unknown> | null,
						},
						profile: {
							identity: (profile.identity ?? {}) as Record<string, unknown>,
							business: (profile.business ?? null) as Record<string, unknown> | null,
						},
						claimed: data.profileConfirmations ?? [],
					});
					// Dedupe by field: the schema does not require unique fields,
					// and the confirmation table is unique per (application, field).
					const reused = [...new Set(derived.reused)];
					const edited = [...new Set(derived.edited)];
					if (reused.length > 0) {
						await tx.insert(applicationProfileConfirmations).values(
							reused.map((field) => ({
								applicationId: id,
								customerProfileId: profile.id,
								field,
								valueHash: confirmationHmac(
									getConfirmableValue(
										{
											identity: data.identity as Record<string, unknown>,
											sme: (data.sme ?? null) as Record<string, unknown> | null,
										},
										field,
									),
									t17.confirmationKey,
								),
							})),
						);
					}
					await writeAudit(tx, {
						applicationId: id,
						actor: me.id,
						action: "customer.profile_confirmed",
						entity: "application",
						payload: { reused, edited },
					});
				}
			}
			await writeAudit(tx, {
				applicationId: id,
				actor: me.id,
				action: "application.draft_updated",
				entity: "application",
				payload:
					row.aiResearchConsent !== data.aiResearchConsent
						? {
								changed,
								aiResearchConsent: data.aiResearchConsent,
								aiResearchConsentVersion: AI_RESEARCH_CONSENT_VERSION,
							}
						: { changed },
			});
			return draftResponse(updated);
		});
		return c.json(outcome, 200);
	});

	// Requirements checklist: owner (draft or submitted) or assigned
	// officer (submitted only). Officers get 404 on drafts.
	app.get("/api/applications/:id/requirements", async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = await db.select().from(applications).where(eq(applications.id, id));
		const row = rows[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "not found");
		if (me.role === "applicant") {
			if (row.applicantUserId !== me.id) throw new HttpError(404, "NOT_FOUND", "not found");
		} else if (me.role === "officer") {
			if (row.status === "draft") throw new HttpError(404, "NOT_FOUND", "not found");
			const resolved = await resolveDocumentAccess(db, id, me);
			if (!resolved || resolved.access !== "assigned") {
				throw new HttpError(404, "NOT_FOUND", "not found");
			}
		} else {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const checklist = await buildRequirements(db, t17, id);
		if (me.role === "officer") {
			// Assigned officers see blockers/warnings/KYC but never customer
			// evidence ids/kinds/dates or reuse controls: reuse is
			// owner-only, and the officer UI hides the section outright.
			return c.json({ ...checklist, reusableDocuments: [] });
		}
		return c.json(checklist);
	});

	// Context-analysis consent: owner only. Withdrawal blocks future
	// context runs/reads (T18/D3 reads this flag); brief/signal purge
	// rides the T16 retention path.
	app.patch("/api/applications/:id/context-consent", async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = contextConsentSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid consent", zodFields(parsed.error));
		}
		const now = new Date();
		const updated = await withTx(db, async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
			const rows = await tx.select().from(applications).where(eq(applications.id, id));
			const row = rows[0];
			if (!row || me.role !== "applicant" || row.applicantUserId !== me.id) {
				throw new HttpError(404, "NOT_FOUND", "not found");
			}
			await tx
				.update(applications)
				.set({
					contextAnalysisConsent: parsed.data.consent,
					contextConsentAt: now,
					contextConsentVersion: CONTEXT_CONSENT_VERSION,
				})
				.where(eq(applications.id, id));
			await writeAudit(tx, {
				applicationId: id,
				actor: me.id,
				action: "context.consent_updated",
				entity: "application",
				payload: { consent: parsed.data.consent },
			});
			return parsed.data.consent;
		});
		// Withdrawal gates stored context: research reads probe this flag
		// live, and the purge callback below clears stored briefs/signals.
		if (!updated) {
			await requestContextPurge(id, me.id);
		}
		return c.json({
			contextAnalysisConsent: updated,
			contextConsentAt: now.toISOString(),
			contextConsentVersion: CONTEXT_CONSENT_VERSION,
		});
	});

	// Submit: the only draft → submitted transition. Idempotency-Key
	// required and scoped to the application; requirements re-run under
	// the user + application locks; missing hard requirements 409 with
	// the typed reason-code map and no writes. Success writes
	// application.submitted (outbox/audit) and starts the workflow
	// post-commit — exactly like direct create. Replay returns 200.
	app.post("/api/applications/:id/submit", async (c) => {
		const me = c.var.user;
		if (me.role !== "applicant") {
			throw new HttpError(403, "FORBIDDEN", "applicants only");
		}
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const key = c.req.header("Idempotency-Key")?.trim();
		if (!key) {
			throw new HttpError(400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required");
		}
		const body = await readJson(c).catch(() => ({}));
		const requestHash = hashCanonical({ route: "submit", body });

		const fast = await readIdempotencyReplay(db, {
			userId: me.id,
			key,
			requestHash,
			applicationId: id,
		});
		if (fast) return c.json(fast, 200);

		let outcome: { id: string; reference: string };
		let replayed = true;
		try {
			outcome = await withTx(db, async (tx) => {
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${me.id}))`);
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
				const keyRows = await tx
					.select()
					.from(idempotencyKeys)
					.where(and(eq(idempotencyKeys.userId, me.id), eq(idempotencyKeys.key, key)));
				const existing = keyRows[0];
				if (existing) {
					if (existing.requestHash !== requestHash || existing.applicationId !== id) {
						throw new HttpError(
							409,
							"IDEMPOTENCY_CONFLICT",
							"Idempotency-Key was already used with a different payload",
						);
					}
					return existing.response as { id: string; reference: string };
				}
				const rows = await tx.select().from(applications).where(eq(applications.id, id));
				const row = rows[0];
				if (!row || row.applicantUserId !== me.id) {
					throw new HttpError(404, "NOT_FOUND", "not found");
				}
				if (row.status !== "draft") {
					throw new HttpError(409, "NOT_DRAFT", "only drafts can be submitted");
				}
				// Fail closed: a draft written with a minor/foreign email can
				// never be submitted (same 400 field paths as create).
				const submitIdentity = (row.identity ?? {}) as { dob?: unknown; email?: unknown };
				if (typeof submitIdentity.dob !== "string" || !isAdult(submitIdentity.dob, new Date())) {
					throw new HttpError(400, "VALIDATION_ERROR", "invalid application", {
						"identity.dob": ["owner must be 18 or older"],
					});
				}
				if (
					typeof submitIdentity.email !== "string" ||
					submitIdentity.email.toLowerCase() !== me.email.toLowerCase()
				) {
					throw new HttpError(400, "VALIDATION_ERROR", "invalid application", {
						"identity.email": ["must match the signed-in email"],
					});
				}
				const checklist = await buildRequirements(db, t17, id);
				if (!checklist.readyToSubmit) {
					throw new HttpError(
						409,
						"REQUIREMENTS_INCOMPLETE",
						"hard requirements are incomplete",
						checklist.blockers,
					);
				}
				const active = await tx
					.select({ id: applications.id })
					.from(applications)
					.where(
						and(
							eq(applications.applicantUserId, me.id),
							inArray(applications.status, ["submitted", "processing", "pending_review"]),
						),
					);
				if (active.length >= 3) {
					throw new HttpError(409, "TOO_MANY_APPLICATIONS", "at most 3 non-terminal applications");
				}
				const profile = await getCustomerProfile(tx as unknown as Db, me.id);
				const submittedAt = asOfFor(t17, row, profile);
				const [updated] = await tx
					.update(applications)
					.set({ status: "submitted", submittedAt })
					.where(and(eq(applications.id, id), eq(applications.status, "draft")))
					.returning({ id: applications.id, reference: applications.reference });
				if (!updated) {
					throw new HttpError(409, "NOT_DRAFT", "only drafts can be submitted");
				}
				const response = { id: updated.id, reference: updated.reference };
				await tx.insert(idempotencyKeys).values({
					userId: me.id,
					key,
					requestHash,
					applicationId: updated.id,
					response,
				});
				await writeAudit(tx, {
					applicationId: updated.id,
					actor: me.id,
					action: "application.submitted",
					entity: "application",
					payload: {
						reference: updated.reference,
						type: row.type,
						product: row.product,
						amountCents: row.amountCents,
						termMonths: row.termMonths,
					},
				});
				await insertOutbox(tx, {
					type: "application.submitted",
					key: updated.id,
					payload: {
						applicationId: updated.id,
						reference: updated.reference,
						type: row.type,
						product: row.product,
						amountCents: row.amountCents,
						termMonths: row.termMonths,
					},
					dedupeKey: dedupeApplicationSubmitted(updated.id),
					applicationId: updated.id,
				});
				return response;
			});
			replayed = false;
		} catch (err) {
			if (err instanceof HttpError) throw err;
			if (!isUniqueViolation(err)) throw err;
			const winner = await readIdempotencyReplay(db, {
				userId: me.id,
				key,
				requestHash,
				applicationId: id,
			});
			if (!winner) throw err;
			return c.json(winner, 200);
		}

		if (!replayed) {
			try {
				await gateway.startApplication(outcome.id);
				await db
					.update(applications)
					.set({ workflowStartedAt: new Date() })
					.where(eq(applications.id, outcome.id));
			} catch (err) {
				logger.warn(
					{ applicationId: outcome.id, err },
					"workflow start failed; reconciler will repair",
				);
			}
		}
		return c.json(outcome, 200);
	});

	// Draft detail/list live in the base routes (owner 200 with null
	// submittedAt; officers 404/excluded) — see routes/applications.ts.

	return app;
}
