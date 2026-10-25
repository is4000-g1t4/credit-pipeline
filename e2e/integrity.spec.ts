// E2 document integrity + EN-05 fraud review (US-INT-1/3/5).
//
// On-path (DOCUMENT_INTEGRITY_ENABLED + FRAUD_REVIEW_ENABLED): applicant
// grants consent and uploads the text fixture; the officer claims, runs
// cross-check, and the deterministic mismatch opens a fraud-review item.
// Queue/item/signals/brief are asserted through the officer UI; resolution
// is reviewer-grant gated, so when officer@example.com is not a seeded
// reviewer only the resolve step is skipped — after the queue/item
// assertions have passed.
//
// Requires the document stack (see documents.spec.ts) plus the integrity
// flags; DOCUMENT_INTEGRITY_AGENT_ENABLED=false in e2e, so no triage brief
// is produced and an unresolved item stays open.
import { expect, test } from "@playwright/test";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Api,
	ApiError,
	gotoHydrated,
	poll,
	smeApplication,
	uiLogin,
	uiLogout,
	type CaseDetail,
} from "./helpers.js";

dotenv.config();

const enabled =
	process.env.DOCUMENT_INTEGRITY_ENABLED === "true" && process.env.FRAUD_REVIEW_ENABLED === "true";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/mismatch.pdf");

const SKIP_ENV =
	"integrity disabled: set DOCUMENT_INTEGRITY_ENABLED=true and FRAUD_REVIEW_ENABLED=true " +
	"(plus the documents.spec.ts document stack) to run the integrity happy path";

