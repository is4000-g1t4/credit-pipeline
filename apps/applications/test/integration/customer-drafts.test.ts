// T17 D1 integration (real Postgres, fake scanner/OCR, temp storage
// roots): profile → draft → stale blockers → reuse → submit, with no
// workflow/outbox before submit, typed 409s, double-submit replay, draft
// caps, draft officer isolation, and the app-orphan-sweep/customer-root
// separation.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applications,
	auditLog,
	caseAccessGrants,
	customerAccounts,
	customerDocuments,
	customerProfiles,
	documentFiles,
	documentPages,
	outboxEvents,
} from "@credit/db/applications";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { bodySha256Hex, createLogger, resolveInternalUser } from "@credit/service-kit";
import { stubGateway } from "@credit/service-kit/test";
import {
	createCustomerDocument,
	openCustomerDocument,
	type CustomerConfig,
} from "../../src/customer/service.js";
import { configFromEnv } from "../../src/documents/service.js";
import type { ExtractionResult, OcrAdapter, OcrLimits } from "../../src/documents/ocr.js";
import type { ScannerAdapter } from "../../src/documents/scanner.js";
import { loadEnv } from "../../src/env.js";
import {
	createUser,
	individualPayload,
	multipart,
	postApplication,
	postSubmit,
	setupApp,
	signed,
	type TestContext,
	type TestUser,
} from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
// Fixed fixture clock (matches the env default; passed explicitly so the
// suite is deterministic whatever the operator's .env holds).
const DEMO_AS_OF = new Date("2026-06-30T00:00:00Z");

const READY_TEXT: ExtractionResult = {
	status: "ready",
	pages: [{ text: "reused-page-text", source: "ocr", confidence: 0.95 }],
	textLayerRisk: false,
};

const cleanScanner: ScannerAdapter = {
	async scan(_bytes: Buffer) {
		return "clean";
	},
};
const readyOcr: OcrAdapter = {
	async extractPdf(_b: Buffer, _l: OcrLimits) {
		return structuredClone(READY_TEXT) as ExtractionResult;
	},
	async extractImage(_b: Buffer, _t: "png" | "jpeg", _l: OcrLimits) {
		return structuredClone(READY_TEXT) as ExtractionResult;
	},
};

interface CustomerContext extends TestContext {
	customerConfig: CustomerConfig;
}

let ctx: CustomerContext;
let appDir: string;
let customerDir: string;

function setupCustomer(): CustomerContext {
	const customerConfig: CustomerConfig = {
		storageDir: (globalThis as { t17CustomerDir?: string }).t17CustomerDir ?? "",
		encryptionKey: ENCRYPTION_KEY,
		keyId: "v1",
		previousKeys: undefined,
		retentionDays: 90,
		lockTimeoutMs: 5000,
	};
	const ctx = setupApp({
		storageDir: (globalThis as { t17AppDir?: string }).t17AppDir ?? "",
		documents: {
			config: { featureEnabled: true, encryptionKey: ENCRYPTION_KEY, keyId: "v1" },
			scanner: cleanScanner,
			ocr: readyOcr,
		},
		customer: { config: customerConfig, demoMode: true, demoAsOf: DEMO_AS_OF },
	});
	return { ...ctx, customerConfig };
}

beforeAll(async () => {
	appDir = await mkdtemp(join(tmpdir(), "t17-app-"));
	customerDir = await mkdtemp(join(tmpdir(), "t17-cust-"));
	(globalThis as { t17AppDir?: string }).t17AppDir = appDir;
	(globalThis as { t17CustomerDir?: string }).t17CustomerDir = customerDir;
	ctx = setupCustomer();
});

afterAll(async () => {
	await ctx.sql.end();
	await rm(appDir, { recursive: true, force: true });
	await rm(customerDir, { recursive: true, force: true });
});

const IDENTITY_FIELDS = [
	"identity.fullName",
	"identity.dob",
	"identity.nationalId",
	"identity.email",
	"identity.phone",
	"identity.address",
	"identity.city",
];

function confirmAll(): Array<{ field: string; valueHash: string }> {
	return IDENTITY_FIELDS.map((field) => ({ field, valueHash: "advisory-client-hash" }));
}

async function postDraft(user: TestUser, payload: unknown, key: string): Promise<Response> {
	return postApplication(ctx, user, "/api/applications/drafts", payload, key);
}

async function postDirect(user: TestUser, payload: unknown, key: string): Promise<Response> {
	return postApplication(ctx, user, "/api/applications", payload, key);
}

