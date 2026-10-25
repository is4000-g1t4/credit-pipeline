// D2a BreadTalk lifecycle (real Postgres, temp storage roots): seed →
// case → pre-refresh blockers → submit 409 → refresh (still blocked) →
// explicit reuse → ready → submit once (real endpoint) → post-submit.
// Plus alex/sparse phases, seed idempotency/drift convergence, and the
// touched-draft skip. Mirrors the demo:seed/case/refresh/submit/verify
// scripts through the same lib modules.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeApplicationSubmitted } from "@credit/core";
import {
	applicationProfileConfirmations,
	applications,
	customerAccounts,
	customerDocumentPages,
	customerDocuments,
	customerProfiles,
	customerTransactions,
	documentConsistencyCandidates,
	documentFieldCandidates,
	documentFiles,
	documentFingerprints,
	documentIntegrityRuns,
	documentDuplicateExplanations,
	documents,
	externalReports,
	fraudReviews,
	generatedArtifacts,
	idempotencyKeys,
	kycChecks,
	outboxEvents,
	policyEvaluations,
	scores,
} from "@credit/db/applications";
import { and, eq, inArray, like, notInArray, sql as drizzleSql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCustomerDocument, type CustomerConfig } from "../../src/customer/service.js";
import {
	ensureDemoCase,
	isFixtureDraftTouched,
	type AppDocConfig,
} from "../../../../scripts/lib/case.js";
import { memoryUserDirectory } from "../../../../scripts/lib/db-helpers.js";
import { loadManifest } from "../../../../scripts/lib/manifest.js";
import { refreshDemoEvidence } from "../../../../scripts/lib/refresh.js";
import { seedDemo } from "../../../../scripts/lib/seed.js";
import { verifyDemo } from "../../../../scripts/lib/verify.js";
import { setupApp, postApplication, type TestContext, type TestUser } from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const DEMO_AS_OF = new Date("2026-06-30T00:00:00Z");
const manifest = loadManifest();

interface DemoContext extends TestContext {
	customerConfig: CustomerConfig;
	appDocConfig: AppDocConfig;
}

let ctx: DemoContext;
let appDir: string;
let customerDir: string;
const users = memoryUserDirectory();

function setupDemo(): DemoContext {
	const customerConfig: CustomerConfig = {
		storageDir: (globalThis as { d2aCustomerDir?: string }).d2aCustomerDir ?? "",
		encryptionKey: ENCRYPTION_KEY,
		keyId: "v1",
		previousKeys: undefined,
		retentionDays: 90,
		lockTimeoutMs: 5000,
	};
	const ctx = setupApp({
		storageDir: (globalThis as { d2aAppDir?: string }).d2aAppDir ?? "",
		documents: {
			config: { featureEnabled: true, encryptionKey: ENCRYPTION_KEY, keyId: "v1" },
		},
		customer: { config: customerConfig, demoMode: true, demoAsOf: DEMO_AS_OF },
	});
	return {
		...ctx,
		customerConfig,
		appDocConfig: {
			storageDir: (globalThis as { d2aAppDir?: string }).d2aAppDir ?? "",
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			previousKeys: undefined,
			lockTimeoutMs: 5000,
			retentionDays: 90,
		},
	};
}

function applicant(email: string): TestUser {
	const id = (users.ids as Map<string, string>).get(email.toLowerCase());
	if (!id) throw new Error(`no demo user for ${email}`);
	return { id, email, role: "applicant" };
}

async function seedAll() {
	return seedDemo(manifest, { appDb: ctx.db, users, customerConfig: ctx.customerConfig });
}

