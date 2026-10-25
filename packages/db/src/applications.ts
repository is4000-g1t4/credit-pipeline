// @credit/db/applications — applications service only (credit_applications):
// applications, kyc_checks, external_reports, documents, scores,
// policy_evaluations, decisions, idempotency_keys, generated artifacts/holds,
// plus the shared audit_log/outbox_events. applicant_user_id / officer_user_id
// are plain uuids — no FK to users (cross-database references must never be FKs).
import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	real,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

export { auditLog, outboxEvents } from "./shared.js";
// Client utilities re-exported so service code imports one subpath.
export { createDb, withTx, type Db, type Tx } from "./client.js";

const createdAt = () =>
	timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull();

const updatedAt = () =>
	timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull();

const money = (name: string) => bigint(name, { mode: "number" }).notNull();
const moneyNullable = (name: string) => bigint(name, { mode: "number" });

export const applicationType = pgEnum("application_type", ["individual", "sme"]);
export const applicationProduct = pgEnum("application_product", ["personal_loan", "sme_term_loan"]);
export const applicationStatus = pgEnum("application_status", [
	"draft",
	"submitted",
	"processing",
	"pending_review",
	"booked",
	"declined",
	"expired",
	"failed",
]);
export const kycCheckStatus = pgEnum("kyc_check_status", ["passed", "failed"]);
export const reportKind = pgEnum("report_kind", ["bureau", "bank"]);
export const documentStatus = pgEnum("document_status", ["required", "verified"]);
export const decisionOutcome = pgEnum("decision_outcome", ["approved", "declined"]);
export const decidedBy = pgEnum("decided_by", ["system", "officer"]);
// T01 document workflow (SPEC-t01-t02 §4). Enum values are append-only:
// v1 uses `assigned_officer` only; specialist roles extend this list later.
export const caseAccessRole = pgEnum("case_access_role", ["assigned_officer"]);
export const documentFileKind = pgEnum("document_file_kind", [
	"id",
	"business_registration",
	"bank_statement",
	"payslip",
	"financial_statements",
	"other",
]);
export const documentFileStatus = pgEnum("document_file_status", ["ready", "rejected", "deleted"]);
export const documentOcrStatus = pgEnum("document_ocr_status", [
	"not_applicable",
	"ready",
	"low_confidence",
	"unsupported",
	"failed",
]);
export const documentTextSource = pgEnum("document_text_source", ["pdf_text", "ocr"]);
export const documentCrosscheckStatus = pgEnum("document_crosscheck_status", [
	"succeeded",
	"failed",
	"redacted",
]);
export const documentFindingField = pgEnum("document_finding_field", [
	"company_name",
	"registration_number",
	"account_holder_name",
	"applicant_name",
	"other",
]);
export const documentFindingConfidence = pgEnum("document_finding_confidence", [
	"low",
	"medium",
	"high",
]);
export const documentFindingStatus = pgEnum("document_finding_status", ["mismatch", "needs_chase"]);
export const chaseRequestStatus = pgEnum("chase_request_status", ["draft"]);
// --- T17 customer master / reusable evidence (SPEC-t17-t18 §2.2). D0 wires
// schema only; draft/requirements/reuse/seed handlers land in D1+. ---
export const applicationSource = pgEnum("application_source", ["live", "demo_case"]);
export const customerSegment = pgEnum("customer_segment", ["individual", "sme"]);
export const customerKycStatus = pgEnum("customer_kyc_status", [
	"verified",
	"expired",
	"not_started",
]);
export const customerSource = pgEnum("customer_source", ["demo_seed", "customer_master"]);
export const customerAccountType = pgEnum("customer_account_type", [
	"personal_current",
	"business_current",
	"savings",
]);
export const customerAccountStatus = pgEnum("customer_account_status", ["active", "closed"]);
export const customerTransactionCategory = pgEnum("customer_transaction_category", [
	"income",
	"transfer",
	"payroll",
	"loan",
	"fee",
	"purchase",
	"cash",
	"returned_payment",
	"other",
]);
export const customerTransactionSource = pgEnum("customer_transaction_source", [
	"demo_seed",
	"statement",
	"feed",
]);
export const customerDocumentScanStatus = pgEnum("customer_document_scan_status", [
	"clean",
	"rejected",
]);
export const documentFileSource = pgEnum("document_file_source", [
	"upload",
	"customer_reuse",
	"demo_seed",
]);
export const documentDateSource = pgEnum("document_date_source", [
	"statement_import",
	"server_ocr",
	"reused",
	"customer_kyc",
]);
// EN-02 generated artifact lifecycle. Content lives only on draft/approved
// history rows; approved rows reject content mutation at the database level.
export const generatedArtifactType = pgEnum("generated_artifact_type", [
	"credit_memo",
	"policy_exception_memo",
	"adverse_action_letter",
	"document_integrity_brief",
]);
export const generatedArtifactStatus = pgEnum("generated_artifact_status", [
	"draft",
	"approved",
	"superseded",
	"deleted",
]);

