// pnpm demo:monitor — officer login + POST /api/demo/monitoring/run,
// printing the result counts. Starts nothing; needs compose + api + worker.
import { apiBase, loginCookie, LoginError } from "./lib/env.js";

const API_BASE = apiBase();

let session: string;
try {
	session = await loginCookie("officer@example.com", "demo1234", API_BASE);
} catch (err) {
	if (err instanceof LoginError && err.status !== undefined) {
		console.error(
			`demo:monitor: officer login failed (HTTP ${err.status}). ` +
				"Is the api running? `pnpm dev` (compose must be up).",
		);
		process.exit(1);
	}
	// No session cookie on a 200 (or a transport failure): historically the
	// script carried on with an empty cookie and let the run call fail.
	if (err instanceof LoginError) {
		session = "";
	} else {
		throw err;
	}
}
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
