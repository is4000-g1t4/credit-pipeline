// Demo seed: load the reviewed Markdown corpus into credit_policy as approved
// documents. Insert-only: never resurrect/retire/change status; a conflicting
// (policy_id, version) with a different content_hash refuses and requires a
// version bump. Validates registry refs + the 9.0-9.4 standard hash first.
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "@credit/db";
import { POLICY_ENGINE_STANDARD_HASH, hashCanonical, validateRegistryRefs } from "@credit/core";
import postgres from "postgres";
import { loadEnv } from "../src/env.js";
import { parsePolicyMarkdown } from "../src/markdown.js";
import { createOpenRouterEmbedder } from "../src/openrouter.js";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const POLICY_DIR = join(HERE, "policies", "credit");
const INDEX_VERSION = "idx-v1";
const CHUNKING_VERSION = "sections-v1";

const env = loadEnv();
if (!env.demoMode && !process.argv.includes("--force")) {
	throw new Error("policy seed is demo-only; set DEMO_MODE=true or pass --force");
}
if (env.embeddingDimensions !== 1024) {
	throw new Error(
		`policy seed expects the current schema dimension 1024; env has ${env.embeddingDimensions}. Regenerate the migration first.`,
	);
}

async function demoUserIds(): Promise<{ owner: string; approver: string }> {
	const url = env.authDatabaseUrl ?? "postgres://credit:credit@localhost:5432/credit_auth";
	const auth = postgres(url, { max: 1 });
	try {
		const rows = (await auth`
			SELECT id, email FROM users WHERE email IN ('officer@example.com','senior.officer@example.com')
		`) as unknown as Array<{ id: string; email: string }>;
		const byEmail = new Map(rows.map((row) => [row.email, row.id]));
		const owner = byEmail.get("officer@example.com");
		const approver = byEmail.get("senior.officer@example.com");
		if (owner && approver) return { owner, approver };
	} catch {
		// Fall through to fixed ids for a database-only seed.
	} finally {
		await auth.end();
	}
	console.warn("policy seed: demo officer users not found; using fixed audit ids");
	return {
		owner: "11111111-1111-4111-8111-111111111111",
		approver: "22222222-2222-4222-8222-222222222222",
	};
}

const files = readdirSync(POLICY_DIR)
	.filter((name) => name.endsWith(".md"))
	.sort();
if (files.length === 0) throw new Error(`no policy Markdown under ${POLICY_DIR}`);

const parsedAll = files.map((file) => ({
	file,
	parsed: parsePolicyMarkdown(readFileSync(join(POLICY_DIR, file), "utf8"), file),
}));

// Validate registry refs against the parsed corpus for both kinds before writing.
{
	const corpus = parsedAll.flatMap(({ parsed }) =>
		parsed.sections.map((section) => ({
			policyKey: parsed.frontmatter.policy_key,
			sectionId: section.sectionId,
			productScope: parsed.frontmatter.product_scope,
		})),
	);
	const refs = new Set(corpus.map((s) => `${s.policyKey}#${s.sectionId}`));
	for (const kind of ["individual", "sme"] as const) {
		const v = validateRegistryRefs(refs, corpus, kind, true);
		if (
			v.missingRefs.length > 0 ||
			v.scopeMismatches.length > 0 ||
			v.missingExceptionRuleIds.length > 0
		) {
			throw new Error(
				`policy seed registry validation failed for ${kind}: missing=${v.missingRefs.join(",")} scope=${v.scopeMismatches.join(",")}`,
			);
		}
	}
	const std = parsedAll.find((p) => p.parsed.frontmatter.policy_key === "POL-CR-009");
	if (!std) throw new Error("policy seed: POL-CR-009 is missing from the corpus");
	const bodies = std.parsed.sections
		.filter((s) => ["9.0", "9.1", "9.2", "9.3", "9.4"].includes(s.sectionId))
		.map((s) => ({ sectionId: s.sectionId, body: s.body }))
		.sort((a, b) => (a.sectionId < b.sectionId ? -1 : 1));
	if (bodies.length !== 5) throw new Error("policy seed: POL-CR-009 must have sections 9.0-9.4");
	if (hashCanonical(bodies) !== POLICY_ENGINE_STANDARD_HASH) {
		throw new Error("policy seed: POL-CR-009 9.0-9.4 standard hash drift (STANDARD_CHANGED)");
	}
}