// E2 document integrity. The fraud-review item is the flag's system of record:
// `fraud_reviews.status` is the case-level flag state, not a boolean column.
export const integrityCandidateStatus = pgEnum("integrity_candidate_status", [
	"candidate",
	"validated",
	"confirmed",
	"rejected",
]);
export const integrityConsistencyStatus = pgEnum("integrity_consistency_status", [
	"candidate",
	"confirmed",
	"rejected",
]);
export const integrityConsistencyKind = pgEnum("integrity_consistency_kind", ["match", "mismatch"]);
export const integrityRunFeature = pgEnum("integrity_run_feature", [
	"document_analysis",
	"document_triage",
]);
export const integrityRunStatus = pgEnum("integrity_run_status", [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
]);
export const integrityEditSignal = pgEnum("integrity_edit_signal", [
	"detected",
	"not_detected",
	"unknown",
]);
export const fraudReviewStatus = pgEnum("fraud_review_status", [
	"open",
	"cleared",
	"confirmed",
	"needs_info",
]);
export const fraudReviewSeverity = pgEnum("fraud_review_severity", ["low", "medium", "high"]);
export const integrityCandidateField = pgEnum("integrity_candidate_field", [
	"document_type",
	"issuer",
	"document_date",
	"statement_period_start",
	"statement_period_end",
	"registration_number",
	"account_number",
	"account_holder_name",
	"material_amount",
	"other",
]);
export const integrityConsistencyField = pgEnum("integrity_consistency_field", [
	"company_name",
	"registration_number",
	"account_holder_name",
	"statement_period",
	"material_amount",
	"document_date",
	"other",
]);

export const applications = pgTable(
	"applications",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		reference: text("reference").notNull().unique(),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		applicantUserId: uuid("applicant_user_id").notNull(),
		type: applicationType("type").notNull(),
		product: applicationProduct("product").notNull(),
		status: applicationStatus("status").notNull().default("submitted"),
		amountCents: money("amount_cents"),
		termMonths: integer("term_months").notNull(),
		purpose: text("purpose").notNull(),
		identity: jsonb("identity").notNull(),
		financial: jsonb("financial"),
		business: jsonb("business"),
		consents: jsonb("consents").notNull(),
		aiResearchConsent: boolean("ai_research_consent").notNull().default(false),
		documentProcessingConsent: boolean("document_processing_consent").notNull().default(false),
		documentConsentAt: timestamp("document_consent_at", {
			withTimezone: true,
			mode: "date",
		}),
		documentConsentVersion: text("document_consent_version"),
		// T17 draft/intake additions: nullable submittedAt (null iff draft),
		// live/demo source + fixture key, and context-analysis consent.
		source: applicationSource("source").notNull().default("live"),
		fixtureKey: text("fixture_key").unique(),
		contextAnalysisConsent: boolean("context_analysis_consent").notNull().default(false),
		contextConsentAt: timestamp("context_consent_at", {
			withTimezone: true,
			mode: "date",
		}),
		contextConsentVersion: text("context_consent_version"),
		submittedAt: timestamp("submitted_at", {
			withTimezone: true,
			mode: "date",
		}),
		workflowStartedAt: timestamp("workflow_started_at", {
			withTimezone: true,
			mode: "date",
		}),
		decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
		failedReason: text("failed_reason"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		index("applications_status_idx").on(t.status),
		// Drafts carry no submitted_at; submitted rows always do.
		check(
			"applications_draft_submitted_chk",
			sql`(${t.status} = 'draft') = (${t.submittedAt} IS NULL)`,
		),
	],
);

export const kycChecks = pgTable(
	"kyc_checks",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		type: text("type").notNull(),
		status: kycCheckStatus("status").notNull(),
		details: jsonb("details"),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex("kyc_checks_application_id_type_uniq").on(t.applicationId, t.type)],
);

export const externalReports = pgTable(
	"external_reports",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		provider: text("provider").notNull(),
		kind: reportKind("kind").notNull(),
		version: text("version").notNull(),
		payload: jsonb("payload").notNull(),
		fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("external_reports_application_provider_kind_uniq").on(
			t.applicationId,
			t.provider,
			t.kind,
		),
	],
);

export const documents = pgTable(
	"documents",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		kind: text("kind").notNull(),
		status: documentStatus("status").notNull().default("required"),
		note: text("note"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex("documents_application_id_kind_uniq").on(t.applicationId, t.kind)],
);

export const scores = pgTable(
	"scores",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		modelVersion: text("model_version").notNull(),
		score: integer("score").notNull(),
		grade: text("grade").notNull(),
		components: jsonb("components"),
		factors: jsonb("factors").notNull(),
		affordability: jsonb("affordability").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("scores_application_id_model_version_uniq").on(t.applicationId, t.modelVersion),
	],
);

