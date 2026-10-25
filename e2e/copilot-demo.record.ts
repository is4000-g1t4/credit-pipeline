// Manual recording harness: officer reviews an agent-drafted credit memo,
// edits a claim, and approves it. Requires an existing agent draft and
// ASSIST_ENABLED=true. Run via e2e/playwright.record.config.ts.
import { expect, test } from "@playwright/test";
import { Api, ApiError, gotoHydrated, uiLogin } from "./helpers.js";

test("officer reviews, edits, and approves an agent-drafted credit memo", async ({ page }) => {
	test.setTimeout(180_000);
	const officer = new Api();
	await officer.login("officer@example.com");

	const queue = await officer.get<{ items: Array<{ id: string }> }>("/api/review/queue");
	let appId = "";
	for (const item of queue.items) {
		let artifacts: {
			items: Array<{ status: string; agentTrace: { writer: string } | null }>;
		};
		try {
			artifacts = await officer.get<{
				items: Array<{ status: string; agentTrace: { writer: string } | null }>;
			}>(`/api/assist/cases/${item.id}/artifacts?type=credit_memo`);
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) continue;
			throw err;
		}
		if (
			artifacts.items.some(
				(a) => a.status === "draft" && a.agentTrace?.writer === "agent",
			)
		) {
			appId = item.id;
			break;
		}
	}
	if (!appId) throw new Error("no pending case with an agent-drafted memo");

	await uiLogin(page, "officer@example.com");
	await gotoHydrated(page, `/officer/review/${appId}`);
	await expect(page.getByRole("heading", { name: "Credit memo" })).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.getByRole("heading", { name: "Agent trace (metadata)" })).toBeVisible({
		timeout: 60_000,
	});
	await page.getByRole("heading", { name: "Agent trace (metadata)" }).scrollIntoViewIfNeeded();
	await page.waitForTimeout(2_000);
	await page.screenshot({ path: "e2e/recordings/copilot-drafted.png", fullPage: true });

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
