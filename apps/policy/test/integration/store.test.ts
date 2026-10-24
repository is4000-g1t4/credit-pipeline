// DB-backed store contract: ACL/role filtering, section drawer reads, case-token
// replay, and the budget reservation/settlement SQL. The route tests stub the
// store, so these are the only checks on the real queries.
import { randomUUID } from "node:crypto";
import { createDb } from "@credit/db/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";
import { createPostgresPolicyStore } from "../../src/postgres-store.js";

const env = loadEnv();
const { sql } = createDb(env.databaseUrl);
const store = createPostgresPolicyStore(sql);

const policyId = randomUUID();
const versionId = randomUUID();
const actorId = randomUUID();
const policyKey = `test-store-${randomUUID()}`;
const day = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
	await sql`
		INSERT INTO policy_documents (id, policy_key, title, domain, policy_family, product_scope, jurisdiction, owner_id)
		VALUES (${policyId}, ${policyKey}, 'Store contract test', 'credit', 'underwriting', 'individual', 'SG', ${actorId})
	`;
	await sql`
		INSERT INTO policy_versions (
			id, policy_id, version, status, effective_from, created_by_principal,
			created_via, content_hash, source_uri
		) VALUES (
			${versionId}, ${policyId}, 'v1', 'approved', '2026-01-01', 'service:policy_editor',
			'api', 'hash-test', 'test://store'
		)
	`;
	await sql`
		INSERT INTO policy_sections (version_id, section_id, heading, body, order_index, char_start, char_end, content_hash)
		VALUES
			(${versionId}, '1', 'Purpose', 'Purpose body.', 0, 0, 13, 'h1'),
			(${versionId}, '2', 'Scope', 'Scope body.', 1, 14, 25, 'h2')
	`;
	await sql`
		INSERT INTO policy_acl (policy_id, principal_type, principal, permission)
		VALUES
			(${policyId}, 'role', 'officer', 'read'),
			(${policyId}, 'role', 'applicant', 'read')
	`;
	await sql`
		UPDATE policy_acl SET revoked_at = now()
		WHERE policy_id = ${policyId} AND principal = 'applicant'
	`;
	await sql`
		INSERT INTO policy_roles (user_id, role, granted_via)
		VALUES
			(${actorId}, 'compliance', 'ops_cli'),
			(${actorId}, 'policy_owner', 'ops_cli')
	`;
	await sql`
		UPDATE policy_roles SET revoked_at = now()
		WHERE user_id = ${actorId} AND role = 'policy_owner'
	`;
});

afterAll(async () => {
	await sql`DELETE FROM policy_case_token_uses WHERE run_id = ${versionId}`;
	await sql`DELETE FROM policy_spend_reservations WHERE actor_id = ${actorId}`;
	await sql`DELETE FROM policy_queries WHERE actor_id = ${actorId}`;
	await sql`DELETE FROM policy_sections WHERE version_id = ${versionId}`;
	await sql`DELETE FROM policy_versions WHERE id = ${versionId}`;
	await sql`DELETE FROM policy_acl WHERE policy_id = ${policyId}`;
	await sql`DELETE FROM policy_documents WHERE id = ${policyId}`;
	await sql`DELETE FROM policy_roles WHERE user_id = ${actorId}`;
	await sql.end();
});

describe("postgres policy store", () => {
	it("returns only active ACLs and roles", async () => {
		const acls = await store.loadAcls([policyId]);
		expect(acls).toEqual([
			{ policyId, principalType: "role", principal: "officer", permission: "read" },
		]);
		expect(await store.loadPolicyRoles(actorId)).toEqual(["compliance"]);
	});

	it("reads a section with ordered neighbours", async () => {
		const section = await store.getSection(versionId, "2");
		expect(section).toMatchObject({
			policyId,
			policyKey,
			version: "v1",
			status: "approved",
			sectionId: "2",
			heading: "Scope",
			body: "Scope body.",
		});
		expect(section?.neighbours).toEqual([
			{ sectionId: "1", heading: "Purpose" },
			{ sectionId: "2", heading: "Scope" },
		]);
		expect(await store.getSection(versionId, "9.9")).toBeNull();
	});

	it("consumes a case token exactly once", async () => {
		const jti = randomUUID();
		expect(await store.consumeCaseToken(jti, versionId, policyId)).toBe(true);
		expect(await store.consumeCaseToken(jti, versionId, policyId)).toBe(false);
	});

	it("rejects over-cap spend and releases settled reservations", async () => {
		const over = await store.reserveBudget({
			day,
			budgetClass: "navigator",
			actorId,
			maxCostUsd: 1,
			dailyCapUsd: 0.001,
			actorCapUsd: 0,
			ttlSeconds: 60,
		});
		expect(over).toEqual({ error: "budget_exceeded" });

		const ok = await store.reserveBudget({
			day,
			budgetClass: "navigator",
			actorId,
			maxCostUsd: 0.5,
			dailyCapUsd: 1_000,
			actorCapUsd: 1_000,
			ttlSeconds: 60,
		});
		expect("reservationId" in ok).toBe(true);
		if (!("reservationId" in ok)) return;
		await store.settleBudget(ok.reservationId, 0.1);
		const settled = (await sql`
			SELECT settled_at FROM policy_spend_reservations WHERE id = ${ok.reservationId}
		`) as unknown as Array<{ settled_at: Date | null }>;
		expect(settled[0]?.settled_at).not.toBeNull();

		// A settled reservation no longer counts, so another reservation fits.
		const next = await store.reserveBudget({
			day,
			budgetClass: "navigator",
			actorId,
			maxCostUsd: 0.5,
			dailyCapUsd: 1_000,
			actorCapUsd: 1_000,
			ttlSeconds: 60,
		});
		expect("reservationId" in next).toBe(true);
	});
});
