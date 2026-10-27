import { reportingDay } from "@credit/core";
import { HttpError, type ServiceVariables } from "@credit/service-kit";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createPolicyRoutes } from "../src/routes.js";
import type { ApprovedPolicyDocument, PolicyDeps, PolicyStore } from "../src/store.js";
import { appWithUser, baseDeps } from "./helper.js";

const officer = {
	id: "44444444-4444-4444-8444-444444444444",
	email: "officer@example.com",
	role: "officer" as const,
};
const applicant = {
	id: "55555555-5555-4555-8555-555555555555",
	email: "applicant@example.com",
	role: "applicant" as const,
};

function addDays(date: string, n: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

const asOf = reportingDay(new Date());

interface Fixture {
	rows: ApprovedPolicyDocument[];
	restrictedPolicyId: string;
	supersededVersionId: string;
	futureVersionId: string;
}

function fixture(): Fixture {
	const p1 = "11111111-1111-4111-8111-111111111111";
	const p2 = "22222222-2222-4222-8222-222222222222";
	const p3 = "33333333-3333-4333-8333-333333333333";
	const p4 = "44444444-4444-4444-8444-444444444444";
	const p5 = "55555555-5555-4555-8555-555555555555";
	const v1old = "a1a1a1a1-1111-4111-8111-111111111111";
	const v2now = "a2a2a2a2-2222-4222-8222-222222222222";
	const v3future = "a3a3a3a3-3333-4333-8333-333333333333";
	return {
		rows: [
			// Scrambled on purpose: the fake must return policyKey order.
			{
				policyId: p5,
				policyKey: "POL-CR-009",
				title: "Decision Engine Standard",
				version: "v1",
				versionId: "e9e9e9e9-9999-4999-8999-999999999999",
				effectiveFrom: "2026-01-01",
				effectiveTo: null,
				productScope: "all",
				jurisdiction: "SG",
				sectionCount: 6,
			},
			{
				policyId: p1,
				policyKey: "POL-CR-001",
				title: "SME Underwriting Standard",
				version: "v1",
				versionId: v1old,
				effectiveFrom: "2026-01-01",
				effectiveTo: addDays(asOf, -1),
				productScope: "sme",
				jurisdiction: "SG",
				sectionCount: 3,
			},
			{
				policyId: p3,
				policyKey: "POL-CR-003",
				title: "Future Policy",
				version: "v1",
				versionId: "c3c3c3c3-3333-4333-8333-333333333333",
				effectiveFrom: addDays(asOf, 1),
				effectiveTo: null,
				productScope: "sme",
				jurisdiction: "SG",
				sectionCount: 1,
			},
			{
				policyId: p1,
				policyKey: "POL-CR-001",
				title: "SME Underwriting Standard",
				version: "v2",
				versionId: v2now,
				effectiveFrom: asOf,
				effectiveTo: null,
				productScope: "sme",
				jurisdiction: "SG",
				sectionCount: 4,
			},
			{
				policyId: p1,
				policyKey: "POL-CR-001",
				title: "SME Underwriting Standard",
				version: "v3",
				versionId: v3future,
				effectiveFrom: addDays(asOf, 1),
				effectiveTo: null,
				productScope: "sme",
				jurisdiction: "SG",
				sectionCount: 5,
			},
			{
				policyId: p2,
				policyKey: "POL-CR-002",
				title: "Affordability",
				version: "v1",
				versionId: "b2b2b2b2-2222-4222-8222-222222222222",
				effectiveFrom: "2026-01-01",
				effectiveTo: null,
				productScope: "individual",
				jurisdiction: "SG",
				sectionCount: 2,
			},
			{
				policyId: p4,
				policyKey: "POL-CR-004",
				title: "Restricted Policy",
				version: "v1",
				versionId: "d4d4d4d4-4444-4444-8444-444444444444",
				effectiveFrom: "2026-01-01",
				effectiveTo: null,
				productScope: "sme",
				jurisdiction: "SG",
				sectionCount: 7,
			},
		],
		restrictedPolicyId: p4,
		supersededVersionId: v1old,
		futureVersionId: v3future,
	};
}

/** In-memory fake implementing the register contract: effective-window
 * filter, newest-effective version wins (version DESC tiebreak), ordered by
 * policyKey — mirrors the postgres DISTINCT ON query. */
function registerDeps(fix: Fixture, env: Record<string, unknown> = {}): PolicyDeps {
	const seenAsOf: { value: string | null } = { value: null };
	const { deps } = baseDeps({
		store: {
			async listApprovedPolicyDocuments(queryAsOf: string) {
				seenAsOf.value = queryAsOf;
				const eligible = fix.rows.filter(
					(row) =>
						row.effectiveFrom <= queryAsOf &&
						(row.effectiveTo === null || row.effectiveTo >= queryAsOf),
				);
				const current = new Map<string, ApprovedPolicyDocument>();
				for (const row of eligible) {
					const prior = current.get(row.policyKey);
					if (
						!prior ||
						row.effectiveFrom > prior.effectiveFrom ||
						(row.effectiveFrom === prior.effectiveFrom && row.version > prior.version)
					) {
						current.set(row.policyKey, row);
					}
				}
				return [...current.values()].sort((a, b) => (a.policyKey < b.policyKey ? -1 : 1));
			},
			async loadAcls(policyIds: string[]) {
				return policyIds
					.filter((policyId) => policyId !== fix.restrictedPolicyId)
					.map((policyId) => ({
						policyId,
						principalType: "role" as const,
						principal: "officer",
						permission: "read" as const,
					}));
			},
		} satisfies Partial<PolicyStore>,
		env,
	});
	(deps as unknown as { seenAsOf: unknown }).seenAsOf = seenAsOf;
	return deps;
}

function bareApp(d: PolicyDeps): Hono<{ Variables: ServiceVariables }> {
	const app = new Hono<{ Variables: ServiceVariables }>();
	app.onError((err, c) =>
		err instanceof HttpError
			? c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
			: c.json({ error: { code: "INTERNAL_ERROR", message: "internal error" } }, 500),
	);
	app.route("/", createPolicyRoutes(d));
	return app;
}

describe("policy register", () => {
	it("lists only current approved readable documents, ordered", async () => {
		const fix = fixture();
		const d = registerDeps(fix);
		const res = await appWithUser(d, officer).request("/api/policy/register");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Array<Record<string, unknown>> };
		expect(body.items.map((item) => item.policyKey)).toEqual([
			"POL-CR-001",
			"POL-CR-002",
			"POL-CR-009",
		]);
		const sme = body.items[0]!;
		expect(sme).toEqual({
			policyKey: "POL-CR-001",
			title: "SME Underwriting Standard",
			version: "v2",
			versionId: "a2a2a2a2-2222-4222-8222-222222222222",
			effectiveFrom: asOf,
			effectiveTo: null,
			productScope: "sme",
			jurisdiction: "SG",
			sectionCount: 4,
		});
		// Superseded v1, future v3/v-tomorrow and the unreadable policy are absent.
		const versionIds = body.items.map((item) => item.versionId);
		expect(versionIds).not.toContain(fix.supersededVersionId);
		expect(versionIds).not.toContain(fix.futureVersionId);
		expect(body.items.map((item) => item.policyKey)).not.toContain("POL-CR-003");
		expect(body.items.map((item) => item.policyKey)).not.toContain("POL-CR-004");
		// Explicit allowlist: no policyId, owner, ACL, section bodies or quotes.
		const raw = JSON.stringify(body);
		expect(raw).not.toContain("policyId");
		expect(raw).not.toContain("permission");
		for (const item of body.items) {
			expect(Object.keys(item).sort()).toEqual(
				[
					"effectiveFrom",
					"effectiveTo",
					"jurisdiction",
					"policyKey",
					"productScope",
					"sectionCount",
					"title",
					"version",
					"versionId",
				].sort(),
			);
		}
	});

	it("passes the SGT reporting day as asOf: effective today included, tomorrow excluded", async () => {
		const fix = fixture();
		const d = registerDeps(fix);
		const res = await appWithUser(d, officer).request("/api/policy/register");
		expect(res.status).toBe(200);
		expect((d as unknown as { seenAsOf: { value: string } }).seenAsOf.value).toBe(asOf);
		const body = (await res.json()) as { items: Array<{ effectiveFrom: string }> };
		expect(body.items.some((item) => item.effectiveFrom === asOf)).toBe(true);
		expect(body.items.some((item) => item.effectiveFrom === addDays(asOf, 1))).toBe(false);
	});

	it("rejects applicants and unauthenticated callers", async () => {
		const d = registerDeps(fixture());
		expect((await appWithUser(d, applicant).request("/api/policy/register")).status).toBe(403);
		expect((await bareApp(d).request("/api/policy/register")).status).toBe(401);
	});

	it("is not gated by POLICY_ASSIST_ENABLED", async () => {
		const d = registerDeps(fixture(), { assistEnabled: false });
		const res = await appWithUser(d, officer).request("/api/policy/register");
		expect(res.status).toBe(200);
		expect(((await res.json()) as { items: unknown[] }).items.length).toBe(3);
	});
});
