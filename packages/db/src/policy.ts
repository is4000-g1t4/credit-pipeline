// @credit/db/policy — credit policy corpus only (credit_policy).
// Versioned policy documents with stable section IDs, owners, approvals,
// ACLs, retrieval chunks (pgvector), index generations, and spend ledgers.
// See docs/specs/t03-t04-policy-corpus-and-navigator.md §5.
import { sql } from "drizzle-orm";
import {
	check,
	customType,
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	vector,
} from "drizzle-orm/pg-core";

export { createDb, withTx, type Db, type Tx } from "./client.js";

// Eval placeholder: the embedding eval (SPEC §7.4) picks the final model /
// dimension. Change this one constant (and re-embed + migrate) afterwards.
// Chosen by the held-out embedding eval (voyage-4-large, 1024 dims).
// Changing this requires a re-embed index plus a generated migration.
export const POLICY_EMBEDDING_DIMENSIONS = 1024;

const createdAt = () =>
	timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull();

const updatedAt = () =>
	timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull();

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const tsNotNull = (name: string) =>
	timestamp(name, { withTimezone: true, mode: "date" }).defaultNow().notNull();

// Full-text column for hybrid search; populated by Postgres from
// heading/text. The GIN index lives in the hand-written SQL migration.
const tsvector = customType<{ data: string }>({
	dataType: () => "tsvector",
});

export const policyDomain = pgEnum("policy_domain", ["credit"]);
export const policyFamily = pgEnum("policy_family", [
	"underwriting",
	"affordability",
	"documentation",
	"exceptions",
	"pricing",
	"servicing",
]);
export const productScope = pgEnum("product_scope", ["individual", "sme", "all"]);
export const versionStatus = pgEnum("version_status", ["draft", "approved", "retired"]);
export const policyAclPrincipal = pgEnum("policy_acl_principal", ["role", "user", "service"]);
export const policyAclPermission = pgEnum("policy_acl_permission", [
	"read",
	"case_explain",
	"admin",
]);
export const policyRole = pgEnum("policy_role", ["policy_owner", "compliance"]);
export const policyGrantVia = pgEnum("policy_grant_via", ["bootstrap", "ops_cli"]);
export const policyCreatedVia = pgEnum("policy_created_via", ["cli_editor", "demo_seed", "api"]);
export const policyQueryMode = pgEnum("policy_query_mode", ["navigator", "case_explain"]);
export const policyBudgetClass = pgEnum("policy_budget_class", [
	"navigator",
	"case",
	"policy_exception",
]);
export const policyQueryStatus = pgEnum("policy_query_status", [
	"succeeded",
	"no_match",
	"needs_policy_owner",
	"out_of_scope",
	"identifier_blocked",
	"rate_limited",
	"budget_exceeded",
	"failed",
]);
export const indexStatus = pgEnum("index_status", ["building", "active", "retired"]);
export const approvalAction = pgEnum("approval_action", [
	"draft_created",
	"submitted",
	"approved",
	"retired",
	"rejected",
]);

export const policyDocuments = pgTable("policy_documents", {
	id: uuid("id").defaultRandom().primaryKey(),
	policyKey: text("policy_key").notNull().unique(),
	title: text("title").notNull(),
	domain: policyDomain("domain").notNull(),
	family: policyFamily("policy_family").notNull(),
	scope: productScope("product_scope").notNull(),
	jurisdiction: text("jurisdiction").notNull(),
	// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
	ownerId: uuid("owner_id").notNull(),
	createdAt: createdAt(),
});

export const policyRoles = pgTable(
	"policy_roles",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id").notNull(),
		role: policyRole("role").notNull(),
		// Null only for the bootstrap row (ops CLI with DB credentials).
		grantedBy: uuid("granted_by"),
		grantedVia: policyGrantVia("granted_via").notNull(),
		grantedAt: tsNotNull("granted_at"),
		revokedAt: ts("revoked_at"),
	},
	(t) => [
		uniqueIndex("policy_roles_active_user_role_uniq")
			.on(t.userId, t.role)
			.where(sql`${t.revokedAt} IS NULL`),
	],
);

export const policyAcl = pgTable(
	"policy_acl",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		policyId: uuid("policy_id")
			.notNull()
			.references(() => policyDocuments.id),
		principalType: policyAclPrincipal("principal_type").notNull(),
		principal: text("principal").notNull(),
		permission: policyAclPermission("permission").notNull(),
		grantedBy: uuid("granted_by"),
		grantedAt: tsNotNull("granted_at"),
		revokedAt: ts("revoked_at"),
	},
	(t) => [
		uniqueIndex("policy_acl_active_policy_principal_permission_uniq")
			.on(t.policyId, t.principalType, t.principal, t.permission)
			.where(sql`${t.revokedAt} IS NULL`),
	],
);

