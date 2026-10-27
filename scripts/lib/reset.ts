// `demo:reset` planner (SPEC-t17-t18 §2.5): destructive, compose-backed,
// and guarded. This module only plans — it never spawns, deletes, or
// connects — so unit tests cover every guard and the `--dry-run` output
// without docker. The CLI (`scripts/demo-reset.ts`) executes the plan step
// by step after the same guards pass.
import {
	assertDemoCustomerRoot,
	assertDemoDocumentRoot,
	assertDemoResetAllowed,
	assertDemoVolume,
	assertStorageRootsDisjoint,
	DEMO_RESET_VOLUMES,
	isDemoHostRoot,
} from "@credit/service-kit";
import {
	assertManifest,
	EXPECTED_MANIFEST_SHA256,
	EXPECTED_MANIFEST_VERSION,
	type DemoManifest,
} from "./manifest.js";

export interface ResetStep {
	name: string;
	kind: "exec" | "fs-clear";
	detail: string;
	argv?: string[];
	paths?: string[];
}

export interface ResetPlan {
	steps: ResetStep[];
	volumes: string[];
}

export interface ResetOptions {
	demoMode: boolean;
	nodeEnv: string;
	demoResetAllowed: boolean;
	confirmed: boolean;
	documentStorageDir: string;
	customerStorageDir: string;
	applicationsDatabaseUrl: string;
	kafkaBrokers: string;
	temporalAddress: string;
	composeProject: string;
	/** Checked-in fixture manifest — version/hash must agree with code. */
	manifest: DemoManifest;
	/** DB-side `demo_meta` sentinel from a prior `demo:seed` (never wipe blind). */
	sentinel: { version: string; hash: string } | null;
}

function assertDemoDatabaseUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`refusing: APPLICATIONS_DATABASE_URL is not a URL`);
	}
	if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
		throw new Error(`refusing: APPLICATIONS_DATABASE_URL is not postgres: ${url}`);
	}
	if (!["localhost", "127.0.0.1", "postgres"].includes(parsed.hostname)) {
		throw new Error(`refusing: database host is not a demo host: ${parsed.hostname}`);
	}
}

function assertDemoBrokerList(brokers: string, name: string, ports: string[]): void {
	const entries = brokers
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (entries.length === 0) throw new Error(`refusing: ${name} is empty`);
	for (const entry of entries) {
		const [host, port] = entry.split(":");
		if (
			!["localhost", "127.0.0.1", "kafka", "temporal"].includes(host) ||
			!ports.includes(port ?? "")
		) {
			throw new Error(`refusing: ${name} entry is not a compose service: ${entry}`);
		}
	}
}

const COMPOSE_PREFIX = [
	"docker",
	"compose",
	"-f",
	"docker-compose.yml",
	"-f",
	"compose.services.yml",
	"--profile",
	"microservices",
];

/** Compose labels prove a named volume belongs to the project we are about
 * to delete. A bare suffix allowlist is not enough: `project_pgdata` could
 * belong to an unrelated checkout. */
export function assertResetVolumeOwnership(
	project: string,
	short: string,
	labels: Record<string, string> | null | undefined,
): void {
	if (
		labels?.["com.docker.compose.project"] !== project ||
		labels["com.docker.compose.volume"] !== short
	) {
		throw new Error(
			`refusing: volume ${project}_${short} is not owned by compose project ${project}`,
		);
	}
}

/** Keep the removal step aligned with volumes that actually exist (and were
 * label-checked). A missing volume must not make `docker volume rm` abort
 * after other demo volumes were already removed. */
export function withRemovableVolumes(plan: ResetPlan, existing: readonly string[]): ResetPlan {
	const volumes = existing.filter((v) => plan.volumes.includes(v));
	return {
		...plan,
		volumes,
		steps: plan.steps
			.map((step) =>
				step.name === "remove-volumes"
					? {
							...step,
							detail: `remove demo volumes (${volumes.join(", ") || "none"})`,
							argv: ["docker", "volume", "rm", ...volumes],
						}
					: step,
			)
			.filter((step) => step.name !== "remove-volumes" || volumes.length > 0),
	};
}

function composeArgs(args: string[]): string[] {
	return [...COMPOSE_PREFIX, ...args];
}

/** Fail closed on every guard; otherwise return the ordered reset plan.
 * Manifest + sentinel agreement is validated before anything else — a wipe
 * is never planned against drifted fixtures. The order is two-phase: infra
 * up + healthy, then databases/topics, then application services, then
 * seed — application health is never awaited before its tables exist. */
