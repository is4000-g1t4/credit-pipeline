// @credit/db/applications — applications service only (credit_applications):
// applications, kyc_checks, external_reports, documents, scores,
// policy_evaluations, decisions, idempotency_keys, plus the shared
// audit_log/outbox_events. applicant_user_id / officer_user_id are plain
// uuids — no FK to users (cross-database references must never be FKs).
import {
	bigint,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
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
		submittedAt: timestamp("submitted_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
		workflowStartedAt: timestamp("workflow_started_at", {
			withTimezone: true,
			mode: "date",
		}),
		decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
		failedReason: text("failed_reason"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index("applications_status_idx").on(t.status)],
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
