// Draft update (§4): create-token shape, optimistic PATCH, consent-route
// guard, handler re-checks, confirmations replace, and submit fail-closed.
import { randomUUID } from "node:crypto";
import {
	applicationProfileConfirmations,
	applications,
	auditLog,
	customerProfiles,
	outboxEvents,
} from "@credit/db/applications";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createUser,
	individualPayload,
	postApplication,
	postSubmit,
	setupApp,
	signed,
	type TestContext,
	type TestUser,
} from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

let ctx: TestContext;

beforeAll(() => {
	ctx = setupApp();
});

afterAll(async () => {
	await ctx.sql.end();
});

async function postDraft(user: TestUser, payload: unknown, key: string): Promise<Response> {
	return postApplication(ctx, user, "/api/applications/drafts", payload, key);
}

async function patchDraft(user: TestUser, appId: string, body: unknown): Promise<Response> {
	const raw = JSON.stringify(body);
	const path = `/api/applications/${appId}/draft`;
	return ctx.app.request(path, {
		method: "PATCH",
		headers: {
			"content-type": "application/json",
			...signed(ctx, user, "PATCH", path, {}, raw),
		},
		body: raw,
	});
}

async function seedProfile(user: TestUser) {
	const payload = individualPayload(user.email);
	const [profile] = await ctx.db
		.insert(customerProfiles)
		.values({
			userId: user.id,
			segment: "individual",
			customerSince: "2020-01-15",
			kycStatus: "verified",
			kycVerifiedAt: new Date("2025-01-01T00:00:00Z"),
			kycExpiresAt: new Date("2028-01-01T00:00:00Z"),
			identity: payload.identity,
			source: "customer_master",
		})
		.returning();
	return { profile, payload };
}

async function outboxFor(appId: string): Promise<unknown[]> {
	const rows = await ctx.db.select().from(outboxEvents);
	return rows.filter((r) => {
		const payload = r.payload as { payload?: { applicationId?: string } };
		return payload?.payload?.applicationId === appId;
	});
}

describe("draft create token", () => {
	it("returns updatedAt and replays the same shape for the same key", async () => {
		const user = await createUser(ctx);
		const key = randomUUID();
		const payload = { ...individualPayload(user.email), documentProcessingConsent: true };
		const first = await postDraft(user, payload, key);
		expect(first.status).toBe(201);
		const created = (await first.json()) as { id: string; reference: string; updatedAt: string };
		expect(typeof created.updatedAt).toBe("string");
		expect(Number.isNaN(Date.parse(created.updatedAt))).toBe(false);

		const second = await postDraft(user, payload, key);
		expect(second.status).toBe(201);
		expect(await second.json()).toEqual(created);
	});
});

