// Shared E2E helpers: tiny cookie-jar API client (global fetch, no new
// deps) for setup/polling, plus UI login/logout. State assertions poll the
// API; key actions go through the real UI.
import type { Page } from "@playwright/test";

export const API_BASE = "http://127.0.0.1:3001";
export const DEMO_PASSWORD = "demo1234";

export class ApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
	) {
		super(message);
	}
}

export class Api {
	private cookie = "";

	async login(email: string, password = DEMO_PASSWORD): Promise<void> {
		const res = await fetch(`${API_BASE}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password }),
		});
		if (!res.ok) {
			throw new ApiError(res.status, "LOGIN_FAILED", `login ${email}: ${res.status}`);
		}
		const setCookie = res.headers.get("set-cookie") ?? "";
		const session = setCookie.split(";")[0] ?? "";
		if (!session.startsWith("session=")) throw new Error("no session cookie set");
		this.cookie = session;
	}

	private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = { cookie: this.cookie };
		if (body !== undefined) headers["content-type"] = "application/json";
		if (path === "/api/applications" && method === "POST") {
			headers["Idempotency-Key"] = crypto.randomUUID();
		}
		const res = await fetch(`${API_BASE}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		let data: unknown = null;
		try {
			data = await res.json();
		} catch {
			throw new ApiError(res.status, "BAD_RESPONSE", `${method} ${path}: ${res.status}`);
		}
		if (!res.ok) {
			const err = (data as { error?: { code?: string; message?: string } })?.error;
			throw new ApiError(
				res.status,
				err?.code ?? "REQUEST_FAILED",
				err?.message ?? `${method} ${path}: ${res.status}`,
			);
		}
		return data as T;
	}

	get<T>(path: string): Promise<T> {
		return this.req<T>("GET", path);
	}

	post<T>(path: string, body?: unknown): Promise<T> {
		return this.req<T>("POST", path, body);
	}
}

export interface CaseDetail {
	application: {
		id: string;
		reference: string;
		status: string;
		amountCents: number;
		termMonths: number;
	};
	score: {
		score: number;
		grade: string;
		factors: Array<{ code: string; points: number }>;
	} | null;
	policyEvaluation: {
		outcome: string;
		reasons: Array<{ code: string }>;
	} | null;
	decision: {
		outcome: string;
		decidedBy: string;
		approvedAmountCents: number | null;
		termMonths: number | null;
		reasons: Array<string | { code: string }>;
		notes: string | null;
		snapshot: Record<string, unknown>;
	} | null;
	loan: {
		id: string;
		principalCents: number;
		termMonths: number;
		status: string;
		installments: { total: number; paid: number; overdue: number };
	} | null;
}

export interface LoanDetail {
	loan: { id: string; status: string; nextDueDate: string | null };
	installments: Array<{ id: string; number: number; status: string }>;
	payments: Array<{ id: string; installmentId: string }>;
	alerts: Array<{
		id: string;
		type: string;
		status: string;
		installmentId: string | null;
	}>;
}

const TERMINAL = new Set(["booked", "declined", "expired", "failed"]);

/** Poll `fn` until it returns non-null (throws the last error at deadline). */
export async function poll<T>(
	label: string,
	fn: () => Promise<T | null>,
	timeoutMs = 120_000,
	intervalMs = 2000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const got = await fn();
		if (got !== null) return got;
		if (Date.now() >= deadline) throw new Error(`e2e: timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

export function getCase(api: Api, id: string): Promise<CaseDetail> {
	return api.get<CaseDetail>(`/api/applications/${id}`);
}

/** Poll the case until it reaches a terminal status; return the detail. */
export function waitTerminal(api: Api, id: string, timeoutMs = 180_000): Promise<CaseDetail> {
	return poll(
		`application ${id} to settle`,
		async () => {
			const d = await getCase(api, id);
			return TERMINAL.has(d.application.status) ? d : null;
		},
		timeoutMs,
	);
}

/** Poll the case until it reaches `status` (or any terminal state); return it. */
export function waitStatus(
	api: Api,
	id: string,
	status: string,
	timeoutMs = 180_000,
): Promise<CaseDetail> {
	return poll(
		`application ${id} to reach ${status}`,
		async () => {
			const d = await getCase(api, id);
			return d.application.status === status || TERMINAL.has(d.application.status) ? d : null;
		},
		timeoutMs,
	);
}

export async function uiLogin(page: Page, email: string): Promise<void> {
	await gotoHydrated(page, "/login");
	await fillStable(page, "#field-email", email);
	await page.getByRole("button", { name: "Sign in" }).click();
	// The submit click only takes effect post-hydration: if the form is
	// still pristine (email intact, no Logout), the click was lost to the
	// hydration race — verify the effect and resubmit until it lands.
	// (SSR shells render instantly; React hydration resets controlled
	// inputs, so a pre-hydration fill+click silently does nothing.)
	await poll(
		"login effect",
		async (): Promise<true | null> => {
			if (await page.getByRole("button", { name: "Logout" }).isVisible()) return true;
			const v = await page
				.locator("#field-email")
				.inputValue()
				.catch(() => "");
			if (v === email) {
				await page
					.getByRole("button", { name: "Sign in" })
					.click({ timeout: 5000 })
					.catch(() => {});
			} else {
				await page
					.locator("#field-email")
					.fill(email, { timeout: 10_000 })
					.catch(() => {});
			}
			return null;
		},
		90_000,
		500,
	);
}

/**
 * Navigate and wait until React has hydrated the SSR markup (root sets
 * <html data-hydrated="true"> from a useEffect). Without this, a click on
 * an SSR-rendered button before hydration is silently lost — the classic
 * lost "Continue" on the application wizard.
 */
export async function gotoHydrated(page: Page, path: string): Promise<void> {
	await page.goto(path);
	await page.waitForSelector('html[data-hydrated="true"]', {
		timeout: 60_000,
	});
}

/**
 * Fill that survives the SSR→hydration race: a pre-hydration fill is wiped
 * when React takes over the controlled input, so refill until the value
 * holds across a beat. Later interactions are inherently post-hydration.
 */
async function fillStable(page: Page, selector: string, value: string): Promise<void> {
	const loc = page.locator(selector);
	await poll(
		`stable fill ${selector}`,
		async (): Promise<true | null> => {
			await loc.fill(value, { timeout: 10_000 });
			await page.waitForTimeout(300);
			return (await loc.inputValue().catch(() => "")) === value ? true : null;
		},
		30_000,
		200,
	);
}

export async function uiLogout(page: Page): Promise<void> {
	// Same race class as login: a pre-hydration click on the React handler
	// silently does nothing — re-click until the login form is back.
	await poll(
		"logout effect",
		async (): Promise<true | null> => {
			if (await page.getByRole("button", { name: "Sign in" }).isVisible()) return true;
			await page
				.getByRole("button", { name: "Logout" })
				.click({ timeout: 5000 })
				.catch(() => {});
			return null;
		},
		60_000,
		500,
	);
}
