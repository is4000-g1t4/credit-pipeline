// Pure shared fixtures for research tests: no DB, no env, no network.
// Unit doubles (fake OpenAI, model brief, context candidates) live here so
// the unit suites and integration doubles share one definition.
import type OpenAI from "openai";
import type { CandidateSnapshot } from "../src/context-tools.js";
import type { ModelBrief } from "../src/validator.js";

export interface RecordedCall {
	params: Record<string, unknown>;
}

/** Fake OpenAI chat client: cycles `replies` (single or list), records params. */
export function fakeOpenAi(replies: unknown, recorded?: RecordedCall[]): OpenAI {
	const list = Array.isArray(replies) ? replies : [replies];
	let i = 0;
	return {
		chat: {
			completions: {
				create: async (params: Record<string, unknown>) => {
					recorded?.push({ params });
					const reply = list[Math.min(i++, list.length - 1)];
					return {
						choices: [
							{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } },
						],
						usage: { prompt_tokens: 10, completion_tokens: 5 },
					};
				},
			},
		},
	} as unknown as OpenAI;
}

/** Minimal valid model brief: one registry finding, one official evidence. */
export function modelBrief(overrides: Partial<ModelBrief> = {}): ModelBrief {
	return {
		summary: "Registry shows timely filings; the loan terms look fine.",
		findings: [
			{
				claim: "Acme Ltd filed accounts for the year ending March 2025 on time.",
				category: "registry",
				whyItMatters: "Timely filing supports approval.",
				allegationStatus: "unknown",
				entityMatch: {
					identifierType: "name_city",
					value: "Acme Ltd, Leeds",
					confidence: "medium",
				},
				evidenceLocalIds: ["ev-1"],
			},
		],
		evidence: [
			{
				localId: "ev-1",
				url: "https://find-and-update.company-information.service.gov.uk/company/123",
				title: "Filings",
				publisher: "Companies House",
				publishedAt: "2025-06-01",
				quote: "Acme Ltd filed accounts for the year ending March 2025 on time.",
			},
		],
		contradictions: [],
		unknowns: ["No adverse media found in the searched sources."],
		questionsForOfficer: [],
		...overrides,
	};
}

/** Deterministic context candidate: negative-balance tuple both suites use. */
export function candidateSnapshot(overrides: Partial<CandidateSnapshot> = {}): CandidateSnapshot {
	return {
		localId: "c1",
		type: "negative_balance",
		periodStart: "2025-12-30",
		periodEnd: "2026-01-15",
		metric: "negative_eod_days",
		observed: 3,
		expected: 0,
		confidence: "high",
		status: "review",
		policyVersion: "context-metrics-v1",
		accountScope: "all",
		evidenceIds: ["tx-1", "tx-2"],
		...overrides,
	};
}

/** Tool-observed evidence ids backing the default candidate. */
export function seenEvidence(): Map<string, Set<string>> {
	return new Map([
		["tx-1", new Set(["transaction"])],
		["tx-2", new Set(["transaction"])],
		["c1", new Set(["metric"])],
	]);
}
