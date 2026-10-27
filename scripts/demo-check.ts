// pnpm demo:check — scripted HTTP smoke over the running stack (starts
// nothing). Requires compose + dev servers (`pnpm dev`, or the Playwright
// global setup); fails fast with a clear message if /api/health is not ok.
// Drives the three demo scenarios plus monitoring/pay, prints a PASS/FAIL
// summary with references, exits non-zero on any failure.
import { apiBase, loginCookie, LoginError } from "./lib/env.js";

const API_BASE = apiBase();

class CheckError extends Error {}

class Client {
	private cookie = "";

	async login(email: string): Promise<void> {
		try {
			this.cookie = await loginCookie(email, "demo1234", API_BASE);
		} catch (err) {
			throw new CheckError(err instanceof LoginError ? err.message : String(err));
		}
	}

	async get<T>(path: string): Promise<T> {
		return this.req<T>("GET", path);
	}

	async post<T>(path: string, body?: unknown): Promise<T> {
		return this.req<T>("POST", path, body);
	}

	private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = { cookie: this.cookie };
		if (body !== undefined) headers["content-type"] = "application/json";
		if (method === "POST" && path === "/api/applications") {
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
			throw new CheckError(`${method} ${path}: HTTP ${res.status} (non-JSON)`);
		}
		if (!res.ok) {
			const err = (data as { error?: { code?: string; message?: string } })?.error;
			throw new CheckError(
				`${method} ${path}: HTTP ${res.status} ${err?.code ?? ""} ${err?.message ?? ""}`.trim(),
			);
		}
		return data as T;
	}
}

interface CaseDetail {
	application: { id: string; reference: string; status: string };
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
	} | null;
	loan: {
		id: string;
		principalCents: number;
		termMonths: number;
		installments: { total: number };
	} | null;
}

interface LoanDetail {
	loan: { id: string; status: string };
	installments: Array<{ id: string; number: number; status: string }>;
	payments: Array<{ id: string }>;
	alerts: Array<{ id: string; type: string; status: string }>;
}

const TERMINAL = new Set(["booked", "declined", "expired", "failed"]);
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, cond: boolean, detail: string): void {
	results.push({ name, ok: cond, detail });
	console.log(`${cond ? "PASS" : "FAIL"}  ${name} — ${detail}`);
	if (!cond) throw new CheckError(`assertion failed: ${name}`);
}

async function pollCase(c: Client, id: string, want: (s: string) => boolean): Promise<CaseDetail> {
	const deadline = Date.now() + 180_000;
	for (;;) {
		const d = await c.get<CaseDetail>(`/api/applications/${id}`);
		if (want(d.application.status)) return d;
		if (Date.now() >= deadline) throw new CheckError(`timed out waiting for ${id}`);
		await new Promise((r) => setTimeout(r, 2000));
	}
}

const waitTerminal = (c: Client, id: string) => pollCase(c, id, (s) => TERMINAL.has(s));

