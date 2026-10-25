// Agentic credit-memo writer (SPEC agentic-memo, wave B). Bounded tool loop
// over the passed `EvidenceBundle` only: no DB, no network, no cross-case
// reads. Deterministic code owns access, validation, and the trace; the
// model writes memo prose only.
import {
	SOURCE_TYPES,
	validateGeneratedText,
	type CreditMemoContent,
	type EvidenceBundle,
} from "@credit/core";
import type { applications } from "@credit/db/applications";
import { evidenceHash, type MemoAgentTrace } from "./memo-trace.js";
import {
	MemoModelError,
	type MemoModel,
	type MemoModelMessage,
	type MemoToolCall,
	type MemoToolDefinition,
} from "./memo-model.js";

type ApplicationRow = typeof applications.$inferSelect;

export interface MemoAgentConfig {
	model: string;
	promptVersion: string;
	agentVersion: string;
	maxSteps: number;
	maxToolCalls: number;
	timeoutMs: number;
	maxCostUsd: number;
}

export type MemoAgentErrorCode =
	| "STEP_LIMIT"
	| "TOOL_CALL_LIMIT"
	| "TIMEOUT"
	| "BUDGET_EXCEEDED"
	| "NO_TOOL_USE"
	| "INVALID_OUTPUT"
	| "MODEL_ERROR";

const ERROR_MESSAGES: Record<MemoAgentErrorCode, string> = {
	STEP_LIMIT: "memo agent step limit exceeded",
	TOOL_CALL_LIMIT: "memo agent tool-call limit exceeded",
	TIMEOUT: "memo agent timed out",
	BUDGET_EXCEEDED: "memo agent cost budget exceeded",
	NO_TOOL_USE: "memo agent draft used no evidence tools",
	INVALID_OUTPUT: "memo agent output failed validation",
	MODEL_ERROR: "memo model request failed",
};

/** Typed failure, never an artifact. Issues carry codes/paths only, never
 * generated text or evidence. */
export class MemoAgentError extends Error {
	readonly code: MemoAgentErrorCode;
	readonly issues: Array<{ code: string; path: string }>;
	constructor(code: MemoAgentErrorCode, issues: Array<{ code: string; path: string }> = []) {
		super(ERROR_MESSAGES[code]);
		this.name = "MemoAgentError";
		this.code = code;
		this.issues = issues;
	}
}

const SOURCE_TYPE_LIST = [...SOURCE_TYPES] as string[];

