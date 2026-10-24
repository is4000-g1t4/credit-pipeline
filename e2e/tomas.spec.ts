// Tomás refer path (AC-7): UI login → /apply wizard $60,000/60m SME
// (hospitality, 4y, 9 employees, $610k revenue, $3.8k FCF, $300 service) →
// pending_review with amount + SECTOR_REVIEW reasons → officer queue shows
// the case and it stays decidable (W5 wobble pin) → approve $50,000/60m +
// note → booked at $50,000 with officer terms.
import { expect, test } from "@playwright/test";
import {
	Api,
	getCase,
	gotoHydrated,
	smeApplication,
	submitApplication,
	uiLogin,
	uiLogout,
	waitStatus,
	waitTerminal,
} from "./helpers.js";

test("Tomás refer path: SME submit → queue → approve $50k → booked", async ({ page }) => {
	const applicant = new Api();
	await applicant.login("tomas@cafe-aurora.example");
	await uiLogin(page, "tomas@cafe-aurora.example");

	const appId = await submitApplication(
		page,
		smeApplication({
			amountCents: 6_000_000,
			termMonths: 60,
			purpose: "Café expansion",
			identity: {
				fullName: "Tomas Aurora",
				dob: "1985-03-20",
				nationalId: "TOMAS42X1",
				email: "tomas@cafe-aurora.example",
				phone: "+1-555-0200",
				address: "2 Café Street",
				city: "Demo City",
			},
			sme: {
				companyName: "Café Aurora",
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

	// Referred, with amount + SECTOR_REVIEW reasons (API state proof).
	const pending = await waitStatus(applicant, appId, "pending_review");
	expect(pending.application.status).toBe("pending_review");
	const reasonCodes = (pending.policyEvaluation?.reasons ?? []).map((r) => r.code);
	expect(reasonCodes).toContain("AMOUNT_ABOVE_AUTO_LIMIT");
	expect(reasonCodes).toContain("SECTOR_REVIEW");
	await expect(page.getByText("AMOUNT_ABOVE_AUTO_LIMIT")).toBeVisible({
		timeout: 60_000,
	});
	const reference = pending.application.reference;

	// --- W5 wobble pin: the case is in the officer queue AND still
	// pending_review immediately before the decision is sent. The earlier
	// 1-then-0 read was a referred case terminal-transitioning between
	// runs; targeting our own id plus a pre-decision status check makes
	// that visible instead of flaky.
	const officer = new Api();
	await officer.login("officer@example.com");
	const queue = await officer.get<{ items: Array<{ id: string }> }>("/api/review/queue");
	expect(queue.items.map((i) => i.id)).toContain(appId);

	await uiLogout(page);
	await uiLogin(page, "officer@example.com");
	await gotoHydrated(page, "/officer/review");
	await expect(page.getByRole("link", { name: reference })).toBeVisible({
		timeout: 60_000,
	});
	await page.getByRole("link", { name: reference }).click();
	await page.waitForURL(/\/officer\/review\/.+/);

	// Still decidable right before deciding (API proof, same run).
	const before = await getCase(officer, appId);
	expect(before.application.status).toBe("pending_review");

	// --- Officer decision: approve at reduced $50,000/60m with a note. ---
	await page.locator("#field-amount-usd").fill("50000");
	await page.locator("#field-term-months").fill("60");
	await page
		.locator("#field-note-optional")
		.fill("Counter-offer: reduced to $50,000 on current cash flow.");
	await page.getByRole("button", { name: "Approve" }).click();
	await page.waitForURL(/\/officer\/review\/?$/);

	// Booked at officer terms (API state proof)…
	const done = await waitTerminal(officer, appId);
	expect(done.application.status).toBe("booked");
	expect(done.decision?.outcome).toBe("approved");
	expect(done.decision?.approvedAmountCents).toBe(5_000_000);
	expect(done.decision?.termMonths).toBe(60);
	expect(done.loan?.principalCents).toBe(5_000_000);
	expect(done.loan?.termMonths).toBe(60);

	// …and the UI reflects the officer terms on the case page.
	await gotoHydrated(page, `/officer/review/${appId}`);
	await expect(page.getByText("Case is booked — no decision needed.")).toBeVisible();
	await expect(page.getByText("$50,000.00").first()).toBeVisible();
});