describe("draft PATCH", () => {
	it("updates fields and returns a newer token visible in detail and list", async () => {
		const user = await createUser(ctx);
		const payload = { ...individualPayload(user.email), documentProcessingConsent: true };
		const created = (await (await postDraft(user, payload, randomUUID())).json()) as {
			id: string;
			reference: string;
			updatedAt: string;
		};
		await new Promise((r) => setTimeout(r, 15));
		const next = {
			...individualPayload(user.email),
			documentProcessingConsent: true,
			amountCents: 1500000,
			purpose: "updated purpose",
		};
		const patched = await patchDraft(user, created.id, {
			expectedUpdatedAt: created.updatedAt,
			application: next,
		});
		expect(patched.status).toBe(200);
		const body = (await patched.json()) as { id: string; reference: string; updatedAt: string };
		expect(body.id).toBe(created.id);
		expect(body.reference).toBe(created.reference);
		expect(Date.parse(body.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));

		const detailPath = `/api/applications/${created.id}`;
		const detail = await ctx.app.request(detailPath, {
			headers: signed(ctx, user, "GET", detailPath),
		});
		expect(detail.status).toBe(200);
		const detailBody = (await detail.json()) as {
			application: { amountCents: number; purpose: string; updatedAt: string };
		};
		expect(detailBody.application.amountCents).toBe(1500000);
		expect(detailBody.application.purpose).toBe("updated purpose");
		expect(detailBody.application.updatedAt).toBe(body.updatedAt);

		const listed = (await (
			await ctx.app.request("/api/applications", {
				headers: signed(ctx, user, "GET", "/api/applications"),
			})
		).json()) as { items: Array<{ id: string; amountCents: number; updatedAt: string }> };
		const item = listed.items.find((i) => i.id === created.id);
		expect(item?.amountCents).toBe(1500000);
		expect(item?.updatedAt).toBe(body.updatedAt);
	});

	it("rejects a stale token with the current one, twice", async () => {
		const user = await createUser(ctx);
		const created = (await (
			await postDraft(user, individualPayload(user.email), randomUUID())
		).json()) as { id: string; updatedAt: string };
		await new Promise((r) => setTimeout(r, 15));
		const next = { ...individualPayload(user.email), purpose: "second purpose" };
		const ok = await patchDraft(user, created.id, {
			expectedUpdatedAt: created.updatedAt,
			application: next,
		});
		expect(ok.status).toBe(200);
		const current = ((await ok.json()) as { updatedAt: string }).updatedAt;

		for (let attempt = 0; attempt < 2; attempt++) {
			const stale = await patchDraft(user, created.id, {
				expectedUpdatedAt: created.updatedAt,
				application: { ...next, purpose: `stale try ${attempt}` },
			});
			expect(stale.status).toBe(409);
			const err = (await stale.json()) as {
				error: { code: string; fields: { updatedAt: string[] } };
			};
			expect(err.error.code).toBe("DRAFT_CONFLICT");
			expect(err.error.fields.updatedAt).toEqual([current]);
		}
	});

	it("preserves stored consents when the patch omits them", async () => {
		const user = await createUser(ctx);
		const created = (await (
			await postDraft(
				user,
				{ ...individualPayload(user.email), documentProcessingConsent: true },
				randomUUID(),
			)
		).json()) as { id: string; updatedAt: string };
		const patched = await patchDraft(user, created.id, {
			expectedUpdatedAt: created.updatedAt,
			application: { ...individualPayload(user.email), purpose: "consents untouched" },
		});
		expect(patched.status).toBe(200);
		const detailPath = `/api/applications/${created.id}`;
		const detailBody = (await (
			await ctx.app.request(detailPath, { headers: signed(ctx, user, "GET", detailPath) })
		).json()) as {
			application: { documentProcessingConsent: boolean; contextAnalysisConsent: boolean };
		};
		expect(detailBody.application.documentProcessingConsent).toBe(true);
		expect(detailBody.application.contextAnalysisConsent).toBe(false);
	});

	it("routes explicit consent changes away, equal values succeed", async () => {
		const user = await createUser(ctx);
		const created = (await (
			await postDraft(
				user,
				{ ...individualPayload(user.email), documentProcessingConsent: true },
				randomUUID(),
			)
		).json()) as { id: string; updatedAt: string };

		const docChange = await patchDraft(user, created.id, {
			expectedUpdatedAt: created.updatedAt,
			application: {
				...individualPayload(user.email),
				documentProcessingConsent: false,
			},
		});
		expect(docChange.status).toBe(409);
		expect(((await docChange.json()) as { error: { code: string } }).error.code).toBe(
			"CONSENT_ROUTE_REQUIRED",
		);

		const ctxChange = await patchDraft(user, created.id, {
			expectedUpdatedAt: created.updatedAt,
			application: { ...individualPayload(user.email), contextAnalysisConsent: true },
		});
		expect(ctxChange.status).toBe(409);
		expect(((await ctxChange.json()) as { error: { code: string } }).error.code).toBe(
			"CONSENT_ROUTE_REQUIRED",
		);

		const same = await patchDraft(user, created.id, {
			expectedUpdatedAt: created.updatedAt,
			application: {
				...individualPayload(user.email),
				documentProcessingConsent: true,
				contextAnalysisConsent: false,
				purpose: "same consents ok",
			},
		});
		expect(same.status).toBe(200);
	});

	it("re-checks adult and email like create", async () => {
		const user = await createUser(ctx);
		const created = (await (
			await postDraft(user, individualPayload(user.email), randomUUID())
		).json()) as { id: string; updatedAt: string };

		const minor = await patchDraft(user, created.id, {
			expectedUpdatedAt: created.updatedAt,
			application: {
				...individualPayload(user.email),
				identity: {
					...(individualPayload(user.email).identity as Record<string, unknown>),
					dob: "2015-06-01",
				},
			},
		});
		expect(minor.status).toBe(400);
		const minorBody = (await minor.json()) as {
			error: { code: string; fields: Record<string, string[]> };
		};
		expect(minorBody.error.code).toBe("VALIDATION_ERROR");
		expect(minorBody.error.fields["identity.dob"]).toBeDefined();

		const foreign = await patchDraft(user, created.id, {
			expectedUpdatedAt: created.updatedAt,
			application: {
				...individualPayload(user.email),
				identity: {
					...(individualPayload(user.email).identity as Record<string, unknown>),
					email: "someone@else.com",
				},
			},
		});
		expect(foreign.status).toBe(400);
		const foreignBody = (await foreign.json()) as {
			error: { code: string; fields: Record<string, string[]> };
		};
		expect(foreignBody.error.code).toBe("VALIDATION_ERROR");
		expect(foreignBody.error.fields["identity.email"]).toBeDefined();
	});

	it("403s officers, 404s strangers, 409s non-drafts", async () => {
		const user = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const stranger = await createUser(ctx);
		const created = (await (
			await postDraft(user, individualPayload(user.email), randomUUID())
		).json()) as { id: string; updatedAt: string };
		const body = {
			expectedUpdatedAt: created.updatedAt,
			application: individualPayload(user.email),
		};
		const asOfficer = await patchDraft(officer, created.id, body);
		expect(asOfficer.status).toBe(403);
		expect(((await asOfficer.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");

		expect((await patchDraft(stranger, created.id, body)).status).toBe(404);
		expect((await patchDraft(user, randomUUID(), body)).status).toBe(404);

		await ctx.db
			.update(applications)
			.set({ status: "submitted", submittedAt: new Date() })
			.where(eq(applications.id, created.id));
		const submitted = await patchDraft(user, created.id, body);
		expect(submitted.status).toBe(409);
		expect(((await submitted.json()) as { error: { code: string } }).error.code).toBe("NOT_DRAFT");
	});

	it("422s unknown confirmation fields", async () => {
		const user = await createUser(ctx);
		const created = (await (
			await postDraft(user, individualPayload(user.email), randomUUID())
		).json()) as { id: string; updatedAt: string };
		const res = await patchDraft(user, created.id, {
			expectedUpdatedAt: created.updatedAt,
			application: {
				...individualPayload(user.email),
				profileConfirmations: [{ field: "identity.nickname", valueHash: "x" }],
			},
		});
		expect(res.status).toBe(422);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_FIELD");
	});

	it("leaves confirmations alone when absent, clears them on []", async () => {
		const user = await createUser(ctx);
		const { profile, payload } = await seedProfile(user);
		const created = (await (
			await postDraft(user, { ...payload, documentProcessingConsent: true }, randomUUID())
		).json()) as { id: string; updatedAt: string };
		await ctx.db.insert(applicationProfileConfirmations).values({
			applicationId: created.id,
			customerProfileId: profile.id,
			field: "identity.fullName",
			valueHash: "seeded",
		});
		const count = async (): Promise<number> =>
			(
				await ctx.db
					.select()
					.from(applicationProfileConfirmations)
					.where(eq(applicationProfileConfirmations.applicationId, created.id))
			).length;

		const untouched = await patchDraft(user, created.id, {
			expectedUpdatedAt: created.updatedAt,
			application: { ...(payload as Record<string, unknown>), purpose: "no confirmation edit" },
		});
		expect(untouched.status).toBe(200);
		expect(await count()).toBe(1);

		const cleared = await patchDraft(user, created.id, {
			expectedUpdatedAt: ((await untouched.json()) as { updatedAt: string }).updatedAt,
			application: {
				...(payload as Record<string, unknown>),
				profileConfirmations: [],
				purpose: "clear confirmations",
			},
		});
		expect(cleared.status).toBe(200);
		expect(await count()).toBe(0);
	});

	it("dedupes duplicate confirmation fields instead of 500ing", async () => {
		const user = await createUser(ctx);
		const { payload } = await seedProfile(user);
		const created = (await (
			await postDraft(user, payload as Record<string, unknown>, randomUUID())
		).json()) as { id: string; updatedAt: string };
		const res = await patchDraft(user, created.id, {
			expectedUpdatedAt: created.updatedAt,
			application: {
				...(payload as Record<string, unknown>),
				profileConfirmations: [
					{ field: "identity.fullName", valueHash: "a" },
					{ field: "identity.fullName", valueHash: "b" },
				],
			},
		});
		expect(res.status).toBe(200);
		const rows = await ctx.db
			.select()
			.from(applicationProfileConfirmations)
			.where(eq(applicationProfileConfirmations.applicationId, created.id));
		expect(rows.filter((r) => r.field === "identity.fullName")).toHaveLength(1);
	});

	it("starts no workflow and writes no outbox rows", async () => {
		const user = await createUser(ctx);
		const created = (await (
			await postDraft(user, individualPayload(user.email), randomUUID())
		).json()) as { id: string; reference: string; updatedAt: string };
		const patched = await patchDraft(user, created.id, {
			expectedUpdatedAt: created.updatedAt,
			application: {
				...individualPayload(user.email),
				purpose: "quiet update",
				aiResearchConsent: true,
			},
		});
		expect(patched.status).toBe(200);
		expect(ctx.gateway.started).not.toContain(created.id);
		expect(await outboxFor(created.id)).toEqual([]);
		const audits = await ctx.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.applicationId, created.id));
		expect(audits.map((a) => a.action)).toContain("application.draft_updated");
		const draftAudit = audits.find((a) => a.action === "application.draft_updated");
		expect(draftAudit?.payload).toMatchObject({
			aiResearchConsent: true,
			aiResearchConsentVersion: "ai-research-consent-v1",
		});
	});
});

describe("submit re-check", () => {
	it("fails closed on a corrupt email and stays a draft", async () => {
		const user = await createUser(ctx);
		const created = (await (
			await postDraft(user, individualPayload(user.email), randomUUID())
		).json()) as { id: string };
		const [row] = await ctx.db.select().from(applications).where(eq(applications.id, created.id));
		await ctx.db
			.update(applications)
			.set({
				identity: { ...(row.identity as Record<string, unknown>), email: "intruder@example.com" },
			})
			.where(eq(applications.id, created.id));

		const submitted = await postSubmit(ctx, user, created.id, randomUUID());
		expect(submitted.status).toBe(400);
		const err = (await submitted.json()) as {
			error: { code: string; fields: Record<string, string[]> };
		};
		expect(err.error.code).toBe("VALIDATION_ERROR");
		expect(err.error.fields["identity.email"]).toBeDefined();

		const [after] = await ctx.db.select().from(applications).where(eq(applications.id, created.id));
		expect(after.status).toBe("draft");
		expect(ctx.gateway.started).not.toContain(created.id);
	});
});