async function main(): Promise<void> {
	// Fail fast: the smoke starts nothing.
	let health: {
		status: string;
		checks: {
			db: { ok: boolean };
			kafka: { ok: boolean };
			temporal: { ok: boolean };
		};
	};
	try {
		const res = await fetch(`${API_BASE}/api/health`);
		health = (await res.json()) as typeof health;
	} catch {
		throw new CheckError(
			`API at ${API_BASE} is not reachable. Start compose + dev servers first: ` +
				"`docker compose up -d --wait && pnpm setup && pnpm dev` (or run `pnpm test:e2e`, whose global setup starts them).",
		);
	}
	const up =
		health.status === "ok" &&
		health.checks.db.ok &&
		health.checks.kafka.ok &&
		health.checks.temporal.ok;
	if (!up) {
		throw new CheckError(
			`/api/health is not ok (${JSON.stringify(health.checks)}). ` +
				"Start compose + dev servers first: `docker compose up -d --wait && pnpm setup && pnpm dev`.",
		);
	}
	console.log("demo:check: /api/health ok (db/kafka/temporal up)");

	// --- Maria: $12,000/48m → auto-booked, 777/A, 48 installments. ---
	const maria = new Client();
	await maria.login("maria@example.com");
	const mApp = await maria.post<{ id: string; reference: string }>("/api/applications", {
		type: "individual",
		product: "personal_loan",
		amountCents: 1_200_000,
		termMonths: 48,
		purpose: "Home renovation (demo:check)",
		consents: [true, true, true],
		identity: {
			fullName: "Maria Demo",
			dob: "1990-05-14",
			nationalId: "MARIA42C1",
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
	});
	const mDone = await waitTerminal(maria, mApp.id);
	check("maria booked", mDone.application.status === "booked", mApp.reference);
	check(
		"maria 777/A",
		mDone.score?.score === 777 && mDone.score?.grade === "A",
		`score ${mDone.score?.score}/${mDone.score?.grade}`,
	);
	check(
		"maria 48 installments",
		mDone.loan?.installments.total === 48,
		`loan ${mDone.loan?.id ?? "none"}`,
	);

	// --- Sam: $10,000/36m → auto-declined SCORE_TOO_LOW, no loan. ---
	const sam = new Client();
	await sam.login("sam@example.com");
	const sApp = await sam.post<{ id: string; reference: string }>("/api/applications", {
		type: "individual",
		product: "personal_loan",
		amountCents: 1_000_000,
		termMonths: 36,
		purpose: "Used car (demo:check)",
		consents: [true, true, true],
		identity: {
			fullName: "Sam Demo",
			dob: "1992-08-04",
			nationalId: "SAMDEMO21",
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
	});
	const sDone = await waitTerminal(sam, sApp.id);
	const sCodes = (sDone.decision?.reasons ?? []).map((r) => (typeof r === "string" ? r : r.code));
	const sNeg = (sDone.score?.factors ?? []).filter((f) => f.points < 0).map((f) => f.code);
	check("sam declined", sDone.application.status === "declined", sApp.reference);
	check(
		"sam SCORE_TOO_LOW + factors",
		sCodes.includes("SCORE_TOO_LOW") && sNeg.length > 0,
		sCodes.join(","),
	);
	check("sam no loan", sDone.loan === null, "no loan row");

	// --- Tomás: $60,000/60m SME → referred → officer approves $50k → booked. ---
	const tomas = new Client();
	await tomas.login("tomas@cafe-aurora.example");
	const tApp = await tomas.post<{ id: string; reference: string }>("/api/applications", {
		type: "sme",
		product: "sme_term_loan",
		amountCents: 6_000_000,
		termMonths: 60,
		purpose: "Café expansion (demo:check)",
		consents: [true, true, true],
		identity: {
			fullName: "Tomas Aurora",
			dob: "1985-03-20",
			nationalId: "TOMAS42C1",
			email: "tomas@cafe-aurora.example",
			phone: "+1-555-0200",
			address: "2 Café Street",
			city: "Demo City",
		},
		sme: {
			companyName: "Café Aurora",
			registrationNumber: "CAFEAURC",
			industry: "hospitality",
			yearsTrading: 4,
			employees: 9,
			annualRevenueCents: 61_000_000,
			monthlyFcfCents: 380_000,
			existingDebtServiceCents: 30_000,
		},
	});
	const tPending = await pollCase(tomas, tApp.id, (s) => s === "pending_review" || TERMINAL.has(s));
	const tReasons = (tPending.policyEvaluation?.reasons ?? []).map((r) => r.code);
	check("tomas referred", tPending.application.status === "pending_review", tApp.reference);
	check(
		"tomas amount + SECTOR_REVIEW",
		tReasons.includes("AMOUNT_ABOVE_AUTO_LIMIT") && tReasons.includes("SECTOR_REVIEW"),
		tReasons.join(","),
	);

	const officer = new Client();
	await officer.login("officer@example.com");
	const queue = await officer.get<{ items: Array<{ id: string }> }>("/api/review/queue");
	check(
		"tomas in officer queue",
		queue.items.some((i) => i.id === tApp.id),
		`${queue.items.length} queued`,
	);
	const tDecision = await officer.post<{
		outcome: string;
		decisionId: string;
		loanId: string | null;
	}>(`/api/review/${tApp.id}/decision`, {
		requestId: crypto.randomUUID(),
		outcome: "approve",
		approvedAmountCents: 5_000_000,
		termMonths: 60,
		notes: "Counter-offer: reduced to $50,000 on current cash flow.",
	});
	check(
		"tomas officer approve → booked",
		tDecision.outcome === "booked",
		`decision ${tDecision.decisionId}`,
	);
	const tDone = await waitTerminal(officer, tApp.id);
	check(
		"tomas booked at officer terms",
		tDone.application.status === "booked" &&
			tDone.decision?.approvedAmountCents === 5_000_000 &&
			tDone.loan?.principalCents === 5_000_000,
		`loan ${tDone.loan?.id ?? "none"}`,
	);

	// --- Monitoring on Tomás's loan: age → alert → ack → pay. ---
	const loanId = tDone.loan?.id ?? "";
	const aged = await officer.post<{
		aged: number;
		markedOverdue?: number;
		workflowId?: string;
	}>(`/api/demo/loans/${loanId}/age`, { days: 40 });
	const monitored = await officer.post<{
		markedOverdue?: number;
		alertsCreated?: number;
		workflowId?: string;
	}>("/api/demo/monitoring/run", {});
	const deadline = Date.now() + 120_000;
	let loan: LoanDetail | null = null;
	for (;;) {
		loan = await officer.get<LoanDetail>(`/api/loans/${loanId}`);
		if (loan.alerts.some((a) => a.status === "open")) break;
		if (Date.now() >= deadline) throw new CheckError("timed out waiting for overdue alert");
		await new Promise((r) => setTimeout(r, 2000));
	}
	const alert = loan.alerts.find((a) => a.status === "open") ?? loan.alerts[0];
	check(
		"age + monitoring → overdue alert",
		alert?.type === "payment_overdue",
		`aged ${aged.aged}, monitored ${JSON.stringify(monitored)}`,
	);
	await officer.post(`/api/loans/${loanId}/alerts/${alert.id}/acknowledge`, {});
	const acked = await officer.get<LoanDetail>(`/api/loans/${loanId}`);
	check(
		"alert acknowledged",
		acked.alerts.find((a) => a.id === alert.id)?.status === "acknowledged",
		alert.id,
	);
	const first = acked.installments.find((i) => i.status !== "paid") ?? acked.installments[0];
	await officer.post(`/api/demo/loans/${loanId}/pay`, {
		installmentId: first.id,
	});
	const paid = await officer.get<LoanDetail>(`/api/loans/${loanId}`);
	check(
		"payment posted, alert resolved",
		paid.payments.length > 0,
		`${paid.payments.length} payment(s)`,
	);
	check(
		"no open alerts",
		paid.alerts.filter((a) => a.status === "open").length === 0,
		`alert ${alert.id} now ${paid.alerts.find((a) => a.id === alert.id)?.status}`,
	);

	const failed = results.filter((r) => !r.ok).length;
	console.log(`demo:check: ${results.length - failed}/${results.length} checks passed`);
	if (failed > 0) process.exit(1);
}

try {
	await main();
} catch (err) {
	if (err instanceof CheckError) {
		console.error(`demo:check: FAIL — ${err.message}`);
		process.exit(1);
	}
	throw err;
}