async function seedProfile(
	user: TestUser,
	opts: {
		kycStatus?: "verified" | "expired" | "not_started";
		expiresAt?: Date | null;
		identity?: Record<string, unknown>;
		source?: "demo_seed" | "customer_master";
	} = {},
) {
	const payload = individualPayload(user.email);
	const identity = opts.identity ?? (payload.identity as Record<string, unknown>);
	const [profile] = await ctx.db
		.insert(customerProfiles)
		.values({
			userId: user.id,
			segment: "individual",
			customerSince: "2020-01-15",
			kycStatus: opts.kycStatus ?? "verified",
			kycVerifiedAt: new Date("2025-01-01T00:00:00Z"),
			kycExpiresAt: opts.expiresAt ?? new Date("2028-01-01T00:00:00Z"),
			identity,
			source: opts.source ?? "customer_master",
		})
		.returning();
	await ctx.db.insert(customerAccounts).values({
		customerId: profile.id,
		bankName: "Demo Bank",
		accountType: "personal_current",
		maskedNumber: "****4242",
		currency: "SGD",
		openedAt: "2020-02-01",
		status: "active",
		source: opts.source ?? "customer_master",
	});
	return { profile, payload };
}

function daysAgo(n: number): string {
	return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

async function seedEvidence(
	customerId: string,
	kind: string,
	opts: { periodEnd?: string | null; documentDate?: string | null } = {},
) {
	return createCustomerDocument(ctx.db, ctx.customerConfig, {
		customerId,
		kind,
		bytes: Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(64)]),
		mimeType: "application/pdf",
		documentDate: opts.documentDate ?? opts.periodEnd ?? null,
		periodEnd: opts.periodEnd ?? null,
		pages: [{ text: "reused-page-text", source: "pdf_text", confidence: 0.99 }],
	});
}

async function outboxFor(appId: string): Promise<unknown[]> {
	const rows = await ctx.db.select().from(outboxEvents);
	return rows.filter((r) => {
		const payload = r.payload as { payload?: { applicationId?: string } };
		return payload?.payload?.applicationId === appId;
	});
}

async function uploadDoc(
	user: TestUser,
	appId: string,
	kind: string,
	bytes: Buffer,
): Promise<Response> {
	const boundary = `----t17boundary${randomUUID().replace(/-/g, "")}`;
	const body = multipart(boundary, [
		{ name: "kind", data: kind },
		{
			name: "file",
			filename: "statement.pdf",
			contentType: "application/octet-stream",
			data: bytes,
		},
	]);
	const path = `/api/applications/${appId}/documents`;
	return ctx.app.request(path, {
		method: "POST",
		headers: {
			"content-type": `multipart/form-data; boundary=${boundary}`,
			...signed(ctx, user, "POST", path, {}, body),
		},
		body,
	});
}