// Scoped to fixture rows only: sibling suites insert random rows
// concurrently in the shared dev DB (see helper.ts convention).
async function fixtureCounts() {
	const userIds = Object.values(manifest.personas).map((p) =>
		(users.ids as Map<string, string>).get(p.email.toLowerCase()),
	);
	const profiles = await ctx.db.select().from(customerProfiles);
	const mine = profiles.filter((p) => userIds.includes(p.userId));
	const accounts = await ctx.db.select().from(customerAccounts);
	const mineAccounts = accounts.filter((a) => mine.some((p) => p.id === a.customerId));
	const txns = await ctx.db.select().from(customerTransactions);
	const mineTxns = txns.filter((t) => mineAccounts.some((a) => a.id === t.accountId));
	const docs = await ctx.db.select().from(customerDocuments);
	// Seed-managed rows only: fresh-evidence rows are refresh-owned (and
	// may be pinned by surviving e2e reuse copies), so they must not move
	// the seed idempotency pin.
	const seedKeys = new Set(
		Object.values(manifest.personas).flatMap((p) => p.evidence.map((e) => e.fixtureKey)),
	);
	const mineDocs = docs.filter(
		(d) => mine.some((p) => p.id === d.customerId) && d.fixtureKey && seedKeys.has(d.fixtureKey),
	);
	return {
		profiles: mine.length,
		accounts: mineAccounts.length,
		txns: mineTxns.length,
		docs: mineDocs.length,
	};
}

async function makeCase(personaKey: string) {
	return ensureDemoCase(manifest, personaKey, {
		appDb: ctx.db,
		users,
		customerConfig: ctx.customerConfig,
		appDocConfig: ctx.appDocConfig,
		confirmationKey: ctx.secret,
		demoMode: true,
		asOf: DEMO_AS_OF,
	});
}

async function expectVerify(
	personaKey: string,
	phase: "pre-refresh" | "post-refresh" | "post-attach" | "post-submit",
) {
	const { checks, failed } = await verifyDemo(manifest, personaKey, phase, {
		appDb: ctx.db,
		users,
		customerConfig: ctx.customerConfig,
		researchDb: null,
		asOf: DEMO_AS_OF,
	});
	if (failed > 0) {
		throw new Error(
			`${personaKey}/${phase} failed:\n${checks
				.filter((c) => !c.ok)
				.map((c) => `  ${c.name}: ${c.detail}`)
				.join("\n")}`,
		);
	}
	return checks;
}

async function postSubmit(user: TestUser, appId: string, key: string): Promise<Response> {
	return postApplication(ctx, user, `/api/applications/${appId}/submit`, {}, key);
}

async function postReuse(
	user: TestUser,
	appId: string,
	customerDocumentIds: string[],
): Promise<Response> {
	return postApplication(ctx, user, `/api/applications/${appId}/documents/reuse`, {
		customerDocumentIds,
	});
}

async function customerDocIds(email: string, fixtureKeys: string[]): Promise<string[]> {
	const profile = (
		await ctx.db
			.select()
			.from(customerProfiles)
			.where(eq(customerProfiles.userId, applicant(email).id))
	)[0];
	const docs = await ctx.db
		.select()
		.from(customerDocuments)
		.where(eq(customerDocuments.customerId, profile.id));
	return fixtureKeys.map((key) => {
		const doc = docs.find((d) => d.fixtureKey === key);
		if (!doc) throw new Error(`missing customer doc ${key}`);
		return doc.id;
	});
}

/** Full breadtalk lifecycle to submitted, converging whatever state earlier
 * tests (or a `-t` filter) left behind — this file passes standalone. */
async function ensureSubmittedBreadtalk(): Promise<string> {
	await seedAll();
	const outcome = await makeCase("breadtalk");
	const [row] = await ctx.db
		.select()
		.from(applications)
		.where(eq(applications.fixtureKey, "case-breadtalk"))
		.limit(1);
	if (row.status !== "submitted") {
		await refreshDemoEvidence(manifest, "breadtalk", {
			appDb: ctx.db,
			users,
			customerConfig: ctx.customerConfig,
			asOf: DEMO_AS_OF,
		});
		const user = applicant("breadtalk@example.com");
		const freshIds = await customerDocIds("breadtalk@example.com", [
			"bank_statement_fresh",
			"financial_statements_fresh",
		]);
		const reuse = await postReuse(user, outcome.draftId, freshIds);
		expect([200, 201]).toContain(reuse.status);
		const submitted = await postSubmit(user, outcome.draftId, randomUUID());
		expect(submitted.status).toBe(200);
	}
	return outcome.draftId;
}

