import type postgres from "postgres";

/** Production chunk embedding text: `title > heading > body`. The seed
 * importer, reindex, and eval corpus must embed exactly this string. */
export function embeddingText(section: { title: string; heading: string; body: string }): string {
	return `${section.title} > ${section.heading} > ${section.body}`;
}

export interface ChunkWriteSection {
	sectionId: string;
	heading: string;
	body: string;
	charStart: number;
	charEnd: number;
	contentHash: string;
}

export interface ChunkWriteInput {
	indexVersion: string;
	versionId: string;
	sections: ChunkWriteSection[];
	vectors: number[][];
	embeddingModel: string;
	embeddingDimensions: number;
	chunkingVersion: string;
}

/** Replace a version's chunks in an index generation. Column list and value
 * order match the seed importer exactly; callers validate embeddings first. */
export async function writeChunks(
	tx: postgres.TransactionSql,
	input: ChunkWriteInput,
): Promise<void> {
	await tx`DELETE FROM policy_chunks WHERE version_id = ${input.versionId} AND index_version = ${input.indexVersion}`;
	for (const [index, section] of input.sections.entries()) {
		const vector = input.vectors[index];
		if (!vector) throw new Error(`missing embedding for ${section.sectionId}`);
		await tx`
			INSERT INTO policy_chunks (
				index_version, version_id, section_id, chunk_index, heading, text,
				char_start, char_end, token_count, content_hash, chunking_version,
				embedding, embedding_model, embedding_dimensions, embedding_version
			) VALUES (
				${input.indexVersion}, ${input.versionId}, ${section.sectionId}, 0,
				${section.heading}, ${section.body}, ${section.charStart}, ${section.charEnd},
				${Math.max(1, Math.ceil(section.body.length / 4))}, ${section.contentHash},
				${input.chunkingVersion}, ${JSON.stringify(vector)}::vector, ${input.embeddingModel},
				${input.embeddingDimensions}, ${`${input.embeddingModel}:${input.embeddingDimensions}:${input.chunkingVersion}`}
			)
		`;
	}
}
