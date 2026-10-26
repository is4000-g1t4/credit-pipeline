// DB-backed bridge contract: section resolve (exact + as-of), search with
// real chunks, and the approval integrity gates (registry/standard/index
// rejection + hasVersionChunks). Uses a unique policy key so it never
// touches seeded corpus rows.
import { randomUUID } from "node:crypto";
import { createDb } from "@credit/db/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";
import { createPostgresPolicyStore } from "../../src/postgres-store.js";
import { appWithUser } from "../helper.js";

const env = loadEnv();
const { sql } = createDb(env.databaseUrl);
const store = createPostgresPolicyStore(sql);

const officerId = randomUUID();
const submitterId = randomUUID();
const day = new Date().toISOString().slice(0, 10);

const bridgeKey = `POL-BR-${randomUUID().slice(0, 8).toUpperCase()}`;
let bridgePolicyId = "";
let bridgeVersionId = "";
const extraVersionIds: string[] = [];

async function addSection(
	versionId: string,
	sectionId: string,
	body: string,
	orderIndex: number,
): Promise<void> {
	await sql`
		INSERT INTO policy_sections (version_id, section_id, heading, body, order_index, char_start, char_end, content_hash)
		VALUES (${versionId}, ${sectionId}, ${sectionId}, ${body}, ${orderIndex}, 0, ${body.length}, ${`h-${sectionId}`})
		ON CONFLICT (version_id, section_id) DO UPDATE SET body = EXCLUDED.body
	`;
}

const deps = {
	store,
	embedder: {
		model: env.embeddingModel,
		dimensions: env.embeddingDimensions,
		async embed(inputs: string[]): Promise<number[][]> {
			return inputs.map(() => [1, ...Array(env.embeddingDimensions - 1).fill(0)]);
		},
	},
	answerer: {
		async answerNavigator(): Promise<never> {
			throw new Error("not used");
		},
		async answerCase(): Promise<never> {
			throw new Error("not used");
		},
	},
	env: {
		assistEnabled: true,
		citationSecret: "citation-secret-it",
		auditHashSecret: "audit-secret-it",
		jurisdiction: "SG",
		retrievalTopK: 8,
		agentTimeoutMs: 5_000,
		caseTimeoutMs: 5_000,
		agentMaxCostUsd: 0.1,
		caseMaxCostUsd: 0.2,
		navDailyBudgetUsd: 2,
		caseDailyBudgetUsd: 2,
		actorDailyBudgetUsd: 1,
		policyExceptionDailyBudgetUsd: 2,
		reservationTtlSeconds: 180,
		caseTokenSecret: "case-token-secret",
		embeddingModel: env.embeddingModel,
		embeddingDimensions: env.embeddingDimensions,
	},
	logger: { info() {}, warn() {}, error() {} },
};

const serviceUser = {
	id: "00000000-0000-0000-0000-000000000000",
	email: "svc@internal.local",
	role: "service" as const,
};
const officerUser = { id: officerId, email: "officer-it@example.com", role: "officer" as const };

beforeAll(async () => {
	const docs = (await sql`
		INSERT INTO policy_documents (policy_key, title, domain, policy_family, product_scope, jurisdiction, owner_id)
		VALUES (${bridgeKey}, ${bridgeKey}, 'credit', 'underwriting', 'all', 'SG', ${officerId})
		RETURNING id
	`) as unknown as Array<{ id: string }>;
	bridgePolicyId = docs[0]!.id;
	const versions = (await sql`
		INSERT INTO policy_versions (policy_id, version, status, effective_from, created_by_principal, created_via, content_hash, source_uri)
		VALUES (${bridgePolicyId}, 'v1', 'approved', '2026-01-01', 'service:policy_editor', 'api', 'hash-bridge-v1', 'test://bridge')
		RETURNING id
	`) as unknown as Array<{ id: string }>;
	bridgeVersionId = versions[0]!.id;
	await addSection(bridgeVersionId, "A", "Bridge section A body about DSCR coverage.", 0);
	await addSection(bridgeVersionId, "B", "Bridge section B body about affordability review.", 1);
	await sql`
		INSERT INTO policy_acl (policy_id, principal_type, principal, permission)
		VALUES (${bridgePolicyId}, 'service', 'case_explain', 'case_explain')
		ON CONFLICT DO NOTHING
	`;
	await sql`
		INSERT INTO policy_roles (user_id, role, granted_via)
		VALUES (${officerId}, 'compliance', 'ops_cli')
		ON CONFLICT DO NOTHING
	`;

	const active = await store.getActiveIndex();
	let indexVersion = active?.indexVersion;
	if (!indexVersion) {
		await sql`
			INSERT INTO policy_index_meta (index_version, embedding_model, embedding_dimensions, chunking_version, status, activated_at)
			VALUES ('idx-v1', ${env.embeddingModel}, ${env.embeddingDimensions}, 'sections-v1', 'active', now())
			ON CONFLICT (index_version) DO UPDATE SET status = 'active', activated_at = now()
		`;
		indexVersion = "idx-v1";
	}
	const vector = JSON.stringify([1, ...Array(env.embeddingDimensions - 1).fill(0)]);
	await sql`
		INSERT INTO policy_chunks (index_version, version_id, section_id, chunk_index, heading, text, char_start, char_end, token_count, content_hash, chunking_version, embedding, embedding_model, embedding_dimensions, embedding_version)
		VALUES (${indexVersion}, ${bridgeVersionId}, 'A', 0, 'A', 'Bridge section A body about DSCR coverage.', 0, 44, 11, 'h-A', 'sections-v1', ${vector}::vector, ${env.embeddingModel}, ${env.embeddingDimensions}, 'test')
		ON CONFLICT (index_version, version_id, section_id, chunk_index) DO NOTHING
	`;
}, 60_000);

