// Mock verification (SPEC FR-2.1/2.3): identity fails on national
// ID/registration '00000000'; sanctions fails on an exact-name list match;
// documents always verify (metadata only, no bytes stored). All writes are
// idempotent upserts on (application_id,type)/(application_id,kind).
import { documents, kycChecks, withTx } from "@credit/db/applications";
import { getApplicationsDb } from "../db.js";
import { loadApplicationRow } from "./application.js";
import { writeAudit } from "@credit/service-kit";
import type { DocumentResult, VerificationResult } from "./types.js";

// ponytail: SPEC leaves the mock sanctions list open; two obviously-fake
// fixtures. Exact (case-sensitive) full-name match per "exact-name list".
const SANCTIONED_NAMES: readonly string[] = ["Sanctioned Person", "Sanctioned Entity"];

const REQUIRED_DOCS = {
	individual: ["id", "payslip", "bank_statement"],
	sme: ["id", "business_registration", "financial_statements", "bank_statement"],
} as const;

interface IdentityBlock {
	fullName: string;
	nationalId: string;
	email: string;
}

async function upsertKyc(applicationId: string, type: string, passed: boolean): Promise<void> {
	const { db } = getApplicationsDb();
	const status = passed ? "passed" : "failed";
	await withTx(db, async (tx) => {
		await tx
			.insert(kycChecks)
			.values({ applicationId, type, status, details: { mock: true } })
			.onConflictDoUpdate({
				target: [kycChecks.applicationId, kycChecks.type],
				set: { status, details: { mock: true } },
			});
		await writeAudit(tx, {
			applicationId,
			actor: "system",
			action: `kyc.${type}`,
			entity: "kyc_check",
			payload: { check: type, status, mock: true },
		});
	});
}

export async function runIdentityCheck(input: {
	applicationId: string;
}): Promise<VerificationResult> {
	const app = await loadApplicationRow(input.applicationId);
	const identity = app.identity as IdentityBlock;
	const business = app.business as { registrationNumber?: string } | null;
	const documentNo =
		app.type === "individual" ? identity.nationalId : (business?.registrationNumber ?? "");
	const passed = documentNo !== "00000000";
	await upsertKyc(input.applicationId, "identity", passed);
	return { check: "identity", passed };
}

export async function runSanctionsCheck(input: {
	applicationId: string;
}): Promise<VerificationResult> {
	const app = await loadApplicationRow(input.applicationId);
	const identity = app.identity as IdentityBlock;
	const passed = !SANCTIONED_NAMES.includes(identity.fullName);
	await upsertKyc(input.applicationId, "sanctions", passed);
	return { check: "sanctions", passed };
}

export async function runDocumentCheck(input: { applicationId: string }): Promise<DocumentResult> {
	const app = await loadApplicationRow(input.applicationId);
	const kinds = [...REQUIRED_DOCS[app.type]];
	const { db } = getApplicationsDb();
	await withTx(db, async (tx) => {
		for (const kind of kinds) {
			await tx
				.insert(documents)
				.values({
					applicationId: input.applicationId,
					kind,
					status: "verified",
					note: "mock verification — no documents stored",
				})
				.onConflictDoUpdate({
					target: [documents.applicationId, documents.kind],
					set: {
						status: "verified",
						note: "mock verification — no documents stored",
					},
				});
		}
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: "system",
			action: "kyc.documents",
			entity: "document",
			payload: { kinds, status: "verified", mock: true },
		});
	});
	return { verified: true, kinds };
}
