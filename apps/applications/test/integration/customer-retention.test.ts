// D2a customer retention (real Postgres, temp storage roots): expiry
// tombstones pages/blob/row (row kept, never hard-deleted), legal holds
// block the sweep, referenced rows survive, the throwing deleter leaves a
// retry marker, and the joint maintenance run keeps the T01 app sweep and
// the customer sweep on their own roots.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@credit/db";
import {
	customerDocumentPages,
	customerDocuments,
	customerProfiles,
	documentFiles,
} from "@credit/db/applications";
import { createLogger } from "@credit/service-kit";
import { stubGateway } from "@credit/service-kit/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import {
	createCustomerDocument,
	openCustomerDocument,
	reuseCustomerDocuments,
	type CustomerConfig,
} from "../../src/customer/service.js";
import {
	createCustomerLegalHold,
	customerRetentionBlockedBy,
	releaseCustomerLegalHold,
	runCustomerRetention,
} from "../../src/customer/retention.js";
import { configFromEnv } from "../../src/documents/service.js";
import { openAndVerifyBlob } from "../../src/documents/storage.js";
import { runDocumentMaintenanceOnce } from "../../src/documents/retention.js";
import { loadEnv } from "../../src/env.js";
import { createUser, type TestContext } from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const DEMO_AS_OF = new Date("2026-06-30T00:00:00Z");

interface RetentionContext extends TestContext {
	customerConfig: CustomerConfig;
	appDir: string;
	customerDir: string;
}

let ctx: RetentionContext;

async function seedProfile(userId: string) {
	const [profile] = await ctx.db
		.insert(customerProfiles)
		.values({
			userId,
			segment: "individual",
			customerSince: "2020-01-15",
			kycStatus: "verified",
			kycVerifiedAt: new Date("2025-01-01T00:00:00Z"),
			kycExpiresAt: new Date("2028-01-01T00:00:00Z"),
			identity: { fullName: "Retention Case" },
			source: "customer_master",
		})
		.returning();
	return profile;
}

async function seedDoc(
	customerId: string,
	kind = "bank_statement",
	periodEnd: string | null = "2026-05-31",
) {
	return createCustomerDocument(ctx.db, ctx.customerConfig, {
		customerId,
		kind,
		bytes: Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(64)]),
		mimeType: "application/pdf",
		documentDate: periodEnd,
		periodEnd,
		pages: [{ text: "retention-page", source: "pdf_text", confidence: 0.99 }],
		asOf: DEMO_AS_OF,
	});
}

async function expireDoc(docId: string) {
	await ctx.db
		.update(customerDocuments)
		.set({ retentionUntil: new Date("2020-01-01T00:00:00Z") })
		.where(eq(customerDocuments.id, docId));
}

beforeAll(async () => {
	const appDir = await mkdtemp(join(tmpdir(), "d2a-ret-app-"));
	const customerDir = await mkdtemp(join(tmpdir(), "d2a-ret-cust-"));
	const env = loadEnv();
	const { db, sql } = createDb(env.databaseUrl);
	const config = {
		...configFromEnv(env),
		featureEnabled: true,
		storageDir: appDir,
		encryptionKey: ENCRYPTION_KEY,
		keyId: "v1",
	};
	const customerConfig: CustomerConfig = {
		storageDir: customerDir,
		encryptionKey: ENCRYPTION_KEY,
		keyId: "v1",
		previousKeys: undefined,
		retentionDays: 90,
		lockTimeoutMs: 5000,
	};
	const app = createApp({
		db,
		sql,
		env,
		gateway: stubGateway(),
		logger: createLogger("applications-retention-test"),
		documents: { config },
		customer: { config: customerConfig, demoMode: true, demoAsOf: DEMO_AS_OF },
	});
	ctx = {
		app,
		db,
		sql,
		gateway: stubGateway(),
		secret: env.internalSecret,
		customerConfig,
		appDir,
		customerDir,
	};
});

afterAll(async () => {
	await ctx.sql.end();
	await rm(ctx.appDir, { recursive: true, force: true });
	await rm(ctx.customerDir, { recursive: true, force: true });
});

describe("customerRetentionBlockedBy", () => {
	it("is blocked by a customer-wide hold or its own document hold", () => {
		expect(customerRetentionBlockedBy([], "d1")).toBe(false);
		expect(customerRetentionBlockedBy([{ customerDocumentId: null }], "d1")).toBe(true);
		expect(customerRetentionBlockedBy([{ customerDocumentId: "d1" }], "d1")).toBe(true);
		expect(customerRetentionBlockedBy([{ customerDocumentId: "d2" }], "d1")).toBe(false);
	});
});