describe("profile → draft → stale blockers → reuse → submit", () => {
	it("never auto-attaches customer evidence; explicit reuse unblocks submit", async () => {
		const user = await createUser(ctx);
		const { profile, payload } = await seedProfile(user);
		const stale = await seedEvidence(profile.id, "bank_statement", {
			periodEnd: daysAgo(120),
		});
		const idDoc = await seedEvidence(profile.id, "id");
		const payslipDoc = await seedEvidence(profile.id, "payslip");

		const draftPayload = {
			...payload,
			documentProcessingConsent: true,
			profileConfirmations: confirmAll(),
		};
		const created = await postDraft(user, draftPayload, randomUUID());
		expect(created.status).toBe(201);
		const { id, reference } = (await created.json()) as { id: string; reference: string };
		expect(ctx.gateway.started).not.toContain(id);
		expect(await outboxFor(id)).toEqual([]);

		const detailPath = `/api/applications/${id}`;
		const detail = await ctx.app.request(detailPath, {
			headers: signed(ctx, user, "GET", detailPath),
		});
		expect(detail.status).toBe(200);
		const detailBody = (await detail.json()) as {
			application: { status: string; submittedAt: string | null };
		};
		expect(detailBody.application.status).toBe("draft");
		expect(detailBody.application.submittedAt).toBeNull();

		// Stale customer evidence is NOT auto-attached: the app checklist
		// reports missing, never silently stale.
		const reqPath = `/api/applications/${id}/requirements`;
		const reqs = await ctx.app.request(reqPath, { headers: signed(ctx, user, "GET", reqPath) });
		expect(reqs.status).toBe(200);
		const checklist = (await reqs.json()) as {
			readyToSubmit: boolean;
			blockers: Record<string, string[]>;
			policyVersion: string;
			prefill: { reused: string[] };
		};
		expect(checklist.policyVersion).toBe("demo-requirements-v1");
		expect(checklist.readyToSubmit).toBe(false);
		expect(checklist.blockers["document:bank_statement"]).toEqual(["missing"]);
		expect(checklist.prefill.reused).toEqual(expect.arrayContaining(IDENTITY_FIELDS));

		const blocked = await postSubmit(ctx, user, id, randomUUID());
		expect(blocked.status).toBe(409);
		const blockedBody = (await blocked.json()) as {
			error: { code: string; fields: Record<string, string[]> };
		};
		expect(blockedBody.error.code).toBe("REQUIREMENTS_INCOMPLETE");
		expect(blockedBody.error.fields["document:bank_statement"]).toEqual(["missing"]);
		expect(ctx.gateway.started).not.toContain(id);
		expect(await outboxFor(id)).toEqual([]);

		// Stale evidence cannot sneak in through reuse either.
		const reusePath = `/api/applications/${id}/documents/reuse`;
		const staleReuseBody = JSON.stringify({ customerDocumentIds: [stale.id] });
		const staleReuse = await ctx.app.request(reusePath, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(ctx, user, "POST", reusePath, {}, staleReuseBody),
			},
			body: staleReuseBody,
		});
		expect(staleReuse.status).toBe(409);

		// A raw upload carries no server date: unknown_date, never fresh.
		const uploaded = await uploadDoc(
			user,
			id,
			"bank_statement",
			Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(64)]),
		);
		expect(uploaded.status).toBe(201);
		const unknownChecklist = (await (
			await ctx.app.request(reqPath, { headers: signed(ctx, user, "GET", reqPath) })
		).json()) as { blockers: Record<string, string[]> };
		expect(unknownChecklist.blockers["document:bank_statement"]).toEqual(["unknown_date"]);

		// Refreshing customer evidence alone still blocks until explicit reuse.
		const fresh = await seedEvidence(profile.id, "bank_statement", {
			periodEnd: daysAgo(10),
		});
		const stillBlocked = await postSubmit(ctx, user, id, randomUUID());
		expect(stillBlocked.status).toBe(409);

		const reuseBody = JSON.stringify({ customerDocumentIds: [idDoc.id, payslipDoc.id, fresh.id] });
		const reuse = await ctx.app.request(reusePath, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(ctx, user, "POST", reusePath, {}, reuseBody),
			},
			body: reuseBody,
		});
		expect(reuse.status).toBe(201);
		const reuseJson = (await reuse.json()) as {
			files: Array<{ id: string; source: string; periodEnd: string | null }>;
		};
		expect(reuseJson.files).toHaveLength(3);
		const statement = reuseJson.files.find((f) => f.periodEnd === daysAgo(10));
		expect(statement?.source).toBe("customer_reuse");
		// Pages are copied, source untouched.
		const pages = await ctx.db
			.select()
			.from(documentPages)
			.where(eq(documentPages.documentFileId, statement!.id));
		expect(pages.map((p) => p.text)).toEqual(["reused-page-text"]);
		expect((await openCustomerDocument(ctx.customerConfig, stale)).length).toBeGreaterThan(0);

		const replayBody = JSON.stringify({ customerDocumentIds: [fresh.id] });
		const replay = await ctx.app.request(reusePath, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(ctx, user, "POST", reusePath, {}, replayBody),
			},
			body: replayBody,
		});
		expect(replay.status).toBe(200);
		const replayFiles = ((await replay.json()) as { files: Array<{ id: string }> }).files;
		expect(replayFiles).toHaveLength(1);
		expect(replayFiles[0].id).toBe(statement!.id);

		const ready = (await (
			await ctx.app.request(reqPath, { headers: signed(ctx, user, "GET", reqPath) })
		).json()) as { readyToSubmit: boolean; blockers: unknown };
		expect(ready.readyToSubmit).toBe(true);

		const key = randomUUID();
		const submitted = await postSubmit(ctx, user, id, key);
		expect(submitted.status).toBe(200);
		expect(((await submitted.json()) as { reference: string }).reference).toBe(reference);
		expect(ctx.gateway.started).toContain(id);
		expect((await outboxFor(id)).length).toBe(1);
		const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, id));
		expect(audits.map((a) => a.action)).toContain("application.submitted");

		// Double submit with the same key replays 200 with the same reference.
		const again = await postSubmit(ctx, user, id, key);
		expect(again.status).toBe(200);
		expect(((await again.json()) as { reference: string }).reference).toBe(reference);
		expect((await outboxFor(id)).length).toBe(1);

		// A key bound to another application 409s with no writes.
		const other = await createUser(ctx);
		const { id: otherId } = (await (
			await postDraft(other, individualPayload(other.email), randomUUID())
		).json()) as { id: string };
		const clash = await postSubmit(ctx, other, otherId, key);
		expect(clash.status).toBe(409);
	});
});

