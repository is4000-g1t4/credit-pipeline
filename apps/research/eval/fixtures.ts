// Shared demo-case fixtures for the research evals. Seeded applications are
// marked with fixture_key=eval-* so cleanup can never touch live rows.
import { randomUUID } from "node:crypto";
import { createDb } from "@credit/db/applications";

export type PersonaName = "breadtalk" | "alex" | "sparse";

export interface ContextCase {
	name: string;
	applicationId: string;
	caseFacts: Record<string, unknown>;
	asOfDate: string;
	keywords: string[];
	cleanup: boolean;
}

export const personas: Record<
	PersonaName,
	{
		email: string;
		type: "sme" | "individual";
		product: "sme_term_loan" | "personal_loan";
		amountCents: number;
		termMonths: number;
		financial: Record<string, unknown> | null;
		keywords: string[];
	}
> = {
	breadtalk: {
		email: "breadtalk@example.com",
		type: "sme",
		product: "sme_term_loan",
		amountCents: 6_000_000,
		termMonths: 36,
		financial: null,
		keywords: [
			"prior",
			"loan",
			"document",
			"cash",
			"round",
			"returned",
			"declared",
			"fcf",
			"report",
			"kyc",
			"transaction",
		],
	},
	alex: {
		email: "alex@example.com",
		type: "individual",
		product: "personal_loan",
		amountCents: 1_500_000,
		termMonths: 36,
		financial: {
			employmentStatus: "employed",
			employerName: "Acme Corp",
			employmentYears: 3,
			monthlyIncomeCents: 520_000,
			existingDebtCents: 40_000,
			bankRelationshipYears: 4,
		},
		keywords: ["salary", "bank", "payslip", "document", "prior", "loan", "transaction"],
	},
	sparse: {
		email: "sparse@example.com",
		type: "individual",
		product: "personal_loan",
		amountCents: 1_000_000,
		termMonths: 24,
		financial: {
			employmentStatus: "employed",
			employerName: "Demo Retail",
			employmentYears: 1,
			monthlyIncomeCents: 300_000,
			existingDebtCents: 10_000,
			bankRelationshipYears: 1,
		},
		keywords: ["insufficient", "no account", "no transaction", "unavailable", "sparse", "missing"],
	},
};

export async function ensureCase(
	sql: ReturnType<typeof createDb>["sql"],
	name: PersonaName,
): Promise<ContextCase> {
	const p = personas[name];
	const [profile] = (await sql`
		SELECT user_id, identity, business
		FROM customer_profiles
		WHERE identity->>'email' = ${p.email}
		LIMIT 1
	`) as unknown as Array<Record<string, unknown>>;
	if (!profile) throw new Error(`missing customer profile for ${name}`);
	const userId = profile.user_id as string;
	const existing = (await sql`
		SELECT id, reference, type, product, amount_cents, term_months, identity, business,
		       financial, status, submitted_at
		FROM applications
		WHERE applicant_user_id = ${userId}
		  AND context_analysis_consent = true
		  AND submitted_at IS NOT NULL
		  AND fixture_key LIKE 'eval-%'
		  AND status IN ('submitted', 'processing', 'pending_review')
		ORDER BY created_at DESC
		LIMIT 1
	`) as unknown as Array<Record<string, unknown>>;
	let row = existing[0];
	let cleanup = false;
	if (!row) {
		const reference = `EVAL-${name.toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;
		const fixtureKey = `eval-${reference}`;
		const identity = profile.identity ?? {};
		const business = profile.business ?? null;
		const [inserted] = (await sql`
			INSERT INTO applications
				(reference, applicant_user_id, type, product, status, amount_cents, term_months,
				 purpose, identity, financial, business, consents, ai_research_consent,
				 document_processing_consent, context_analysis_consent, submitted_at, fixture_key)
			VALUES
				(${reference}, ${userId}, ${p.type}::application_type,
				 ${p.product}::application_product, 'pending_review',
				 ${p.amountCents}, ${p.termMonths}, 'settings eval',
				 ${JSON.stringify(identity)}::jsonb, ${JSON.stringify(p.financial)}::jsonb,
				 ${JSON.stringify(business)}::jsonb, ${JSON.stringify([true, true, true])}::jsonb,
				 true, true, true, ${"2026-06-30T00:00:00Z"}::timestamptz, ${fixtureKey})
			RETURNING id, reference, type, product, amount_cents, term_months, identity, business,
			          financial, status, submitted_at
		`) as unknown as Array<Record<string, unknown>>;
		row = inserted;
		cleanup = true;
	}
	const identity = (row.identity ?? {}) as Record<string, unknown>;
	const business = (row.business ?? null) as Record<string, unknown> | null;
	const submittedAt = new Date(row.submitted_at as string);
	return {
		name,
		applicationId: row.id as string,
		asOfDate: submittedAt.toISOString().slice(0, 10),
		caseFacts: {
			applicationId: row.id,
			reference: row.reference,
			type: row.type,
			product: row.product,
			amountCents: row.amount_cents,
			termMonths: row.term_months,
			submittedAt: submittedAt.toISOString(),
			asOf: submittedAt.toISOString(),
			applicantName: identity.fullName ?? "",
			companyName: business?.companyName ?? null,
			registrationNumber: business?.registrationNumber ?? null,
			industry: business?.industry ?? null,
			yearsTrading: business?.yearsTrading ?? null,
			city: identity.city ?? null,
			status: row.status,
		},
		keywords: p.keywords,
		cleanup,
	};
}
