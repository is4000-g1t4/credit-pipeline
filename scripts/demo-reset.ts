// pnpm demo:reset [--dry-run] --yes — guarded compose-backed reset
// (SPEC-t17-t18 §2.5): validates the manifest (version/hash) plus the
// DB seed sentinel before planning anything, then stops services, removes
// only the allowlisted demo volumes (pgdata, kafka-data — blob data lives
// on the host `.data/` bind-mounts and svc-node-modules is never touched),
// clears both host storage roots, brings infra up first (postgres/kafka/
// temporal), recreates databases/topics, seeds the base and demo fixtures
// (db:init → migrate → kafka:init → db-seed → demo-seed), then starts the
// application services; asserts all topics exist with 3 partitions, and
// waits for gateway health with a bounded timeout. `--dry-run` prints the
// plan and exits 0 without executing anything. Production is always refused.
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { Kafka } from "kafkajs";
import { createDb } from "@credit/db/applications";
import { TOPICS } from "@credit/core";
import { DEMO_RESET_VOLUMES } from "@credit/service-kit";
import { cliFlags, requireEnv } from "./lib/env.js";
import { assertFixtureClock, loadManifest } from "./lib/manifest.js";
import { assertResetVolumeOwnership, planDemoReset, withRemovableVolumes } from "./lib/reset.js";
import { assertSeedSentinel } from "./lib/seed.js";

const execFileAsync = promisify(execFile);
const dryRun = process.argv.includes("--dry-run");
const confirmed = process.argv.includes("--yes");

async function run(argv: string[]): Promise<void> {
	console.log(`demo:reset: $ ${argv.join(" ")}`);
	await execFileAsync(argv[0], argv.slice(1), { maxBuffer: 10 * 1024 * 1024 });
}

/** Inspect existing target volumes before deleting them; missing volumes are
 * fine (fresh reset), but a volume carrying another project's labels is not. */
async function assertVolumeOwnership(project: string): Promise<string[]> {
	const existing: string[] = [];
	for (const short of DEMO_RESET_VOLUMES) {
		const full = `${project}_${short}`;
		let stdout: string;
		try {
			({ stdout } = await execFileAsync("docker", [
				"volume",
				"inspect",
				full,
				"--format",
				"{{json .Labels}}",
			]));
		} catch (err) {
			const text = `${(err as { stderr?: string }).stderr ?? ""} ${(err as Error).message}`;
			if (/no such volume/i.test(text)) continue;
			throw err;
		}
		assertResetVolumeOwnership(project, short, JSON.parse(stdout) as Record<string, string>);
		existing.push(full);
	}
	return existing;
}

async function main(): Promise<void> {
	const flags = cliFlags();
	const manifest = loadManifest();
	assertFixtureClock(manifest.demoAsOf, process.env.DEMO_AS_OF);

	const { db: appDb, sql } = createDb(requireEnv("APPLICATIONS_DATABASE_URL"));
	let sentinel: { version: string; hash: string };
	try {
		sentinel = await assertSeedSentinel(appDb, manifest);
	} finally {
		await sql.end();
	}

	const composeProject = process.env.COMPOSE_PROJECT_NAME?.trim() || basename(process.cwd());
	const plan = withRemovableVolumes(
		planDemoReset({
			demoMode: flags.demoMode,
			nodeEnv: flags.nodeEnv,
			demoResetAllowed: flags.demoResetAllowed,
			confirmed: dryRun ? true : confirmed,
			documentStorageDir: process.env.DOCUMENT_STORAGE_DIR ?? ".data/documents",
			customerStorageDir: process.env.CUSTOMER_STORAGE_DIR ?? ".data/customer-documents",
			applicationsDatabaseUrl: requireEnv("APPLICATIONS_DATABASE_URL"),
			kafkaBrokers: process.env.KAFKA_BROKERS ?? "localhost:9092",
			temporalAddress: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
			composeProject,
			manifest,
			sentinel,
		}),
		await assertVolumeOwnership(composeProject),
	);

	console.log(
		`demo:reset: plan (${plan.steps.length} steps, volumes ${plan.volumes.join(", ") || "none"})`,
	);
	for (const step of plan.steps) {
		if (step.kind === "exec")
			console.log(`demo:reset:   [exec] ${step.name}: ${(step.argv ?? []).join(" ")}`);
		else console.log(`demo:reset:   [fs-clear] ${step.name}: ${(step.paths ?? []).join(", ")}`);
	}
	if (dryRun) {
		console.log("demo:reset: dry-run — no changes made");
		return;
	}

	for (const step of plan.steps) {
		if (step.kind === "exec" && step.argv) {
			await run(step.argv);
		} else if (step.kind === "fs-clear") {
			for (const root of step.paths ?? []) {
				await rm(root, { recursive: true, force: true });
				console.log(`demo:reset: cleared ${root}`);
			}
		}
	}

	// Topics exist with 3 partitions (kafka:init is idempotent; assert here).
	const kafka = new Kafka({
		clientId: "credit-demo-reset",
		brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((s) => s.trim()),
	});
	const admin = kafka.admin();
	await admin.connect();
	try {
		const metadata = await admin.fetchTopicMetadata();
		const expected = Object.values(TOPICS);
		for (const topic of expected) {
			const found = metadata.topics.find((t) => t.name === topic);
			if (!found) throw new Error(`demo:reset: topic missing after reset: ${topic}`);
			if (found.partitions.length !== 3) {
				throw new Error(
					`demo:reset: topic ${topic} has ${found.partitions.length} partitions (want 3)`,
				);
			}
		}
		console.log(`demo:reset: ${expected.length} topics present with 3 partitions`);
	} finally {
		await admin.disconnect();
	}

	// Bounded consumer/stack wait: gateway health ok (db/kafka/temporal up).
	const apiBase = process.env.API_BASE ?? "http://127.0.0.1:3001";
	const deadline = Date.now() + 180_000;
	for (;;) {
		try {
			const res = await fetch(`${apiBase}/api/health`);
			const health = (await res.json()) as {
				status: string;
				checks: { db: { ok: boolean }; kafka: { ok: boolean }; temporal: { ok: boolean } };
			};
			if (
				health.status === "ok" &&
				health.checks.db.ok &&
				health.checks.kafka.ok &&
				health.checks.temporal.ok
			) {
				console.log("demo:reset: stack healthy (db/kafka/temporal ok)");
				break;
			}
		} catch {
			// retry until the deadline
		}
		if (Date.now() >= deadline) throw new Error("demo:reset: timed out waiting for stack health");
		await new Promise((r) => setTimeout(r, 5000));
	}
	console.log("demo:reset: done — reseeded; run demo:case/demo:verify for persona flows");
}

try {
	await main();
} catch (err) {
	console.error(`demo:reset: FAIL — ${(err as Error).message}`);
	process.exit(1);
}