describe("direct create guard", () => {
	it("409s DRAFT_REQUIRED for profiled users, still 201s for unprofiled", async () => {
		const profiled = await createUser(ctx);
		await seedProfile(profiled);
		const denied = await postDirect(profiled, individualPayload(profiled.email), randomUUID());
		expect(denied.status).toBe(409);
		expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
			"DRAFT_REQUIRED",
		);

		const plain = await createUser(ctx);
		const allowed = await postDirect(plain, individualPayload(plain.email), randomUUID());
		expect(allowed.status).toBe(201);
	});
});

describe("draft caps and isolation", () => {
	it("allows 3 active drafts and 409s the 4th", async () => {
		const user = await createUser(ctx);
		for (let i = 0; i < 3; i++) {
			const res = await postDraft(user, individualPayload(user.email), randomUUID());
			expect(res.status).toBe(201);
		}
		const fourth = await postDraft(user, individualPayload(user.email), randomUUID());
		expect(fourth.status).toBe(409);
		expect(((await fourth.json()) as { error: { code: string } }).error.code).toBe(
			"TOO_MANY_DRAFTS",
		);
	});

	it("hides drafts from officers until submitted", async () => {
		const user = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const created = await postDraft(user, individualPayload(user.email), randomUUID());
		const { id } = (await created.json()) as { id: string };

		const detailPath = `/api/applications/${id}`;
		expect(
			(await ctx.app.request(detailPath, { headers: signed(ctx, officer, "GET", detailPath) }))
				.status,
		).toBe(404);
		const reqPath = `/api/applications/${id}/requirements`;
		expect(
			(await ctx.app.request(reqPath, { headers: signed(ctx, officer, "GET", reqPath) })).status,
		).toBe(404);
		const listPath = "/api/applications";
		const listed = (await (
			await ctx.app.request(listPath, { headers: signed(ctx, officer, "GET", listPath) })
		).json()) as { items: Array<{ id: string }> };
		expect(listed.items.map((i) => i.id)).not.toContain(id);

		// Draft claim + case-facts/research-context stay closed too.
		const claimPath = `/api/applications/${id}/documents/claim`;
		expect(
			(
				await ctx.app.request(claimPath, {
					method: "POST",
					headers: signed(ctx, officer, "POST", claimPath),
				})
			).status,
		).toBe(404);
		const factsPath = `/internal/applications/${id}/case-facts`;
		expect(
			(await ctx.app.request(factsPath, { headers: signed(ctx, officer, "GET", factsPath) }))
				.status,
		).toBe(404);
		const service = await createUser(ctx, "service");
		const researchPath = `/internal/applications/${id}/research-context`;
		expect(
			(await ctx.app.request(researchPath, { headers: signed(ctx, service, "GET", researchPath) }))
				.status,
		).toBe(409);
	});

	it("hides drafts from officer stats and decision reads", async () => {
		const user = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const statsPath = "/internal/stats";
		const statsGet = async (): Promise<{ applications: Record<string, number> }> => {
			const res = await ctx.app.request(statsPath, {
				headers: signed(ctx, officer, "GET", statsPath),
			});
			expect(res.status).toBe(200);
			return (await res.json()) as { applications: Record<string, number> };
		};
		// Draft count before the new draft exists…
		const before = await statsGet();

		const created = await postDraft(user, individualPayload(user.email), randomUUID());
		const { id } = (await created.json()) as { id: string };

		const decisionPath = `/internal/applications/${id}/decision`;
		expect(
			(await ctx.app.request(decisionPath, { headers: signed(ctx, officer, "GET", decisionPath) }))
				.status,
		).toBe(404);

		// …is identical after: drafts never inflate officer dashboards.
		const after = await statsGet();
		expect(after.applications["draft"] ?? 0).toBe(before.applications["draft"] ?? 0);
	});
});

