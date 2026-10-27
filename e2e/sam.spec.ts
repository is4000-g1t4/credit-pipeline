// Sam decline path (AC-6): UI login → /apply wizard $10,000/36m →
// automatic declined with SCORE_TOO_LOW + negative factors visible;
// no loan is created.
import { expect, test } from "@playwright/test";
import {
	Api,
	getCase,
	individualApplication,
	submitApplication,
	uiLogin,
	waitTerminal,
} from "./helpers.js";

test("Sam decline path: apply → declined SCORE_TOO_LOW, no loan", async ({ page }) => {
	const api = new Api();
	await api.login("sam@example.com");
	await uiLogin(page, "sam@example.com");

	const appId = await submitApplication(
		page,
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

	// Automatic decline, no officer step (API state proof).
	const done = await waitTerminal(api, appId);
	expect(done.application.status).toBe("declined");
	expect(done.decision?.decidedBy).toBe("system");
	const codes = (done.decision?.reasons ?? []).map((r) => (typeof r === "string" ? r : r.code));
	expect(codes).toContain("SCORE_TOO_LOW");
	expect(done.loan).toBeNull();

	// UI proof: declined badge, SCORE_TOO_LOW, no loan card.
	await expect(page.getByText("SCORE_TOO_LOW").first()).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.getByText("Decision: declined (system)")).toBeVisible();
	await expect(page.getByText("Loan", { exact: true })).toHaveCount(0);
	const detail = await getCase(api, appId);
	expect(detail.loan).toBeNull();
});