describe("runCustomerRetention", () => {
	it("tombstones expired rows but keeps the row (never hard-deletes)", async () => {
		const user = await createUser(ctx);
		const profile = await seedProfile(user.id);
		const doc = await seedDoc(profile.id);
		await expireDoc(doc.id);

		const result = await runCustomerRetention({
			db: ctx.db,
			lockTimeoutMs: 5000,
			storageDir: ctx.customerDir,
			customerId: profile.id,
		});
		expect(result.deletedDocuments).toBe(1);

		const [row] = await ctx.db
			.select()
			.from(customerDocuments)
			.where(eq(customerDocuments.id, doc.id));
		expect(row.status).toBe("deleted");
		expect(row.originalFilename).toBeNull();
		expect(row.blobPurgedAt).not.toBeNull();
		const pages = await ctx.db
			.select()
			.from(customerDocumentPages)
			.where(eq(customerDocumentPages.customerDocumentId, doc.id));
		expect(pages).toEqual([]);
		await expect(openCustomerDocument(ctx.customerConfig, row)).rejects.toThrow();
	});

	it("skips held documents until the hold is released", async () => {
		const user = await createUser(ctx);
		const profile = await seedProfile(user.id);
		const doc = await seedDoc(profile.id);
		await expireDoc(doc.id);

		const hold = await createCustomerLegalHold(ctx.db, {
			customerId: profile.id,
			customerDocumentId: doc.id,
			reason: "officer review",
			createdBy: user.id,
			lockTimeoutMs: 5000,
		});
		expect(hold.releasedAt).toBeNull();
		const blocked = await runCustomerRetention({
			db: ctx.db,
			lockTimeoutMs: 5000,
			storageDir: ctx.customerDir,
			customerId: profile.id,
		});
		expect(blocked.skippedHolds).toBe(1);
		const [held] = await ctx.db
			.select()
			.from(customerDocuments)
			.where(eq(customerDocuments.id, doc.id));
		expect(held.status).toBe("ready");

		const released = await releaseCustomerLegalHold(ctx.db, {
			customerId: profile.id,
			holdId: hold.id,
			actor: user.id,
			lockTimeoutMs: 5000,
		});
		expect(released.releasedAt).not.toBeNull();
		const swept = await runCustomerRetention({
			db: ctx.db,
			lockTimeoutMs: 5000,
			storageDir: ctx.customerDir,
			customerId: profile.id,
		});
		expect(swept.deletedDocuments).toBe(1);
	});

	it("keeps referenced rows while purging only the customer blob", async () => {
		const user = await createUser(ctx);
		const profile = await seedProfile(user.id);
		const doc = await seedDoc(profile.id);
		// An application reusing this evidence (draft + consent via SQL).
		const appId = randomUUID();
		const { applications } = await import("@credit/db/applications");
		await ctx.db.insert(applications).values({
			id: appId,
			reference: `REF-${randomUUID().slice(0, 8)}`,
			applicantUserId: user.id,
			type: "individual",
			product: "personal_loan",
			status: "draft",
			amountCents: 1200000,
			termMonths: 48,
			purpose: "retention test",
			identity: {},
			consents: [true, true, true],
			documentProcessingConsent: true,
			submittedAt: null,
		});
		const outcome = await reuseCustomerDocuments(
			ctx.db,
			{
				storageDir: ctx.appDir,
				encryptionKey: ENCRYPTION_KEY,
				keyId: "v1",
				previousKeys: undefined,
				lockTimeoutMs: 5000,
			},
			ctx.customerConfig,
			{
				applicationId: appId,
				userId: user.id,
				customerDocumentIds: [doc.id],
				asOf: DEMO_AS_OF,
				appRetentionDays: 90,
			},
		);
		expect(outcome.files).toHaveLength(1);

		await expireDoc(doc.id);
		await runCustomerRetention({
			db: ctx.db,
			lockTimeoutMs: 5000,
			storageDir: ctx.customerDir,
			customerId: profile.id,
		});
		const [row] = await ctx.db
			.select()
			.from(customerDocuments)
			.where(eq(customerDocuments.id, doc.id));
		expect(row).toBeDefined();
		expect(row.status).toBe("deleted");
		// The app copy is independent: still ready with its own blob.
		const copies = await ctx.db
			.select()
			.from(documentFiles)
			.where(eq(documentFiles.applicationId, appId));
		expect(copies).toHaveLength(1);
		expect(copies[0].status).toBe("ready");
		// The sweep purged only the customer blob: the reused app copy still
		// exists under the app root and decrypts (hash-verified).
		const appPlaintext = await openAndVerifyBlob({
			root: ctx.appDir,
			storageKey: copies[0].storageKey as string,
			nonceB64: copies[0].encryptionNonce as string,
			tagB64: copies[0].encryptionTag as string,
			fileId: copies[0].id,
			applicationId: appId,
			cryptoVersion: copies[0].cryptoVersion,
			keyId: copies[0].keyId,
			keys: new Map([["v1", Buffer.from(ENCRYPTION_KEY, "base64")]]),
			expectedSha256: copies[0].sha256,
		});
		expect(appPlaintext.length).toBeGreaterThan(0);
	});

	it("leaves a retry marker when the blob purge fails", async () => {
		const user = await createUser(ctx);
		const profile = await seedProfile(user.id);
		const doc = await seedDoc(profile.id);
		await expireDoc(doc.id);
		const result = await runCustomerRetention({
			db: ctx.db,
			lockTimeoutMs: 5000,
			storageDir: ctx.customerDir,
			customerId: profile.id,
			deleteBlobFn: async () => {
				throw new Error("disk gone");
			},
		});
		expect(result.deletedDocuments).toBe(1);
		expect(result.blobsPending).toBe(1);
		const [row] = await ctx.db
			.select()
			.from(customerDocuments)
			.where(eq(customerDocuments.id, doc.id));
		expect(row.status).toBe("deleted");
		expect(row.blobPurgedAt).toBeNull();
	});

	it("clocks fixture rows on DEMO_AS_OF, live rows on the wall clock", async () => {
		const user = await createUser(ctx);
		const profile = await seedProfile(user.id);
		// Fixture-owned row, fresh on the fixture clock but long expired on
		// the wall clock (seed stamps asOf + retention days).
		const fixtureFresh = await seedDoc(profile.id);
		await ctx.db
			.update(customerDocuments)
			.set({
				source: "demo_seed",
				retentionUntil: new Date(DEMO_AS_OF.getTime() + 90 * 86_400_000),
			})
			.where(eq(customerDocuments.id, fixtureFresh.id));
		// Fixture-owned row, expired even on the fixture clock.
		const fixtureExpired = await seedDoc(profile.id);
		await ctx.db
			.update(customerDocuments)
			.set({ source: "demo_seed", retentionUntil: new Date("2020-01-01T00:00:00Z") })
			.where(eq(customerDocuments.id, fixtureExpired.id));
		// Live row, expired on the wall clock.
		const liveExpired = await seedDoc(profile.id);
		await expireDoc(liveExpired.id);

		const result = await runCustomerRetention({
			db: ctx.db,
			lockTimeoutMs: 5000,
			storageDir: ctx.customerDir,
			customerId: profile.id,
			demoAsOf: DEMO_AS_OF,
		});
		expect(result.deletedDocuments).toBe(2);
		const rows = await ctx.db
			.select()
			.from(customerDocuments)
			.where(eq(customerDocuments.customerId, profile.id));
		const statusOf = (id: string) => rows.find((r) => r.id === id)?.status;
		expect(statusOf(fixtureFresh.id)).toBe("ready");
		expect(statusOf(fixtureExpired.id)).toBe("deleted");
		expect(statusOf(liveExpired.id)).toBe("deleted");
		await expect(
			openCustomerDocument(
				ctx.customerConfig,
				rows.find((r) => r.id === fixtureFresh.id)!,
			),
		).resolves.toBeDefined();
	});

	it("joint maintenance keeps each sweep on its own root", async () => {
		const user = await createUser(ctx);
		const profile = await seedProfile(user.id);
		const customerDoc = await seedDoc(profile.id);
		await expireDoc(customerDoc.id);
		const result = await runDocumentMaintenanceOnce({
			db: ctx.db,
			lockTimeoutMs: 5000,
			storageDir: ctx.appDir,
			uploadDeadlineMs: 1000,
			storageConfigured: true,
			customerStorageDir: ctx.customerDir,
		});
		expect(result.customer).not.toBeNull();
		expect(result.customer?.deletedDocuments).toBeGreaterThanOrEqual(1);
		// The app orphan sweep scanned the app root only: the customer row
		// is gone by tombstone, not by the app sweep (row still present).
		const [row] = await ctx.db
			.select()
			.from(customerDocuments)
			.where(eq(customerDocuments.id, customerDoc.id));
		expect(row.status).toBe("deleted");
	});
});