const { owner, approver } = await demoUserIds();
const { sql } = createDb(env.databaseUrl);
const embedder = createOpenRouterEmbedder({
	apiKey: env.openrouterApiKey,
	baseUrl: env.openrouterBaseUrl,
	model: env.agentModel,
	dimensions: env.embeddingDimensions,
	embeddingModel: env.embeddingModel,
	temperature: env.agentTemperature,
	maxOutputTokens: env.agentMaxOutputTokens,
	embeddingProviders: env.embeddingProviders ? env.embeddingProviders.split(",") : [],
	answererProviderOrder: [],
});

try {
	await sql.begin(async (tx) => {
		await tx`
			INSERT INTO policy_index_meta (index_version, embedding_model, embedding_dimensions, chunking_version, status, activated_at)
			VALUES (${INDEX_VERSION}, ${env.embeddingModel}, ${env.embeddingDimensions}, ${CHUNKING_VERSION}, 'building', NULL)
			ON CONFLICT (index_version) DO UPDATE
			SET embedding_model = EXCLUDED.embedding_model,
				embedding_dimensions = EXCLUDED.embedding_dimensions,
				chunking_version = EXCLUDED.chunking_version
		`;
		await tx`UPDATE policy_index_meta SET status = 'retired' WHERE status = 'active' AND index_version <> ${INDEX_VERSION}`;
		await tx`UPDATE policy_index_meta SET status = 'active', activated_at = now() WHERE index_version = ${INDEX_VERSION}`;

		for (const { file, parsed } of parsedAll) {
			const fm = parsed.frontmatter;
			const doc = (
				(await tx`
					INSERT INTO policy_documents (policy_key, title, domain, policy_family, product_scope, jurisdiction, owner_id)
					VALUES (${fm.policy_key}, ${fm.title}, 'credit', ${fm.policy_family}, ${fm.product_scope}, ${fm.jurisdiction}, ${owner})
					ON CONFLICT (policy_key) DO UPDATE
					SET title = EXCLUDED.title, policy_family = EXCLUDED.policy_family,
						product_scope = EXCLUDED.product_scope, jurisdiction = EXCLUDED.jurisdiction,
						owner_id = EXCLUDED.owner_id
					RETURNING id
				`) as unknown as Array<{ id: string }>
			)[0]!;
			const existing = (await tx`
				SELECT id, status::text AS status, content_hash FROM policy_versions
				WHERE policy_id = ${doc.id} AND version = ${fm.version}
				LIMIT 1
			`) as unknown as Array<{ id: string; status: string; content_hash: string }>;
			const hit = existing[0];
			if (hit) {
				if (hit.status === "retired") {
					throw new Error(
						`policy seed refuses to resurrect retired ${fm.policy_key} ${fm.version}`,
					);
				}
				if (hit.content_hash !== parsed.contentHash) {
					throw new Error(
						`policy seed refuses to mutate ${fm.policy_key} ${fm.version} with a different content_hash; bump the version`,
					);
				}
				const chunkCount =
					(
						(await tx`
						SELECT count(*)::int AS n FROM policy_chunks
						WHERE version_id = ${hit.id} AND index_version = ${INDEX_VERSION}
						  AND embedding_model = ${env.embeddingModel}
						  AND embedding_dimensions = ${env.embeddingDimensions}
						  AND chunking_version = ${CHUNKING_VERSION}
					`) as unknown as Array<{ n: number }>
					)[0]?.n ?? 0;
				if (chunkCount >= parsed.sections.length) {
					console.log(`seed: ${fm.policy_key} ${fm.version} unchanged (no-op)`);
					continue;
				}
				// Unchanged policy but the active generation is missing chunks
				// (e.g. a previous seed was interrupted): re-embed this version
				// only, never the whole corpus.
				await tx`DELETE FROM policy_chunks WHERE version_id = ${hit.id} AND index_version = ${INDEX_VERSION}`;
				const vectors = await embedder.embed(
					parsed.sections.map((section) => `${fm.title} > ${section.heading} > ${section.body}`),
				);
				for (const [index, section] of parsed.sections.entries()) {
					const vector = vectors[index];
					if (!vector)
						throw new Error(`missing embedding for ${fm.policy_key}#${section.sectionId}`);
					await tx`
						INSERT INTO policy_chunks (
							index_version, version_id, section_id, chunk_index, heading, text,
							char_start, char_end, token_count, content_hash, chunking_version,
							embedding, embedding_model, embedding_dimensions, embedding_version
						) VALUES (
							${INDEX_VERSION}, ${hit.id}, ${section.sectionId}, 0,
							${section.heading}, ${section.body}, ${section.charStart}, ${section.charEnd},
							${Math.max(1, Math.ceil(section.body.length / 4))}, ${section.contentHash},
							${CHUNKING_VERSION}, ${JSON.stringify(vector)}::vector, ${env.embeddingModel},
							${env.embeddingDimensions}, ${`${env.embeddingModel}:${env.embeddingDimensions}:${CHUNKING_VERSION}`}
						)
					`;
				}
				console.log(`seed: ${fm.policy_key} ${fm.version} chunks re-embedded`);
				continue;
			}
			const version = (
				(await tx`
					INSERT INTO policy_versions (
						policy_id, version, status, effective_from, effective_to,
						created_by_principal, created_by_user_id, created_via,
						source_commit, source_author, submitted_by, submitted_at,
						approved_by, approved_at, content_hash, source_uri
					) VALUES (
						${doc.id}, ${fm.version}, 'approved', ${fm.effective_from}::date, NULL,
						${env.editorPrincipal}, NULL, 'demo_seed',
						NULL, 'demo-seed', ${owner}, now(), ${approver}, now(),
						${parsed.contentHash}, ${file}
					)
					RETURNING id
				`) as unknown as Array<{ id: string }>
			)[0]!;
			// Close prior approved windows (same window logic as approveVersion).
			await tx`
				UPDATE policy_versions
				SET effective_to = (${fm.effective_from}::date - 1)
				WHERE policy_id = ${doc.id} AND status = 'approved' AND id <> ${version.id}
				  AND effective_from < ${fm.effective_from}::date
				  AND (effective_to IS NULL OR effective_to >= ${fm.effective_from}::date)
			`;
			const vectors = await embedder.embed(
				parsed.sections.map((section) => `${fm.title} > ${section.heading} > ${section.body}`),
			);
			await tx`DELETE FROM policy_chunks WHERE version_id = ${version.id} AND index_version = ${INDEX_VERSION}`;
			for (const [index, section] of parsed.sections.entries()) {
				const vector = vectors[index];
				if (!vector) throw new Error(`missing embedding for ${fm.policy_key}#${section.sectionId}`);
				await tx`
					INSERT INTO policy_sections (
						version_id, section_id, heading, body, order_index,
						char_start, char_end, content_hash
					) VALUES (
						${version.id}, ${section.sectionId}, ${section.heading}, ${section.body},
						${section.orderIndex}, ${section.charStart}, ${section.charEnd}, ${section.contentHash}
					)
				`;
				await tx`
					INSERT INTO policy_chunks (
						index_version, version_id, section_id, chunk_index, heading, text,
						char_start, char_end, token_count, content_hash, chunking_version,
						embedding, embedding_model, embedding_dimensions, embedding_version
					) VALUES (
						${INDEX_VERSION}, ${version.id}, ${section.sectionId}, 0,
						${section.heading}, ${section.body}, ${section.charStart}, ${section.charEnd},
						${Math.max(1, Math.ceil(section.body.length / 4))}, ${section.contentHash},
						${CHUNKING_VERSION}, ${JSON.stringify(vector)}::vector, ${env.embeddingModel},
						${env.embeddingDimensions}, ${`${env.embeddingModel}:${env.embeddingDimensions}:${CHUNKING_VERSION}`}
					)
				`;
			}
			await tx`
				INSERT INTO policy_acl (policy_id, principal_type, principal, permission, granted_by)
				VALUES
					(${doc.id}, 'role', 'officer', 'read', NULL),
					(${doc.id}, 'service', 'case_explain', 'case_explain', NULL),
					(${doc.id}, 'user', ${owner}, 'admin', NULL),
					(${doc.id}, 'user', ${approver}, 'admin', NULL)
				ON CONFLICT DO NOTHING
			`;
			console.log(`seed: ${fm.policy_key} ${fm.version} (${parsed.sections.length} sections)`);
		}

		await tx`
			INSERT INTO policy_roles (user_id, role, granted_by, granted_via)
			VALUES
				(${owner}, 'policy_owner', NULL, 'bootstrap'),
				(${approver}, 'compliance', NULL, 'bootstrap')
			ON CONFLICT DO NOTHING
		`;
	});
	console.log(
		`seed: active index ${INDEX_VERSION} (${env.embeddingModel}, ${env.embeddingDimensions})`,
	);
} finally {
	await sql.end();
}
