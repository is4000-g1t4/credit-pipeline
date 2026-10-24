// Maria auto path (AC-3): UI login → /apply wizard $12,000/48m
// personal_loan → processing → booked, score 777/A → loan page shows 48
// installments, next due, no alerts. Targets the application created in
// this run (URL id); leftover rows from prior runs are ignored.
import { expect, test } from "@playwright/test";
import {
	Api,
	getCase,
	gotoHydrated,
	individualApplication,
	submitApplication,
	uiLogin,
	waitTerminal,
} from "./helpers.js";

test("Maria auto path: apply → booked, 777/A, 48 installments", async ({ page }) => {
	const api = new Api();
	await api.login("maria@example.com");
	await uiLogin(page, "maria@example.com");

	const appId = await submitApplication(
		page,
		individualApplication({
			amountCents: 1_200_000,
			termMonths: 48,
			purpose: "Home renovation",
			identity: {
				fullName: "Maria Demo",
				dob: "1990-05-14",
				nationalId: "MARIA42X1",
				email: "maria@example.com",
				phone: "+1-555-0100",
				address: "1 Demo Street",
				city: "Demo City",
			},
			individual: {
				employmentStatus: "employed",
				employerName: "Acme Corp",
				employmentYears: 6,
				monthlyIncomeCents: 420_000,
				existingDebtCents: 61_000,
				bankRelationshipYears: 3,
			},
		}),
	);

	// Processing first (proves the UI shows the non-terminal state)…
	await expect(page.getByText("Updating automatically…")).toBeVisible();
	// …then booked (API poll for state, UI for the visible proof).
	const done = await waitTerminal(api, appId);
	expect(done.application.status).toBe("booked");
	expect(done.score?.score).toBe(777);
	expect(done.score?.grade).toBe("A");
	await expect(page.getByText("Score 777 / grade A")).toBeVisible({
		timeout: 60_000,
	});

	// --- Loan page: 48 installments, next due, no alerts. ---
	const detail = await getCase(api, appId);
	const loanId = detail.loan?.id;
	expect(loanId).toBeTruthy();
	expect(detail.loan?.installments.total).toBe(48);
	await gotoHydrated(page, `/loans/${loanId}`);
	await expect(page.locator("table tbody tr")).toHaveCount(48);
	await expect(page.getByText("No alerts.")).toBeVisible();
	// Next due renders a real date, not the null placeholder.
	const nextDue = page.locator("dt", { hasText: "Next due" }).locator("..").locator("dd");
	await expect(nextDue).not.toHaveText("—");
});
