// E2E global setup (SPEC §7): starts worker + gateway + 4 services + web
// via pnpm filters, waits for /api/health (db/kafka/temporal up) and web
// HTML, records the child PIDs for the teardown. Services already up are
// reused, never re-spawned (their PIDs are marked reused so teardown leaves
// them alone).
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { API_BASE } from "./helpers.js";

export const WEB_BASE = "http://127.0.0.1:3000";
export const PID_FILE = resolve(dirname(fileURLToPath(import.meta.url)), ".e2e-pids.json");
const LOG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "logs");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SERVICES = [
	{ name: "gateway", filter: "@credit/gateway", url: "http://127.0.0.1:3001" },
	{ name: "applications", filter: "@credit/applications", url: "http://127.0.0.1:4001" },
	{ name: "review", filter: "@credit/review", url: "http://127.0.0.1:4002" },
	{ name: "loans", filter: "@credit/loans", url: "http://127.0.0.1:4003" },
	{ name: "portfolio", filter: "@credit/portfolio", url: "http://127.0.0.1:4004" },
] as const;

interface Health {
	status: string;
	checks: {
		db: { ok: boolean };
		kafka: { ok: boolean };
		temporal: { ok: boolean };
	};
}

async function getJson(url: string): Promise<{ status: number; json: unknown }> {
	const res = await fetch(url);
	const text = await res.text();
	try {
		return { status: res.status, json: JSON.parse(text) as unknown };
	} catch {
		return { status: res.status, json: text };
	}
}

async function apiHealthy(): Promise<boolean> {
	try {
		const { status, json } = await getJson(`${API_BASE}/api/health`);
		if (status !== 200) return false;
		const h = json as Health;
		return h.status === "ok" && h.checks.db.ok && h.checks.kafka.ok && h.checks.temporal.ok;
	} catch {
		return false;
	}
}

async function serviceHealthy(base: string): Promise<boolean> {
	try {
		const { status, json } = await getJson(`${base}/health`);
		if (status !== 200) return false;
		return (json as { status?: unknown }).status === "ok";
	} catch {
		return false;
	}
}

async function webHealthy(): Promise<boolean> {
	try {
		const res = await fetch(`${WEB_BASE}/`);
		if (res.status !== 200) return false;
		const html = await res.text();
		return html.includes("<html");
	} catch {
		return false;
	}
}

function start(name: string, args: string[]): ChildProcess {
	mkdirSync(LOG_DIR, { recursive: true });
	const logPath = `${LOG_DIR}/${name}.log`;
	console.log(`e2e setup: spawning pnpm ${args.join(" ")} (log ${logPath})`);
	// Shell redirection (not fd-passing: Node rejects raw fds in stdio on
	// Windows with EINVAL). The shell PID parents the pnpm tree, so the
	// teardown's taskkill /T still reaps everything.
	const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
	const cmd = `${pnpm} ${args.join(" ")} >> "${logPath}" 2>&1`;
	return spawn(cmd, { cwd: ROOT, shell: true, stdio: "ignore" });
}

async function waitFor(label: string, check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 240_000;
	for (;;) {
		if (await check()) {
			console.log(`e2e setup: ${label} ready`);
			return;
		}
		if (Date.now() >= deadline) throw new Error(`e2e setup: timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 2000));
	}
}

export default async function globalSetup(): Promise<void> {
	// Reuse a healthy stack (e.g. `pnpm dev` already running) instead of
	// binding the same ports twice; only spawn what is actually down.
	const reuseApi = await apiHealthy();
	const reuseWeb = await webHealthy();
	const procs: Array<{
		name: string;
		pid: number | undefined;
		reused: boolean;
	}> = [];
	if (!reuseApi || !reuseWeb) console.log("e2e setup: starting dev stack…");
	// The worker owns no port, so it is always (re)started — a second worker
	// is safe (relay/reconciler take advisory locks, schedule bootstrap and
	// the consumer group are idempotent).
	const worker = start("worker", ["--filter", "@credit/worker", "dev"]);
	procs.push({ name: "worker", pid: worker.pid, reused: false });
	// The gateway owns :3001 but each service is probed individually, so a
	// half-running stack is completed, not duplicated.
	const gatewayHealthy = await apiHealthy();
	if (gatewayHealthy) {
		console.log("e2e setup: reusing running gateway :3001");
		procs.push({ name: "gateway", pid: undefined, reused: true });
	} else {
		const gateway = start("gateway", ["--filter", "@credit/gateway", "dev"]);
		procs.push({ name: "gateway", pid: gateway.pid, reused: false });
	}
	for (const s of SERVICES.slice(1)) {
		if (await serviceHealthy(s.url)) {
			console.log(`e2e setup: reusing running ${s.name} (${s.url})`);
			procs.push({ name: s.name, pid: undefined, reused: true });
		} else {
			const proc = start(s.name, ["--filter", s.filter, "dev"]);
			procs.push({ name: s.name, pid: proc.pid, reused: false });
		}
	}
	if (!reuseWeb) {
		const web = start("web", ["--filter", "@credit/web", "dev"]);
		procs.push({ name: "web", pid: web.pid, reused: false });
	} else {
		console.log("e2e setup: reusing running web :3000");
		procs.push({ name: "web", pid: undefined, reused: true });
	}
	writeFileSync(PID_FILE, JSON.stringify(procs, null, 2));
	try {
		await waitFor("gateway health (db/kafka/temporal up)", apiHealthy);
		for (const s of SERVICES.slice(1)) {
			await waitFor(`${s.name} health`, () => serviceHealthy(s.url));
		}
		await waitFor("web html", webHealthy);
		// Warm the dev compiler: first hits on cold Vite (TanStack Start +
		// Nitro) take tens of seconds; compile the spec routes up front so
		// spec timings reflect the app, not the compiler.
		for (const route of ["/login", "/apply", "/officer/review", "/loans"]) {
			try {
				await fetch(`${WEB_BASE}${route}`);
			} catch {
				// The specs will surface a real web failure loudly.
			}
		}
	} catch (err) {
		console.error(
			"e2e setup: stack did not come up — recent logs are in e2e/logs/. " +
				"If a port is taken by a stale server, stop it (see README troubleshooting).",
		);
		throw err;
	}
	console.log("e2e setup: stack ready (compose + worker + gateway + services + web)");
}