export const policyEvaluations = pgTable(
	"policy_evaluations",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		policyVersion: text("policy_version").notNull(),
		outcome: text("outcome").notNull(),
		reasons: jsonb("reasons").notNull(),
		maxAmountCents: money("max_amount_cents"),
		inputs: jsonb("inputs").notNull(),
		inputHash: text("input_hash").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("policy_evaluations_application_id_policy_version_uniq").on(
			t.applicationId,
			t.policyVersion,
		),
	],
);

export const decisions = pgTable("decisions", {
	id: uuid("id").defaultRandom().primaryKey(),
	applicationId: uuid("application_id")
		.notNull()
		.unique()
		.references(() => applications.id, { onDelete: "restrict" }),
	outcome: decisionOutcome("outcome").notNull(),
	decidedBy: decidedBy("decided_by").notNull(),
	// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
	officerUserId: uuid("officer_user_id"),
	// Nullable: system/check-only decisions carry no request id. Postgres
	// treats NULLs as distinct, so the unique constraint only guards
	// officer request ids — exactly the replay semantics FR-6.2 needs.
	requestId: text("request_id").unique(),
	approvedAmountCents: moneyNullable("approved_amount_cents"),
	termMonths: integer("term_months"),
	rateBps: integer("rate_bps"),
	reasons: jsonb("reasons").notNull(),
	notes: text("notes"),
	snapshot: jsonb("snapshot").notNull(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
	createdAt: createdAt(),
});

// EN-02 generic generated artifact record. One row per version; `revision`
// is the optimistic-concurrency token for draft edits. Approved content is
// immutable (migration trigger); edits create a new version. No hard delete.
export const generatedArtifacts = pgTable(
	"generated_artifacts",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		type: generatedArtifactType("type").notNull(),
		version: integer("version").notNull(),
		revision: integer("revision").notNull().default(1),
		status: generatedArtifactStatus("status").notNull().default("draft"),
		// Set when the artifact cites document evidence. Artifact reads then
		// require the active assigned-officer grant, even after unassignment.
		documentDerived: boolean("document_derived").notNull().default(false),
		content: jsonb("content").notNull(),
		citations: jsonb("citations").notNull(),
		contentHash: text("content_hash").notNull(),
		// Agentic memo provenance (nullable: deterministic writers leave both
		// null). `evidenceHash` mirrors `agentTrace.evidenceHash` for indexed
		// idempotent-replay lookup.
		agentTrace: jsonb("agent_trace"),
		evidenceHash: text("evidence_hash"),
		model: text("model").notNull(),
		promptVersion: text("prompt_version").notNull(),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		createdBy: uuid("created_by").notNull(),
		approvedBy: uuid("approved_by"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
		supersededAt: timestamp("superseded_at", { withTimezone: true, mode: "date" }),
		deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
		retentionUntil: timestamp("retention_until", { withTimezone: true, mode: "date" }).notNull(),
	},
	(t) => [
		uniqueIndex("generated_artifacts_case_type_version_uniq").on(
			t.applicationId,
			t.type,
			t.version,
		),
		// One live draft per case/type; approval supersedes the prior approved
		// row, and a further edit creates the next version instead of a fork.
		uniqueIndex("generated_artifacts_active_draft_uniq")
			.on(t.applicationId, t.type)
			.where(sql`${t.status} = 'draft'`),
		index("generated_artifacts_case_type_created_idx").on(t.applicationId, t.type, t.createdAt),
		index("generated_artifacts_case_type_evidence_idx").on(t.applicationId, t.type, t.evidenceHash),
		index("generated_artifacts_retention_idx")
			.on(t.retentionUntil)
			.where(sql`${t.status} <> 'deleted'`),
		check("generated_artifacts_version_revision_chk", sql`${t.version} > 0 AND ${t.revision} > 0`),
		check(
			"generated_artifacts_approved_actor_chk",
			sql`${t.status} <> 'approved' OR ${t.approvedBy} IS NOT NULL`,
		),
	],
);

// Active rows block the retention tombstone (same semantics as document
// legal holds). Service-only create/release; every change is audited.
export const generatedArtifactHolds = pgTable(
	"generated_artifact_holds",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		artifactId: uuid("artifact_id")
			.notNull()
			.references(() => generatedArtifacts.id, { onDelete: "restrict" }),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		reason: text("reason").notNull(),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		createdBy: uuid("created_by").notNull(),
		createdAt: createdAt(),
		releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
	},
	(t) => [
		index("generated_artifact_holds_artifact_idx").on(t.artifactId),
		index("generated_artifact_holds_active_idx")
			.on(t.artifactId)
			.where(sql`${t.releasedAt} IS NULL`),
	],
);

export const idempotencyKeys = pgTable(
	"idempotency_keys",
	{
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		userId: uuid("user_id").notNull(),
		key: text("key").notNull(),
		requestHash: text("request_hash").notNull(),
		applicationId: uuid("application_id").references(() => applications.id, {
			onDelete: "restrict",
		}),
		response: jsonb("response"),
		createdAt: createdAt(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.key] })],
);

