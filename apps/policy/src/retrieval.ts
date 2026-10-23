import type { AclRow, PolicyChunk } from "./store.js";

export function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let aa = 0;
	let bb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		aa += x * x;
		bb += y * y;
	}
	if (aa === 0 || bb === 0) return 0;
	return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}

function tokens(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9.]+/)
		.filter((token) => token.length > 1);
}

function keywordScore(question: string, chunk: PolicyChunk): number {
	const q = new Set(tokens(question));
	if (q.size === 0) return 0;
	const hay = new Set(tokens(`${chunk.title} ${chunk.heading} ${chunk.body}`));
	let hits = 0;
	for (const token of q) if (hay.has(token)) hits++;
	let score = hits / q.size;
	if (question.toLowerCase().includes(chunk.sectionId.toLowerCase())) score += 0.5;
	return score;
}

export function rankChunks(
	question: string,
	queryEmbedding: number[],
	chunks: PolicyChunk[],
	topK: number,
): PolicyChunk[] {
	const bySection = new Map<string, { chunk: PolicyChunk; score: number }>();
	for (const chunk of chunks) {
		const semantic = cosine(queryEmbedding, chunk.embedding);
		const keyword = keywordScore(question, chunk);
		const score = 0.7 * semantic + 0.3 * keyword;
		const key = `${chunk.policyVersionId}:${chunk.sectionId}`;
		const prior = bySection.get(key);
		if (!prior || score > prior.score) bySection.set(key, { chunk, score });
	}
	return [...bySection.values()]
		.filter((row) => row.score > 0.08)
		.sort((a, b) => b.score - a.score)
		.slice(0, topK)
		.map((row) => row.chunk);
}

export interface Actor {
	id: string;
	role: "applicant" | "officer" | "service";
	policyRoles: Array<"policy_owner" | "compliance">;
}

/** ACL is fail-closed. Admin implies read. A global policy role alone never
 * bypasses the per-policy ACL, except compliance, which is the oversight
 * control role. */
export function canRead(policyId: string, actor: Actor, acls: AclRow[]): boolean {
	if (actor.role === "service") {
		return acls.some(
			(row) =>
				row.policyId === policyId &&
				row.principalType === "service" &&
				row.principal === "case_explain" &&
				row.permission === "case_explain",
		);
	}
	if (actor.policyRoles.includes("compliance")) return true;
	const mine = acls.filter((row) => row.policyId === policyId);
	if (actor.role === "officer") {
		if (
			mine.some(
				(row) =>
					row.principalType === "role" &&
					row.principal === "officer" &&
					(row.permission === "read" || row.permission === "admin"),
			)
		) {
			return true;
		}
	}
	return mine.some(
		(row) =>
			row.principalType === "user" &&
			row.principal === actor.id &&
			(row.permission === "read" || row.permission === "admin"),
	);
}

export function filterByAcl(chunks: PolicyChunk[], actor: Actor, acls: AclRow[]): PolicyChunk[] {
	return chunks.filter((chunk) => canRead(chunk.policyId, actor, acls));
}
