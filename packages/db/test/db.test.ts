// @credit/db tests: scrypt round-trip, per-service schema surfaces, and the
// database-per-service boundary (no cross-service table imports).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/password.js";
import * as applicationsSchema from "../src/applications.js";
import * as authSchema from "../src/auth.js";
import * as loansSchema from "../src/loans.js";
import * as portfolioSchema from "../src/portfolio.js";
import * as root from "../src/index.js";

describe("password", () => {
	it("hashes with per-user salt and verifies", async () => {
		const a = await hashPassword("demo1234");
		const b = await hashPassword("demo1234");
		expect(a).not.toBe(b); // distinct salts
		expect(a).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
		expect(await verifyPassword("demo1234", a)).toBe(true);
		expect(await verifyPassword("demo1234", b)).toBe(true);
		expect(await verifyPassword("wrong", a)).toBe(false);
	});

	it("rejects malformed stored hashes without throwing", async () => {
		expect(await verifyPassword("demo1234", "")).toBe(false);
		expect(await verifyPassword("demo1234", "not-a-hash")).toBe(false);
		expect(await verifyPassword("demo1234", "scrypt$1$2")).toBe(false);
	});
});

describe("schema", () => {
	it("auth owns users only", () => {
		expect(authSchema.users).toBeDefined();
	});

	it("applications owns the pipeline tables + shared outbox/audit", () => {
		for (const table of [
			applicationsSchema.applications,
			applicationsSchema.kycChecks,
			applicationsSchema.externalReports,
			applicationsSchema.documents,
			applicationsSchema.scores,
			applicationsSchema.policyEvaluations,
			applicationsSchema.decisions,
			applicationsSchema.idempotencyKeys,
			applicationsSchema.auditLog,
			applicationsSchema.outboxEvents,
		]) {
			expect(table).toBeDefined();
		}
	});

	it("loans owns the ledger tables (denormalised) + shared outbox/audit", () => {
		for (const table of [
			loansSchema.loans,
			loansSchema.installments,
			loansSchema.payments,
			loansSchema.ewsAlerts,
			loansSchema.auditLog,
			loansSchema.outboxEvents,
		]) {
			expect(table).toBeDefined();
		}
	});

	it("loans carry the denormalised application columns", () => {
		const shape = loansSchema.loans as unknown as Record<string, unknown>;
		for (const column of ["applicationReference", "applicantUserId", "product"]) {
			expect(shape[column], column).toBeDefined();
		}
	});

	it("portfolio owns the read model only", () => {
		for (const table of [
			portfolioSchema.processedEvents,
			portfolioSchema.activityFeed,
			portfolioSchema.deadLetterEvents,
		]) {
			expect(table).toBeDefined();
		}
	});

	it("the package root exports no tables", () => {
		for (const key of Object.keys(root)) {
			expect(key.toLowerCase()).not.toMatch(
				/users|applications|loans|scores|decisions|feed|outbox|audit/,
			);
		}
		expect(root.createDb).toBeDefined();
		expect(root.withTx).toBeDefined();
		expect(root.hashPassword).toBeDefined();
	});
});

describe("data ownership", () => {
	const services = ["gateway", "applications", "review", "loans", "portfolio", "worker"] as const;
	// Which @credit/db subpaths each app may import (bare "@credit/db" =
	// client/password only). Review is stateless (no db imports at all).
	const allowed: Record<(typeof services)[number], string[]> = {
		gateway: ["@credit/db", "@credit/db/auth"],
		applications: ["@credit/db", "@credit/db/applications", "@credit/db/shared"],
		review: [],
		loans: ["@credit/db", "@credit/db/loans", "@credit/db/shared"],
		portfolio: ["@credit/db", "@credit/db/portfolio"],
		worker: ["@credit/db", "@credit/db/applications", "@credit/db/loans", "@credit/db/shared"],
	};

	function tsFiles(dir: string): string[] {
		const out: string[] = [];
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				if (entry === "node_modules") continue;
				out.push(...tsFiles(full));
			} else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
				out.push(full);
			}
		}
		return out;
	}

	it("no service imports another domain's tables", () => {
		const violations: string[] = [];
		const testDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "apps");
		for (const svc of services) {
			const dir = join(testDir, svc, "src");
			for (const file of tsFiles(dir)) {
				const text = readFileSync(file, "utf8");
				for (const match of text.matchAll(/from\s+["'](@credit\/db(?:\/[a-z]+)?)["']/g)) {
					if (!allowed[svc].includes(match[1])) {
						violations.push(`${relative(process.cwd(), file)}: ${match[1]}`);
					}
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
