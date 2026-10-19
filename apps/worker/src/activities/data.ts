// Mock data gathering (SPEC FR-3): deterministic core mocks persisted to
// external_reports unique (application_id,provider,kind) — upsert on retry
// (FR-3.3). forcedFailure is the FR-3.4 test hook (throws before any write).
import {
	BANK_PROVIDER,
	BANK_VERSION,
	BUREAU_PROVIDER,
	BUREAU_VERSION,
	mockBankIndividual,
	mockBankSme,
	mockBureau,
} from "@credit/core";
import { externalReports, withTx } from "@credit/db/applications";
import { getApplicationsDb } from "../db.js";
import { loadApplicationRow } from "./application.js";
import { writeAudit } from "@credit/service-kit";
import type { DataFetchInput } from "./types.js";

async function storeReport(
	applicationId: string,
	provider: string,
	kind: "bureau" | "bank",
	version: string,
	payload: unknown,
): Promise<void> {
	const { db } = getApplicationsDb();
	await withTx(db, async (tx) => {
		await tx
			.insert(externalReports)
			.values({ applicationId, provider, kind, version, payload })
			.onConflictDoUpdate({
				target: [externalReports.applicationId, externalReports.provider, externalReports.kind],
				set: { version, payload, fetchedAt: new Date() },
			});
		await writeAudit(tx, {
			applicationId,
			actor: "system",
			action: `data.${kind}`,
			entity: "external_report",
			payload: { provider, kind, version, mock: true },
		});
	});
}

export async function fetchBureauReport(input: DataFetchInput): Promise<unknown> {
	const app = await loadApplicationRow(input.applicationId);
	const identity = app.identity as {
		email: string;
		nationalId: string;
	};
	const business = app.business as { registrationNumber?: string } | null;
	const report = mockBureau(
		{
			email: identity.email,
			nationalId: identity.nationalId,
			registrationNumber: business?.registrationNumber,
		},
		{ forcedFailure: input.forcedFailure },
	);
	await storeReport(input.applicationId, BUREAU_PROVIDER, "bureau", BUREAU_VERSION, report);
	return report;
}

export async function fetchBankData(input: DataFetchInput): Promise<unknown> {
	const app = await loadApplicationRow(input.applicationId);
	const identity = app.identity as { email: string };
	let report: unknown;
	if (app.type === "individual") {
		const fin = app.financial as {
			monthlyIncomeCents: number;
			existingDebtCents: number;
			bankRelationshipYears: number;
		};
		report = mockBankIndividual(
			{
				email: identity.email,
				monthlyIncomeCents: fin.monthlyIncomeCents,
				existingDebtCents: fin.existingDebtCents,
				relationshipYears: fin.bankRelationshipYears,
			},
			{ forcedFailure: input.forcedFailure },
		);
	} else {
		const biz = app.business as {
			annualRevenueCents: number;
			monthlyFcfCents: number;
			yearsTrading: number;
		};
		report = mockBankSme(
			{
				email: identity.email,
				annualRevenueCents: biz.annualRevenueCents,
				declaredFcfCents: biz.monthlyFcfCents,
				// ponytail: SME has no account-age field; years trading is the
				// declared-tenure proxy (SPEC FR-3.2 account age).
				accountAgeYears: biz.yearsTrading,
			},
			{ forcedFailure: input.forcedFailure },
		);
	}
	await storeReport(input.applicationId, BANK_PROVIDER, "bank", BANK_VERSION, report);
	return report;
}
