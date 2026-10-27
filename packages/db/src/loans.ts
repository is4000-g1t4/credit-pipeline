// @credit/db/loans — loans service only (credit_loans): loans,
// installments, payments, ews_alerts, plus the shared audit_log/outbox_events.
// `loans` carries denormalised application columns (reference, applicant,
// product) so the service never joins to credit_applications: application_id
// is a plain uuid, never an FK.
import { sql } from "drizzle-orm";
import {
	bigint,
	date,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { createdAtColumn, updatedAtColumn, moneyColumn } from "./shared.js";

export { auditLog, outboxEvents } from "./shared.js";
// Client utilities re-exported so service code imports one subpath.
export { createDb, withTx, type Db, type Tx } from "./client.js";


export const loanStatus = pgEnum("loan_status", ["active", "overdue", "closed"]);
export const installmentStatus = pgEnum("installment_status", ["scheduled", "paid", "overdue"]);
export const paymentSource = pgEnum("payment_source", ["operator", "simulated"]);
export const ewsType = pgEnum("ews_type", ["payment_overdue"]);
export const ewsStatus = pgEnum("ews_status", ["open", "acknowledged", "closed"]);

export const loans = pgTable(
	"loans",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		// Cross-DB reference to credit_applications.applications — plain
		// uuid, never an FK (database-per-service).
		applicationId: uuid("application_id").notNull().unique(),
		// Denormalised at booking: no join to applications is ever needed.
		applicationReference: text("application_reference").notNull(),
		applicantUserId: uuid("applicant_user_id").notNull(),
		product: text("product").notNull(),
		principalCents: moneyColumn("principal_cents"),
		termMonths: integer("term_months").notNull(),
		rateBps: integer("rate_bps").notNull(),
		monthlyPaymentCents: moneyColumn("monthly_payment_cents"),
		status: loanStatus("status").notNull().default("active"),
		disbursedAt: timestamp("disbursed_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
		outstandingCents: moneyColumn("outstanding_cents"),
		nextDueDate: date("next_due_date"),
		createdAt: createdAtColumn(),
		updatedAt: updatedAtColumn(),
	},
	(t) => [index("loans_status_idx").on(t.status)],
);

export const installments = pgTable(
	"installments",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		loanId: uuid("loan_id")
			.notNull()
			.references(() => loans.id, { onDelete: "restrict" }),
		number: integer("number").notNull(),
		dueDate: date("due_date").notNull(),
		principalCents: moneyColumn("principal_cents"),
		interestCents: moneyColumn("interest_cents"),
		totalCents: moneyColumn("total_cents"),
		paidCents: moneyColumn("paid_cents").default(0),
		status: installmentStatus("status").notNull().default("scheduled"),
		paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
		createdAt: createdAtColumn(),
		updatedAt: updatedAtColumn(),
	},
	(t) => [
		uniqueIndex("installments_loan_id_number_uniq").on(t.loanId, t.number),
		index("installments_status_due_date_idx").on(t.status, t.dueDate),
	],
);

export const payments = pgTable("payments", {
	id: uuid("id").defaultRandom().primaryKey(),
	installmentId: uuid("installment_id")
		.notNull()
		.unique()
		.references(() => installments.id, { onDelete: "restrict" }),
	amountCents: moneyColumn("amount_cents"),
	paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
	source: paymentSource("source").notNull(),
	createdAt: createdAtColumn(),
});

export const ewsAlerts = pgTable(
	"ews_alerts",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		loanId: uuid("loan_id")
			.notNull()
			.references(() => loans.id, { onDelete: "restrict" }),
		installmentId: uuid("installment_id").references(() => installments.id, {
			onDelete: "restrict",
		}),
		type: ewsType("type").notNull(),
		severity: text("severity").notNull().default("medium"),
		status: ewsStatus("status").notNull().default("open"),
		details: jsonb("details"),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		acknowledgedBy: uuid("acknowledged_by"),
		createdAt: createdAtColumn(),
		updatedAt: updatedAtColumn(),
	},
	(t) => [
		// Loan-level alerts (installment_id NULL) are exempt: NULLs never
		// conflict, but the explicit WHERE documents the FR-10.8 intent.
		uniqueIndex("ews_alerts_installment_id_type_uniq")
			.on(t.installmentId, t.type)
			.where(sql`${t.installmentId} IS NOT NULL`),
	],
);