describe("reuse guards", () => {
	it("rejects stale sources, kind mismatches, unknown and cross-customer ids", async () => {
		const user = await createUser(ctx);
		const { profile, payload } = await seedProfile(user);
		const stale = await seedEvidence(profile.id, "bank_statement", { periodEnd: daysAgo(120) });
		const idDoc = await seedEvidence(profile.id, "id");
		const { id } = (await (
			await postDraft(user, { ...payload, documentProcessingConsent: true }, randomUUID())
		).json()) as { id: string };
		const reuse = async (body: unknown): Promise<Response> => {
			const path = `/api/applications/${id}/documents/reuse`;
			const raw = JSON.stringify(body);
			return ctx.app.request(path, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...signed(ctx, user, "POST", path, {}, raw),
				},
				body: raw,
			});
		};
		expect((await reuse({ customerDocumentIds: [stale.id] })).status).toBe(409);
		const mismatch = await reuse({ customerDocumentIds: [idDoc.id], kind: "bank_statement" });
		expect(mismatch.status).toBe(422);
		expect((await reuse({ customerDocumentIds: [randomUUID()] })).status).toBe(404);

		const stranger = await createUser(ctx);
		const { profile: otherProfile } = await seedProfile(stranger);
		const otherDoc = await seedEvidence(otherProfile.id, "id");
		expect((await reuse({ customerDocumentIds: [otherDoc.id] })).status).toBe(404);
	});

	it("re-reads the application under lock: withdrawal and terminal status block copies", async () => {
		const user = await createUser(ctx);
		const { profile, payload } = await seedProfile(user);
		const idDoc = await seedEvidence(profile.id, "id");
		const { id } = (await (
			await postDraft(user, { ...payload, documentProcessingConsent: true }, randomUUID())
		).json()) as { id: string };
		const reusePath = `/api/applications/${id}/documents/reuse`;
		const reuse = async (docId: string): Promise<Response> => {
			const raw = JSON.stringify({ customerDocumentIds: [docId] });
			return ctx.app.request(reusePath, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...signed(ctx, user, "POST", reusePath, {}, raw),
				},
				body: raw,
			});
		};
		const fileCount = async (): Promise<number> => {
			return (await ctx.db.select().from(documentFiles).where(eq(documentFiles.applicationId, id)))
				.length;
		};

		// Withdrawal blocks reuse: no copy is created after consent is
		// revoked (the route gate and the in-transaction re-read under the
		// application lock both enforce it, so a withdrawal racing reuse
		// cannot slip a copy in).
		const consentPath = `/api/applications/${id}/document-consent`;
		const consentRaw = JSON.stringify({ consent: false });
		const withdrawn = await ctx.app.request(consentPath, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				...signed(ctx, user, "PATCH", consentPath, {}, consentRaw),
			},
			body: consentRaw,
		});
		expect(withdrawn.status).toBe(200);
		expect((await reuse(idDoc.id)).status).toBe(403);
		expect(await fileCount()).toBe(0);

		// A terminal application cannot receive copies either.
		await ctx.db
			.update(applications)
			.set({ documentProcessingConsent: true, status: "processing", submittedAt: new Date() })
			.where(eq(applications.id, id));
		const terminal = await reuse(idDoc.id);
		expect(terminal.status).toBe(409);
		expect(((await terminal.json()) as { error: { code: string } }).error.code).toBe(
			"APPLICATION_NOT_REUSABLE",
		);
		expect(await fileCount()).toBe(0);
	});
});

