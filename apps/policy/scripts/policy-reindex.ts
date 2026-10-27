// Re-embed one policy version into the active index generation.
// Usage: pnpm --filter @credit/policy reindex -- --version=<versionId>
import { createDb } from "@credit/db";
import { loadEnv } from "../src/env.js";
import { createOpenRouterEmbedder, openRouterConfigFromEnv } from "../src/openrouter.js";
import { embeddingText, writeChunks } from "../src/chunks.js";

function arg(name: string): string | undefined {
	const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
	return hit?.slice(name.length + 3);
}

const versionId = arg("version");
if (!versionId) throw new Error("usage: policy-reindex.ts --version=<versionId>");
const env = loadEnv();
if (env.embeddingDimensions !== 1024) {
	throw new Error(
		`policy reindex expects the current schema dimension 1024; env has ${env.embeddingDimensions}. Regenerate the migration first.`,
	);
}

const { sql } = createDb(env.databaseUrl);
try {
	const meta = (await sql`
		SELECT index_version, embedding_model, embedding_dimensions, chunking_version
		FROM policy_index_meta WHERE status = 'active' LIMIT 1
	`) as unknown as Array<{
		index_version: string;
		embedding_model: string;
		embedding_dimensions: number;
		chunking_version: string;
	}>;
	const active = meta[0];
	if (!active) throw new Error("policy reindex: no active index generation");
	if (
		active.embedding_model !== env.embeddingModel ||
		active.embedding_dimensions !== env.embeddingDimensions
	) {
		throw new Error(
			`policy reindex: env embedding ${env.embeddingModel}/${env.embeddingDimensions} does not match active ${active.embedding_model}/${active.embedding_dimensions}`,
		);
	}
	const sections = (await sql`
		SELECT s.section_id, s.heading, s.body, s.char_start, s.char_end, s.content_hash,
			d.title, v.version
		FROM policy_sections s
		JOIN policy_versions v ON v.id = s.version_id
		JOIN policy_documents d ON d.id = v.policy_id
		WHERE s.version_id = ${versionId}
		ORDER BY s.order_index
	`) as unknown as Array<{
		section_id: string;
		heading: string;
		body: string;
		char_start: number;
		char_end: number;
		content_hash: string;
		title: string;
		version: string;
	}>;
	if (sections.length === 0)
		throw new Error(`policy reindex: version has no sections: ${versionId}`);
	const embedder = createOpenRouterEmbedder(openRouterConfigFromEnv(env));
	const vectors = await embedder.embed(sections.map((s) => embeddingText(s)));
	for (const [i, section] of sections.entries()) {
		const vector = vectors[i];
		if (!vector || vector.length !== env.embeddingDimensions) {
			throw new Error(
				`policy reindex: embedding dimension mismatch for ${section.section_id} (expected ${env.embeddingDimensions}, got ${vector?.length ?? 0})`,
			);
		}
	}
	await sql.begin(async (tx) => {
		await writeChunks(tx, {
			indexVersion: active.index_version,
			versionId,
			sections: sections.map((s) => ({
				sectionId: s.section_id,
				heading: s.heading,
				body: s.body,
				charStart: s.char_start,
				charEnd: s.char_end,
				contentHash: s.content_hash,
			})),
			vectors,
			embeddingModel: env.embeddingModel,
			embeddingDimensions: env.embeddingDimensions,
			chunkingVersion: active.chunking_version,
		});
	});
	console.log(
		`reindex: version ${versionId} (${sections.length} sections) into ${active.index_version} (${active.embedding_model}, ${active.embedding_dimensions})`,
	);
} finally {
	await sql.end();
}
