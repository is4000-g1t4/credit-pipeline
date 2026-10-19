import { execFileSync } from "node:child_process";

const TIMEOUT_MS = Number(process.env.DB_WAIT_TIMEOUT_S ?? 120) * 1000;
const INTERVAL_MS = 2000;
const deadline = Date.now() + TIMEOUT_MS;

for (;;) {
	try {
		execFileSync("docker", ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "credit"], {
			stdio: "pipe",
		});
		console.log("db:wait: postgres is ready");
		process.exit(0);
	} catch {
		if (Date.now() >= deadline) {
			console.error("db:wait: timed out waiting for postgres");
			process.exit(1);
		}
		await new Promise((r) => setTimeout(r, INTERVAL_MS));
	}
}
