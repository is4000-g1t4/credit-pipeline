// Integration setup: real Postgres (credit_research via compose), fake
// agent runner + stub support judge — no model/Tavily/Grafana network.
// Hermetic observability: OTEL_SDK_DISABLED + no OTLP endpoint.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

process.env.OTEL_SDK_DISABLED = "true";
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { randomUUID } from "node:crypto";
import { createDb } from "@credit/db/research";
import { createLogger, signInternalHeaders } from "@credit/service-kit";
import { stubAgentRunner, type FetchedEvidence } from "../src/agent.js";
import { createApp } from "../src/app.js";
import { stubCaseAssistantRunner } from "../src/case-assistant.js";
import { stubContextRunner } from "../src/context-agent.js";
import { loadEnv } from "../src/env.js";
import { getRun, type CaseFactsPayload } from "../src/lifecycle.js";
import { resetObservability, type Observability } from "../src/observability.js";
import { stubLanguageRepair } from "../src/repair.js";
import { stubSupportJudge } from "../src/support.js";

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
	secret: string;
}

export const OFFICER: TestUser = {
	id: randomUUID(),
	email: "officer@example.com",
	role: "officer",
};
export const APPLICANT: TestUser = {
	id: randomUUID(),
	email: "applicant@example.com",
	role: "applicant",
};

export function user(role: "applicant" | "officer" | "service"): TestUser {
	return { id: randomUUID(), email: `svc-${randomUUID()}@example.com`, role };
}

/** Hermetic observability double: executes, never dials OTLP. */
export const degradedObservability: Observability = {
	status: "degraded",
	hooksFor: () => ({ detach: () => {} }),
	trackModelCall: (_opts, fn) => fn(),
	trackToolExecution: (_opts, fn) => fn(),
};

/** Signed POST against the in-process app, as the P1b gateway would send. */
export async function post(
	ctx: TestContext,
	path: string,
	who: TestUser,
	payload: unknown,
): Promise<Response> {
	const body = JSON.stringify(payload);
	return ctx.app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json", ...signed(ctx, who, "POST", path, {}, body) },
		body,
	});
}

/** Signed GET against the in-process app. */
export async function get(ctx: TestContext, path: string, who: TestUser): Promise<Response> {
	return ctx.app.request(path, { headers: signed(ctx, who, "GET", path) });
}

