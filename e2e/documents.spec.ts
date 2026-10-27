// Documents E2E (SPEC-t01-t02 §11, D3): applicant grants document consent
// and uploads a text PDF; officer claims, runs cross-check, sees a cited
// mismatch, opens the original, and creates a draft chase (never sent).
//
// Requires the document stack (SPEC §10): DOCUMENT_FEATURE_ENABLED=true,
// DOCUMENT_ENCRYPTION_KEY (base64, 32 bytes), DOCUMENT_STORAGE_DIR, and a
// ClamAV daemon at CLAMAV_HOST/CLAMAV_PORT. PDF text extraction needs no
// OCR assets. The default dev stack sets none of this, so the spec skips
// with the exact env instead of failing spuriously:
//
//   DOCUMENT_FEATURE_ENABLED=true
//   DOCUMENT_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
//   DOCUMENT_STORAGE_DIR=.data/documents
//   CLAMAV_HOST=127.0.0.1 CLAMAV_PORT=3310   # local clamd, or the compose
//                                            # `clamav` service (microservices profile)
//
// Restart the applications service after setting them. Image OCR
// additionally needs DOCUMENT_OCR_DATA_DIR with vendored tesseract data.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Api, ApiError, type CaseDetail, gotoHydrated, smeApplication, uiLogin, uiLogout, waitStatus } from "./helpers.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/mismatch.pdf");

const SKIP_ENV =
	"documents disabled: set DOCUMENT_FEATURE_ENABLED=true, DOCUMENT_ENCRYPTION_KEY=<base64-32B>, " +
	"DOCUMENT_STORAGE_DIR, and a ClamAV daemon at CLAMAV_HOST/CLAMAV_PORT, then restart the applications service";

const SKIP_UNAVAILABLE =
	"document service unavailable (no encryption key or scanner): set DOCUMENT_ENCRYPTION_KEY and run ClamAV, " +
	"then restart the applications service";

/** Case this spec touched. Declined in afterEach when still pending_review,
 * so repeat runs never hit the 3-active-application cap. `created` lets a
 * skipped run clean up its own case without mutating a reused one. */
let trackedCase: { id: string; created: boolean } | null = null;

test.afterEach(async ({ page: _page }, testInfo) => {
	if (trackedCase === null) return;
	const tracked = trackedCase;
	trackedCase = null;
	// A runtime test.skip() still runs afterEach. Leave a reused case alone;
	// a case this run created (and never exercised) must still be retired.
	if (testInfo.status === "skipped" && !tracked.created) return;
	const id = tracked.id;
	try {
		const applicant = new Api();
		await applicant.login("tomas@cafe-aurora.example");
		// The submit response lands before the workflow reaches pending_review.
		// A created case must be given time to become decidable; a reused one
		// is already active and needs no wait.
		if (tracked.created) {
			try {
				await waitStatus(applicant, id, "pending_review", 20_000);
			} catch {
				// Terminal/expired already: the status read below decides.
			}
		}
		const detail = await applicant.get<CaseDetail>(`/api/applications/${id}`);
		if (detail.application.status !== "pending_review") return;
		const officer = new Api();
		await officer.login("officer@example.com");
		await officer.post(`/api/review/${id}/decision`, {
			requestId: crypto.randomUUID(),
			outcome: "decline",
			reasonCode: "OFFICER_JUDGEMENT",
			notes: "e2e cleanup: decline leftover documents case",
		});
	} catch {
		// Best-effort: must not fail the spec.
	}
});

interface Detail {
	application: {
		id: string;
		status: string;
		reference: string;
		documentsEnabled?: boolean;
		documentProcessingConsent?: boolean;
	};
}

function smePayload(email: string) {
	return smeApplication({
		amountCents: 6_000_000,
		termMonths: 60,
		purpose: "documents e2e",
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
			annualRevenueCents: 61_000_000,
			monthlyFcfCents: 380_000,
			existingDebtServiceCents: 30_000,
		},
	});
	// No documentProcessingConsent here: the test grants it through the
	// applicant UI (legacy opt-in path).
}

