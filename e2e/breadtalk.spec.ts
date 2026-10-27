// BreadTalk T17 draft flow (SPEC-t17-t18 §2.5/AC-T17-5, D2b): profiled SME
// applicant sees prefilled intake, creates a draft (not a submission),
// the checklist marks the stale bank/financial statements, submit is
// blocked (disabled button + API 409 REQUIREMENTS_INCOMPLETE with no
// workflow side effect), and — once fresh customer evidence exists —
// explicit Reuse attaches it, the checklist turns ready, and submit works.
//
// Needs seeded fixtures; otherwise the spec skips with the exact setup:
//   DEMO_MODE=true pnpm demo:seed
//   DEMO_MODE=true pnpm demo:case --persona=breadtalk   (optional: fixture draft)
//   DEMO_MODE=true pnpm demo:refresh-evidence --persona=breadtalk  (for the reuse→submit leg)
// The legacy direct flow (tomas/maria/sam) is untouched — those users have
// no customer profile, so they keep POST /api/applications.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Api, ApiError, type CaseDetail, gotoHydrated, poll, uiLogin, uiLogout, waitStatus } from "./helpers.js";

const SETUP_HINT =
	"breadtalk fixtures unavailable — run the stack (pnpm dev or compose), then " +
	"DEMO_MODE=true pnpm demo:seed to create the breadtalk customer";

/** Case this spec touched (created draft or reused active case). Declined in
 * afterEach when still pending_review, so repeat runs never hit the
 * 3-active-application cap. Draft-only runs (blocked leg without fresh
 * evidence) leave a draft behind — drafts have their own cap and no
 * terminal transition, so those still need `demo:reset` eventually. */
let trackedCase: string | null = null;

test.afterEach(async () => {
	if (trackedCase === null) return;
	const id = trackedCase;
	trackedCase = null;
	try {
		const applicant = new Api();
		await applicant.login("breadtalk@example.com");
		const detail = await applicant.get<CaseDetail>(`/api/applications/${id}`);
		if (detail.application.status !== "pending_review") return;
		const officer = new Api();
		await officer.login("officer@example.com");
		await officer.post(`/api/review/${id}/decision`, {
			requestId: crypto.randomUUID(),
			outcome: "decline",
			reasonCode: "OFFICER_JUDGEMENT",
			notes: "e2e cleanup: decline leftover breadtalk case",
		});
	} catch {
		// Best-effort: must not fail the spec.
	}
});