beforeAll(async () => {
	appDir = await mkdtemp(join(tmpdir(), "d2a-app-"));
	customerDir = await mkdtemp(join(tmpdir(), "d2a-cust-"));
	(globalThis as { d2aAppDir?: string }).d2aAppDir = appDir;
	(globalThis as { d2aCustomerDir?: string }).d2aCustomerDir = customerDir;
	ctx = setupDemo();
	// Fixture keys/ids are deterministic, so a re-run meets the previous
	// run's rows: wipe fixture scope first (FK order, fixture keys only —
	// every other suite's random rows are untouched).
	await cleanupFixtures();
});

/** Delete every fixture-owned row so the suite is re-runnable. */
async function cleanupFixtures(): Promise<void> {
	const fixtureApps = await ctx.db
		.select({ id: applications.id })
		.from(applications)
		.where(like(applications.fixtureKey, "case-%"));
	const appIds = fixtureApps.map((a) => a.id);
	if (appIds.length > 0) {
		// Worker-written mock rows (a fixture app submitted through a live
		// worker carries documents/reports/scores) pin the app under
		// RESTRICT FKs: clear them first. Decided fixture apps are left to
		// fail loudly — terminal state is never silently wiped.
		await ctx.db.delete(documents).where(inArray(documents.applicationId, appIds));
		await ctx.db.delete(externalReports).where(inArray(externalReports.applicationId, appIds));
		await ctx.db.delete(scores).where(inArray(scores.applicationId, appIds));
		await ctx.db.delete(policyEvaluations).where(inArray(policyEvaluations.applicationId, appIds));
		await ctx.db.delete(kycChecks).where(inArray(kycChecks.applicationId, appIds));
		await ctx.db
			.delete(documentDuplicateExplanations)
			.where(inArray(documentDuplicateExplanations.applicationId, appIds));
		await ctx.db
			.delete(documentFieldCandidates)
			.where(inArray(documentFieldCandidates.applicationId, appIds));
		await ctx.db
			.delete(documentConsistencyCandidates)
			.where(inArray(documentConsistencyCandidates.applicationId, appIds));
		await ctx.db.delete(fraudReviews).where(inArray(fraudReviews.applicationId, appIds));
		await ctx.db
			.delete(documentIntegrityRuns)
			.where(inArray(documentIntegrityRuns.applicationId, appIds));
		await ctx.db
			.delete(generatedArtifacts)
			.where(inArray(generatedArtifacts.applicationId, appIds));
		await ctx.db
			.delete(documentFingerprints)
			.where(inArray(documentFingerprints.applicationId, appIds));
		await ctx.db.delete(documentFiles).where(inArray(documentFiles.applicationId, appIds));
		await ctx.db
			.delete(applicationProfileConfirmations)
			.where(inArray(applicationProfileConfirmations.applicationId, appIds));
		await ctx.db.delete(idempotencyKeys).where(inArray(idempotencyKeys.applicationId, appIds));
		await ctx.db
			.delete(outboxEvents)
			.where(inArray(outboxEvents.dedupeKey, appIds.map(dedupeApplicationSubmitted)));
		// audit_log is append-only (DB trigger rejects deletes): fixture
		// audit history accumulates harmlessly across re-runs.
		await ctx.db.delete(applications).where(inArray(applications.id, appIds));
	}
	const profileIds: string[] = [];
	// Fixture scope is the manifest emails in the fixture identity — not
	// the directory user ids, which differ between the memory directory
	// (synthetic) and a real auth DB (random per insert, possibly reseeded).
	// Sibling suites' demo_seed rows (synthetic svc-* emails, if any) never
	// match a manifest email and are untouched.
	{
		const personaEmails = new Set(
			Object.values(manifest.personas).map((p) => p.email.toLowerCase()),
		);
		const fixtureProfiles = await ctx.db
			.select({ id: customerProfiles.id, identity: customerProfiles.identity })
			.from(customerProfiles)
			.where(eq(customerProfiles.source, "demo_seed"));
		for (const row of fixtureProfiles) {
			const email = (row.identity as Record<string, unknown> | null)?.email;
			if (typeof email === "string" && personaEmails.has(email.toLowerCase())) {
				profileIds.push(row.id);
			}
		}
		// Keep the shared directory usable: later tests resolve users from it.
		for (const persona of Object.values(manifest.personas)) {
			await users.ensureUser({
				email: persona.email,
				fullName: persona.fullName,
				role: persona.role,
			});
		}
	}
	if (profileIds.length > 0) {
		// Reuse copies of fixture evidence in surviving non-fixture
		// applications (e2e UI drafts/cases) pin fixture docs under
		// RESTRICT: remove those copies (pages cascade) so the fixture
		// scope below converges. Uploads and non-fixture rows are
		// untouched; the host applications keep their own rows.
		const fixtureDocIds = (
			await ctx.db
				.select({ id: customerDocuments.id })
				.from(customerDocuments)
				.where(inArray(customerDocuments.customerId, profileIds))
		).map((d) => d.id);
		if (fixtureDocIds.length > 0) {
			const copyScope = [
				inArray(documentFiles.reusedFromCustomerDocumentId, fixtureDocIds),
				...(appIds.length > 0 ? [notInArray(documentFiles.applicationId, appIds)] : []),
			];
			const pins = await ctx.db
				.selectDistinct({ applicationId: documentFiles.applicationId })
				.from(documentFiles)
				.where(and(...copyScope));
			if (pins.length > 0) {
				console.log(
					`[cleanup] removing fixture-evidence copies from surviving applications: ${pins.map((p) => p.applicationId).join(", ")}`,
				);
				const copyFiles = await ctx.db
					.select({ id: documentFiles.id })
					.from(documentFiles)
					.where(and(...copyScope));
				if (copyFiles.length > 0) {
					await ctx.db.delete(documentFingerprints).where(
						inArray(
							documentFingerprints.documentFileId,
							copyFiles.map((file) => file.id),
						),
					);
				}
				await ctx.db.delete(documentFiles).where(and(...copyScope));
			}
		}
		// RESTRICT FKs pin fixture rows referenced by surviving UI drafts
		// (applicant drafts with confirmations): exclude referenced rows —
		// seed converges on them anyway, and sibling suites' random rows
		// are untouched.
		await ctx.db
			.delete(customerDocuments)
			.where(
				and(
					inArray(customerDocuments.customerId, profileIds),
					drizzleSql`NOT EXISTS (SELECT 1 FROM document_files f WHERE f.reused_from_customer_document_id = customer_documents.id)`,
				),
			);
		const accountIds = Object.values(manifest.personas).flatMap((p) => p.accounts.map((a) => a.id));
		if (accountIds.length > 0) {
			await ctx.db
				.delete(customerTransactions)
				.where(inArray(customerTransactions.accountId, accountIds));
			await ctx.db.delete(customerAccounts).where(inArray(customerAccounts.id, accountIds));
		}
		await ctx.db
			.delete(customerProfiles)
			.where(
				and(
					inArray(customerProfiles.id, profileIds),
					drizzleSql`NOT EXISTS (SELECT 1 FROM application_profile_confirmations c WHERE c.customer_profile_id = customer_profiles.id)`,
				),
			);
	}
}