describe("customer reads and context consent", () => {
	it("returns masked profile + evidence metadata with no secrets", async () => {
		const user = await createUser(ctx);
		const { profile } = await seedProfile(user);
		await seedEvidence(profile.id, "bank_statement", { periodEnd: daysAgo(10) });
		const path = "/api/customer/profile";
		const res = await ctx.app.request(path, { headers: signed(ctx, user, "GET", path) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			profile: { kycFresh: boolean; identity: Record<string, unknown> };
			accounts: Array<{ maskedNumber: string }>;
			documents: Array<Record<string, unknown>>;
		};
		expect(body.profile.kycFresh).toBe(true);
		expect(body.profile.identity.fullName).toBe("Svc Applicant");
		expect(body.accounts[0].maskedNumber).toBe("****4242");
		expect(body.documents).toHaveLength(1);
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("storageKey");
		expect(serialized).not.toContain("encryptionNonce");
		expect(serialized).not.toContain("reused-page-text");

		const docsPath = "/api/customer/documents";
		const docs = await ctx.app.request(docsPath, {
			headers: signed(ctx, user, "GET", docsPath),
		});
		expect(docs.status).toBe(200);
		expect(((await docs.json()) as { documents: unknown[] }).documents).toHaveLength(1);

		const stranger = await createUser(ctx);
		expect(
			(await ctx.app.request(path, { headers: signed(ctx, stranger, "GET", path) })).status,
		).toBe(404);
	});

	it("patches context consent as the owner only", async () => {
		const user = await createUser(ctx);
		const other = await createUser(ctx);
		const { id } = (await (
			await postDraft(user, individualPayload(user.email), randomUUID())
		).json()) as { id: string };
		const path = `/api/applications/${id}/context-consent`;
		const patch = async (actor: TestUser, consent: boolean): Promise<Response> => {
			const raw = JSON.stringify({ consent });
			return ctx.app.request(path, {
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					...signed(ctx, actor, "PATCH", path, {}, raw),
				},
				body: raw,
			});
		};
		const updated = await patch(user, true);
		expect(updated.status).toBe(200);
		expect((await updated.json()) as Record<string, unknown>).toMatchObject({
			contextAnalysisConsent: true,
			contextConsentVersion: "context-consent-v1",
		});
		expect((await patch(other, true)).status).toBe(404);
		const withdrawn = await patch(user, false);
		expect(withdrawn.status).toBe(200);
		expect((await withdrawn.json()) as Record<string, unknown>).toMatchObject({
			contextAnalysisConsent: false,
		});
	});

	it("calls the research purge callback on withdrawal (service HMAC, best-effort)", async () => {
		const { createServer } = await import("node:http");
		const seen: Array<{ path: string; role: string | null; verified: boolean }> = [];
		const server: import("node:http").Server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				const headers = req.headers as Record<string, string | string[] | undefined>;
				const one = (v: string | string[] | undefined): string =>
					Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
				const user = resolveInternalUser(ctx.secret, {
					method: req.method ?? "POST",
					path: (req.url ?? "").split("?")[0],
					userId: one(headers["x-user-id"]),
					role: one(headers["x-user-role"]),
					email: one(headers["x-user-email"]),
					ts: one(headers["x-internal-ts"]),
					signature: one(headers["x-internal-signature"]),
					bodyHash: one(headers["x-body-sha256"]),
					requestId: one(headers["x-request-id"]),
				});
				seen.push({
					path: req.url ?? "",
					role: (req.headers["x-user-role"] as string | undefined) ?? null,
					// Real verification: service signature over the exact bytes.
					verified:
						user?.role === "service" && bodySha256Hex(body) === one(headers["x-body-sha256"]),
				});
				res.writeHead(200, { "content-type": "application/json" }).end("{}");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		try {
			const env = loadEnv();
			const purgeApp = createApp({
				db: ctx.db,
				sql: ctx.sql,
				env,
				gateway: stubGateway(),
				logger: createLogger("applications-purge-test"),
				documents: {
					config: {
						...configFromEnv(env),
						featureEnabled: true,
						storageDir: appDir,
						encryptionKey: ENCRYPTION_KEY,
						keyId: "v1",
					},
					scanner: cleanScanner,
					ocr: readyOcr,
				},
				customer: {
					config: ctx.customerConfig,
					demoMode: true,
					demoAsOf: DEMO_AS_OF,
				},
				research: { url: `http://127.0.0.1:${port}` },
			});
			const user = await createUser(ctx);
			const draftPath = "/api/applications/drafts";
			const draftBody = JSON.stringify(individualPayload(user.email));
			const draft = await purgeApp.request(draftPath, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...signed(ctx, user, "POST", draftPath, { "Idempotency-Key": randomUUID() }, draftBody),
				},
				body: draftBody,
			});
			expect(draft.status).toBe(201);
			const { id } = (await draft.json()) as { id: string };

			const path = `/api/applications/${id}/context-consent`;
			const grant = JSON.stringify({ consent: true });
			await purgeApp.request(path, {
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					...signed(ctx, user, "PATCH", path, {}, grant),
				},
				body: grant,
			});
			// Granting consent never calls research.
			expect(seen).toHaveLength(0);

			const raw = JSON.stringify({ consent: false });
			const withdrawn = await purgeApp.request(path, {
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					...signed(ctx, user, "PATCH", path, {}, raw),
				},
				body: raw,
			});
			expect(withdrawn.status).toBe(200);
			expect(seen).toHaveLength(1);
			expect(seen[0].path).toBe(`/internal/research/applications/${id}/context/purge`);
			expect(seen[0].role).toBe("service");
			expect(seen[0].verified).toBe(true);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("records a durable marker when the purge callback fails (withdrawal still 200)", async () => {
		const env = loadEnv();
		const failingApp = createApp({
			db: ctx.db,
			sql: ctx.sql,
			env,
			gateway: stubGateway(),
			logger: createLogger("applications-purge-failure-test"),
			documents: {
				config: {
					...configFromEnv(env),
					featureEnabled: true,
					storageDir: appDir,
					encryptionKey: ENCRYPTION_KEY,
					keyId: "v1",
				},
				scanner: cleanScanner,
				ocr: readyOcr,
			},
			customer: {
				config: ctx.customerConfig,
				demoMode: true,
				demoAsOf: DEMO_AS_OF,
			},
			// Closed port: every attempt fails fast, no silent drop.
			research: { url: "http://127.0.0.1:1" },
		});
		const user = await createUser(ctx);
		const draftPath = "/api/applications/drafts";
		const draftBody = JSON.stringify(individualPayload(user.email));
		const draft = await failingApp.request(draftPath, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(ctx, user, "POST", draftPath, { "Idempotency-Key": randomUUID() }, draftBody),
			},
			body: draftBody,
		});
		expect(draft.status).toBe(201);
		const { id } = (await draft.json()) as { id: string };

		const path = `/api/applications/${id}/context-consent`;
		const raw = JSON.stringify({ consent: false });
		const withdrawn = await failingApp.request(path, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				...signed(ctx, user, "PATCH", path, {}, raw),
			},
			body: raw,
		});
		expect(withdrawn.status).toBe(200);
		const markers = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, id));
		const failed = markers.filter((a) => a.action === "context.purge_failed");
		expect(failed).toHaveLength(1);
		expect(failed[0].payload).toMatchObject({ attempts: 3 });
	});

	it("strips reusable evidence for assigned officers (blockers stay)", async () => {
		const user = await createUser(ctx);
		const { profile, payload } = await seedProfile(user);
		await seedEvidence(profile.id, "id");
		const { id } = (await (
			await postDraft(user, { ...payload, documentProcessingConsent: true }, randomUUID())
		).json()) as { id: string };
		// Officers only read submitted cases: flip the draft directly.
		await ctx.db
			.update(applications)
			.set({ status: "submitted", submittedAt: new Date() })
			.where(eq(applications.id, id));
		const officer = await createUser(ctx, "officer");
		await ctx.db.insert(caseAccessGrants).values({
			applicationId: id,
			userId: officer.id,
			accessRole: "assigned_officer",
		});

		const reqPath = `/api/applications/${id}/requirements`;
		const ownerBody = (await (
			await ctx.app.request(reqPath, { headers: signed(ctx, user, "GET", reqPath) })
		).json()) as { reusableDocuments: unknown[] };
		expect(ownerBody.reusableDocuments).toHaveLength(1);

		const officerRes = await ctx.app.request(reqPath, {
			headers: signed(ctx, officer, "GET", reqPath),
		});
		expect(officerRes.status).toBe(200);
		const officerBody = (await officerRes.json()) as {
			reusableDocuments: unknown[];
			blockers: Record<string, string[]>;
			policyVersion: string;
		};
		// No customer evidence ids/kinds/dates leak; the checklist itself
		// is still visible (the officer UI renders blockers, never reuse).
		expect(officerBody.reusableDocuments).toEqual([]);
		expect(JSON.stringify(officerBody)).not.toContain("customerDocumentId");
		expect(officerBody.policyVersion).toBe("demo-requirements-v1");
		expect(officerBody.blockers).toBeDefined();
	});
});

