// pnpm demo:monitor — officer login + POST /api/demo/monitoring/run,
// printing the result counts. Starts nothing; needs compose + api + worker.
const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:3001";

const login = await fetch(`${API_BASE}/api/auth/login`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ email: "officer@example.com", password: "demo1234" }),
});
if (!login.ok) {
	console.error(
		`demo:monitor: officer login failed (HTTP ${login.status}). ` +
			"Is the api running? `pnpm dev` (compose must be up).",
	);
	process.exit(1);
}
const session = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const run = await fetch(`${API_BASE}/api/demo/monitoring/run`, {
	method: "POST",
	headers: { cookie: session, "content-type": "application/json" },
	body: "{}",
});
const body = (await run.json()) as Record<string, unknown>;
if (!run.ok && run.status !== 202) {
	console.error(`demo:monitor: run failed (HTTP ${run.status}): ${JSON.stringify(body)}`);
	process.exit(1);
}
if (run.status === 202) {
	console.log(
		`demo:monitor: monitoring still running (workflow ${body.workflowId}); poll the loan page.`,
	);
} else {
	console.log(
		`demo:monitor: markedOverdue=${body.markedOverdue} alertsCreated=${body.alertsCreated} ` +
			`loansUpdated=${body.loansUpdated} workflow=${body.workflowId}`,
	);
}