test("BreadTalk draft: prefill → stale checklist → blocked submit → reuse → submit", async ({
	page,
}) => {
	const applicant = new Api();
	try {
		await applicant.login("breadtalk@example.com");
	} catch (err) {
		// Skip only on the known missing-fixture signals (unknown user 401,
		// missing user 404); network/5xx failures must fail loudly.
		if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 404)) throw err;
		test.skip(true, `${SETUP_HINT} (login failed)`);
	}
	let profile!: {
		profile: { segment: string; kycStatus: string; identity: Record<string, unknown> };
		documents: Array<{ kind: string; reusable: boolean }>;
	};
	try {
		profile = await applicant.get("/api/customer/profile");
	} catch (err) {
		if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 404)) throw err;
		test.skip(true, `${SETUP_HINT} (no customer profile)`);
	}

	// --- /apply: prefilled from the customer profile, still editable. ---
	await uiLogin(page, "breadtalk@example.com");
	await gotoHydrated(page, "/apply");
	await expect(page.getByText("Prefilled from your customer profile")).toBeVisible();
	expect(profile.profile.segment).toBe("sme");
	await expect(page.locator("#field-borrower-type")).toHaveValue("sme");

	// --- Step 1: loan details. ---
	await page.locator("#field-amount-usd").fill("60000");
	await page.locator("#field-term-months").fill("36");
	await page.locator("#field-purpose").fill("Working capital for new outlet (demo)");
	await page.getByRole("button", { name: "Continue" }).click();

	// --- Step 2: identity + business prefilled, editable. ---
	await expect(page.locator("#field-full-name")).toHaveValue("Baker Tan");
	await expect(page.locator("#field-company-name")).toHaveValue("BreadTalk Demo Pte Ltd");
	await page.getByRole("button", { name: "Continue" }).click();

	// --- Step 3: consents + draft create (never the legacy direct path). ---
	await page.getByLabel("Credit check consent").check();
	await page.getByLabel("Data processing consent").check();
	await page.getByLabel("Terms consent").check();
	await page.getByLabel("Document processing consent", { exact: false }).check();
	await page.getByLabel("Context analysis consent", { exact: false }).check();
	// The research/context legs require the optional AI research consent;
	// without it ensure 403s and the spec's context assertions never run.
	await page.getByLabel("AI research consent", { exact: false }).check();
	await page.getByRole("button", { name: "Create draft" }).click();
	await page.waitForURL(/\/applications\/.+/);
	const appId = page.url().split("/").pop() ?? "";
	expect(appId).toMatch(/^[0-9a-f-]{36}$/);
	trackedCase = appId;

	// Draft: no submission happened.
	const detail = await applicant.get<{ application: { status: string } }>(
		`/api/applications/${appId}`,
	);
	expect(detail.application.status).toBe("draft");

	// --- Requirements: stale bank + financial statements block submit. ---
	await expect(page.getByText("Not ready to submit.")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText("document:bank_statement")).toBeVisible();
	await expect(page.getByText("document:financial_statements")).toBeVisible();
	const submit = page.getByRole("button", { name: "Submit draft application" });
	await expect(submit).toBeDisabled();

	// API proof: submit returns the typed 409 and leaves the draft untouched.
	const blocked = await applicant.postRaw(
		`/api/applications/${appId}/submit`,
		{},
		{ "Idempotency-Key": crypto.randomUUID() },
	);
	expect(blocked.status).toBe(409);
	expect(blocked.code).toBe("REQUIREMENTS_INCOMPLETE");
	const still = await applicant.get<{ application: { status: string } }>(
		`/api/applications/${appId}`,
	);
	expect(still.application.status).toBe("draft");

	// --- Reuse leg: needs fresh customer evidence (demo:refresh-evidence).
	// Refresh alone must NOT satisfy the app checklist — only explicit
	// attach does. Without fresh evidence the spec ends at the blocked
	// assertions above (still a passing pin of AC-T17-5's first half).
	const customerDocs = await applicant.get<{
		documents: Array<{ id: string; kind: string; reusable: boolean }>;
	}>("/api/customer/documents");
	const fresh = customerDocs.documents.filter((d) => d.reusable);
	const hasFreshBank = fresh.some((d) => d.kind === "bank_statement");
	const hasFreshFinancials = fresh.some((d) => d.kind === "financial_statements");
	if (!hasFreshBank || !hasFreshFinancials) {
		test.skip(
			true,
			"blocked-submit leg green; reuse→submit leg needs fresh customer evidence: " +
				"DEMO_MODE=true pnpm demo:refresh-evidence --persona=breadtalk, then rerun",
		);
	}

	// Explicit Reuse per kind — every reusable kind (id, registration,
	// statements) must attach; the checklist turns ready only after attach.
	await page.getByRole("button", { name: "Reuse id evidence" }).click();
	await page.getByRole("button", { name: "Reuse business_registration evidence" }).click();
	await page.getByRole("button", { name: "Reuse bank_statement evidence" }).click();
	await page.getByRole("button", { name: "Reuse financial_statements evidence" }).click();
	await poll(
		"checklist ready after reuse",
		async () => {
			const req = await applicant.get<{ readyToSubmit: boolean }>(
				`/api/applications/${appId}/requirements`,
			);
			return req.readyToSubmit ? true : null;
		},
		60_000,
		2000,
	);
	await expect(page.getByText("Ready to submit.")).toBeVisible({ timeout: 30_000 });
	await expect(submit).toBeEnabled();

	// Submit once → submitted (the worker then owns review.requested). The
	// worker can advance submitted → processing → pending_review within one
	// poll beat, so wait for leaving draft, not for the transient state.
	// Repeat runs can exhaust the 3-active-application budget, in which case
	// the submit 409s with TOO_MANY_APPLICATIONS: reuse an existing active
	// case instead — the same fallback documents.spec.ts uses.
	const actives = (
		await applicant.get<{ items: Array<{ id: string; status: string }> }>(
			"/api/applications?limit=100",
		)
	).items.filter(
		(a) => a.id !== appId && ["submitted", "processing", "pending_review"].includes(a.status),
	);
	let caseId = appId;
	if (actives.length >= 3) {
		const existing = actives.find((a) => a.status === "pending_review") ?? actives[0];
		if (!existing) throw new Error("breadtalk: active budget exhausted with no reusable case");
		caseId = existing.id;
	} else {
		await submit.click();
		const done = await poll(
			`application ${appId} to leave draft`,
			async () => {
				const d = await applicant.get<{ application: { status: string } }>(
					`/api/applications/${appId}`,
				);
				return d.application.status === "draft" ? null : d;
			},
			180_000,
			2000,
		);
		expect(["submitted", "processing", "pending_review", "booked"]).toContain(
			done.application.status,
		);
	}
	trackedCase = caseId;

	// --- Context leg (D4): officer opens the submitted case and sees the
	// Internal context section after T11, then accept/dismiss round-trips a
	// signal through the real API. Live T11 needs the research flags plus
	// model keys. With the default dev flags this leg pins the disabled
	// contract instead (officer 404 + hidden panel) — the spec runs green
	// either way, never skipped. BREADTALK_CONTEXT_STUB=1 seeds the
	// deterministic stub (no model spend) instead of waiting on a live run.
	await waitStatus(applicant, caseId, "pending_review");
	const officer = new Api();
	await officer.login("officer@example.com");
	const stubMode = process.env.BREADTALK_CONTEXT_STUB === "1";
	if (stubMode) {
		// Deterministic stub first (no model spend): the reads below must
		// see the stub run, never trigger a live one.
		const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		execFileSync(
			process.platform === "win32" ? "bun.exe" : "bun",
			["scripts/demo-context-stub.ts", "--persona=breadtalk", `--app-id=${caseId}`],
			{ cwd: root, stdio: "pipe", env: { ...process.env, DEMO_MODE: "true" } },
		);
	}
	interface ContextLatest {
		run: { id: string; status: string };
		context: {
			status: string;
			brief: { summary?: string } | null;
			signals: Array<{ id: string; type: string; reviewStatus?: string }>;
		};
	}
	let researchDisabled = false;
	async function readLatest(): Promise<ContextLatest | null> {
		try {
			return await officer.get<ContextLatest>(`/api/review/${caseId}/research`);
		} catch (err) {
			if (err instanceof ApiError && err.status === 404 && err.code === "RESEARCH_DISABLED") {
				researchDisabled = true;
				return null;
			}
			// Flags on but no run yet (auto-trigger off, no stub): null so
			// the officer ensure path below starts one. Anything else fails.
			if (err instanceof ApiError && err.status === 404) return null;
			throw err;
		}
	}
	let latest = await readLatest();
	if (researchDisabled) {
		if (stubMode) {
			throw new Error(
				"BREADTALK_CONTEXT_STUB=1 needs the research read flags " +
					"(AGENTS_ENABLED=true AGENT_CASE_BRIEF_ENABLED=true with the review/research services restarted); " +
					"reads are 404 RESEARCH_DISABLED",
			);
		}
		// Disabled stack: pin the contract — officer reads 404 and the case
		// page hides the research panel entirely.
		await uiLogout(page);
		await uiLogin(page, "officer@example.com");
		await gotoHydrated(page, `/officer/review/${caseId}`);
		await expect(page.getByText("Identity").first()).toBeVisible({ timeout: 60_000 });
		await expect(page.locator('section[aria-label="Agent research"]')).toHaveCount(0);
		await expect(page.locator('section[aria-label="Internal context"]')).toHaveCount(0);
		return;
	}
	// No run yet and no stub: trigger one run as the officer through the
	// real ensure path, then poll both stages terminal.
	if (!latest && !stubMode) {
		const ensured = await officer.post<{ runId: string; status: string }>(
			`/api/review/${caseId}/research`,
		);
		expect(ensured.runId).toMatch(/^[0-9a-f-]{36}$/);
	}
	// The run may not be readable on the very next GET; the poll below is
	// the authority (and fails loudly if no run ever appears).
	latest = await poll(
		"research run + context stage terminal",
		async () => {
			const cur = await officer.get<ContextLatest>(`/api/review/${caseId}/research`);
			const runTerminal = cur.run.status === "succeeded" || cur.run.status === "failed";
			const contextTerminal = cur.context.status !== "queued" && cur.context.status !== "running";
			return runTerminal && contextTerminal ? cur : null;
		},
		300_000,
		5000,
	);

	// Officer UI: the Internal context section renders after the external
	// brief, with status-appropriate content (never an all-clear).
	await uiLogout(page);
	await uiLogin(page, "officer@example.com");
	await gotoHydrated(page, `/officer/review/${caseId}`);
	const internal = page.locator('section[aria-label="Internal context"]');
	await expect(internal).toBeVisible({ timeout: 60_000 });
	if (latest.context.status === "succeeded") {
		const signals = latest.context.signals;
		expect(signals.length).toBeGreaterThan(0);
		for (const s of signals) {
			await expect(internal.getByText(s.type).first()).toBeVisible();
		}
		// Accept the first signal, dismiss the second with a note when present.
		const [first, second] = signals;
		await internal.getByRole("button", { name: `Accept signal: ${first.type}` }).click();
		await poll(
			"first signal accepted",
			async () => {
				const cur = await officer.get<ContextLatest>(`/api/review/${caseId}/research`);
				return cur.context.signals.find((s) => s.id === first.id)?.reviewStatus === "accepted"
					? true
					: null;
			},
			60_000,
			2000,
		);
		if (second) {
			await internal.getByPlaceholder("Note (optional)").nth(1).fill("benign on review");
			await internal.getByRole("button", { name: `Dismiss signal: ${second.type}` }).click();
			await poll(
				"second signal dismissed",
				async () => {
					const cur = await officer.get<ContextLatest>(`/api/review/${caseId}/research`);
					return cur.context.signals.find((s) => s.id === second.id)?.reviewStatus === "rejected"
						? true
						: null;
				},
				60_000,
				2000,
			);
		}
	} else if (latest.context.status === "failed") {
		// Sanitized failure (code only) plus the officer Retry path: 202,
		// then the stage settles again on its own.
		await expect(internal.getByText(/Internal context failed/)).toBeVisible();
		const retry = internal.getByRole("button", { name: "Retry internal context" });
		await expect(retry).toBeVisible();
		await retry.click();
		await poll(
			"context stage terminal after retry",
			async () => {
				const cur = await officer.get<ContextLatest>(`/api/review/${caseId}/research`);
				return cur.context.status !== "queued" && cur.context.status !== "running" ? true : null;
			},
			300_000,
			5000,
		);
	} else {
		// skipped / not_applicable: neutral copy, never "no anomalies".
		await expect(internal.getByText(/skipped|did not run/)).toBeVisible();
	}
	if (process.env.BREADTALK_RECORD_HOLD === "1") {
		// Recording-only hold: leave the officer's Internal context panel on
		// screen long enough for the video to show the analyst output.
		await internal.scrollIntoViewIfNeeded();
		await page.waitForTimeout(8000);
	}
});
