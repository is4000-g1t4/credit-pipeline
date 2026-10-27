// Reset guards + dry-run plan (SPEC-t17-t18 §2.5). No docker, no DB, no
// destructive run: every guard throws, and the dry-run plan is asserted
// step by step (manifest + sentinel agreement first, two-phase compose
// order, volumes allowlisted, node_modules never listed, only host roots
// cleared, reseed order).
import { describe, expect, it } from "vitest";
import { loadManifest } from "../lib/manifest.js";
import {
	assertResetVolumeOwnership,
	planDemoReset,
	withRemovableVolumes,
	type ResetOptions,
} from "../lib/reset.js";

const manifest = loadManifest();

const base: ResetOptions = {
	demoMode: true,
	nodeEnv: "development",
	demoResetAllowed: true,
	confirmed: true,
	documentStorageDir: ".data/documents",
	customerStorageDir: ".data/customer-documents",
	applicationsDatabaseUrl: "postgres://credit:credit@localhost:5432/credit_applications",
	kafkaBrokers: "localhost:9092",
	temporalAddress: "localhost:7233",
	composeProject: "project",
	manifest,
	sentinel: { version: String(manifest.version), hash: manifest.sha256 },
};

describe("demo:reset guards", () => {
	it("refuses production even with --yes", () => {
		expect(() => planDemoReset({ ...base, nodeEnv: "production" })).toThrow();
	});
	it("refuses demo-off, unallowed, and unconfirmed", () => {
		expect(() => planDemoReset({ ...base, demoMode: false })).toThrow();
		expect(() => planDemoReset({ ...base, demoResetAllowed: false })).toThrow();
		expect(() => planDemoReset({ ...base, confirmed: false })).toThrow();
	});
	it("refuses a drifted manifest before any other guard", () => {
		const drifted = structuredClone(manifest);
		drifted.personas.breadtalk.case.amountCents += 1;
		expect(() => planDemoReset({ ...base, manifest: drifted })).toThrow(/manifest/);
	});
	it("refuses without a seed sentinel, or a stale one", () => {
		expect(() => planDemoReset({ ...base, sentinel: null })).toThrow(/sentinel/);
		expect(() =>
			planDemoReset({ ...base, sentinel: { version: "999", hash: manifest.sha256 } }),
		).toThrow(/sentinel version/);
		expect(() =>
			planDemoReset({
				...base,
				sentinel: { version: String(manifest.version), hash: "0".repeat(64) },
			}),
		).toThrow(/sentinel hash/);
	});
	it("refuses non-demo database hosts and brokers", () => {
		expect(() =>
			planDemoReset({
				...base,
				applicationsDatabaseUrl: "postgres://credit:credit@prod-db:5432/credit_applications",
			}),
		).toThrow(/demo host/);
		expect(() => planDemoReset({ ...base, kafkaBrokers: "prod-kafka:9092" })).toThrow(
			/compose service/,
		);
		expect(() => planDemoReset({ ...base, temporalAddress: "prod-temporal:7233" })).toThrow(
			/compose service/,
		);
	});
	it("refuses non-demo storage roots", () => {
		expect(() => planDemoReset({ ...base, documentStorageDir: "/srv/docs" })).toThrow();
		expect(() => planDemoReset({ ...base, customerStorageDir: "/srv/customer" })).toThrow();
		expect(() => planDemoReset({ ...base, documentStorageDir: ".data/documents/sub" })).toThrow();
	});
	it("accepts container-style compose addresses", () => {
		expect(() =>
			planDemoReset({
				...base,
				applicationsDatabaseUrl: "postgres://credit:credit@postgres:5432/credit_applications",
				kafkaBrokers: "kafka:29092",
				temporalAddress: "temporal:7233",
			}),
		).not.toThrow();
	});
});

describe("demo:reset volume ownership", () => {
	it("accepts only volumes labelled for the target compose project and suffix", () => {
		const labels = {
			"com.docker.compose.project": "project",
			"com.docker.compose.volume": "pgdata",
		};
		expect(() => assertResetVolumeOwnership("project", "pgdata", labels)).not.toThrow();
		expect(() =>
			assertResetVolumeOwnership("project", "pgdata", {
				...labels,
				"com.docker.compose.project": "other-checkout",
			}),
		).toThrow(/not owned/);
		expect(() =>
			assertResetVolumeOwnership("project", "pgdata", {
				...labels,
				"com.docker.compose.volume": "kafka-data",
			}),
		).toThrow(/not owned/);
		expect(() => assertResetVolumeOwnership("project", "pgdata", null)).toThrow(/not owned/);
	});

	it("keeps the removal step aligned with existing volumes", () => {
		const plan = planDemoReset(base);
		const one = withRemovableVolumes(plan, ["project_pgdata"]);
		expect(one.volumes).toEqual(["project_pgdata"]);
		expect(one.steps.find((s) => s.name === "remove-volumes")?.argv).toEqual([
			"docker",
			"volume",
			"rm",
			"project_pgdata",
		]);
		expect(one.steps.some((s) => s.name === "remove-containers")).toBe(true);

		const none = withRemovableVolumes(plan, []);
		expect(none.volumes).toEqual([]);
		expect(none.steps.some((s) => s.name === "remove-volumes")).toBe(false);
	});
});

describe("demo:reset dry-run plan", () => {
	it("orders stop → volumes → roots → infra → databases → apps → reseed", () => {
		const plan = planDemoReset(base);
		expect(plan.steps.map((s) => s.name)).toEqual([
			"stop-services",
			"stop-infra",
			"remove-containers",
			"remove-volumes",
			"clear-host-roots",
			"up-infra",
			"db-init",
			"db-migrate",
			"kafka-init",
			"db-seed",
			"demo-seed",
			"up-apps",
		]);
	});
	it("brings infra up before migrations, apps only after", () => {
		const plan = planDemoReset(base);
		const names = plan.steps.map((s) => s.name);
		const infra = plan.steps.find((s) => s.name === "up-infra");
		expect(infra?.argv ?? []).toEqual(expect.arrayContaining(["postgres", "kafka", "temporal"]));
		expect(names.indexOf("up-infra")).toBeLessThan(names.indexOf("db-init"));
		expect(names.indexOf("kafka-init")).toBeLessThan(names.indexOf("db-seed"));
		expect(names.indexOf("db-seed")).toBeLessThan(names.indexOf("demo-seed"));
		expect(names.indexOf("demo-seed")).toBeLessThan(names.indexOf("up-apps"));
	});
	it("removes only allowlisted volumes (node_modules and blob bind-mounts preserved)", () => {
		const plan = planDemoReset(base);
		expect(plan.volumes).toEqual(["project_pgdata", "project_kafka-data"]);
		const rmStep = plan.steps.find((s) => s.name === "remove-volumes");
		expect(rmStep?.argv ?? []).toEqual([
			"docker",
			"volume",
			"rm",
			"project_pgdata",
			"project_kafka-data",
		]);
		expect(rmStep?.argv ?? []).not.toContain("svc-node-modules");
	});
	it("clears only host roots (container roots are volume state, never rm)", () => {
		const plan = planDemoReset(base);
		const clear = plan.steps.find((s) => s.name === "clear-host-roots");
		expect(clear?.kind).toBe("fs-clear");
		expect(clear?.paths).toEqual([".data/documents", ".data/customer-documents"]);
		const container = planDemoReset({
			...base,
			documentStorageDir: "/data/documents",
			customerStorageDir: "/data/customer-documents",
		});
		expect(container.steps.find((s) => s.name === "clear-host-roots")?.paths).toEqual([]);
	});
});