afterAll(async () => {
	await ctx.sql.end();
	await rm(appDir, { recursive: true, force: true });
	await rm(customerDir, { recursive: true, force: true });
});

describe("demo:seed idempotency", () => {
	it("converges fixture rows on re-run without duplicates", async () => {
		const first = await seedAll();
		expect(first.profilesUpserted).toBe(3);
		expect(first.evidenceCreated).toBeGreaterThan(0);
		const before = await fixtureCounts();
		expect(before).toEqual({ profiles: 3, accounts: 2, txns: 38, docs: 7 });
		const second = await seedAll();
		expect(await fixtureCounts()).toEqual(before);
		expect(second.evidenceCreated).toBe(0);
		expect(second.evidenceSkipped).toBe(first.evidenceCreated);
	});

	it("restores drifted fixture-owned rows", async () => {
		await seedAll();
		const user = applicant("breadtalk@example.com");
		const [profile] = await ctx.db
			.select()
			.from(customerProfiles)
			.where(eq(customerProfiles.userId, user.id));
		await ctx.db
			.update(customerProfiles)
			.set({ business: { tampered: true } })
			.where(eq(customerProfiles.id, profile.id));
		await seedAll();
		const [restored] = await ctx.db
			.select()
			.from(customerProfiles)
			.where(eq(customerProfiles.id, profile.id));
		expect((restored.business as Record<string, unknown>).companyName).toBe(
			"BreadTalk Demo Pte Ltd",
		);
	});

	it("restores wiped evidence blobs in place without touching references", async () => {
		await seedAll();
		const user = applicant("breadtalk@example.com");
		const [profile] = await ctx.db
			.select()
			.from(customerProfiles)
			.where(eq(customerProfiles.userId, user.id));
		// Seed-managed rows only: fresh-evidence blobs are refresh-owned.
		const seedKeys = new Set(manifest.personas.breadtalk.evidence.map((e) => e.fixtureKey));
		const docs = (
			await ctx.db
				.select()
				.from(customerDocuments)
				.where(eq(customerDocuments.customerId, profile.id))
		).filter((d) => d.fixtureKey && seedKeys.has(d.fixtureKey));
		expect(docs.length).toBeGreaterThan(0);
		// Wipe every blob on disk (rows stay): re-seed must rewrite the
		// ciphertext under the same ids, not recreate rows.
		for (const doc of docs) {
			if (doc.storageKey) await rm(join(customerDir, doc.storageKey), { force: true });
		}
		const counts = await seedAll();
		expect(counts.evidenceCreated).toBeGreaterThan(0);
		const again = (
			await ctx.db
				.select()
				.from(customerDocuments)
				.where(eq(customerDocuments.customerId, profile.id))
		).filter((d) => d.fixtureKey && seedKeys.has(d.fixtureKey));
		expect(again.map((d) => d.id).sort()).toEqual(docs.map((d) => d.id).sort());
		for (const doc of again) {
			await expect(openCustomerDocument(ctx.customerConfig, doc)).resolves.toBeDefined();
		}
	});

	it("repairs swept/tampered fixture evidence in place (same ids)", async () => {
		await seedAll();
		const user = applicant("breadtalk@example.com");
		const [profile] = await ctx.db
			.select()
			.from(customerProfiles)
			.where(eq(customerProfiles.userId, user.id));
		const seedKeys = new Set(manifest.personas.breadtalk.evidence.map((e) => e.fixtureKey));
		const docs = (
			await ctx.db
				.select()
				.from(customerDocuments)
				.where(eq(customerDocuments.customerId, profile.id))
		).filter((d) => d.fixtureKey && seedKeys.has(d.fixtureKey));
		expect(docs.length).toBeGreaterThan(1);
		const [swept, tampered] = docs;
		// Retention-sweep tombstone: pages gone, filename nulled, blob purged.
		await ctx.db
			.delete(customerDocumentPages)
			.where(eq(customerDocumentPages.customerDocumentId, swept.id));
		if (swept.storageKey) await rm(join(customerDir, swept.storageKey), { force: true });
		await ctx.db
			.update(customerDocuments)
			.set({
				status: "deleted",
				originalFilename: null,
				blobPurgedAt: new Date(),
				retentionUntil: new Date("2020-01-01T00:00:00Z"),
			})
			.where(eq(customerDocuments.id, swept.id));
		// Tamper: same bytes, wrong metadata (dates, scan, retention).
		await ctx.db
			.update(customerDocuments)
			.set({
				documentDate: "2020-01-01",
				scanStatus: "rejected",
				retentionUntil: new Date("2020-01-01T00:00:00Z"),
			})
			.where(eq(customerDocuments.id, tampered.id));

		const counts = await seedAll();
		expect(counts.evidenceCreated).toBe(2);
		const totalSeedEvidence = Object.values(manifest.personas).reduce(
			(n, p) => n + p.evidence.length,
			0,
		);
		expect(counts.evidenceSkipped).toBe(totalSeedEvidence - 2);
		const again = (
			await ctx.db
				.select()
				.from(customerDocuments)
				.where(eq(customerDocuments.customerId, profile.id))
		).filter((d) => d.fixtureKey && seedKeys.has(d.fixtureKey));
		expect(again.map((d) => d.id).sort()).toEqual(docs.map((d) => d.id).sort());
		for (const doc of again) {
			expect(doc.status).toBe("ready");
			expect(doc.blobPurgedAt).toBeNull();
			expect(doc.retentionUntil.getTime()).toBeGreaterThan(DEMO_AS_OF.getTime());
			await expect(openCustomerDocument(ctx.customerConfig, doc)).resolves.toBeDefined();
		}
		const fixed = again.find((d) => d.id === tampered.id);
		const want = manifest.personas.breadtalk.evidence.find(
			(e) => e.fixtureKey === fixed?.fixtureKey,
		);
		expect(fixed?.documentDate).toBe(want?.documentDate);
		expect(fixed?.scanStatus).toBe("clean");
	});

	it("re-links fixture profiles after an auth-DB reseed without deleting rows", async () => {
		await seedAll();
		const personaEmails = new Set(
			Object.values(manifest.personas).map((p) => p.email.toLowerCase()),
		);
		const isFixtureEmail = (identity: unknown): boolean => {
			const email = (identity as Record<string, unknown> | null)?.email;
			return typeof email === "string" && personaEmails.has(email.toLowerCase());
		};
		const fixtureIds = (
			await ctx.db
				.select({ id: customerProfiles.id, identity: customerProfiles.identity })
				.from(customerProfiles)
				.where(eq(customerProfiles.source, "demo_seed"))
		)
			.filter((r) => isFixtureEmail(r.identity))
			.map((r) => r.id)
			.sort();
		expect(fixtureIds).toHaveLength(3);
		const before = await fixtureCounts();

		// Simulate an auth-DB reseed: same emails, fresh random user ids.
		const freshIds = new Map<string, string>();
		const reseeded = {
			ensureUser: async (input: { email: string }) => {
				const key = input.email.toLowerCase();
				let id = freshIds.get(key);
				if (!id) {
					id = randomUUID();
					freshIds.set(key, id);
				}
				return id;
			},
			findUserByEmail: async (email: string) => {
				const id = freshIds.get(email.toLowerCase());
				if (!id) throw new Error(`no reseeded user for ${email}`);
				return id;
			},
		};
		const counts = await seedDemo(manifest, {
			appDb: ctx.db,
			users: reseeded,
			customerConfig: ctx.customerConfig,
		});
		expect(counts.profilesUpserted).toBe(3);

		// Converged: the same profile rows, re-linked — no duplicates, and
		// the fixture evidence/accounts/transactions still count the same.
		const afterIds = (
			await ctx.db
				.select({ id: customerProfiles.id, identity: customerProfiles.identity })
				.from(customerProfiles)
				.where(eq(customerProfiles.source, "demo_seed"))
		)
			.filter((r) => isFixtureEmail(r.identity))
			.map((r) => r.id)
			.sort();
		expect(afterIds).toEqual(fixtureIds);
		const relinked = await ctx.db
			.select()
			.from(customerProfiles)
			.where(eq(customerProfiles.source, "demo_seed"));
		for (const persona of Object.values(manifest.personas)) {
			const row = relinked.find(
				(p) =>
					((p.identity ?? {}) as Record<string, unknown>).email ===
					(persona.profile.identity as Record<string, unknown>).email,
			);
			expect(row?.userId).toBe(freshIds.get(persona.email.toLowerCase()));
		}

		// Restore the canonical directory mapping so later tests self-heal.
		await seedAll();
		expect(await fixtureCounts()).toEqual(before);
	});
});

