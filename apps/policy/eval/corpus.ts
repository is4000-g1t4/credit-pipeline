// Eval-only corpus loader. Uses the production Markdown parser so frontmatter,
// anchors, duplicate-section checks, and empty bodies behave exactly like the
// importer; the DB is replaced by in-memory chunks.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RetrievedSection } from "../src/answer.js";
import { readPolicyDir } from "../src/markdown.js";
import type { PolicyChunk } from "../src/store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICIES_DIR = path.join(HERE, "..", "policies", "credit");

export interface CorpusSection extends PolicyChunk {
	policyFamily: string;
	productScope: string;
	jurisdiction: string;
	status: "approved";
}

/** One section = one chunk, matching the seed importer's v1 chunking. */
export function loadCorpus(): CorpusSection[] {
	const out: CorpusSection[] = [];
	for (const policy of readPolicyDir(POLICIES_DIR)) {
		const fm = policy.frontmatter;
		const policyVersionId = `${fm.policy_key}@${fm.version}`;
		for (const section of policy.sections) {
			out.push({
				chunkId: `${policyVersionId}#${section.sectionId}`,
				indexVersion: "eval",
				policyId: fm.policy_key,
				policyVersionId,
				policyKey: fm.policy_key,
				title: fm.title,
				sectionId: section.sectionId,
				heading: section.heading,
				version: fm.version,
				effectiveFrom: fm.effective_from,
				effectiveTo: null,
				body: section.body,
				policyFamily: fm.policy_family,
				productScope: fm.product_scope,
				jurisdiction: fm.jurisdiction,
				status: "approved",
				embedding: [],
				embeddingModel: "",
				embeddingDimensions: 0,
				chunkingVersion: "eval-v1",
			});
		}
	}
	return out;
}

/** Production embeds `title > heading > body`; match it exactly. */
export function embeddingText(section: RetrievedSection): string {
	return `${section.title} > ${section.heading} > ${section.body}`;
}

export async function embedCorpus(
	sections: CorpusSection[],
	embedder: { embed(inputs: string[], opts?: { conversationId?: string }): Promise<number[][]> },
	model: string,
	dimensions: number,
	batchSize = 16,
): Promise<void> {
	for (let i = 0; i < sections.length; i += batchSize) {
		const batch = sections.slice(i, i + batchSize);
		const vectors = await embedder.embed(batch.map(embeddingText), {
			conversationId: "policy-eval:corpus",
		});
		for (const [j, section] of batch.entries()) {
			const vector = vectors[j];
			if (!vector || vector.length !== dimensions) {
				throw new Error(`embedding shape mismatch for ${section.chunkId}`);
			}
			section.embedding = vector;
			section.embeddingModel = model;
			section.embeddingDimensions = dimensions;
		}
	}
}
