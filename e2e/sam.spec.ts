// Sam decline path (AC-6): UI login → /apply wizard $10,000/36m →
// automatic declined with SCORE_TOO_LOW + negative factors visible;
// no loan is created.
import { expect, test } from "@playwright/test";
import { Api, getCase, gotoHydrated, uiLogin, waitTerminal } from "./helpers.js";

test("Sam decline path: apply → declined SCORE_TOO_LOW, no loan", async ({ page }) => {
	const api = new Api();
	await api.login("sam@example.com");
	await uiLogin(page, "sam@example.com");

	// --- Step 1: $10,000/36m personal_loan. ---
	await gotoHydrated(page, "/apply");
	await page.locator("#field-borrower-type").selectOption("individual");
	await page.locator("#field-amount-usd").fill("10000");
	await page.locator("#field-term-months").fill("36");
	await page.locator("#field-purpose").fill("Used car");
	await page.getByRole("button", { name: "Continue" }).click();

	// --- Step 2: identity + individual block (§5.1 Sam vector). ---
	await page.locator("#field-full-name").fill("Sam Demo");
	await page.locator("#field-date-of-birth").fill("1992-08-04");
	await page.locator("#field-national-id").fill("SAMDEMO11");
	await page.locator("#field-phone").fill("+1-555-0300");
	await page.locator("#field-address").fill("3 Demo Street");
	await page.locator("#field-employment-status").selectOption("employed");
	await page.locator("#field-employer-name").fill("Gig Platform");
	await page.locator("#field-employment-years").fill("1");
	await page.locator("#field-bank-relationship-years").fill("0");
	await page.locator("#field-monthly-income").fill("2800");
	await page.locator("#field-existing-debt").fill("950");
	await page.getByRole("button", { name: "Continue" }).click();

	// --- Step 3: consents + submit → /applications/:id. ---
	await page.getByLabel("Credit check consent").check();
	await page.getByLabel("Data processing consent").check();
	await page.getByLabel("Terms consent").check();
	await page.getByRole("button", { name: "Submit application" }).click();
	await page.waitForURL(/\/applications\/.+/);
	const appId = page.url().split("/").pop() ?? "";
	expect(appId).toMatch(/^[0-9a-f-]{36}$/);

	// Automatic decline, no officer step (API state proof).
	const done = await waitTerminal(api, appId);
	expect(done.application.status).toBe("declined");
	expect(done.decision?.decidedBy).toBe("system");
	const codes = (done.decision?.reasons ?? []).map((r) => (typeof r === "string" ? r : r.code));
	expect(codes).toContain("SCORE_TOO_LOW");
	expect(done.loan).toBeNull();

	// UI proof: declined badge, SCORE_TOO_LOW, negative factors, no loan card.
	await expect(page.getByText("SCORE_TOO_LOW").first()).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.getByText("(DELINQUENCIES)").first()).toBeVisible();
	await expect(page.getByText("Decision: declined (system)")).toBeVisible();
	await expect(page.getByText("Loan", { exact: true })).toHaveCount(0);
	const detail = await getCase(api, appId);
	expect(detail.loan).toBeNull();
});
