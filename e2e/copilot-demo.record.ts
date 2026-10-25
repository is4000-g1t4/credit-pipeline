// Temporary recording spec: shows the officer copilot flow end to end.
import { expect, test } from "@playwright/test";
import { Api, ApiError, gotoHydrated, smeApplication, uiLogin, waitStatus } from "./helpers.js";

test("officer drafts, reviews, edits, and approves a credit memo", async ({ page }) => {
	test.setTimeout(300_000);
	const applicant = new Api();
	await applicant.login("tomas@cafe-aurora.example");
	let appId = "";
	try {
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
		appId = created.id;
		await waitStatus(applicant, appId, "pending_review");
	} catch (err) {
		// The demo DB enforces 3 non-terminal applications per applicant. Reuse
		// this applicant's queued case when the fixture cap is already exhausted.
		if (!(err instanceof ApiError) || err.code !== "TOO_MANY_APPLICATIONS") throw err;
		const mine = await applicant.get<{
			items: Array<{ id: string; status: string }>;
		}>("/api/applications?limit=50");
		const officer = new Api();
		await officer.login("officer@example.com");
		for (const item of mine.items.filter((row) => row.status === "pending_review")) {
			const artifacts = await officer.get<{ items: unknown[] }>(
				`/api/assist/cases/${item.id}/artifacts?type=credit_memo`,
			);
			if (artifacts.items.length === 0) {
				appId = item.id;
				break;
			}
		}
		if (!appId) throw err;
	}

	await uiLogin(page, "officer@example.com");
	await gotoHydrated(page, `/officer/review/${appId}`);
	await expect(page.getByRole("heading", { name: "Credit memo" })).toBeVisible({
		timeout: 60_000,
	});
	await page.waitForTimeout(1_500);

	// The copilot starts from the case evidence; the agent may take a minute.
	const draft = page.getByRole("button", { name: /Draft memo|Re-draft memo/ });
	await expect(draft).toBeVisible({ timeout: 30_000 });
	await draft.click();
	await expect(page.getByRole("heading", { name: "Agent trace (metadata)" })).toBeVisible({
		timeout: 180_000,
	});
	await page.screenshot({ path: "e2e/recordings/copilot-drafted.png", fullPage: true });
	await page.getByRole("heading", { name: "Agent trace (metadata)" }).scrollIntoViewIfNeeded();
	await page.waitForTimeout(2_000);

	// Officer edits a claim; citations and provenance stay attached.
	await page.getByRole("button", { name: "Edit memo" }).click();
	const claim = page.locator('textarea[aria-label^="Edit claim"]').first();
	await expect(claim).toBeVisible();
	await claim.fill(`${await claim.inputValue()} Officer reviewed.`);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("button", { name: "Approve memo" })).toBeVisible({
		timeout: 30_000,
	});
	await page.waitForTimeout(1_000);

	// Explicit two-step approval.
	await page.getByRole("button", { name: "Approve memo" }).click();
	await page.getByRole("button", { name: "Confirm approval" }).click();
	await expect(page.getByText(/Approved/)).toBeVisible({ timeout: 30_000 });
	await page.screenshot({ path: "e2e/recordings/copilot-approved.png", fullPage: true });
	await page.waitForTimeout(1_500);
});
