// E3 policy/exception navigator. The happy path needs ASSIST_ENABLED and
// ASSIST_POLICY_EXCEPTION_ENABLED; the flag-off test runs in the other mode.
// The deterministic view (rules + approval/exception path) works without the
// policy service; cited explanations and memo drafting are covered by
// integration/eval suites.
import { expect, test } from "@playwright/test";
import dotenv from "dotenv";
import {
	Api,
	ApiError,
	getCase,
	gotoHydrated,
	smeApplication,
	uiLogin,
	waitStatus,
} from "./helpers.js";

dotenv.config();

const enabled =
	process.env.ASSIST_ENABLED === "true" && process.env.ASSIST_POLICY_EXCEPTION_ENABLED === "true";

function smePayload(email: string) {
	return smeApplication({
		amountCents: 6_000_000,
		termMonths: 60,
		purpose: "policy exception e2e",
		identity: {
			fullName: "Tomas Aurora",
			dob: "1985-03-20",
			nationalId: "TOMAS42X1",
			email,
			phone: "+1-555-0200",
			address: "2 Cafe Street",
			city: "Demo City",
		},
		sme: {
			companyName: "Cafe Aurora Pte Ltd",
			registrationNumber: "201812345K",
			industry: "hospitality",
			yearsTrading: 4,
			employees: 9,
			annualRevenueCents: 120_000_000,
			monthlyFcfCents: 1_200_000,
			existingDebtServiceCents: 30_000,
		},
	});
}

async function submitOrReuse(applicant: Api): Promise<{ id: string; reference: string }> {
	try {
		return await applicant.post<{ id: string; reference: string }>(
			"/api/applications",
			smePayload("tomas@cafe-aurora.example"),
		);
	} catch (err) {
		if (!(err instanceof ApiError) || err.code !== "TOO_MANY_APPLICATIONS") throw err;
		const list = await applicant.get<{
			items: Array<{ id: string; reference: string; status: string }>;
		}>("/api/applications?limit=100");
		const existing = list.items.find((a) =>
			["submitted", "processing", "pending_review"].includes(a.status),
		);
		if (!existing) throw err;
		const detail = await getCase(applicant, existing.id);
		if (detail.application.status !== "pending_review") throw err;
		return { id: existing.id, reference: existing.reference };
	}
}

test("officer sees the deterministic policy/exception view and the case is unchanged", async ({
	page,
}) => {
	test.skip(!enabled, "set ASSIST_ENABLED=true and ASSIST_POLICY_EXCEPTION_ENABLED=true");
	const applicant = new Api();
	await applicant.login("tomas@cafe-aurora.example");
	const submitted = await submitOrReuse(applicant);
	await waitStatus(applicant, submitted.id, "pending_review");

	const officer = new Api();
	await officer.login("officer@example.com");
	const before = await getCase(officer, submitted.id);
	const view = await officer.get<{
		context: {
			status: string;
			failedRules: Array<{
				ruleId: string;
				observed: string;
				threshold: string;
				mappingState: string;
			}>;
			limitations: string[];
		};
		sourceStatus: string;
	}>(`/api/assist/cases/${submitted.id}/policy-exception`);

	expect(view.context.failedRules.length).toBeGreaterThan(0);
	const ruleIds = view.context.failedRules.map((rule) => rule.ruleId);
	expect(ruleIds).toContain("SME-AMOUNT-AUTO");
	expect(view.context.failedRules.every((rule) => rule.observed.length > 0)).toBe(true);
	expect(view.context.failedRules.every((rule) => rule.threshold.length > 0)).toBe(true);

	await uiLogin(page, "officer@example.com");
	await gotoHydrated(page, `/officer/review/${submitted.id}`);
	await page.getByRole("button", { name: "Policy" }).click();
	await expect(page.getByText("Policy & exception navigator")).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.getByText("SME-AMOUNT-AUTO").first()).toBeVisible();
	await expect(page.getByText("Policy & exception navigator")).toContainText(/policy/i);

	const after = await getCase(officer, submitted.id);
	expect(after.application.status).toBe(before.application.status);
	expect(after.decision?.outcome ?? null).toBe(before.decision?.outcome ?? null);
});

test("policy exception routes and panel are dark while the flag is off", async ({ page }) => {
	test.skip(enabled, "set ASSIST_POLICY_EXCEPTION_ENABLED=false to run the flag-off case");
	const applicant = new Api();
	await applicant.login("tomas@cafe-aurora.example");
	const list = await applicant.get<{ items: Array<{ id: string; status: string }> }>(
		"/api/applications?limit=100",
	);
	const pending = list.items.find((a) => a.status === "pending_review") ?? list.items[0];
	if (!pending) test.skip(true, "no application available for the flag-off probe");

	const officer = new Api();
	await officer.login("officer@example.com");
	await expect(
		officer.get(`/api/assist/cases/${pending.id}/policy-exception`),
	).rejects.toMatchObject({ status: 404 });

	await uiLogin(page, "officer@example.com");
	await gotoHydrated(page, `/officer/review/${pending.id}`);
	await expect(page.getByText("Policy & exception navigator")).toHaveCount(0);
});