// --- T01 document workflow (SPEC-t01-t02 §4). D0 wires schema + consent
// only; upload/OCR/crosscheck/chase handlers land in D1/D2. ---

// Explicit case assignment. The applicant owner is implicit (never a row);
// v1 grants `assigned_officer` only. One active officer per application.
export const caseAccessGrants = pgTable(
	"case_access_grants",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		userId: uuid("user_id").notNull(),
		accessRole: caseAccessRole("access_role").notNull(),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		grantedBy: uuid("granted_by"),
		grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
	},
	(t) => [
		index("case_access_grants_application_id_idx").on(t.applicationId),
		uniqueIndex("case_access_grants_active_officer_uniq")
			.on(t.applicationId)
			.where(sql`${t.accessRole} = 'assigned_officer' AND ${t.revokedAt} IS NULL`),
	],
);

// One row per uploaded file; terminal metadata only, never page text.
// `rejected` rows hold no blob (scan/validation failure); there is no
// `failed` file status — storage/DB finalization failures leave no row.
export const documentFiles = pgTable(
	"document_files",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		kind: documentFileKind("kind").notNull(),
		status: documentFileStatus("status").notNull(),
		ocrStatus: documentOcrStatus("ocr_status").notNull(),
		textLayerRisk: boolean("text_layer_risk").notNull().default(false),
		originalFilename: text("original_filename"),
		mimeType: text("mime_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		sha256: text("sha256").notNull(),
		storageKey: text("storage_key"),
		encryptionNonce: text("encryption_nonce"),
		encryptionTag: text("encryption_tag"),
		keyId: text("key_id").notNull(),
		cryptoVersion: text("crypto_version").notNull(),
		pageCount: integer("page_count").notNull().default(0),
		ocrConfidence: real("ocr_confidence"),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		uploadedBy: uuid("uploaded_by").notNull(),
		uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		retentionUntil: timestamp("retention_until", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		blobPurgedAt: timestamp("blob_purged_at", { withTimezone: true, mode: "date" }),
		errorCode: text("error_code"),
		errorMessage: text("error_message"),
		// T17 reuse provenance/freshness: server-derived dates only — uploads
		// never assert document_date; null means unknown freshness (D1).
		source: documentFileSource("source").notNull().default("upload"),
		reusedFromCustomerDocumentId: uuid("reused_from_customer_document_id").references(
			() => customerDocuments.id,
			{ onDelete: "restrict" },
		),
		documentDate: date("document_date", { mode: "string" }),
		periodEnd: date("period_end", { mode: "string" }),
		documentDateSource: documentDateSource("document_date_source"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		index("document_files_application_id_idx").on(t.applicationId),
		// Cross-application duplicate lookup (EN-04). Ready rows only: a
		// tombstoned file must not keep matching.
		index("document_files_sha256_ready_idx")
			.on(t.sha256)
			.where(sql`${t.status} = 'ready'`),
		// Same bytes + kind dedupe: re-upload replays the existing row
		// instead of storing a second blob. Deleted rows don't collide.
		// (No CAST in the predicate: enum::text is not immutable, and PG
		// rejects it in index predicates — compare the enum directly.)
		uniqueIndex("document_files_application_kind_sha_uniq")
			.on(t.applicationId, t.kind, t.sha256)
			.where(sql`${t.status} != 'deleted'`),
	],
);

// Extracted page text with confidence and provenance. `id`-kind files
// store no pages (encrypted bytes only).
export const documentPages = pgTable(
	"document_pages",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		documentFileId: uuid("document_file_id")
			.notNull()
			.references(() => documentFiles.id, { onDelete: "cascade" }),
		pageNumber: integer("page_number").notNull(),
		text: text("text").notNull(),
		textSource: documentTextSource("text_source").notNull(),
		confidence: real("confidence").notNull(),
		textSha256: text("text_sha256").notNull(),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex("document_pages_file_page_uniq").on(t.documentFileId, t.pageNumber)],
);

// One deterministic cross-check run over an application's ready documents.
export const documentCrosschecks = pgTable(
	"document_crosschecks",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		status: documentCrosscheckStatus("status").notNull(),
		validatorVersion: text("validator_version").notNull(),
		documentsChecked: jsonb("documents_checked").notNull(),
		findingCount: integer("finding_count").notNull().default(0),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		requestedBy: uuid("requested_by").notNull(),
		startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
		finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
		errorCode: text("error_code"),
	},
	(t) => [index("document_crosschecks_application_id_idx").on(t.applicationId)],
);

