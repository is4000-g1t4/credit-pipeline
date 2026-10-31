// Integration setup: real Postgres (compose), fake gateway. Unique users
// per test keep runs deterministic — rows accumulate harmlessly in dev.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

// Hermetic tests: never export generations or OTel spans to the Cloud tenant.
process.env.OTEL_SDK_DISABLED = "true";

import { randomBytes, randomUUID } from "node:crypto";
import { createDb } from "@credit/db";
import { applications, caseAccessGrants, type Db } from "@credit/db/applications";
import { createLogger, signInternalHeaders } from "@credit/service-kit";
import { stubGateway, type FakeGateway } from "@credit/service-kit/test";
import { createApp } from "../src/app.js";
import type { AssistConfig, MemoAgentRunner } from "../src/assist/index.js";
import type { IntegrityAgentRunner, IntegrityConfig } from "../src/integrity/types.js";
import type { CustomerConfig } from "../src/customer/service.js";
import type { OcrAdapter } from "../src/documents/ocr.js";
import type { ScannerAdapter } from "../src/documents/scanner.js";
import type { DocumentsConfig } from "../src/documents/service.js";
import { loadEnv } from "../src/env.js";

process.env.LOG_LEVEL ??= "silent";

export interface TestUser {
	id: string;
	email: string;
	role: "applicant" | "officer" | "service";
}

export interface TestContext {
	app: ReturnType<typeof createApp>;
	db: ReturnType<typeof createDb>["db"];
	sql: ReturnType<typeof createDb>["sql"];
	gateway: FakeGateway;
	secret: string;
}

export interface SetupOpts {
	documents?: {
		config?: Partial<DocumentsConfig>;
		scanner?: ScannerAdapter;
		ocr?: OcrAdapter;
	};
	customer?: {
		config?: Partial<CustomerConfig>;
		demoMode?: boolean;
		demoAsOf?: Date;
	};
	/** App blob root shorthand (lands in documents.config.storageDir unless set there). */
	storageDir?: string;
	/** EN-01/02/03 assist overrides (flag, clock, research upstream, memo model). */
	assist?: {
		config?: Partial<AssistConfig>;
		memoAgentRunner?: MemoAgentRunner;
		policyClient?: import("../src/agents/policy-exception/index.js").PolicyClient;
		policyExceptionAgentRunner?: import("../src/agents/policy-exception/index.js").PolicyExceptionAgentRunner;
		now?: () => Date;
		researchFetchImpl?: typeof fetch;
	};
	/** E2 integrity overrides (flag, clock, runner). */
	integrity?: {
		config?: Partial<IntegrityConfig>;
		agentRunner?: IntegrityAgentRunner;
		now?: () => Date;
		starter?: import("@credit/agent-kit/temporal/client").AgentRunStarter | null;
	};
}

export function setupApp(opts: SetupOpts = {}): TestContext {
	const env = loadEnv();
	const { db, sql } = createDb(env.databaseUrl);
	const gateway = stubGateway();
	const documents =
		opts.documents || opts.storageDir
			? {
					...opts.documents,
					config: { storageDir: opts.storageDir, ...opts.documents?.config },
				}
			: undefined;
	const app = createApp({
		db,
		sql,
		env,
		gateway,
		logger: createLogger("applications-test"),
		documents,
		customer: opts.customer,
		assist: opts.assist,
		// Tests are deterministic and flag-off by default; suite-specific
		// overrides opt in explicitly (the local .env may enable demo flags).
		integrity: opts.integrity ?? {
			config: {
				enabled: false,
				fraudReviewEnabled: false,
				agentEnabled: false,
				triageEnabled: false,
			},
		},
	});
	return { app, db, sql, gateway, secret: env.internalSecret };
}

// Identity is signed headers only in this DB (applicant_user_id is a plain
// uuid — no users table here), so test users are synthetic.
export async function createUser(
	_ctx: TestContext,
	role: "applicant" | "officer" | "service" = "applicant",
): Promise<TestUser> {
	const email = `svc-${randomUUID()}@example.com`;
	return { id: randomUUID(), email, role };
}