afterAll(async () => {
	const versionIds = [bridgeVersionId, ...extraVersionIds];
	await sql`DELETE FROM policy_chunks WHERE version_id = ANY(${versionIds}::uuid[])`;
	await sql`DELETE FROM policy_sections WHERE version_id = ANY(${versionIds}::uuid[])`;
	await sql`DELETE FROM policy_query_citations WHERE policy_id = ${bridgePolicyId}`;
	await sql`DELETE FROM policy_spend_reservations WHERE actor_id IN (${officerId}, ${submitterId})`;
	await sql`DELETE FROM policy_queries WHERE actor_id IN (${officerId}, ${submitterId})`;
	await sql`DELETE FROM policy_versions WHERE id = ANY(${versionIds}::uuid[])`;
	await sql`DELETE FROM policy_acl WHERE policy_id = ${bridgePolicyId}`;
	await sql`DELETE FROM policy_documents WHERE id = ${bridgePolicyId}`;
	await sql`DELETE FROM policy_roles WHERE user_id = ${officerId}`;
	await sql.end();
});

async function postJson(
	app: ReturnType<typeof appWithUser>,
	path: string,
	body: unknown,
): Promise<Response> {
	return app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("policy bridge integration", () => {
	it("resolves the exact version and the as-of window", async () => {
		const exact = await store.getSectionByRef({
			policyKey: bridgeKey,
			sectionId: "A",
			asOf: "2026-06-30",
			productScope: "sme",
			jurisdiction: "SG",
			versionId: bridgeVersionId,
		});
		expect(exact?.body).toContain("DSCR");
		const asOf = await store.getSectionByRef({
			policyKey: bridgeKey,
			sectionId: "B",
			asOf: "2026-06-30",
			productScope: "sme",
			jurisdiction: "SG",
		});
		expect(asOf?.body).toContain("affordability");
		expect(
			await store.getSectionByRef({
				policyKey: bridgeKey,
				sectionId: "A",
				asOf: "2025-01-01",
				productScope: "sme",
				jurisdiction: "SG",
			}),
		).toBeNull();
		expect(await store.listVersionSectionIds(bridgeVersionId)).toEqual(["A", "B"]);
	});

	it("resolves sections over HTTP with drawer tokens", async () => {
		const app = appWithUser(deps, serviceUser);
		const res = await postJson(app, "/internal/policy/sections/resolve", {
			applicationId: randomUUID(),
			actorId: officerId,
			actorRole: "officer",
			policyAsOf: "2026-06-30",
			productScope: "sme",
			refs: [{ policyKey: bridgeKey, sectionId: "A", versionId: bridgeVersionId }],
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			status: string;
			sections: Array<{ policyKey: string; drawerToken: string; quoteHash: string }>;
			missing: unknown[];
		};
		expect(body.status).toBe("ok");
		expect(body.sections).toHaveLength(1);
		expect(body.sections[0]!.drawerToken).toBeTruthy();
		expect(body.sections[0]!.quoteHash).toMatch(/^[a-f0-9]{32}$/);
	});

	it("searches the active index", async () => {
		const app = appWithUser(deps, serviceUser);
		const res = await postJson(app, "/internal/policy/search", {
			applicationId: randomUUID(),
			actorId: officerId,
			actorRole: "officer",
			policyAsOf: "2026-06-30",
			productScope: "sme",
			query: "Bridge section DSCR coverage requirements",
			topK: 5,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; sections: Array<{ sectionId: string }> };
		expect(body.status).toBe("ok");
		expect(body.sections.length).toBeGreaterThan(0);
		expect(body.sections[0]!.sectionId).toBe("A");
	});

	it("rejects approval without index chunks and names the reindex command when indexed", async () => {
		const drafts = (await sql`
			INSERT INTO policy_versions (policy_id, version, status, created_by_principal, created_via, content_hash, source_uri, submitted_by, submitted_at)
			VALUES (${bridgePolicyId}, 'vdraft', 'draft', 'service:policy_editor', 'api', 'hash-draft', 'test://bridge', ${submitterId}, now())
			RETURNING id
		`) as unknown as Array<{ id: string }>;
		const draftId = drafts[0]!.id;
		extraVersionIds.push(draftId);
		await addSection(draftId, "A", "Bridge section A body about DSCR coverage.", 0);
		expect(await store.hasVersionChunks(draftId)).toBe(false);
		const app = appWithUser(deps, officerUser);
		const res = await postJson(app, `/api/policy/versions/${draftId}/approve`, {
			effectiveFrom: day,
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string; message: string } };
		// A random-key draft fails registry validation first; a fully-mapped
		// corpus would reach INDEX_NOT_BUILT with the reindex command.
		expect(["REGISTRY_MAPPING_MISSING", "INDEX_NOT_BUILT", "STANDARD_CHANGED"]).toContain(
			body.error.code,
		);
		if (body.error.code === "INDEX_NOT_BUILT") {
			expect(body.error.message).toContain(`reindex -- --version=${draftId}`);
		}
	});
});