describe("fixture clock", () => {
	it("evaluates demo_seed profiles against DEMO_AS_OF, not wall clock", async () => {
		const user = await createUser(ctx);
		// 46 days before DEMO_AS_OF (fresh for fixtures) but ~5 months
		// before wall clock (stale live).
		const { profile } = await seedProfile(user, { source: "demo_seed" });
		await seedEvidence(profile.id, "bank_statement", { periodEnd: "2026-05-15" });
		const path = "/api/customer/documents";
		const res = await ctx.app.request(path, { headers: signed(ctx, user, "GET", path) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			asOf: string;
			documents: Array<{ freshness: string; reusable: boolean }>;
		};
		expect(body.asOf).toBe(DEMO_AS_OF.toISOString());
		expect(body.documents[0].freshness).toBe("fresh");
		expect(body.documents[0].reusable).toBe(true);
	});
});

describe("storage separation", () => {
	it("the T01 app orphan sweep never touches the customer root", async () => {
		const { runDocumentMaintenanceOnce } = await import("../../src/documents/retention.js");
		const user = await createUser(ctx);
		const { profile } = await seedProfile(user);
		const doc = await seedEvidence(profile.id, "id");
		const before = await openCustomerDocument(ctx.customerConfig, doc);
		const result = await runDocumentMaintenanceOnce({
			db: ctx.db,
			lockTimeoutMs: 5000,
			storageDir: appDir,
			uploadDeadlineMs: 1000,
			storageConfigured: true,
		});
		expect(result.orphans).not.toBeNull();
		expect((await openCustomerDocument(ctx.customerConfig, doc)).equals(before)).toBe(true);
		const rows = await ctx.db
			.select()
			.from(customerDocuments)
			.where(eq(customerDocuments.id, doc.id));
		expect(rows).toHaveLength(1);
	});
});

describe("sme requirements", () => {
	it("submits an SME draft with fresh registration/financials/statements", async () => {
		const user = await createUser(ctx);
		const sme = {
			companyName: "BreadTalk Demo Pte Ltd",
			registrationNumber: "BT201901",
			industry: "retail",
			yearsTrading: 5,
			employees: 12,
			annualRevenueCents: 120000000,
			monthlyFcfCents: 8000000,
			existingDebtServiceCents: 1000000,
		};
		const payload = {
			type: "sme",
			product: "sme_term_loan",
			amountCents: 5000000,
			termMonths: 36,
			purpose: "sme integration test",
			consents: [true, true, true],
			documentProcessingConsent: true,
			identity: {
				fullName: "Svc Applicant",
				dob: "1990-05-01",
				nationalId: "SVCTEST01",
				email: user.email,
				phone: "+1-555-0100",
				address: "1 Test Street",
				city: "Demo City",
			},
			sme,
		};
		const [profile] = await ctx.db
			.insert(customerProfiles)
			.values({
				userId: user.id,
				segment: "sme",
				customerSince: "2019-03-01",
				kycStatus: "verified",
				kycVerifiedAt: new Date("2025-01-01T00:00:00Z"),
				kycExpiresAt: new Date("2028-01-01T00:00:00Z"),
				identity: payload.identity,
				business: { ...sme },
				source: "customer_master",
			})
			.returning();
		const ids: string[] = [];
		ids.push((await seedEvidence(profile.id, "id")).id);
		ids.push((await seedEvidence(profile.id, "business_registration")).id);
		ids.push(
			(
				await seedEvidence(profile.id, "financial_statements", {
					periodEnd: daysAgo(180),
				})
			).id,
		);
		ids.push(
			(
				await seedEvidence(profile.id, "bank_statement", {
					periodEnd: daysAgo(20),
				})
			).id,
		);
		const draftPayload = {
			...payload,
			profileConfirmations: [
				...confirmAll(),
				{ field: "sme.companyName", valueHash: "advisory" },
				{ field: "sme.registrationNumber", valueHash: "advisory" },
			],
		};
		const created = await postDraft(user, draftPayload, randomUUID());
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };

		const bad = await postDraft(
			user,
			{ ...payload, profileConfirmations: [{ field: "sme.shoeSize", valueHash: "x" }] },
			randomUUID(),
		);
		expect(bad.status).toBe(422);

		const reusePath = `/api/applications/${id}/documents/reuse`;
		const reuseBody = JSON.stringify({ customerDocumentIds: ids });
		const reuse = await ctx.app.request(reusePath, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(ctx, user, "POST", reusePath, {}, reuseBody),
			},
			body: reuseBody,
		});
		expect(reuse.status).toBe(201);

		const submitted = await postSubmit(ctx, user, id, randomUUID());
		expect(submitted.status).toBe(200);
		const [row] = await ctx.db.select().from(applications).where(eq(applications.id, id));
		expect(row.status).toBe("submitted");
		expect(row.submittedAt).not.toBeNull();

		// Reused app files carry provenance and copied dates.
		const files = await ctx.db
			.select()
			.from(documentFiles)
			.where(eq(documentFiles.applicationId, id));
		expect(files).toHaveLength(4);
		for (const file of files) {
			expect(file.source).toBe("customer_reuse");
			expect(file.reusedFromCustomerDocumentId).not.toBeNull();
		}
	});
});