test("documents: consent → upload → claim → crosscheck → draft chase (no send)", async ({
	page,
}) => {
	expect(readFileSync(FIXTURE).subarray(0, 5).toString()).toBe("%PDF-");

	const applicant = new Api();
	await applicant.login("tomas@cafe-aurora.example");
	let submitted: { id: string; reference: string };
	let created = true;
	try {
		submitted = await applicant.post<{ id: string; reference: string }>(
			"/api/applications",
			smePayload("tomas@cafe-aurora.example"),
		);
	} catch (err) {
		// Reruns reuse an existing active case rather than depending on the
		// seeded applicant's 3-active-application budget.
		if (!(err instanceof ApiError) || err.code !== "TOO_MANY_APPLICATIONS") throw err;
		const list = await applicant.get<{
			items: Array<{ id: string; reference: string; status: string }>;
		}>("/api/applications?limit=100");
		const existing = list.items.find((a) =>
			["submitted", "processing", "pending_review"].includes(a.status),
		);
		if (!existing) throw err;
		submitted = { id: existing.id, reference: existing.reference };
		created = false;
	}
	const appId = submitted.id;
	trackedCase = { id: appId, created };

	// Feature-gate probe: skip (don't fail) when the flag is off.
	const detail = await applicant.get<Detail>(`/api/applications/${appId}`);
	if (!detail.application.documentsEnabled) test.skip(true, SKIP_ENV);

	// --- Applicant UI: grant consent, upload the text PDF. ---
	await uiLogin(page, "tomas@cafe-aurora.example");
	await gotoHydrated(page, `/applications/${appId}`);
	await expect(page.getByText(submitted.reference).first()).toBeVisible({ timeout: 60_000 });

	await page.getByLabel("Consent to document processing").check();
	const updateConsent = page.getByRole("button", { name: "Update consent" });
	if (await updateConsent.isEnabled()) await updateConsent.click();

	const kind = page.locator("#document-kind");
	await kind.selectOption("business_registration");
	await page.locator("#document-file").setInputFiles(FIXTURE);
	await page.getByRole("button", { name: "Upload document" }).click();

	// Either the file row lands or the service reports itself unavailable
	// (no key/scanner) — the latter skips with the env, never fails. "OCR:"
	// is unique to uploaded file rows (the kind <option> text would make a
	// bare kind-name assertion ambiguous).
	await expect(
		page.getByText(/OCR:|temporarily unavailable|currently unavailable/).first(),
	).toBeVisible({
		timeout: 120_000,
	});
	if (
		(await page.getByText("temporarily unavailable").count()) > 0 ||
		(await page.getByText("currently unavailable").count()) > 0
	) {
		test.skip(true, SKIP_UNAVAILABLE);
	}

	// --- Officer UI: claim, run cross-check, open original, draft chase. ---
	await uiLogout(page);
	await uiLogin(page, "officer@example.com");
	await gotoHydrated(page, `/officer/review/${appId}`);
	await expect(page.getByText(submitted.reference).first()).toBeVisible({ timeout: 60_000 });

	// Wait for the panel and either the claim action or the assigned state.
	await expect(page.getByRole("heading", { name: "Documents", exact: true })).toBeVisible({
		timeout: 60_000,
	});
	const assign = page.getByRole("button", { name: "Assign to me" });
	const runCrosscheck = page.getByRole("button", { name: "Run cross-check" });
	await expect(assign.or(runCrosscheck)).toBeVisible({ timeout: 60_000 });
	if (await assign.isVisible()) {
		await assign.click();
		await expect(runCrosscheck).toBeVisible({ timeout: 60_000 });
	}
	// File-row assertion, not the kind <option>/mock checklist text.
	await expect(page.getByText(/OCR:/).first()).toBeVisible({ timeout: 60_000 });

	await runCrosscheck.click();
	await expect(page.getByText("company_name").first()).toBeVisible({ timeout: 120_000 });
	// Cited mismatch from the fixture (not a suffix/initials softening).
	await expect(page.getByText("Harbour Foods Ltd").first()).toBeVisible();
	await expect(page.getByText("mismatch").first()).toBeVisible();

	// Opening the original is required before drafting (server verifies the
	// audit event, not the client flag). The blob opens in a new tab.
	const [popup] = await Promise.all([
		page.waitForEvent("popup"),
		page
			.getByRole("button", { name: /Open original/ })
			.first()
			.click(),
	]);
	await popup.close();
	await expect(page.getByText("original opened").first()).toBeVisible({ timeout: 30_000 });

	await page.getByLabel("Select finding company_name for chase draft").check();
	await page.getByRole("button", { name: "Create draft chase" }).click();
	await expect(page.getByText("Draft created — not sent")).toBeVisible({ timeout: 60_000 });
	await expect(page.getByText(/Harbour Foods Ltd/).first()).toBeVisible();

	// Draft-only: no send path exists anywhere on the page.
	await expect(page.getByRole("button", { name: /^send$/i })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /send chase/i })).toHaveCount(0);
});