// Append-only: every ACL grant/revoke writes a row. `action` is
// grant/revoke; `actor_id` is null for ops-CLI changes.
export const policyAclAudit = pgTable(
	"policy_acl_audit",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		policyId: uuid("policy_id")
			.notNull()
			.references(() => policyDocuments.id),
		principal: text("principal").notNull(),
		permission: policyAclPermission("permission").notNull(),
		action: text("action").notNull(),
		actorId: uuid("actor_id"),
		createdAt: createdAt(),
	},
	(t) => [index("policy_acl_audit_policy_time_idx").on(t.policyId, t.createdAt)],
);

export const policyVersions = pgTable(
	"policy_versions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		policyId: uuid("policy_id")
			.notNull()
			.references(() => policyDocuments.id),
		version: text("version").notNull(),
		status: versionStatus("status").notNull().default("draft"),
		effectiveFrom: date("effective_from", { mode: "string" }),
		effectiveTo: date("effective_to", { mode: "string" }),
		// `service:policy_editor` for CLI imports; a human creator is
		// recorded in createdByUserId, never smuggled through a flag.
		createdByPrincipal: text("created_by_principal").notNull(),
		createdByUserId: uuid("created_by_user_id"),
		createdVia: policyCreatedVia("created_via").notNull(),
		sourceCommit: text("source_commit"),
		sourceAuthor: text("source_author"),
		// Authenticated human submitter/approver; null until submit/approve.
		submittedBy: uuid("submitted_by"),
		submittedAt: ts("submitted_at"),
		approvedBy: uuid("approved_by"),
		approvedAt: ts("approved_at"),
		contentHash: text("content_hash").notNull(),
		sourceUri: text("source_uri").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("policy_versions_policy_version_uniq").on(t.policyId, t.version),
		check(
			"policy_versions_approved_needs_from_chk",
			sql`${t.status} <> 'approved' OR ${t.effectiveFrom} IS NOT NULL`,
		),
		check(
			"policy_versions_effective_range_chk",
			sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
		),
		// No overlapping approved ranges: enforced by the hand-written
		// EXCLUDE USING gist migration (Drizzle cannot express it).
	],
);

export const policySections = pgTable(
	"policy_sections",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		versionId: uuid("version_id")
			.notNull()
			.references(() => policyVersions.id),
		sectionId: text("section_id").notNull(),
		parentSectionId: text("parent_section_id"),
		heading: text("heading").notNull(),
		body: text("body").notNull(),
		orderIndex: integer("order_index").notNull(),
		pageNumber: integer("page_number"),
		charStart: integer("char_start").notNull(),
		charEnd: integer("char_end").notNull(),
		contentHash: text("content_hash").notNull(),
	},
	(t) => [
		uniqueIndex("policy_sections_version_section_uniq").on(t.versionId, t.sectionId),
		check(
			"policy_sections_section_id_chk",
			sql`${t.sectionId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'`,
		),
	],
);

// Append-only: no update/delete path. Service-created draft rows use
// actorPrincipal `service:policy_editor` with null actorId.
export const policyApprovals = pgTable(
	"policy_approvals",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		versionId: uuid("version_id")
			.notNull()
			.references(() => policyVersions.id),
		actorId: uuid("actor_id"),
		actorPrincipal: text("actor_principal").notNull(),
		actorRole: text("actor_role").notNull(),
		action: approvalAction("action").notNull(),
		comment: text("comment"),
		createdAt: createdAt(),
	},
	(t) => [index("policy_approvals_version_time_idx").on(t.versionId, t.createdAt)],
);

// Retrieval index; rebuildable, not evidence. Rows always carry the
// generation they were embedded under; only the active generation is read.
export const policyChunks = pgTable(
	"policy_chunks",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		indexVersion: text("index_version")
			.notNull()
			.references(() => policyIndexMeta.indexVersion, { onDelete: "cascade" }),
		versionId: uuid("version_id")
			.notNull()
			.references(() => policyVersions.id),
		sectionId: text("section_id").notNull(),
		chunkIndex: integer("chunk_index").notNull(),
		heading: text("heading").notNull(),
		chunkText: text("text").notNull(),
		charStart: integer("char_start").notNull(),
		charEnd: integer("char_end").notNull(),
		tokenCount: integer("token_count").notNull(),
		contentHash: text("content_hash").notNull(),
		chunkingVersion: text("chunking_version").notNull(),
		embedding: vector("embedding", { dimensions: POLICY_EMBEDDING_DIMENSIONS }).notNull(),
		embeddingModel: text("embedding_model").notNull(),
		embeddingDimensions: integer("embedding_dimensions").notNull(),
		embeddingVersion: text("embedding_version").notNull(),
		tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', heading || ' ' || text)`),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("policy_chunks_generation_section_chunk_uniq").on(
			t.indexVersion,
			t.versionId,
			t.sectionId,
			t.chunkIndex,
		),
	],
);

