// Demo guards (SPEC-t17-t18 §2.5): DEMO_MODE/non-production gates, demo
// storage-root and reset-volume allowlists. Compose-free.
import { describe, expect, it } from "vitest";
import { isAbsolute, sep } from "node:path";
import {
	assertDemoBoot,
	assertDemoCustomerRoot,
	assertDemoDocumentRoot,
	assertDemoMutable,
	assertDemoResetAllowed,
	assertDemoStorageRoot,
	assertDemoVolume,
	assertStorageRootsDisjoint,
	DemoGuardError,
	isDemoCustomerRoot,
	isDemoDocumentRoot,
	isDemoHostRoot,
	isDemoStorageRoot,
	resolveWorkspacePath,
} from "../src/demo-guards.js";

describe("assertDemoMutable", () => {
	it("passes for demo dev/test", () => {
		expect(() => assertDemoMutable({ demoMode: true, nodeEnv: "development" })).not.toThrow();
		expect(() => assertDemoMutable({ demoMode: true, nodeEnv: "test" })).not.toThrow();
	});
	it("refuses demo-off and production", () => {
		expect(() => assertDemoMutable({ demoMode: false, nodeEnv: "development" })).toThrow(
			DemoGuardError,
		);
		expect(() => assertDemoMutable({ demoMode: true, nodeEnv: "production" })).toThrow(
			DemoGuardError,
		);
	});
});

describe("demo storage roots", () => {
	it("allows the exact host and container demo roots", () => {
		for (const root of [
			".data/documents",
			".data/customer-documents",
			"/data/documents",
			"/data/customer-documents",
			".data/documents/",
		]) {
			expect(isDemoStorageRoot(root)).toBe(true);
		}
	});
	it("refuses subpaths, suffix tricks, escapes, and foreign roots", () => {
		for (const root of [
			"",
			"/tmp/docs",
			"/var/lib/data",
			"../.data/documents",
			".data/other",
			"/",
			// Exact canonical roots only: subpaths of an allowlisted root…
			".data/documents/sub",
			".data/customer-documents/sub",
			"/data/documents/sub",
			// …suffix matches that merely contain the marker…
			"/tmp/.data/documents",
			"/var/lib/project/.data/customer-documents",
			"C:/evil/.data/documents",
			// …and arbitrary absolute paths are all refused.
			"/srv/docs",
			"C:/srv/customer",
		]) {
			expect(isDemoStorageRoot(root)).toBe(false);
		}
		expect(() => assertDemoStorageRoot("/etc/passwd", "DOCUMENT_STORAGE_DIR")).toThrow(
			DemoGuardError,
		);
	});
	it("only host workspace roots are rm-able (container roots are volume state)", () => {
		for (const root of [".data/documents", ".data/customer-documents"]) {
			expect(isDemoHostRoot(root)).toBe(true);
		}
		expect(isDemoHostRoot(resolveWorkspacePath(".data/documents"))).toBe(true);
		for (const root of ["/data/documents", "/data/customer-documents", "/srv/docs", ""]) {
			expect(isDemoHostRoot(root)).toBe(false);
		}
	});
});