export function planDemoReset(opts: ResetOptions): ResetPlan {
	const { hash } = assertManifest(opts.manifest);
	if (hash !== EXPECTED_MANIFEST_SHA256 || opts.manifest.version !== EXPECTED_MANIFEST_VERSION) {
		throw new Error("refusing: manifest disagrees with the code-side expectation");
	}
	if (!opts.sentinel) {
		throw new Error("refusing: no demo seed sentinel (run demo:seed first)");
	}
	if (opts.sentinel.version !== String(opts.manifest.version)) {
		throw new Error(
			`refusing: sentinel version ${opts.sentinel.version} != manifest ${opts.manifest.version}`,
		);
	}
	if (opts.sentinel.hash !== hash) {
		throw new Error("refusing: sentinel hash != manifest hash (re-run demo:seed)");
	}
	assertDemoResetAllowed(opts);
	assertDemoDocumentRoot(opts.documentStorageDir, "DOCUMENT_STORAGE_DIR");
	assertDemoCustomerRoot(opts.customerStorageDir, "CUSTOMER_STORAGE_DIR");
	assertStorageRootsDisjoint(opts.documentStorageDir, opts.customerStorageDir);
	assertDemoDatabaseUrl(opts.applicationsDatabaseUrl);
	assertDemoBrokerList(opts.kafkaBrokers, "KAFKA_BROKERS", ["9092", "29092"]);
	assertDemoBrokerList(opts.temporalAddress, "TEMPORAL_ADDRESS", ["7233"]);
	if (!opts.composeProject.trim()) {
		throw new Error("refusing: COMPOSE_PROJECT_NAME is empty");
	}
	const volumes = DEMO_RESET_VOLUMES.map((short) => {
		assertDemoVolume(short);
		return `${opts.composeProject}_${short}`;
	});
	// Only host workspace roots are ever `rm`d; container roots (`/data/…`)
	// are volume/bind-mounted state, never host paths.
	const hostPaths = [opts.documentStorageDir, opts.customerStorageDir].filter(isDemoHostRoot);
	return {
		volumes,
		steps: [
			{
				name: "stop-services",
				kind: "exec",
				detail: "stop services/worker first (apps, gateway, research)",
				argv: composeArgs([
					"stop",
					"applications",
					"review",
					"loans",
					"portfolio",
					"gateway",
					"research",
					"worker",
				]),
			},
			{
				name: "stop-infra",
				kind: "exec",
				detail: "stop postgres/kafka/temporal",
				argv: composeArgs(["stop", "postgres", "kafka", "temporal", "temporal-ui"]),
			},
			{
				name: "remove-containers",
				kind: "exec",
				detail: "remove stopped service/infra containers so their volumes are not busy",
				argv: composeArgs([
					"rm",
					"-f",
					"-s",
					"applications",
					"review",
					"loans",
					"portfolio",
					"gateway",
					"research",
					"worker",
					"postgres",
					"kafka",
					"temporal",
					"temporal-ui",
				]),
			},
			{
				name: "remove-volumes",
				kind: "exec",
				detail: `remove demo volumes only (${volumes.join(", ")}; svc-node-modules preserved)`,
				argv: ["docker", "volume", "rm", ...volumes],
			},
			{
				name: "clear-host-roots",
				kind: "fs-clear",
				detail: "clear host storage roots (recreated by seed; container roots are volume state)",
				paths: hostPaths,
			},
			{
				name: "up-infra",
				kind: "exec",
				detail: "bring up postgres/kafka/temporal and wait healthy",
				argv: composeArgs(["up", "-d", "--wait", "postgres", "kafka", "temporal"]),
			},
			{
				name: "db-init",
				kind: "exec",
				detail: "recreate service databases",
				argv: ["bun", "scripts/db-init.ts"],
			},
			{
				name: "db-migrate",
				kind: "exec",
				detail: "apply migrations",
				argv: ["bun", "packages/db/src/migrate.ts"],
			},
			{
				name: "kafka-init",
				kind: "exec",
				detail: "recreate topics (3 partitions)",
				argv: ["bun", "scripts/kafka-init.ts"],
			},
			{
				name: "db-seed",
				kind: "exec",
				detail: "seed base demo users (officer/applicant logins)",
				argv: ["bun", "packages/db/src/seed.ts"],
			},
			{
				name: "demo-seed",
				kind: "exec",
				detail: `reseed fixtures (sentinel v${opts.sentinel.version} ${opts.sentinel.hash.slice(0, 12)})`,
				argv: ["bun", "scripts/demo-seed.ts"],
			},
			{
				name: "up-apps",
				kind: "exec",
				detail: "start application services and wait (tables/topics already exist)",
				argv: composeArgs(["up", "-d", "--wait"]),
			},
		],
	};
}
