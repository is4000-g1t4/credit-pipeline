// UBS §1/§2 integration (real Postgres): queue item additions + summary
// and decisionsToday. Rows accumulate harmlessly like the other suites;
// seeds use year-2000 submittedAt so they sort into the 100-item window.
import { randomUUID } from "node:crypto";
import { applications, decisions, policyEvaluations, scores } from "@credit/db/applications";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, setupApp, signed, teardown, type TestContext } from "../helper.js";

let ctx: TestContext;

beforeAll(() => {
	ctx = setupApp();
});

afterAll(async () => {
	await teardown(ctx);
});

async function seedPending(over: Partial<typeof applications.$inferSelect> = {}): Promise<string> {
	const [row] = await ctx.db
		.insert(applications)
		.values({
			reference: `Q-${randomUUID()}`,
			applicantUserId: randomUUID(),
			type: "individual",
			product: "personal_loan",
			status: "pending_review",
			amountCents: 1_200_000,
			termMonths: 48,
			purpose: "queue seed",
			identity: { fullName: "Queue Seed" },
			consents: [true, true, true],
			submittedAt: new Date("2000-01-01T00:00:00Z"),
			...over,
		})
		.returning({ id: applications.id });
	return row.id;
}

describe("GET /internal/review/queue", () => {
	it("adds client fields, risk, flags and a coherent summary; no fraud fields", async () => {
		const officer = await createUser(ctx, "officer");
		const smeId = await seedPending({
			type: "sme",
			product: "sme_term_loan",
			amountCents: 6_000_000,
			termMonths: 60,
			identity: { fullName: "Queue Owner", city: "Singapore" },
			business: { companyName: "Queue Seed Co" },
		});
		const individualId = await seedPending({
			identity: { fullName: "Queue Seed Applicant", city: "Kuala Lumpur" },
		});
		await ctx.db.insert(scores).values({
			applicationId: smeId,
			modelVersion: "scorecard-v1",
			score: 800,
			grade: "A",
			factors: [
				{ code: "SECTOR_RISK", points: -40 },
				{ code: "REVENUE_SCALE", points: 75 },
			],
			affordability: {},
		});
		await ctx.db.insert(policyEvaluations).values({
			applicationId: smeId,
			policyVersion: "policy-v1.0",
			outcome: "refer",
			reasons: [{ code: "AMOUNT_ABOVE_AUTO_LIMIT", text: "above auto limit" }],
			maxAmountCents: 6_000_000,
			inputs: {},
			inputHash: "queue-seed",
		});

		const path = "/internal/review/queue";
		const res = await ctx.app.request(path, { headers: signed(ctx, officer, "GET", path) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: Array<Record<string, unknown>>;
			summary: Record<string, unknown>;
		};
		const byId = new Map(body.items.map((i) => [i["id"], i]));
		const sme = byId.get(smeId);
		const individual = byId.get(individualId);
		expect(sme).toBeDefined();
		expect(individual).toBeDefined();

		// Existing fields unchanged.
		for (const item of [sme!, individual!]) {
			for (const k of [
				"id",
				"reference",
				"type",
				"product",
				"amountCents",
				"termMonths",
				"submittedAt",
				"waitMs",
				"score",
				"grade",
				"reasons",
				"topReasons",
			]) {
				expect(item).toHaveProperty(k);
			}
			// No fraud disclosure on the shared queue.
			expect(Object.keys(item).filter((k) => k.toLowerCase().includes("fraud"))).toEqual([]);
		}

		expect(sme!["clientName"]).toBe("Queue Seed Co");
		expect(sme!["city"]).toBe("Singapore");
		expect(sme!["risk"]).toBe("low");
		expect(sme!["flags"]).toEqual({ referred: true, aboveAutoLimit: true });
		expect(sme!["reasons"]).toContain("AMOUNT_ABOVE_AUTO_LIMIT");
		expect(sme!["topReasons"]).toEqual(["REVENUE_SCALE", "SECTOR_RISK"]);

		expect(individual!["clientName"]).toBe("Queue Seed Applicant");
		expect(individual!["city"]).toBe("Kuala Lumpur");
		expect(individual!["score"]).toBeNull();
		expect(individual!["risk"]).toBe("medium");
		expect(individual!["flags"]).toEqual({ referred: false, aboveAutoLimit: false });

		// Summary invariants (scoped to returned items; the dev DB is shared).
		const s = body.summary;
		expect(s["shown"]).toBe(body.items.length);
		expect(s["truncated"]).toBe((s["total"] as number) > (s["shown"] as number));
		expect(s["oldestCaseId"]).toBe(body.items[0]?.["id"] ?? null);
		expect(s["referredCount"] as number).toBeGreaterThanOrEqual(1);
		expect(s["over24hCount"] as number).toBeGreaterThanOrEqual(2);
		if (body.items.length < 100) expect(s["total"]).toBe(body.items.length);
	});
});

describe("GET /internal/stats decisionsToday", () => {
	it("counts decision rows in the current SGT day only", async () => {
		const officer = await createUser(ctx, "officer");
		const path = "/internal/stats";
		const readStats = async (): Promise<{ decisionsToday: number }> => {
			const res = await ctx.app.request(path, {
				headers: signed(ctx, officer, "GET", path),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				decisionsToday: number;
				decidedApplications: number;
			};
			expect(body).toHaveProperty("decidedApplications");
			return body as { decisionsToday: number };
		};
		const before = await readStats();

		const appNow = await seedPending({ status: "booked" });
		const appOld = await seedPending({ status: "declined" });
		await ctx.db.insert(decisions).values({
			applicationId: appNow,
			outcome: "approved",
			decidedBy: "officer",
			reasons: [],
			snapshot: {},
		});
		await ctx.db.insert(decisions).values({
			applicationId: appOld,
			outcome: "declined",
			decidedBy: "officer",
			reasons: [],
			snapshot: {},
			createdAt: new Date(Date.now() - 3 * 86_400_000),
		});

		const after = await readStats();
		expect(after.decisionsToday).toBe(before.decisionsToday + 1);
	});
});