export const MEMO_AGENT_TOOLS: MemoToolDefinition[] = [
	{
		name: "list_evidence",
		description: "List evidence refs with labels and source types. Returns no content excerpts.",
		parameters: {
			type: "object",
			properties: {
				sourceType: { type: "string", enum: [...SOURCE_TYPES] },
				limit: { type: "integer", minimum: 1, maximum: 50 },
			},
			additionalProperties: false,
		},
	},
	{
		name: "search_evidence",
		description:
			"Case-insensitive token search over evidence labels, content, and metadata. Returns short excerpts, not full content.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string" },
				sourceType: { type: "string", enum: [...SOURCE_TYPES] },
				limit: { type: "integer", minimum: 1, maximum: 20 },
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
	{
		name: "get_evidence",
		description: "Return one evidence item by exact ref. Content is capped at 4,000 characters.",
		parameters: {
			type: "object",
			properties: { ref: { type: "string" } },
			required: ["ref"],
			additionalProperties: false,
		},
	},
	{
		name: "list_unavailable",
		description: "List typed missing/unavailable sources to record as open items.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	},
];

const SYSTEM_PROMPT = `You are drafting an internal credit memorandum for a bank officer. You have no power to decide, recommend, score, rate, limit, or set terms; write observations only.

Hard rules:
1. Draft only from evidence returned by the evidence tools. Never use outside knowledge. Before writing, query every evidence source type present in the bundle and call \`list_unavailable\`; at least one evidence tool call is required.
2. Every factual claim in \`sections\` must cite at least one source as {"ref","quote"}. The ref must be an evidence ref returned by the tools; the quote must be an exact character-for-character excerpt of that item's content.
3. Banned in ALL prose (claims, titles, open items, questions): approve/approval, decline, reject, recommend, decision, score, rate, limit, and term/terms. Never include applicant/company names, contact details, identifiers, demographics, or proxy language; never mention models, grades, policy ids, or internal systems. Numbers and dates are allowed only when copied from a cited evidence item.
4. Anything unsupported or missing goes in \`openItems\` with the matching code, never in a claim. Unavailable sources go in \`openItems\` with their evidence ref.
5. \`officerQuestions\` holds 1-5 concrete follow-up questions for the gaps.
6. Return ONLY strict JSON, no fences, no commentary:
{"title":"...","sections":[{"key":"request|entity|financial_summary|strengths|risks|policy_compliance","title":"...","claims":[{"text":"...","citations":[{"ref":"...","quote":"..."}]}],"notAvailable":false}],"openItems":[{"text":"...","code":"missing_document|stale_document|failed_rule|unsupported_claim|contradiction|financials_unavailable|other","sourceRef":"..."}],"officerQuestions":["..."]}
All six section keys appear exactly once in the listed order. A section with no supported claims uses "claims":[] and "notAvailable":true; a section with claims uses "notAvailable":false. At most 20 claims per section.`;

const NO_TOOL_USE_REPAIR =
	"You returned a draft without calling any evidence tool. Draft only from evidence: call list_evidence, search_evidence, or get_evidence first, then return the strict JSON draft.";

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function clampLimit(value: unknown, def: number, max: number): number {
	return typeof value === "number" && Number.isInteger(value)
		? Math.min(Math.max(value, 1), max)
		: def;
}

interface ToolOutcome {
	payload: unknown;
	resultCount: number;
	sourceTypes: string[];
	refs: string[];
}

function uniqueSourceTypes(refs: string[], items: Map<string, string>): string[] {
	const types = new Set<string>();
	for (const ref of refs) {
		const type = items.get(ref);
		if (type) types.add(type);
	}
	return [...types].sort();
}

function toolError(message: string): ToolOutcome {
	return {
		payload: { error: message },
		resultCount: 0,
		sourceTypes: [],
		refs: [],
	};
}

function executeTool(call: MemoToolCall, evidence: EvidenceBundle): ToolOutcome {
	const args = asRecord(call.arguments);
	const byRef = new Map(evidence.items.map((item) => [item.ref, item]));
	const error = toolError;
	switch (call.name) {
		case "list_evidence": {
			const sourceType = args["sourceType"];
			if (
				sourceType !== undefined &&
				(typeof sourceType !== "string" || !SOURCE_TYPE_LIST.includes(sourceType))
			) {
				return error("unknown sourceType");
			}
			const limit = clampLimit(args["limit"], 20, 50);
			const filtered = evidence.items.filter(
				(item) => sourceType === undefined || item.sourceType === sourceType,
			);
			const items = filtered.slice(0, limit).map((item) => ({
				ref: item.ref,
				label: item.label,
				sourceType: item.sourceType,
			}));
			const refs = items.map((item) => item.ref);
			return {
				payload: { total: filtered.length, items },
				resultCount: items.length,
				sourceTypes: uniqueSourceTypes(
					refs,
					new Map(evidence.items.map((i) => [i.ref, i.sourceType])),
				),
				refs,
			};
		}
		case "search_evidence": {
			const query = args["query"];
			if (typeof query !== "string" || query.trim().length === 0) {
				return error("query is required");
			}
			const sourceType = args["sourceType"];
			if (
				sourceType !== undefined &&
				(typeof sourceType !== "string" || !SOURCE_TYPE_LIST.includes(sourceType))
			) {
				return error("unknown sourceType");
			}
			const limit = clampLimit(args["limit"], 10, 20);
			const tokens = query
				.toLowerCase()
				.split(/\s+/)
				.filter((token) => token.length > 0);
			if (tokens.length === 0) return error("query is required");
			const matched = evidence.items.filter((item) => {
				if (sourceType !== undefined && item.sourceType !== sourceType) return false;
				const haystack =
					`${item.label} ${item.content} ${JSON.stringify(item.metadata)}`.toLowerCase();
				return tokens.every((token) => haystack.includes(token));
			});
			const items = matched.slice(0, limit).map((item) => ({
				ref: item.ref,
				label: item.label,
				sourceType: item.sourceType,
				// ponytail: 500-char excerpt; full text needs get_evidence.
				excerpt: item.content.slice(0, 500),
			}));
			const refs = items.map((item) => item.ref);
			return {
				payload: { total: matched.length, items },
				resultCount: items.length,
				sourceTypes: uniqueSourceTypes(
					refs,
					new Map(evidence.items.map((i) => [i.ref, i.sourceType])),
				),
				refs,
			};
		}
		case "get_evidence": {
			if (typeof args["ref"] !== "string" || args["ref"].length === 0) {
				return error("ref is required");
			}
			const item = byRef.get(args["ref"]);
			if (!item) return error("unknown evidence ref");
			return {
				payload: {
					ref: item.ref,
					sourceType: item.sourceType,
					label: item.label,
					content: item.content.slice(0, 4_000),
					metadata: item.metadata,
				},
				resultCount: 1,
				sourceTypes: [item.sourceType],
				refs: [item.ref],
			};
		}
		case "list_unavailable": {
			const items = evidence.unavailable.map((item) => ({
				ref: item.ref,
				sourceType: item.sourceType,
				code: item.code,
				...(item.detail ? { detail: item.detail } : {}),
			}));
			const refs = items.map((item) => item.ref);
			return {
				payload: { total: items.length, items },
				resultCount: items.length,
				sourceTypes: [...new Set(items.map((item) => item.sourceType))].sort(),
				refs,
			};
		}
		default:
			return error(`unknown tool: ${call.name.slice(0, 80)}`);
	}
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	const trimmed = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	try {
		return { ok: true, value: JSON.parse(trimmed) as unknown };
	} catch {
		return { ok: false };
	}
}

export async function runMemoAgent(input: {
	application: ApplicationRow;
	evidence: EvidenceBundle;
	model: MemoModel;
	config: MemoAgentConfig;
	signal?: AbortSignal;
}): Promise<{ content: CreditMemoContent; trace: MemoAgentTrace }> {
	const { application, evidence, model, config } = input;
	const startedAt = Date.now();
	const deadline = startedAt + config.timeoutMs;
	const messages: MemoModelMessage[] = [
		{ role: "system", content: SYSTEM_PROMPT },
		{
			role: "user",
			content:
				`Draft the credit memorandum for application ${application.reference} ` +
				`(${application.type}, ${application.product}). The evidence bundle holds ` +
				`${evidence.items.length} items and ${evidence.unavailable.length} unavailable ` +
				`sources; it is visible only through the evidence tools. Start by calling them.`,
		},
	];

	let steps = 0;
	let toolCallsUsed = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;
	let toolUseRepairAttempted = false;
	let validationRepairAttempted = false;
	const toolCalls: MemoAgentTrace["toolCalls"] = [];
	const toolRefs = new Set<string>();

	const fail = (
		code: MemoAgentErrorCode,
		issues: Array<{ code: string; path: string }> = [],
	): never => {
		throw new MemoAgentError(code, issues);
	};

	for (;;) {
		if (input.signal?.aborted || Date.now() >= deadline) fail("TIMEOUT");
		if (steps >= config.maxSteps) fail("STEP_LIMIT");
		let result: Awaited<ReturnType<MemoModel["complete"]>>;
		try {
			const timeout = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
			result = await model.complete({
				messages,
				tools: MEMO_AGENT_TOOLS,
				signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
			});
			steps += 1;
		} catch (err) {
			if (err instanceof MemoModelError && err.code === "TIMEOUT")
				throw new MemoAgentError("TIMEOUT");
			if (input.signal?.aborted || Date.now() >= deadline) throw new MemoAgentError("TIMEOUT");
			throw new MemoAgentError("MODEL_ERROR");
		}
		if (input.signal?.aborted || Date.now() >= deadline) fail("TIMEOUT");
		inputTokens += result.usage.inputTokens;
		outputTokens += result.usage.outputTokens;
		costUsd +=
			result.usage.costUsd ?? (result.usage.inputTokens + result.usage.outputTokens) / 1_000_000;
		if (costUsd > config.maxCostUsd) fail("BUDGET_EXCEEDED");

		if (result.toolCalls.length > 0) {
			if (toolCallsUsed + result.toolCalls.length > config.maxToolCalls) fail("TOOL_CALL_LIMIT");
			messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
			for (const call of result.toolCalls) {
				const outcome = executeTool(call, evidence);
				toolCallsUsed += 1;
				toolCalls.push({
					step: steps,
					name: call.name.slice(0, 80),
					resultCount: outcome.resultCount,
					sourceTypes: outcome.sourceTypes,
				});
				for (const ref of outcome.refs) toolRefs.add(ref);
				messages.push({
					role: "tool",
					content: JSON.stringify(outcome.payload),
					toolCallId: call.id,
					name: call.name.slice(0, 80),
				});
			}
			continue;
		}

		const text = result.content?.trim() ?? "";
		if (toolCallsUsed === 0) {
			if (!toolUseRepairAttempted) {
				toolUseRepairAttempted = true;
				messages.push({ role: "assistant", content: result.content });
				messages.push({ role: "user", content: NO_TOOL_USE_REPAIR });
				continue;
			}
			fail("NO_TOOL_USE");
		}
		const parsed = text.length > 0 ? parseJson(text) : { ok: false as const };
		const validation = parsed.ok
			? validateGeneratedText({ artifactType: "credit_memo", content: parsed.value, evidence })
			: null;
		// Tool-grounded citations + category coverage (SPEC agentic-memo):
		// a schema-valid draft is still rejected when a claim cites a ref no
		// tool returned, or when a source type in the bundle never appeared
		// in any tool result. Both share the single bounded repair below.
		let issues: Array<{ code: string; path: string }>;
		let repairHint = "";
		if (validation?.ok) {
			const notFetched = validation.citations.filter((citation) => !toolRefs.has(citation.ref));
			const present = new Set(evidence.items.map((item) => item.sourceType));
			const covered = new Set(toolCalls.flatMap((call) => call.sourceTypes));
			const missing = [...present].filter((type) => !covered.has(type)).sort();
			issues = [
				...notFetched.map((citation) => ({
					code: "CITATION_NOT_FROM_TOOL",
					path: citation.path,
				})),
				...missing.map((type) => ({ code: "EVIDENCE_COVERAGE", path: `evidence.${type}` })),
			];
			if (issues.length === 0) {
				// Validated as `credit_memo` above, so the content is a CreditMemoContent.
				const content = validation.content as CreditMemoContent;
				const claimRefs = validation.citations.map((citation) => citation.ref);
				const sourceRefs = [...new Set([...toolRefs, ...claimRefs])].sort().slice(0, 500);
				const repairAttempted = toolUseRepairAttempted || validationRepairAttempted;
				return {
					content,
					trace: {
						writer: "agent",
						agentVersion: config.agentVersion,
						model: config.model,
						promptVersion: config.promptVersion,
						evidenceHash: evidenceHash(evidence),
						steps,
						toolCalls,
						sourceRefs,
						repairAttempted,
						repairSucceeded: repairAttempted ? true : null,
						fallbackReason: null,
						inputTokens,
						outputTokens,
						latencyMs: Math.max(0, Date.now() - startedAt),
					},
				};
			}
			const hints: string[] = [];
			if (notFetched.length > 0) {
				hints.push(
					"cite only evidence refs returned by the tools; drop or re-fetch any other ref.",
				);
			}
			if (missing.length > 0) {
				hints.push(
					`cover each missing evidence category with list_evidence or search_evidence: ${missing.join(", ")}.`,
				);
			}
			if (hints.length > 0) repairHint = ` ${hints.join(" ")}`;
		} else {
			issues = validation
				? validation.issues.map((issue) => ({ code: issue.code, path: issue.path }))
				: [{ code: "SCHEMA_INVALID", path: "_" }];
		}
		if (!validationRepairAttempted) {
			validationRepairAttempted = true;
			messages.push({ role: "assistant", content: result.content });
			messages.push({
				role: "user",
				content:
					`Your draft failed validation with these issues (codes and paths only): ` +
					`${JSON.stringify(issues.slice(0, 20))}. Fix the draft: use the evidence ` +
					`tools if you need exact quotes, keep every claim cited with an exact ` +
					`excerpt, and return only the corrected strict JSON.${repairHint}`,
			});
			continue;
		}
		fail("INVALID_OUTPUT", issues.slice(0, 100));
	}
}