// A single field comparison outcome. `mismatch` must cite an exact raw-page
// substring (file/page/quote/offsets/hash); `needs_chase` may cite nothing.
// Code-point offsets into raw `document_pages.text` — enforced here at the
// row level (presence) and in the service transaction (exactness).
export const documentFindings = pgTable(
	"document_findings",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		crosscheckId: uuid("crosscheck_id")
			.notNull()
			.references(() => documentCrosschecks.id, { onDelete: "cascade" }),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		documentFileId: uuid("document_file_id").references(() => documentFiles.id, {
			onDelete: "restrict",
		}),
		field: documentFindingField("field").notNull(),
		expected: text("expected"),
		observed: text("observed"),
		pageNumber: integer("page_number"),
		quote: text("quote"),
		quoteStart: integer("quote_start"),
		quoteEnd: integer("quote_end"),
		quoteHash: text("quote_hash"),
		confidence: documentFindingConfidence("confidence").notNull(),
		status: documentFindingStatus("status").notNull(),
		reason: text("reason").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		index("document_findings_crosscheck_id_idx").on(t.crosscheckId),
		index("document_findings_application_id_idx").on(t.applicationId),
		check(
			"document_findings_mismatch_citation_chk",
			sql`CAST(${t.status} AS text) != 'mismatch' OR (${t.documentFileId} IS NOT NULL AND ${t.pageNumber} IS NOT NULL AND ${t.quote} IS NOT NULL AND ${t.quoteStart} IS NOT NULL AND ${t.quoteEnd} IS NOT NULL AND ${t.quoteHash} IS NOT NULL)`,
		),
	],
);

// Draft-only chase request (v1 never sends). `sent_at` stays null.
export const chaseRequests = pgTable(
	"chase_requests",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		crosscheckId: uuid("crosscheck_id")
			.notNull()
			.references(() => documentCrosschecks.id, { onDelete: "restrict" }),
		status: chaseRequestStatus("status").notNull().default("draft"),
		body: text("body"),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		createdBy: uuid("created_by").notNull(),
		createdAt: createdAt(),
		sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
		inspectedOriginalAt: timestamp("inspected_original_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		redactedAt: timestamp("redacted_at", { withTimezone: true, mode: "date" }),
	},
	(t) => [index("chase_requests_application_id_idx").on(t.applicationId)],
);

// The draft's selected findings; both sides cascade so retention can clear
// links without touching the crosscheck row itself.
export const chaseRequestFindings = pgTable(
	"chase_request_findings",
	{
		chaseRequestId: uuid("chase_request_id")
			.notNull()
			.references(() => chaseRequests.id, { onDelete: "cascade" }),
		findingId: uuid("finding_id")
			.notNull()
			.references(() => documentFindings.id, { onDelete: "cascade" }),
	},
	(t) => [primaryKey({ columns: [t.chaseRequestId, t.findingId] })],
);

// Retention blockers, application-wide (file null) or per file. An active
// hold (`released_at IS NULL`) blocks the retention sweep transactionally.
export const documentLegalHolds = pgTable(
	"document_legal_holds",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		documentFileId: uuid("document_file_id").references(() => documentFiles.id, {
			onDelete: "restrict",
		}),
		reason: text("reason").notNull(),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		createdBy: uuid("created_by").notNull(),
		createdAt: createdAt(),
		releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
	},
	(t) => [
		index("document_legal_holds_application_id_idx").on(t.applicationId),
		index("document_legal_holds_active_idx")
			.on(t.applicationId)
			.where(sql`${t.releasedAt} IS NULL`),
	],
);

// --- E2 document integrity (EN-04/EN-05). Fingerprint rows carry metadata
// only — never page text, filenames, authors, titles, or applicant data. ---