// Index-generation metadata, not a singleton: exactly one `active` row.
export const policyIndexMeta = pgTable(
	"policy_index_meta",
	{
		indexVersion: text("index_version").primaryKey(),
		embeddingModel: text("embedding_model").notNull(),
		embeddingDimensions: integer("embedding_dimensions").notNull(),
		chunkingVersion: text("chunking_version").notNull(),
		status: indexStatus("status").notNull(),
		createdAt: createdAt(),
		activatedAt: ts("activated_at"),
	},
	(t) => [
		uniqueIndex("policy_index_meta_active_uniq")
			.on(t.status)
			.where(sql`${t.status} = 'active'`),
	],
);

// Append-only audit: no raw question/answer text, only the HMAC (or status).
export const policyQueries = pgTable(
	"policy_queries",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		actorId: uuid("actor_id").notNull(),
		actorRole: text("actor_role").notNull(),
		mode: policyQueryMode("mode").notNull(),
		budgetClass: policyBudgetClass("budget_class").notNull(),
		applicationId: uuid("application_id"),
		runId: uuid("run_id"),
		// HMAC-SHA256 of the sanitized question; null for identifier_blocked.
		questionHmac: text("question_hmac"),
		domain: policyDomain("domain").notNull(),
		asOf: date("as_of", { mode: "string" }).notNull(),
		status: policyQueryStatus("status").notNull(),
		errorCode: text("error_code"),
		retrievedSectionIds: jsonb("retrieved_section_ids"),
		usageCost: numeric("usage_cost").notNull().default("0"),
		createdAt: createdAt(),
	},
	(t) => [
		index("policy_queries_actor_created_idx").on(t.actorId, t.createdAt),
		index("policy_queries_status_created_idx").on(t.status, t.createdAt),
	],
);

// Concurrency-safe budget ledgers: reservations are taken under
// SELECT ... FOR UPDATE on the class/actor rows before provider calls.
export const policyDailySpend = pgTable(
	"policy_daily_spend",
	{
		day: date("day", { mode: "string" }).notNull(),
		budgetClass: policyBudgetClass("budget_class").notNull(),
		reservedUsd: numeric("reserved_usd").notNull().default("0"),
		spentUsd: numeric("spent_usd").notNull().default("0"),
		updatedAt: updatedAt(),
	},
	(t) => [primaryKey({ columns: [t.day, t.budgetClass] })],
);

export const policyActorSpend = pgTable(
	"policy_actor_spend",
	{
		day: date("day", { mode: "string" }).notNull(),
		actorId: uuid("actor_id").notNull(),
		reservedUsd: numeric("reserved_usd").notNull().default("0"),
		spentUsd: numeric("spent_usd").notNull().default("0"),
		updatedAt: updatedAt(),
	},
	(t) => [primaryKey({ columns: [t.day, t.actorId] })],
);

export const policySpendReservations = pgTable(
	"policy_spend_reservations",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		day: date("day", { mode: "string" }).notNull(),
		budgetClass: policyBudgetClass("budget_class").notNull(),
		actorId: uuid("actor_id").notNull(),
		amountUsd: numeric("amount_usd").notNull(),
		expiresAt: ts("expires_at").notNull(),
		settledAt: ts("settled_at"),
	},
	(t) => [
		// Cap checks sum unsettled reservations by class/actor; the reaper
		// scans unsettled rows by expiry.
		index("policy_spend_reservations_day_class_idx")
			.on(t.day, t.budgetClass)
			.where(sql`${t.settledAt} IS NULL`),
		index("policy_spend_reservations_day_actor_idx")
			.on(t.day, t.actorId)
			.where(sql`${t.settledAt} IS NULL`),
		index("policy_spend_reservations_expiry_idx")
			.on(t.expiresAt)
			.where(sql`${t.settledAt} IS NULL`),
	],
);

// Every persisted citation is server-verified against the section body.
// itemRef/segmentIndex preserve the validated case/navigator mapping.
export const policyQueryCitations = pgTable(
	"policy_query_citations",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		queryId: uuid("query_id")
			.notNull()
			.references(() => policyQueries.id, { onDelete: "cascade" }),
		itemRef: text("item_ref"),
		segmentIndex: integer("segment_index").notNull(),
		policyId: uuid("policy_id")
			.notNull()
			.references(() => policyDocuments.id),
		versionId: uuid("version_id")
			.notNull()
			.references(() => policyVersions.id),
		sectionId: text("section_id").notNull(),
		quote: text("quote").notNull(),
		quoteStart: integer("quote_start").notNull(),
		quoteEnd: integer("quote_end").notNull(),
		contentHash: text("content_hash").notNull(),
	},
	(t) => [index("policy_query_citations_query_idx").on(t.queryId)],
);

// Replay log for short-lived case tokens: the jti insert and the policy
// query commit in the same transaction; duplicates reject 409.
export const policyCaseTokenUses = pgTable(
	"policy_case_token_uses",
	{
		jti: uuid("jti").primaryKey(),
		runId: uuid("run_id").notNull(),
		applicationId: uuid("application_id").notNull(),
		usedAt: tsNotNull("used_at"),
	},
	(t) => [index("policy_case_token_uses_run_idx").on(t.runId)],
);