describe("breadtalk draft lifecycle", () => {
	it("pre-refresh: stale blockers, submit 409, no side effects", async () => {
		await seedAll();
		const outcome = await makeCase("breadtalk");
		expect(outcome.created).toBe(true);
		expect(outcome.attached).toHaveLength(2);
		expect(outcome.staleCopies).toHaveLength(2);
		await expectVerify("breadtalk", "pre-refresh");

		const user = applicant("breadtalk@example.com");
		const blocked = await postSubmit(user, outcome.draftId, randomUUID());
		expect(blocked.status).toBe(409);
		const body = (await blocked.json()) as {
			error: { code: string; fields: Record<string, string[]> };
		};
		expect(body.error.code).toBe("REQUIREMENTS_INCOMPLETE");
		expect(body.error.fields).toEqual({
			"document:bank_statement": ["stale"],
			"document:financial_statements": ["stale"],
		});
		expect(ctx.gateway.started).not.toContain(outcome.draftId);
	});

	it("post-refresh: customer fresh, app still blocked", async () => {
		await seedAll();
		const outcome = await makeCase("breadtalk");
		const refreshed = await refreshDemoEvidence(manifest, "breadtalk", {
			appDb: ctx.db,
			users,
			customerConfig: ctx.customerConfig,
			asOf: DEMO_AS_OF,
		});
		expect(refreshed.created).toEqual(["bank_statement_fresh", "financial_statements_fresh"]);
		const again = await refreshDemoEvidence(manifest, "breadtalk", {
			appDb: ctx.db,
			users,
			customerConfig: ctx.customerConfig,
			asOf: DEMO_AS_OF,
		});
		expect(again.created).toEqual([]);
		await expectVerify("breadtalk", "post-refresh");

		const user = applicant("breadtalk@example.com");
		const stillBlocked = await postSubmit(user, outcome.draftId, randomUUID());
		expect(stillBlocked.status).toBe(409);
	});

	it("post-attach: explicit reuse unblocks; submit once via the real endpoint", async () => {
		await seedAll();
		const outcome = await makeCase("breadtalk");
		await refreshDemoEvidence(manifest, "breadtalk", {
			appDb: ctx.db,
			users,
			customerConfig: ctx.customerConfig,
			asOf: DEMO_AS_OF,
		});
		const user = applicant("breadtalk@example.com");
		const freshIds = await customerDocIds("breadtalk@example.com", [
			"bank_statement_fresh",
			"financial_statements_fresh",
		]);
		const reuse = await postReuse(user, outcome.draftId, freshIds);
		expect(reuse.status).toBe(201);
		await expectVerify("breadtalk", "post-attach");

		const key = randomUUID();
		const submitted = await postSubmit(user, outcome.draftId, key);
		expect(submitted.status).toBe(200);
		const { reference } = (await submitted.json()) as { reference: string };
		expect(reference).toBe(outcome.reference);
		expect(ctx.gateway.started).toContain(outcome.draftId);

		const replay = await postSubmit(user, outcome.draftId, key);
		expect(replay.status).toBe(200);
		expect(((await replay.json()) as { reference: string }).reference).toBe(reference);

		const events = await ctx.db.select().from(outboxEvents);
		const submittedEvents = events.filter(
			(r) =>
				(r.payload as { payload?: { applicationId?: string } })?.payload?.applicationId ===
				outcome.draftId,
		);
		expect(submittedEvents).toHaveLength(1);

		const [row] = await ctx.db
			.select()
			.from(applications)
			.where(eq(applications.id, outcome.draftId));
		expect(row.status).toBe("submitted");
		expect(row.submittedAt?.toISOString()).toBe(DEMO_AS_OF.toISOString());
		await expectVerify("breadtalk", "post-submit");
	});

	it("never re-touches submitted or edited drafts", async () => {
		await seedAll();
		// An applicant edit marks the draft touched: re-case skips it.
		const alex = await makeCase("alex");
		await ctx.db
			.update(applications)
			.set({ purpose: "edited by applicant" })
			.where(eq(applications.id, alex.draftId));
		const rerun = await makeCase("alex");
		expect(rerun.created).toBe(false);
		expect(rerun.draftId).toBe(alex.draftId);
		expect(rerun.attached).toEqual([]);
		expect(rerun.staleCopies).toEqual([]);

		// An applicant upload (source='upload') marks touched even when the
		// scalars still match the fixture.
		const sparse = await makeCase("sparse");
		const sparseUser = applicant("sparse@example.com");
		await ctx.db.insert(documentFiles).values({
			applicationId: sparse.draftId,
			kind: "bank_statement",
			status: "ready",
			ocrStatus: "not_applicable",
			mimeType: "application/pdf",
			sizeBytes: 16,
			sha256: "upload-source-marker",
			keyId: "v1",
			cryptoVersion: "v1",
			pageCount: 0,
			uploadedBy: sparseUser.id,
			retentionUntil: new Date("2027-01-01T00:00:00Z"),
			source: "upload",
		});
		const sparseRerun = await makeCase("sparse");
		expect(sparseRerun.created).toBe(false);
		expect(sparseRerun.attached).toEqual([]);

		// Submitted drafts are never resurrected — submitted here, not by an
		// earlier test, so this case passes standalone.
		const submittedId = await ensureSubmittedBreadtalk();
		const submitted = (
			await ctx.db.select().from(applications).where(eq(applications.id, submittedId)).limit(1)
		)[0];
		expect(submitted.status).toBe("submitted");
		expect(
			await isFixtureDraftTouched(
				ctx.db,
				submitted.id,
				submitted,
				manifest.personas.breadtalk.case,
				manifest.personas.breadtalk.case.identity,
				manifest.personas.breadtalk.case.sme ?? null,
			),
		).toBe(true);
		const submittedRerun = await makeCase("breadtalk");
		expect(submittedRerun.created).toBe(false);
		expect(submittedRerun.draftId).toBe(submitted.id);

		// Clean up the markers so later phase asserts see fixture state.
		await ctx.db
			.update(applications)
			.set({ purpose: manifest.personas.alex.case.purpose })
			.where(eq(applications.id, alex.draftId));
		const markerFiles = await ctx.db
			.select({ id: documentFiles.id })
			.from(documentFiles)
			.where(eq(documentFiles.sha256, "upload-source-marker"));
		if (markerFiles.length > 0) {
			await ctx.db.delete(documentFingerprints).where(
				inArray(
					documentFingerprints.documentFileId,
					markerFiles.map((file) => file.id),
				),
			);
		}
		await ctx.db.delete(documentFiles).where(eq(documentFiles.sha256, "upload-source-marker"));
	});
});

describe("alex and sparse phases", () => {
	it("alex ships ready; sparse is blocked on missing evidence", async () => {
		await seedAll();
		await makeCase("alex");
		await expectVerify("alex", "pre-refresh");
		await makeCase("sparse");
		await expectVerify("sparse", "pre-refresh");
	});
});