/** Poll a background run until terminal (succeeded/failed). */
export async function waitRun(
	ctx: TestContext,
	runId: string,
	timeoutMs = 15_000,
): Promise<NonNullable<Awaited<ReturnType<typeof getRun>>>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const run = await getRun(ctx.db, runId);
		if (run && (run.status === "succeeded" || run.status === "failed")) return run;
		if (Date.now() > deadline) throw new Error(`run ${runId} did not settle`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** Signed internal headers for `app.request`, as the P1b gateway would send. */
export function signed(
	ctx: TestContext,
	who: TestUser,
	method: string,
	path: string,
	extra: Record<string, string> = {},
	body?: string,
): Record<string, string> {
	return {
		...signInternalHeaders(ctx.secret, {
			userId: who.id,
			role: who.role,
			email: who.email,
			method,
			path,
			body,
		}),
		...extra,
	};
}

export interface BriefFixture {
	brief: unknown;
	fetched: FetchedEvidence[];
}

/** One official + one news source, quotes embedded in raw content. */
export function successFixture(): BriefFixture {
	const quoteA = "Acme Ltd filed accounts for the year ending March 2025 on time.";
	const quoteB = "Local paper notes Acme Ltd opened a second warehouse in Leeds.";
	// Model dates appear verbatim in the page text, so date verification
	// resolves them as publisher_metadata.
	const rawA = `Published 2025-06-01.\nheader\n${quoteA}\nfooter `.repeat(20);
	const rawB = `Published 2025-05-01.\nintro\n${quoteB}\nmore text here `.repeat(20);
	return {
		brief: {
			summary: "Registry shows timely filings; local press notes expansion.",
			findings: [
				{
					// Deliberately a paraphrase, not a verbatim quote: the
					// validator may fast-path exact quotes without the judge.
					claim: "Acme Ltd's accounts for the year ending March 2025 were filed on time.",
					category: "registry",
					whyItMatters: "Timely filing is part of the public record.",
					allegationStatus: "unknown",
					entityMatch: {
						identifierType: "name_city",
						value: "Acme Ltd, Leeds",
						confidence: "medium",
					},
					evidenceLocalIds: ["ev-1"],
				},
				{
					claim: "Local press reported that Acme Ltd opened a second warehouse in Leeds.",
					category: "market",
					whyItMatters: "Expansion is context for the application.",
					allegationStatus: "unknown",
					entityMatch: {
						identifierType: "name_city",
						value: "Acme Ltd, Leeds",
						confidence: "medium",
					},
					evidenceLocalIds: ["ev-2"],
				},
			],
			evidence: [
				{
					localId: "ev-1",
					url: "https://find-and-update.company-information.service.gov.uk/company/123",
					title: "Acme Ltd filings",
					publisher: "Companies House",
					publishedAt: "2025-06-01",
					quote: quoteA,
				},
				{
					localId: "ev-2",
					url: "https://www.bbc.co.uk/news/acme-leeds",
					title: "Acme opens warehouse",
					publisher: "BBC",
					publishedAt: "2025-05-01",
					quote: quoteB,
				},
			],
			contradictions: [],
			unknowns: ["No adverse media found in the searched sources."],
			questionsForOfficer: [],
		},
		fetched: [
			{
				requestedUrl: "https://find-and-update.company-information.service.gov.uk/company/123",
				returnedUrl: "https://find-and-update.company-information.service.gov.uk/company/123",
				title: "Acme Ltd filings",
				searchPublishedDate: null,
				rawContent: rawA,
			},
			{
				requestedUrl: "https://www.bbc.co.uk/news/acme-leeds",
				returnedUrl: "https://www.bbc.co.uk/news/acme-leeds",
				title: "Acme opens warehouse",
				searchPublishedDate: null,
				rawContent: rawB,
			},
		],
	};
}

export function setupApp(
	fixture?: BriefFixture,
	overrides: {
		runner?: Parameters<typeof createApp>[0]["runner"];
		judge?: Parameters<typeof createApp>[0]["judge"];
		repair?: Parameters<typeof createApp>[0]["repair"];
		observability?: Parameters<typeof createApp>[0]["observability"];
		contextRunner?: Parameters<typeof createApp>[0]["contextRunner"];
		fetchContextConsent?: Parameters<typeof createApp>[0]["fetchContextConsent"];
		caseAssistant?: Parameters<typeof createApp>[0]["caseAssistant"];
		fetchResearchContext?: Parameters<typeof createApp>[0]["fetchResearchContext"];
		checkAssistantCaseAccess?: Parameters<typeof createApp>[0]["checkAssistantCaseAccess"];
		env?: Partial<ReturnType<typeof loadEnv>>;
	} = {},
): TestContext {
	resetObservability();
	// Context is off unless the test enables it, independent of the local
	// .env. setupContext() flips it on for the context suites.
	const env = { ...loadEnv(), agentsEnabled: true, contextEnabled: false };
	Object.assign(env, overrides.env);
	const { db, sql } = createDb(env.databaseUrl);
	const use = fixture ?? successFixture();
	const app = createApp({
		db,
		sql,
		env,
		logger: createLogger("research-test"),
		runner: overrides.runner ?? stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
		judge: overrides.judge ?? stubSupportJudge(),
		repair: overrides.repair ?? stubLanguageRepair(),
		observability: overrides.observability ?? degradedObservability,
		// Context is disabled unless the test enables it; the throwing
		// default proves the stage never runs then.
		contextRunner:
			overrides.contextRunner ??
			stubContextRunner({ outputs: [], throw: new Error("context stage must not run") }),
		fetchContextConsent: overrides.fetchContextConsent,
		caseAssistant:
			overrides.caseAssistant ??
			stubCaseAssistantRunner({
				outputs: [{ answer: "Test answer from the case assistant.", limitations: [] }],
			}),
		fetchResearchContext: overrides.fetchResearchContext,
		// No applications call in tests unless the case proves the gate.
		checkAssistantCaseAccess: overrides.checkAssistantCaseAccess ?? (async () => undefined),
	});
	return { app, db, sql, secret: env.internalSecret };
}

export function caseFacts(overrides: Partial<CaseFactsPayload> = {}): CaseFactsPayload {
	return {
		applicationId: randomUUID(),
		reference: "CR-2026-0001",
		type: "sme",
		product: "business_loan",
		amountCents: 500000,
		termMonths: 36,
		submittedAt: "2026-01-15T10:00:00.000Z",
		asOf: "2026-01-15T10:00:00.000Z",
		applicantName: "Jane Doe",
		companyName: "Acme Ltd",
		registrationNumber: "12345678",
		industry: "manufacturing",
		yearsTrading: 5,
		city: "Leeds",
		aiResearchConsent: true,
		status: "pending_review",
		...overrides,
	};
}

export async function teardown(ctx: TestContext): Promise<void> {
	await ctx.sql.end();
}
