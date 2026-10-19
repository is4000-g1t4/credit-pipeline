// Maria auto path (AC-3): UI login → /apply wizard $12,000/48m
// personal_loan → processing → booked, score 777/A → loan page shows 48
// installments, next due, no alerts. Targets the application created in
// this run (URL id); leftover rows from prior runs are ignored.
import { expect, test } from "@playwright/test";
import { Api, getCase, gotoHydrated, uiLogin, waitTerminal } from "./helpers.js";

test("Maria auto path: apply → booked, 777/A, 48 installments", async ({ page }) => {
	const api = new Api();
	await api.login("maria@example.com");
	await uiLogin(page, "maria@example.com");

	// --- Step 1: loan details ($12,000/48m personal_loan). ---
	await gotoHydrated(page, "/apply");
	await page.locator("#field-borrower-type").selectOption("individual");
	await page.locator("#field-amount-usd").fill("12000");
	await page.locator("#field-term-months").fill("48");
	await page.locator("#field-purpose").fill("Home renovation");
	await page.getByRole("button", { name: "Continue" }).click();

	// --- Step 2: identity + individual block (§5.1 vector). ---
	await page.locator("#field-full-name").fill("Maria Demo");
	await page.locator("#field-date-of-birth").fill("1990-05-14");
	await page.locator("#field-national-id").fill("MARIA42X1");
	await page.locator("#field-phone").fill("+1-555-0100");
	await page.locator("#field-address").fill("1 Demo Street");
	await page.locator("#field-employment-status").selectOption("employed");
	await page.locator("#field-employer-name").fill("Acme Corp");
	await page.locator("#field-employment-years").fill("6");
	await page.locator("#field-bank-relationship-years").fill("3");
	await page.locator("#field-monthly-income").fill("4200");
	await page.locator("#field-existing-debt").fill("610");
	await page.getByRole("button", { name: "Continue" }).click();

	// --- Step 3: consents + submit → /applications/:id. ---
	await page.getByLabel("Credit check consent").check();
	await page.getByLabel("Data processing consent").check();
	await page.getByLabel("Terms consent").check();
	await page.getByRole("button", { name: "Submit application" }).click();
	await page.waitForURL(/\/applications\/.+/);
	const appId = page.url().split("/").pop() ?? "";
	expect(appId).toMatch(/^[0-9a-f-]{36}$/);

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
