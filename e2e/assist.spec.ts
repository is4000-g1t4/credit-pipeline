// EN-01/02/03 (API-only; no UI yet). The happy path runs with
// ASSIST_ENABLED=true and the flag-off case runs with it false; each test
// skips in the other mode. The service-level flag-off matrix is also covered
// by apps/applications integration tests.
import { expect, test } from "@playwright/test";
import dotenv from "dotenv";
import { Api, ApiError, smeApplication, waitStatus } from "./helpers.js";

dotenv.config();

const enabled = process.env.ASSIST_ENABLED === "true";

test("officer drafts, validates, and approves a credit memo", async () => {
	test.skip(!enabled, "set ASSIST_ENABLED=true to run the assist happy path");
	const applicant = new Api();
	await applicant.login("tomas@cafe-aurora.example");
	const created = await applicant.post<{ application: { id: string } }>("/api/applications", {
		...smeApplication({
			amountCents: 6_000_000,
			termMonths: 60,
			purpose: "Cafe expansion",
			identity: {
				fullName: "Tomas Aurora",
				dob: "1985-03-20",
				nationalId: "TOMAS42X1",
				email: "tomas@cafe-aurora.example",
				phone: "+1-555-0200",
				address: "2 Cafe Street",
				city: "Demo City",
			},
			sme: {
				companyName: "Cafe Aurora",
				registrationNumber: "CAFEAUR1",
				industry: "hospitality",
				yearsTrading: 4,
				employees: 9,
				annualRevenueCents: 61_000_000,
				monthlyFcfCents: 380_000,
				existingDebtServiceCents: 30_000,
			},
		}),
	});
	const appId = created.application.id;
	await waitStatus(applicant, appId, "pending_review");

	const officer = new Api();
	await officer.login("officer@example.com");
	const evidence = await officer.get<{
		bundle: { items: Array<{ sourceType: string }>; unavailable: unknown[] };
	}>(`/api/assist/cases/${appId}/evidence`);
	expect(evidence.bundle.items.length).toBeGreaterThan(0);
	expect(evidence.bundle.items.some((item) => item.sourceType === "case_fact")).toBe(true);
	expect(evidence.bundle.items.some((item) => item.sourceType === "score_reason")).toBe(true);

	const drafted = await officer.post<{
		artifact: {
			id: string;
			status: string;
			version: number;
			revision: number;
			citations: unknown[];
		};
	}>(`/api/assist/cases/${appId}/memos`);
	expect(drafted.artifact.status).toBe("draft");
	expect(drafted.artifact.version).toBe(1);
	expect(drafted.artifact.citations.length).toBeGreaterThan(0);

	const approved = await officer.post<{ artifact: { status: string; approvedBy: string | null } }>(
		`/api/assist/artifacts/${drafted.artifact.id}/approve`,
		{ expectedRevision: drafted.artifact.revision, confirm: true },
	);
	expect(approved.artifact.status).toBe("approved");
	expect(approved.artifact.approvedBy).toBeTruthy();

	const list = await officer.get<{ items: Array<{ id: string; status: string }> }>(
		`/api/assist/cases/${appId}/artifacts?type=credit_memo`,
	);
	expect(
		list.items.some((item) => item.id === drafted.artifact.id && item.status === "approved"),
	).toBe(true);
});

test("assist routes are not available while the flag is off", async () => {
	test.skip(enabled, "set ASSIST_ENABLED=false to run the flag-off case");
	const officer = new Api();
	await officer.login("officer@example.com");
	const failure = await officer
		.get(`/api/assist/cases/${crypto.randomUUID()}/evidence`)
		.catch((err: unknown) => err);
	expect(failure).toBeInstanceOf(ApiError);
	expect((failure as ApiError).status).toBe(404);
});
