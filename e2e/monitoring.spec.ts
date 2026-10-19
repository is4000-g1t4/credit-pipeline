// Monitoring demo (AC-9): API-assisted setup of a fresh Tomás loan
// (submit → approve $50k/60m → booked), then the real officer UI on the
// loan page: demo panel age 40 days → run monitoring → overdue alert →
// acknowledge → pay next installment → alert resolved + payment visible.
import { expect, test } from "@playwright/test";
import {
	Api,
	gotoHydrated,
	type LoanDetail,
	poll,
	uiLogin,
	waitStatus,
	waitTerminal,
} from "./helpers.js";

const TOMAS = "tomas@cafe-aurora.example";

test("Monitoring demo: age → alert → acknowledge → pay", async ({ page }) => {
	const applicant = new Api();
	await applicant.login(TOMAS);
	const officer = new Api();
	await officer.login("officer@example.com");

	// --- Setup via API: fresh Tomás SME application → referred → approved. ---
	const created = await applicant.post<{ id: string; reference: string }>("/api/applications", {
		type: "sme",
		product: "sme_term_loan",
		amountCents: 6_000_000,
		termMonths: 60,
		purpose: "Café expansion (monitoring demo)",
		consents: [true, true, true],
		identity: {
			fullName: "Tomas Aurora",
			dob: "1985-03-20",
			nationalId: "TOMAS42X2",
			email: TOMAS,
			phone: "+1-555-0200",
			address: "2 Café Street",
		},
		sme: {
			companyName: "Café Aurora",
			registrationNumber: "CAFEAUR2",
			industry: "hospitality",
			yearsTrading: 4,
			employees: 9,
			annualRevenueCents: 61_000_000,
			monthlyFcfCents: 380_000,
			existingDebtServiceCents: 30_000,
		},
	});
	const referred = await waitStatus(applicant, created.id, "pending_review");
	expect(referred.application.status).toBe("pending_review");

	const decision = await officer.post<{
		outcome: string;
		decisionId: string;
		loanId: string | null;
	}>(`/api/review/${created.id}/decision`, {
		requestId: crypto.randomUUID(),
		outcome: "approve",
		approvedAmountCents: 5_000_000,
		termMonths: 60,
		notes: "Monitoring demo counter-offer.",
	});
	expect(decision.outcome).toBe("booked");
	const booked = await waitTerminal(officer, created.id);
	const loanId = booked.loan?.id ?? decision.loanId;
	expect(loanId).toBeTruthy();

	// --- Officer UI on the loan page. ---
	await uiLogin(page, "officer@example.com");
	await gotoHydrated(page, `/loans/${loanId}`);
	await expect(page.getByText("Demo controls (officer, demo mode)")).toBeVisible();

	// Age 40 days (runs monitoring synchronously and returns counts; on a
	// 30s timeout it returns 202 with just a workflowId — AC-9 polls).
	await page.locator("#field-age-days").fill("40");
	await page.getByRole("button", { name: "Age loan" }).click();
	const ageResult = page.getByRole("status");
	await expect(ageResult).toContainText(/markedOverdue|workflowId/, {
		timeout: 120_000,
	});

	// …then run monitoring explicitly from the panel.
	await page.getByRole("button", { name: "Run monitoring" }).click();
	await expect(ageResult).toContainText(/markedOverdue|workflowId/, {
		timeout: 120_000,
	});

	// An overdue alert appears (API state proof + UI proof). Polled because
	// a 202 monitoring run may still be finishing server-side.
	const withAlert = await poll("open payment_overdue alert", async () => {
		const loan = await officer.get<LoanDetail>(`/api/loans/${loanId}`);
		return loan.alerts.some((a) => a.status === "open") ? loan : null;
	});
	const openAlert = withAlert.alerts.find((a) => a.status === "open");
	expect(openAlert?.type).toBe("payment_overdue");
	await expect(page.getByText("payment_overdue").first()).toBeVisible({
		timeout: 60_000,
	});

	// Acknowledge via the UI…
	await page.getByRole("button", { name: "Acknowledge alert payment_overdue" }).click();
	await expect(page.getByText("acknowledged").first()).toBeVisible({
		timeout: 60_000,
	});

	// …then pay the next installment via the panel → payment shows,
	// alert resolved (acknowledged stays acknowledged; open ones close).
	await page.getByRole("button", { name: /Pay next installment/ }).click();
	await expect(page.getByText("Payments")).toBeVisible({ timeout: 60_000 });

	const final = await officer.get<LoanDetail>(`/api/loans/${loanId}`);
	expect(final.payments.length).toBeGreaterThan(0);
	expect(final.alerts.filter((a) => a.status === "open")).toHaveLength(0);
	const target = final.alerts.find((a) => a.id === openAlert?.id);
	expect(target?.status).not.toBe("open");
});
