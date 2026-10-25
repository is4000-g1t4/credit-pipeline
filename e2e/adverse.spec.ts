// Adverse-action letter (API-only): Sam decline → officer drafts, approves;
// applicant is 403. Flag-off case runs with ASSIST_ENABLED=false.
import { expect, test } from "@playwright/test";
import dotenv from "dotenv";
import { Api, individualApplication, smeApplication, waitStatus, waitTerminal } from "./helpers.js";

dotenv.config();

const enabled = process.env.ASSIST_ENABLED === "true";
const contactConfigured = (process.env.ASSIST_ADVERSE_CONTACT_PATH ?? "").trim().length > 0;

interface AdverseContent {
	decisionId: string;
	jurisdiction: string;
	profileVersion: string;
	decision: string;
	principalReasons: Array<{
		code: string;
		text: string;
		citations: Array<{ ref: string; quote: string }>;
	}>;
	notices: string[];
	contactPath: string;
}

interface AdverseDraft {
	artifact: {
		id: string;
		type: string;
		status: string;
		version: number;
		revision: number;
		content: AdverseContent;
	};
}

test("officer drafts and approves an adverse-action letter for a declined case", async () => {
	test.skip(!enabled, "set ASSIST_ENABLED=true to run the adverse-action happy path");
	test.skip(
		!contactConfigured,
		"set ASSIST_ADVERSE_CONTACT_PATH to run the adverse-action happy path",
	);
	const sam = new Api();
	await sam.login("sam@example.com");
	const created = await sam.post<{ id: string }>(
		"/api/applications",
		individualApplication({
			amountCents: 1_000_000,
			termMonths: 36,
			purpose: "Used car",
			identity: {
				fullName: "Sam Demo",
				dob: "1992-08-04",
				nationalId: "SAMDEMO11",
				email: "sam@example.com",
				phone: "+1-555-0300",
				address: "3 Demo Street",
				city: "Demo City",
			},
			individual: {
				employmentStatus: "employed",
				employerName: "Gig Platform",
				employmentYears: 1,
				monthlyIncomeCents: 280_000,
				existingDebtCents: 95_000,
				bankRelationshipYears: 0,
			},
		}),
	);
	const appId = created.id;
	const done = await waitTerminal(sam, appId);
	expect(done.application.status).toBe("declined");
	expect((done.decision?.reasons ?? []).length).toBeGreaterThanOrEqual(3);

	const officer = new Api();
	await officer.login("officer@example.com");
	const drafted = await officer.post<AdverseDraft>(`/api/assist/cases/${appId}/adverse-action`);
	expect(drafted.artifact.type).toBe("adverse_action_letter");
	expect(drafted.artifact.status).toBe("draft");
	expect(drafted.artifact.version).toBe(1);
	const content = drafted.artifact.content;
	expect(content.jurisdiction).toBe("SG");
	expect(content.decision).toBe("not_successful");
	expect(content.profileVersion).toBe("sg-feat-v2");
	expect(content.principalReasons.length).toBeGreaterThanOrEqual(3);
	expect(content.principalReasons.length).toBeLessThanOrEqual(4);
	expect(content.notices.length).toBeGreaterThanOrEqual(3);
	expect(content.contactPath).toBeTruthy();
	expect(content.decisionId).toBeTruthy();
	const banned = /\b(score|decline|reject|recommend|limit|terms)\b/i;
	for (const reason of content.principalReasons) {
		expect(reason.citations.length).toBeGreaterThanOrEqual(1);
		expect(reason.text).not.toMatch(banned);
	}

	const approved = await officer.post<{ artifact: { status: string } }>(
		`/api/assist/artifacts/${drafted.artifact.id}/approve`,
		{ expectedRevision: drafted.artifact.revision, confirm: true },
	);
	expect(approved.artifact.status).toBe("approved");

	const applicant = new Api();
	await applicant.login("sam@example.com");
	const denied = await applicant.postRaw(`/api/assist/cases/${appId}/adverse-action`);
	expect(denied.status).toBe(403);
});

test("adverse-action route is not available while the flag is off", async () => {
	test.skip(enabled, "set ASSIST_ENABLED=false to run the flag-off case");
	const applicant = new Api();
	await applicant.login("tomas@cafe-aurora.example");
	const created = await applicant.post<{ id: string }>(
		"/api/applications",
		smeApplication({
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
	);
	// A real pending case proves the 404 is the flag gate, not the case lookup:
	// with the gate removed this route would return 409 CASE_NOT_DECLINED.
	await waitStatus(applicant, created.id, "pending_review");
	const officer = new Api();
	await officer.login("officer@example.com");
	const missing = await officer.postRaw(`/api/assist/cases/${created.id}/adverse-action`);
	expect(missing.status).toBe(404);
});
