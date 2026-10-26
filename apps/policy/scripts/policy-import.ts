// Trusted draft import. It records the editor service as creator, never a
// human flag; approval is a separate authenticated API (and requires the
// active index to be rebuilt first). Validates registry refs + the 9.0-9.4
// standard hash against the union of the approved corpus and this draft.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { createDb } from "@credit/db";
import { POLICY_ENGINE_STANDARD_HASH, hashCanonical, validateRegistryRefs } from "@credit/core";
import { loadEnv } from "../src/env.js";
import { parsePolicyMarkdown } from "../src/markdown.js";

function arg(name: string): string | undefined {
	const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
	return hit?.slice(name.length + 3);
}

const file = arg("file");
if (!file)
	throw new Error("usage: policy-import.ts --file=apps/policy/policies/credit/POL-CR-001.md");
const env = loadEnv();
const parsed = parsePolicyMarkdown(readFileSync(file, "utf8"), file);
const fm = parsed.frontmatter;

const authUrl = env.authDatabaseUrl ?? "postgres://credit:credit@localhost:5432/credit_auth";
const auth = postgres(authUrl, { max: 1 });
let ownerId: string;
try {
	const rows =
		(await auth`SELECT id FROM users WHERE email = ${fm.owner_email} LIMIT 1`) as unknown as Array<{
			id: string;
		}>;
	if (!rows[0]) throw new Error(`owner not found in auth DB: ${fm.owner_email}`);
	ownerId = rows[0].id;
} finally {
	await auth.end();
}

const { sql } = createDb(env.databaseUrl);
try {
	// Validate before writing: approved corpus + this draft as the union.
	const approved = (await sql`
		SELECT d.policy_key, s.section_id, s.body, d.product_scope::text AS product_scope
		FROM policy_sections s
		JOIN policy_versions v ON v.id = s.version_id
		JOIN policy_documents d ON d.id = v.policy_id
		WHERE v.status = 'approved' AND d.domain = 'credit'
		  AND v.effective_from <= ${fm.effective_from}::date
		  AND (v.effective_to IS NULL OR v.effective_to >= ${fm.effective_from}::date)
		ORDER BY d.policy_key, s.section_id, v.effective_from DESC, v.id DESC
	`) as unknown as Array<{
		policy_key: string;
		section_id: string;
		body: string;
		product_scope: "individual" | "sme" | "all";
	}>;
	const draftCorpus = parsed.sections.map((section) => ({
		policyKey: fm.policy_key,
		sectionId: section.sectionId,
		productScope: fm.product_scope,
	}));
	const union = [
		...approved.map((row) => ({
			policyKey: row.policy_key,
			sectionId: row.section_id,
			productScope: row.product_scope,
		})),
		...draftCorpus.filter(
			(s) => !approved.some((r) => r.policy_key === s.policyKey && r.section_id === s.sectionId),
		),
	];
	const refs = new Set(union.map((s) => `${s.policyKey}#${s.sectionId}`));
	for (const kind of ["individual", "sme"] as const) {
		const v = validateRegistryRefs(refs, union, kind, true);
		if (
			v.missingRefs.length > 0 ||
			v.scopeMismatches.length > 0 ||
			v.missingExceptionRuleIds.length > 0
		) {
			throw new Error(
				`policy import registry validation failed for ${kind}: missing=${v.missingRefs.join(",")} scope=${v.scopeMismatches.join(",")}`,
			);
		}
	}
	// Standard hash over the union's POL-CR-009 9.0-9.4 bodies.
	const byKey = new Map<string, string>();
	for (const row of approved) {
		if (row.policy_key === "POL-CR-009") byKey.set(row.section_id, row.body);
	}
	if (fm.policy_key === "POL-CR-009") {
		for (const section of parsed.sections) byKey.set(section.sectionId, section.body);
	}
	const standardBodies = ["9.0", "9.1", "9.2", "9.3", "9.4"].map((sectionId) => {
		const body = byKey.get(sectionId);
		if (!body) throw new Error(`policy import: standard section missing: ${sectionId}`);
		return { sectionId, body };
	});
	if (hashCanonical(standardBodies) !== POLICY_ENGINE_STANDARD_HASH) {
		throw new Error("policy import: POL-CR-009 9.0-9.4 standard hash drift (STANDARD_CHANGED)");
	}

	await sql.begin(async (tx) => {
		const doc = (
			(await tx`
				INSERT INTO policy_documents (policy_key, title, domain, policy_family, product_scope, jurisdiction, owner_id)
				VALUES (${fm.policy_key}, ${fm.title}, 'credit', ${fm.policy_family}, ${fm.product_scope}, ${fm.jurisdiction}, ${ownerId})
				ON CONFLICT (policy_key) DO UPDATE
				SET title = EXCLUDED.title, policy_family = EXCLUDED.policy_family,
					product_scope = EXCLUDED.product_scope, jurisdiction = EXCLUDED.jurisdiction,
					owner_id = EXCLUDED.owner_id
				RETURNING id
			`) as unknown as Array<{ id: string }>
		)[0]!;
		const versionRows = (await tx`
			INSERT INTO policy_versions (
				policy_id, version, status, effective_from, effective_to,
				created_by_principal, created_by_user_id, created_via,
				source_commit, source_author, content_hash, source_uri
			) VALUES (
				${doc.id}, ${fm.version}, 'draft', NULL, NULL,
				${env.editorPrincipal}, NULL, 'cli_editor',
				NULL, ${fm.owner_email}, ${parsed.contentHash}, ${file}
			)
			ON CONFLICT (policy_id, version) DO UPDATE
			SET status = 'draft', effective_from = NULL, effective_to = NULL,
				content_hash = EXCLUDED.content_hash, source_uri = EXCLUDED.source_uri
			WHERE policy_versions.status = 'draft'
			RETURNING id
		`) as unknown as Array<{ id: string }>;
		const version = versionRows[0];
		if (!version)
			throw new Error("approved/retired versions cannot be overwritten by a draft import");
		await tx`DELETE FROM policy_sections WHERE version_id = ${version.id}`;
		await tx`DELETE FROM policy_chunks WHERE version_id = ${version.id}`;
		for (const section of parsed.sections) {
			await tx`
				INSERT INTO policy_sections (
					version_id, section_id, heading, body, order_index,
					char_start, char_end, content_hash
				) VALUES (
					${version.id}, ${section.sectionId}, ${section.heading}, ${section.body},
					${section.orderIndex}, ${section.charStart}, ${section.charEnd}, ${section.contentHash}
				)
			`;
		}
		await tx`
			INSERT INTO policy_acl (policy_id, principal_type, principal, permission)
			VALUES
				(${doc.id}, 'role', 'officer', 'read'),
				(${doc.id}, 'service', 'case_explain', 'case_explain'),
				(${doc.id}, 'user', ${ownerId}, 'admin')
			ON CONFLICT DO NOTHING
		`;
		await tx`
			INSERT INTO policy_approvals (version_id, actor_id, actor_principal, actor_role, action)
			VALUES (${version.id}, NULL, ${env.editorPrincipal}, 'service', 'draft_created')
		`;
	});
	console.log(
		`draft imported: ${fm.policy_key} ${fm.version} (${parsed.sections.length} sections)`,
	);
	console.log(
		"approval requires an active-index re-embed; no chunks were written by this draft import",
	);
} finally {
	await sql.end();
}
