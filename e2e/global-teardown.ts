// E2E global teardown: kills exactly the PIDs the setup spawned (reused
// services are left alone). taskkill /T takes the whole PID tree, which
// covers pnpm re-parenting the tsx/vite children on Windows.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { PID_FILE } from "./global-setup.js";

interface Proc {
	name: string;
	pid: number | undefined;
	reused: boolean;
}

function killTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
				stdio: "ignore",
			});
		} else {
			process.kill(pid, "SIGTERM");
		}
		console.log(`e2e teardown: stopped ${pid}`);
	} catch {
		// Already exited (e.g. a spawn that died on a taken port) — nothing
		// to do. We only ever kill PIDs this run started.
	}
}

export default function globalTeardown(): void {
	if (!existsSync(PID_FILE)) return;
	const procs = JSON.parse(readFileSync(PID_FILE, "utf8")) as Proc[];
	for (const p of procs) {
		if (!p.reused && typeof p.pid === "number") killTree(p.pid);
		else console.log(`e2e teardown: leaving ${p.name} (reused)`);
	}
	rmSync(PID_FILE, { force: true });
}