function smePayload(email: string) {
	return smeApplication({
		amountCents: 6_000_000,
		termMonths: 60,
		purpose: "integrity e2e",
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
}

interface Submitted {
	id: string;
	reference: string;
}

/** Fresh case, or reuse an active one when the 3-active budget is hit. */
async function submitOrReuse(applicant: Api): Promise<Submitted> {
	try {
		return await applicant.post<Submitted>(
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
		return { id: existing.id, reference: existing.reference };
	}
}

interface QueueItem {
	id: string;
	applicationId: string;
	applicationReference: string;
	status: string;
	severity: string;
	reasonCode: string;
	briefAvailable: boolean;
	version: number;
}

interface ReviewDetail {
	id: string;
	applicationId: string;
	status: string;
	severity: string;
	reasonCode: string;
	version: number;
	signalCodes?: string[];
	briefArtifactId?: string | null;
	brief?: Record<string, unknown> | null;
	briefAvailable?: boolean;
}

test("integrity flags open a fraud-review item; resolution leaves the case untouched", async ({
	page,
}) => {
	test.skip(!enabled, SKIP_ENV);
	expect(readFileSync(FIXTURE).subarray(0, 5).toString()).toBe("%PDF-");

	const applicant = new Api();
	await applicant.login("tomas@cafe-aurora.example");
	const submitted = await submitOrReuse(applicant);
	const appId = submitted.id;

	const probe = await applicant.get<{ application: { documentsEnabled?: boolean } }>(
		`/api/applications/${appId}`,
	);
	if (!probe.application.documentsEnabled) test.skip(true, SKIP_ENV);

	// --- Applicant UI: grant consent, upload the text fixture. ---
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

	await expect(
		page.getByText(/OCR:|temporarily unavailable|currently unavailable/).first(),
	).toBeVisible({ timeout: 120_000 });
	if (
		(await page.getByText("temporarily unavailable").count()) > 0 ||
		(await page.getByText("currently unavailable").count()) > 0
	) {
		test.skip(true, "document service unavailable — rerun with the documents.spec.ts stack");
	}

	// --- Officer UI: claim, run cross-check, see the cited mismatch. ---
	await uiLogout(page);
	await uiLogin(page, "officer@example.com");
	await gotoHydrated(page, `/officer/review/${appId}`);
	await expect(page.getByText(submitted.reference).first()).toBeVisible({ timeout: 60_000 });

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
	await expect(page.getByText(/OCR:/).first()).toBeVisible({ timeout: 60_000 });

	await runCrosscheck.click();
	await expect(page.getByText("company_name").first()).toBeVisible({ timeout: 120_000 });
	await expect(page.getByText("Harbour Foods Ltd").first()).toBeVisible();
	await expect(page.getByText("mismatch").first()).toBeVisible();

	// --- Fraud review through the gateway API + officer UI.
	// The cross-check mutation hook evaluates integrity synchronously, so
	// the item exists by the time the UI settles; poll for stack slowness.
	const officer = new Api();
	await officer.login("officer@example.com");
	const item = await poll(
		`fraud-review item for case ${appId}`,
		async () => {
			const queue = await officer.get<{ items: QueueItem[] }>("/api/fraud-review/queue");
			return queue.items.find((i) => i.applicationId === appId) ?? null;
		},
		60_000,
	);
	expect(item.status).toBe("open");
	expect(item.reasonCode).toBe("document_integrity");
	expect(["high", "medium"]).toContain(item.severity);

	const detail = await officer.get<{ review: ReviewDetail }>(`/api/fraud-review/${item.id}`);
	expect(detail.review.applicationId).toBe(appId);
	expect(detail.review.status).toBe("open");
	// No model call in e2e (agent disabled): no brief is produced.
	expect(detail.review.briefAvailable ?? detail.review.briefArtifactId ?? null).toBeFalsy();
	expect(detail.review.brief ?? null).toBeNull();

	const me = await officer.get<{ reviewer: boolean; canViewQueue: boolean }>(
		"/api/fraud-review/me",
	);

	// Re-read the case page so the integrity panel refetches: fingerprint
	// copy, case signals, and the open-review banner.
	await gotoHydrated(page, `/officer/review/${appId}`);
	await expect(page.getByText(submitted.reference).first()).toBeVisible({ timeout: 60_000 });
	await expect(page.getByText("signal, not proof").first()).toBeVisible({ timeout: 60_000 });
	await expect(page.getByText(/Open fraud review/).first()).toBeVisible({ timeout: 60_000 });

	// Queue → detail through the officer UI.
	await gotoHydrated(page, "/officer/fraud-review");
	await expect(page.getByRole("heading", { name: "Fraud review" })).toBeVisible({
		timeout: 60_000,
	});
	const row = page.getByRole("link", { name: submitted.reference });
	await expect(row).toBeVisible({ timeout: 60_000 });
	await expect(page.getByText("document_integrity").first()).toBeVisible();
	await row.click();
	await page.waitForURL(/\/officer\/fraud-review\/.+/);

	if (!me.reviewer) {
		// Resolve is reviewer-grant gated: skip only that step. The
		// queue/item assertions above have already passed; the UI shows the
		// minimal status view and the item stays open with no brief.
		await expect(page.getByText("not available").first()).toBeVisible({ timeout: 60_000 });
		await expect(page.getByRole("heading", { name: "Resolve" })).toHaveCount(0);
		expect(detail.review.status).toBe("open");
		test.skip(
			true,
			"officer@example.com is not a seeded fraud reviewer — resolve step skipped; " +
				"queue/item assertions above still hold and the item stays open",
		);
	}

	// Reviewer path: deterministic signals render as codes; the UI must
	// never state or imply confirmed fraud ("signal, not proof").
	await expect(page.getByRole("heading", { name: "Signals" })).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.getByText("crosscheck_mismatch").first()).toBeVisible();
	await expect(page.getByText("No brief for this review.")).toBeVisible();
	await expect(page.getByText(/confirmed fraud/i)).toHaveCount(0);
	await expect(page.getByText(/definitively|tampering confirmed/i)).toHaveCount(0);
	expect(detail.review.signalCodes ?? []).toContain("crosscheck_mismatch");

	const before = await officer.get<CaseDetail>(`/api/applications/${appId}`);
	const resolved = await officer.post<{ review: { status: string } }>(
		`/api/fraud-review/${item.id}/resolve`,
		{
			status: "cleared",
			note: "Integrity e2e: deterministic mismatch chased with the applicant; no fraud indicators.",
			expectedVersion: detail.review.version,
		},
	);
	expect(resolved.review.status).toBe("cleared");

	// Resolution is case-neutral: no status, score, or decision movement.
	const after = await officer.get<CaseDetail>(`/api/applications/${appId}`);
	expect(after.application.status).toBe(before.application.status);
	expect(after.score).toEqual(before.score);
});

test("integrity and fraud-review stay dark while the flags are off", async ({ page }) => {
	test.skip(enabled, "set DOCUMENT_INTEGRITY_ENABLED=false to run the flag-off case");
	const applicant = new Api();
	await applicant.login("tomas@cafe-aurora.example");
	const submitted = await submitOrReuse(applicant);

	const officer = new Api();
	await officer.login("officer@example.com");

	// Officer case page: the panel is fully hidden while the flag is off (G1),
	// with no signal copy anywhere.
	await uiLogin(page, "officer@example.com");
	await gotoHydrated(page, `/officer/review/${submitted.id}`);
	await expect(page.getByText(submitted.reference).first()).toBeVisible({ timeout: 60_000 });
	await expect(page.getByRole("heading", { name: "Document integrity" })).toHaveCount(0);
	await expect(page.getByText("Integrity is not available for this case.")).toHaveCount(0);
	await expect(page.getByText("signal, not proof")).toHaveCount(0);

	// Officer integrity read 404s downstream while the flag is off.
	const integrity = await officer
		.get(`/api/applications/${submitted.id}/integrity`)
		.catch((err: unknown) => err);
	expect(integrity).toBeInstanceOf(ApiError);
	expect((integrity as ApiError).status).toBe(404);

	// Applicant fraud-review access stays officer-only regardless of flags.
	const queue = await applicant.get("/api/fraud-review/queue").catch((err: unknown) => err);
	expect(queue).toBeInstanceOf(ApiError);
	expect((queue as ApiError).status).toBe(403);
});