/** Signed internal headers for `app.request`, as the P1b gateway would send. */
export function signed(
	ctx: TestContext,
	user: TestUser,
	method: string,
	path: string,
	extra: Record<string, string> = {},
	body?: string | Uint8Array,
): Record<string, string> {
	return {
		...signInternalHeaders(ctx.secret, {
			userId: user.id,
			role: user.role,
			email: user.email,
			method,
			path,
			body,
		}),
		...extra,
	};
}

/** Minimal valid individual application for `email` (must match the identity). */
export function individualPayload(email: string, amountCents = 1200000): Record<string, unknown> {
	return {
		type: "individual",
		product: "personal_loan",
		amountCents,
		termMonths: 48,
		purpose: "svc integration test",
		consents: [true, true, true],
		identity: {
			fullName: "Svc Applicant",
			dob: "1990-05-01",
			nationalId: "SVCTEST01",
			email,
			phone: "+1-555-0100",
			address: "1 Test Street",
			city: "Demo City",
		},
		individual: {
			employmentStatus: "employed",
			employerName: "Acme",
			employmentYears: 6,
			monthlyIncomeCents: 420000,
			existingDebtCents: 61000,
			bankRelationshipYears: 3,
		},
	};
}

export async function teardown(ctx: TestContext): Promise<void> {
	await ctx.sql.end();
}

/** Random-tagged minimal PDF (magic bytes + salt so identical tags still differ). */
export function pdfBytes(tag: string): Buffer {
	return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(tag), randomBytes(64)]);
}

export interface MultipartField {
	name: string;
	filename?: string;
	contentType?: string;
	data: Buffer | string;
}

/** Multipart builder for the document upload route (`file` + `kind`). */
export function multipart(boundary: string, fields: MultipartField[]): Buffer {
	const chunks: Buffer[] = [];
	for (const f of fields) {
		chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
		if (f.filename) {
			chunks.push(
				Buffer.from(
					`Content-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
						`Content-Type: ${f.contentType ?? "application/octet-stream"}\r\n\r\n`,
					"utf8",
				),
			);
		} else {
			chunks.push(Buffer.from(`Content-Disposition: form-data; name="${f.name}"\r\n\r\n`, "utf8"));
		}
		chunks.push(typeof f.data === "string" ? Buffer.from(f.data, "utf8") : f.data);
		chunks.push(Buffer.from("\r\n", "utf8"));
	}
	chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
	return Buffer.concat(chunks);
}

/** Signed JSON POST with an Idempotency-Key (default random). Returns the raw
 * response — callers assert the status they expect. */
export async function postApplication(
	ctx: TestContext,
	user: TestUser,
	path: string,
	payload: unknown,
	key: string = randomUUID(),
): Promise<Response> {
	const body = JSON.stringify(payload);
	return ctx.app.request(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...signed(ctx, user, "POST", path, { "Idempotency-Key": key }, body),
		},
		body,
	});
}

/** Direct-DB application insert for artifact/token tests (no HTTP submit).
 * Defaults match the artifact-lifecycle suite; pass overrides for the
 * trace suite. Nothing here is asserted — references stay unique. */
export async function insertApplication(
	database: Db,
	opts: { referencePrefix?: string; purpose?: string; applicantName?: string } = {},
): Promise<string> {
	const [row] = await database
		.insert(applications)
		.values({
			reference: `${opts.referencePrefix ?? "ART"}-${randomUUID()}`,
			applicantUserId: randomUUID(),
			type: "individual",
			product: "personal_loan",
			status: "submitted",
			amountCents: 1200000,
			termMonths: 48,
			purpose: opts.purpose ?? "artifact lifecycle test",
			identity: { fullName: opts.applicantName ?? "Artifact Tester" },
			consents: [true],
			submittedAt: new Date(),
		})
		.returning();
	return row.id;
}

/** Assigned-officer grant for document tests (both suites insert the same row). */
export async function grantOfficer(
	database: Db,
	applicationId: string,
	officer: TestUser,
): Promise<void> {
	await database.insert(caseAccessGrants).values({
		applicationId,
		userId: officer.id,
		accessRole: "assigned_officer",
	});
}

/** Submit an existing draft/application via the real endpoint. */
export function postSubmit(
	ctx: TestContext,
	user: TestUser,
	appId: string,
	key: string,
): Promise<Response> {
	return postApplication(ctx, user, `/api/applications/${appId}/submit`, {}, key);
}