export const documentFingerprints = pgTable(
	"document_fingerprints",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		documentFileId: uuid("document_file_id")
			.notNull()
			.references(() => documentFiles.id, { onDelete: "restrict" }),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		fingerprintVersion: text("fingerprint_version").notNull(),
		sha256: text("sha256").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		mimeType: text("mime_type").notNull(),
		pageCount: integer("page_count").notNull().default(0),
		ocrConfidence: real("ocr_confidence"),
		// Known-software token only; anything else is 'unknown'. Never inferred.
		producer: text("producer").notNull().default("unknown"),
		creator: text("creator").notNull().default("unknown"),
		metadataCreatedAt: timestamp("metadata_created_at", { withTimezone: true, mode: "date" }),
		metadataModifiedAt: timestamp("metadata_modified_at", { withTimezone: true, mode: "date" }),
		metadataSource: text("metadata_source").notNull().default("unknown"),
		editSignal: integrityEditSignal("edit_signal").notNull().default("unknown"),
		editCodes: jsonb("edit_codes")
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		redactedAt: timestamp("redacted_at", { withTimezone: true, mode: "date" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		uniqueIndex("document_fingerprints_file_uniq").on(t.documentFileId),
		index("document_fingerprints_application_id_idx").on(t.applicationId),
	],
);

export const documentFieldCandidates = pgTable(
	"document_field_candidates",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		documentFileId: uuid("document_file_id")
			.notNull()
			.references(() => documentFiles.id, { onDelete: "restrict" }),
		runId: uuid("run_id").notNull(),
		field: integrityCandidateField("field").notNull(),
		value: text("value").notNull(),
		normalizedValue: text("normalized_value").notNull(),
		pageNumber: integer("page_number").notNull(),
		offsetStart: integer("offset_start").notNull(),
		offsetEnd: integer("offset_end").notNull(),
		quote: text("quote").notNull(),
		quoteHash: text("quote_hash").notNull(),
		confidence: real("confidence").notNull(),
		status: integrityCandidateStatus("status").notNull(),
		validationCodes: jsonb("validation_codes")
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		confirmedBy: uuid("confirmed_by"),
		confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
		redactedAt: timestamp("redacted_at", { withTimezone: true, mode: "date" }),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("document_field_candidates_evidence_uniq").on(
			t.runId,
			t.documentFileId,
			t.field,
			t.pageNumber,
			t.offsetStart,
			t.offsetEnd,
		),
		index("document_field_candidates_application_id_idx").on(t.applicationId),
		index("document_field_candidates_run_id_idx").on(t.runId),
		check(
			"document_field_candidates_offsets_chk",
			sql`${t.pageNumber} >= 1 AND ${t.offsetStart} >= 0 AND ${t.offsetEnd} > ${t.offsetStart}`,
		),
		check(
			"document_field_candidates_confidence_chk",
			sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`,
		),
	],
);

export const documentConsistencyCandidates = pgTable(
	"document_consistency_candidates",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		runId: uuid("run_id").notNull(),
		field: integrityConsistencyField("field").notNull(),
		proposedKind: integrityConsistencyKind("proposed_kind").notNull(),
		kind: integrityConsistencyKind("kind"),
		severity: fraudReviewSeverity("severity").notNull(),
		comparisonBasis: text("comparison_basis").notNull(),
		leftDocumentFileId: uuid("left_document_file_id")
			.notNull()
			.references(() => documentFiles.id, { onDelete: "restrict" }),
		leftPageNumber: integer("left_page_number").notNull(),
		leftValue: text("left_value").notNull(),
		leftLabel: text("left_label").notNull(),
		leftCurrency: text("left_currency"),
		leftQuote: text("left_quote").notNull(),
		leftOffsetStart: integer("left_offset_start").notNull(),
		leftOffsetEnd: integer("left_offset_end").notNull(),
		leftQuoteHash: text("left_quote_hash").notNull(),
		rightDocumentFileId: uuid("right_document_file_id")
			.notNull()
			.references(() => documentFiles.id, { onDelete: "restrict" }),
		rightPageNumber: integer("right_page_number").notNull(),
		rightValue: text("right_value").notNull(),
		rightLabel: text("right_label").notNull(),
		rightCurrency: text("right_currency"),
		rightQuote: text("right_quote").notNull(),
		rightOffsetStart: integer("right_offset_start").notNull(),
		rightOffsetEnd: integer("right_offset_end").notNull(),
		rightQuoteHash: text("right_quote_hash").notNull(),
		explanation: text("explanation"),
		explanationVerified: boolean("explanation_verified").notNull().default(false),
		status: integrityConsistencyStatus("status").notNull(),
		reason: text("reason").notNull(),
		confirmedBy: uuid("confirmed_by"),
		confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
		redactedAt: timestamp("redacted_at", { withTimezone: true, mode: "date" }),
		createdAt: createdAt(),
	},
	(t) => [
		index("document_consistency_candidates_application_id_idx").on(t.applicationId),
		index("document_consistency_candidates_run_id_idx").on(t.runId),
		check(
			"document_consistency_candidates_offsets_chk",
			sql`${t.leftPageNumber} >= 1 AND ${t.rightPageNumber} >= 1
				AND ${t.leftOffsetStart} >= 0 AND ${t.rightOffsetStart} >= 0
				AND ${t.leftOffsetEnd} > ${t.leftOffsetStart}
				AND ${t.rightOffsetEnd} > ${t.rightOffsetStart}`,
		),
	],
);

export const documentIntegrityRuns = pgTable(
	"document_integrity_runs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		feature: integrityRunFeature("feature").notNull(),
		status: integrityRunStatus("status").notNull().default("queued"),
		inputHash: text("input_hash").notNull(),
		documentSha256: jsonb("document_sha256").$type<string[]>().notNull(),
		fingerprintVersion: text("fingerprint_version").notNull(),
		model: text("model").notNull(),
		promptVersion: text("prompt_version").notNull(),
		agentVersion: text("agent_version").notNull(),
		attempts: integer("attempts").notNull().default(0),
		maxAttempts: integer("max_attempts").notNull().default(2),
		leaseToken: uuid("lease_token"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
		reviewVersion: integer("review_version"),
		steps: integer("steps"),
		toolCalls: jsonb("tool_calls").$type<unknown[]>(),
		sourceRefs: jsonb("source_refs").$type<string[]>(),
		repairAttempted: boolean("repair_attempted").notNull().default(false),
		repairSucceeded: boolean("repair_succeeded").notNull().default(false),
		usage: jsonb("usage").$type<{
			inputTokens: number;
			outputTokens: number;
			costUsd: number;
		}>(),
		errorCode: text("error_code"),
		errorDetail: text("error_detail"),
		requestedBy: uuid("requested_by"),
		fraudReviewId: uuid("fraud_review_id"),
		artifactId: uuid("artifact_id").references(() => generatedArtifacts.id, {
			onDelete: "restrict",
		}),
		startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
		finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("document_integrity_runs_active_uniq")
			.on(t.applicationId, t.feature, t.inputHash)
			.where(sql`${t.status} IN ('queued','running','succeeded')`),
		index("document_integrity_runs_case_feature_created_idx").on(
			t.applicationId,
			t.feature,
			t.createdAt,
		),
		index("document_integrity_runs_status_lease_idx")
			.on(t.status, t.leaseExpiresAt)
			.where(sql`${t.status} = 'running'`),
	],
);

export const fraudReviews = pgTable(
	"fraud_reviews",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		reviewType: text("review_type").notNull().default("document_integrity"),
		status: fraudReviewStatus("status").notNull().default("open"),
		reasonCode: text("reason_code").notNull(),
		severity: fraudReviewSeverity("severity").notNull(),
		note: text("note"),
		assigneeUserId: uuid("assignee_user_id"),
		signalCodes: jsonb("signal_codes")
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		documentRefs: jsonb("document_refs")
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		sourceHash: text("source_hash").notNull(),
		briefArtifactId: uuid("brief_artifact_id").references(() => generatedArtifacts.id, {
			onDelete: "restrict",
		}),
		briefStaleAt: timestamp("brief_stale_at", { withTimezone: true, mode: "date" }),
		agentRunId: uuid("agent_run_id").references(() => documentIntegrityRuns.id, {
			onDelete: "restrict",
		}),
		model: text("model"),
		promptVersion: text("prompt_version"),
		agentVersion: text("agent_version"),
		version: integer("version").notNull().default(1),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		createdBy: uuid("created_by").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		resolvedBy: uuid("resolved_by"),
		resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
		resolutionNote: text("resolution_note"),
		retentionUntil: timestamp("retention_until", { withTimezone: true, mode: "date" }).notNull(),
		redactedAt: timestamp("redacted_at", { withTimezone: true, mode: "date" }),
	},
	(t) => [
		uniqueIndex("fraud_reviews_active_uniq")
			.on(t.applicationId, t.reviewType)
			.where(sql`${t.status} IN ('open','needs_info')`),
		index("fraud_reviews_status_created_idx").on(t.status, t.createdAt),
		index("fraud_reviews_application_id_idx").on(t.applicationId),
		check("fraud_reviews_version_chk", sql`${t.version} > 0`),
	],
);

export const fraudReviewerGrants = pgTable(
	"fraud_reviewer_grants",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		userId: uuid("user_id").notNull(),
		grantedBy: uuid("granted_by"),
		grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
	},
	(t) => [
		uniqueIndex("fraud_reviewer_grants_active_uniq")
			.on(t.userId)
			.where(sql`${t.revokedAt} IS NULL`),
	],
);

export const documentDuplicateExplanations = pgTable(
	"document_duplicate_explanations",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		sha256: text("sha256").notNull(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		note: text("note").notNull(),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		explainedBy: uuid("explained_by").notNull(),
		retentionUntil: timestamp("retention_until", { withTimezone: true, mode: "date" }).notNull(),
		redactedAt: timestamp("redacted_at", { withTimezone: true, mode: "date" }),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("document_duplicate_explanations_scope_uniq").on(t.sha256, t.applicationId),
		index("document_duplicate_explanations_sha_idx").on(t.sha256),
	],
);

// --- T17 customer master + reusable evidence (SPEC-t17-t18 §2.2). D0 wires
// schema only; customer blobs live under a separate CUSTOMER_STORAGE_DIR
// root (D1) so the T01 app orphan sweep never touches them. ---

export const customerProfiles = pgTable("customer_profiles", {
	id: uuid("id").defaultRandom().primaryKey(),
	// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
	userId: uuid("user_id").notNull().unique(),
	segment: customerSegment("segment").notNull(),
	customerSince: date("customer_since", { mode: "string" }).notNull(),
	kycStatus: customerKycStatus("kyc_status").notNull(),
	kycVerifiedAt: timestamp("kyc_verified_at", { withTimezone: true, mode: "date" }),
	kycExpiresAt: timestamp("kyc_expires_at", { withTimezone: true, mode: "date" }),
	identity: jsonb("identity").notNull(),
	business: jsonb("business"),
	source: customerSource("source").notNull(),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

export const customerAccounts = pgTable(
	"customer_accounts",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customerProfiles.id, { onDelete: "restrict" }),
		bankName: text("bank_name").notNull(),
		accountType: customerAccountType("account_type").notNull(),
		// Last 4 only — never a full account number.
		maskedNumber: text("masked_number").notNull(),
		currency: text("currency").notNull(),
		openedAt: date("opened_at", { mode: "string" }),
		status: customerAccountStatus("status").notNull(),
		source: customerSource("source").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index("customer_accounts_customer_status_idx").on(t.customerId, t.status)],
);

export const customerTransactions = pgTable(
	"customer_transactions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		accountId: uuid("account_id")
			.notNull()
			.references(() => customerAccounts.id, { onDelete: "restrict" }),
		postedAt: timestamp("posted_at", { withTimezone: true, mode: "date" }).notNull(),
		// Signed: credits positive, debits negative.
		amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
		balanceAfterCents: bigint("balance_after_cents", { mode: "number" }).notNull(),
		currency: text("currency").notNull(),
		description: text("description").notNull(),
		counterparty: text("counterparty"),
		category: customerTransactionCategory("category").notNull(),
		returned: boolean("returned").notNull().default(false),
		source: customerTransactionSource("source").notNull(),
		sourceReference: text("source_reference"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		index("customer_transactions_account_posted_idx").on(t.accountId, t.postedAt),
		uniqueIndex("customer_transactions_account_source_ref_uniq")
			.on(t.accountId, t.source, t.sourceReference)
			.where(sql`${t.sourceReference} IS NOT NULL`),
	],
);

export const customerDocuments = pgTable(
	"customer_documents",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customerProfiles.id, { onDelete: "restrict" }),
		fixtureKey: text("fixture_key"),
		kind: documentFileKind("kind").notNull(),
		status: documentFileStatus("status").notNull(),
		scanStatus: customerDocumentScanStatus("scan_status").notNull(),
		scannedAt: timestamp("scanned_at", { withTimezone: true, mode: "date" }),
		originalFilename: text("original_filename"),
		mimeType: text("mime_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		sha256: text("sha256").notNull(),
		storageKey: text("storage_key"),
		encryptionNonce: text("encryption_nonce"),
		encryptionTag: text("encryption_tag"),
		keyId: text("key_id").notNull(),
		cryptoVersion: text("crypto_version").notNull(),
		pageCount: integer("page_count").notNull().default(0),
		ocrStatus: documentOcrStatus("ocr_status").notNull(),
		ocrConfidence: real("ocr_confidence"),
		textLayerRisk: boolean("text_layer_risk").notNull().default(false),
		// Server-derived freshness: period_end authoritative for
		// bank_statement/financial_statements; null = unknown (D1).
		documentDate: date("document_date", { mode: "string" }),
		periodEnd: date("period_end", { mode: "string" }),
		uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		retentionUntil: timestamp("retention_until", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		blobPurgedAt: timestamp("blob_purged_at", { withTimezone: true, mode: "date" }),
		source: customerSource("source").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		index("customer_documents_customer_id_idx").on(t.customerId),
		uniqueIndex("customer_documents_customer_kind_fixture_uniq")
			.on(t.customerId, t.kind, t.fixtureKey)
			.where(sql`${t.fixtureKey} IS NOT NULL`),
	],
);

// Same shape as T01 pages, scoped to a customer document.
export const customerDocumentPages = pgTable(
	"customer_document_pages",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		customerDocumentId: uuid("customer_document_id")
			.notNull()
			.references(() => customerDocuments.id, { onDelete: "cascade" }),
		pageNumber: integer("page_number").notNull(),
		text: text("text").notNull(),
		textSource: documentTextSource("text_source").notNull(),
		confidence: real("confidence").notNull(),
		textSha256: text("text_sha256").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("customer_document_pages_file_page_uniq").on(t.customerDocumentId, t.pageNumber),
	],
);

// Customer-scoped retention blockers (T16 pattern). Active holds
// (`released_at IS NULL`) block the customer sweep (D1).
export const customerLegalHolds = pgTable(
	"customer_legal_holds",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customerProfiles.id, { onDelete: "restrict" }),
		customerDocumentId: uuid("customer_document_id").references(() => customerDocuments.id, {
			onDelete: "restrict",
		}),
		reason: text("reason").notNull(),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		createdBy: uuid("created_by").notNull(),
		createdAt: createdAt(),
		releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
	},
	(t) => [
		index("customer_legal_holds_customer_id_idx").on(t.customerId),
		index("customer_legal_holds_active_idx")
			.on(t.customerId)
			.where(sql`${t.releasedAt} IS NULL`),
	],
);

// Per-field prefill confirmations: client hashes are advisory — the create
// handler derives reused vs edited by comparing canonical values (D1).
export const applicationProfileConfirmations = pgTable(
	"application_profile_confirmations",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		customerProfileId: uuid("customer_profile_id")
			.notNull()
			.references(() => customerProfiles.id, { onDelete: "restrict" }),
		field: text("field").notNull(),
		valueHash: text("value_hash").notNull(),
		confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("application_profile_confirmations_app_field_uniq").on(t.applicationId, t.field),
	],
);