describe("assertDemoBoot", () => {
	it("refuses reset-allowed in production", () => {
		expect(() =>
			assertDemoBoot({
				demoMode: false,
				nodeEnv: "production",
				demoResetAllowed: true,
				documentStorageDir: ".data/documents",
				customerStorageDir: ".data/customer-documents",
			}),
		).toThrow(DemoGuardError);
	});
	it("checks roots only in demo mode", () => {
		expect(() =>
			assertDemoBoot({
				demoMode: true,
				nodeEnv: "development",
				demoResetAllowed: false,
				documentStorageDir: "/srv/docs",
				customerStorageDir: ".data/customer-documents",
			}),
		).toThrow(DemoGuardError);
		expect(() =>
			assertDemoBoot({
				demoMode: false,
				nodeEnv: "development",
				demoResetAllowed: false,
				documentStorageDir: "/srv/docs",
				customerStorageDir: "/srv/customer",
			}),
		).not.toThrow();
	});
	it("rejects equal or nested roots in every environment", () => {
		for (const nodeEnv of ["development", "test", "production"]) {
			for (const demoMode of [true, false]) {
				expect(() =>
					assertDemoBoot({
						demoMode,
						nodeEnv,
						demoResetAllowed: false,
						documentStorageDir: ".data/documents",
						customerStorageDir: ".data/documents",
					}),
				).toThrow(DemoGuardError);
				expect(() =>
					assertDemoBoot({
						demoMode,
						nodeEnv,
						demoResetAllowed: false,
						documentStorageDir: ".data/documents",
						customerStorageDir: ".data/documents/archive",
					}),
				).toThrow(DemoGuardError);
			}
		}
	});
	it("rejects cross-wired demo roots (each root has its own allowlist)", () => {
		expect(() =>
			assertDemoBoot({
				demoMode: true,
				nodeEnv: "development",
				demoResetAllowed: false,
				documentStorageDir: ".data/customer-documents",
				customerStorageDir: ".data/documents",
			}),
		).toThrow(DemoGuardError);
		expect(() =>
			assertDemoBoot({
				demoMode: true,
				nodeEnv: "development",
				demoResetAllowed: false,
				documentStorageDir: ".data/documents",
				customerStorageDir: ".data/customer-documents",
			}),
		).not.toThrow();
		expect(isDemoDocumentRoot(".data/documents")).toBe(true);
		expect(isDemoDocumentRoot(".data/customer-documents")).toBe(false);
		expect(isDemoCustomerRoot(".data/customer-documents")).toBe(true);
		expect(isDemoCustomerRoot(".data/documents")).toBe(false);
		expect(() =>
			assertDemoDocumentRoot(".data/customer-documents", "DOCUMENT_STORAGE_DIR"),
		).toThrow(DemoGuardError);
		expect(() => assertDemoCustomerRoot(".data/documents", "CUSTOMER_STORAGE_DIR")).toThrow(
			DemoGuardError,
		);
		expect(() => assertStorageRootsDisjoint(".data/documents", ".data/documents")).toThrow(
			DemoGuardError,
		);
	});
});

describe("assertDemoResetAllowed", () => {
	it("needs demo mode, non-prod, the allow flag, and --yes", () => {
		const base = {
			demoMode: true,
			nodeEnv: "development",
			demoResetAllowed: true,
			confirmed: true,
		};
		expect(() => assertDemoResetAllowed(base)).not.toThrow();
		expect(() => assertDemoResetAllowed({ ...base, confirmed: false })).toThrow(DemoGuardError);
		expect(() => assertDemoResetAllowed({ ...base, demoResetAllowed: false })).toThrow(
			DemoGuardError,
		);
		expect(() => assertDemoResetAllowed({ ...base, nodeEnv: "production" })).toThrow(
			DemoGuardError,
		);
	});
	it("only allowlisted volumes are resettable (node_modules and blob bind-mounts never)", () => {
		for (const volume of ["pgdata", "kafka-data"]) {
			expect(() => assertDemoVolume(volume)).not.toThrow();
		}
		for (const volume of [
			"svc-node-modules",
			"documents",
			"customer-documents",
			"pgdata_prod",
			"",
		]) {
			expect(() => assertDemoVolume(volume)).toThrow(DemoGuardError);
		}
	});
});

describe("resolveWorkspacePath", () => {
	it("anchors relative roots at the workspace root, not the cwd", () => {
		const resolved = resolveWorkspacePath(".data/customer-documents");
		expect(isAbsolute(resolved)).toBe(true);
		expect(resolved.endsWith(`${sep}.data${sep}customer-documents`)).toBe(true);
		expect(isDemoStorageRoot(resolved)).toBe(true);
	});
	it("passes absolute roots through untouched", () => {
		expect(resolveWorkspacePath("/data/documents")).toBe("/data/documents");
	});
});
