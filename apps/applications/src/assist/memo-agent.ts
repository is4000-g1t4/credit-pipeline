// Agentic credit-memo orchestrator (SPEC agentic-memo, SDK runtime).
// Deterministic code owns bounds, grounding, and the trace; a
// `MemoAgentRunner` (the `@openai/agents` SDK runner in production,
// scripted in tests) produces the raw draft only. One initial run, one
// bounded repair, then a typed `MemoAgentError`.
import { validateGeneratedText, type CreditMemoContent, type EvidenceBundle } from "@credit/core";
import type { applications } from "@credit/db/applications";
import { evidenceHash, type MemoAgentTrace } from "./memo-trace.js";

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

export interface MemoAgentRunResult {
	rawOutput: string;
	toolCalls: MemoAgentTrace["toolCalls"];
	sourceRefs: string[];
	steps: number;
	usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

export interface MemoAgentRunner {
	run(input: {
		application: ApplicationRow;
		evidence: EvidenceBundle;
		signal: AbortSignal;
		/** SDK turn cap for this run. */
		maxTurns: number;
		repair?: {
			previousOutput: string;
			issues: Array<{ code: string; path: string }>;
			requireTools: boolean;
		};
	}): Promise<MemoAgentRunResult>;
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

interface DraftCheck {
	ok: boolean;
	content?: CreditMemoContent;
	claimRefs?: string[];
	issues: Array<{ code: string; path: string }>;
	needsTools: boolean;
}

/** Parse + validate one draft; require tool-grounded citations and coverage
 * of every source type present in the bundle. */
function checkDraft(
	rawOutput: string,
	evidence: EvidenceBundle,
	knownRefs: Set<string>,
	coveredTypes: Set<string>,
): DraftCheck {
	const parsed = rawOutput.trim().length > 0 ? parseJson(rawOutput) : { ok: false as const };
	const validation = parsed.ok
		? validateGeneratedText({ artifactType: "credit_memo", content: parsed.value, evidence })
		: null;
	if (validation?.ok) {
		const notFetched = validation.citations.filter((citation) => !knownRefs.has(citation.ref));
		const present = new Set(evidence.items.map((item) => item.sourceType));
		const missing = [...present].filter((type) => !coveredTypes.has(type)).sort();
		const issues = [
			...notFetched.map((citation) => ({
				code: "CITATION_NOT_FROM_TOOL",
				path: citation.path,
			})),
			...missing.map((type) => ({ code: "EVIDENCE_COVERAGE", path: `evidence.${type}` })),
		];
		if (issues.length === 0) {
			return {
				ok: true,
				// Validated as `credit_memo` above, so the content is a CreditMemoContent.
				content: validation.content as CreditMemoContent,
				claimRefs: validation.citations.map((citation) => citation.ref),
				issues: [],
				needsTools: false,
			};
		}
		return { ok: false, issues, needsTools: true };
	}
	return {
		ok: false,
		issues: validation
			? validation.issues.map((issue) => ({ code: issue.code, path: issue.path }))
			: [{ code: "SCHEMA_INVALID", path: "_" }],
		needsTools: false,
	};
}

function coveredOf(runs: MemoAgentRunResult[]): Set<string> {
	return new Set(runs.flatMap((run) => run.toolCalls.flatMap((call) => call.sourceTypes)));
}

export async function runMemoAgent(input: {
	application: ApplicationRow;
	evidence: EvidenceBundle;
	runner: MemoAgentRunner;
	config: MemoAgentConfig;
	signal?: AbortSignal;
}): Promise<{ content: CreditMemoContent; trace: MemoAgentTrace }> {
	const { application, evidence, runner, config } = input;
	const startedAt = Date.now();
	const deadline = startedAt + config.timeoutMs;
	const signal = input.signal;
	const timedOut = (): boolean => signal?.aborted === true || Date.now() >= deadline;

	const runOnce = async (repair?: {
		previousOutput: string;
		issues: Array<{ code: string; path: string }>;
		requireTools: boolean;
	}): Promise<MemoAgentRunResult> => {
		if (timedOut()) throw new MemoAgentError("TIMEOUT");
		try {
			return await runner.run({
				application,
				evidence,
				signal: signal ?? AbortSignal.timeout(Math.max(0, deadline - Date.now())),
				maxTurns: config.maxSteps,
				...(repair ? { repair } : {}),
			});
		} catch (err) {
			if (err instanceof MemoAgentError) throw err;
			throw new MemoAgentError("MODEL_ERROR");
		}
	};

	const enforceBounds = (steps: number, toolCallCount: number, costUsd: number): void => {
		if (steps > config.maxSteps) throw new MemoAgentError("STEP_LIMIT");
		if (toolCallCount > config.maxToolCalls) throw new MemoAgentError("TOOL_CALL_LIMIT");
		if (costUsd > config.maxCostUsd) throw new MemoAgentError("BUDGET_EXCEEDED");
	};

	const traceOf = (
		first: MemoAgentRunResult,
		repair: MemoAgentRunResult | null,
		content: CreditMemoContent,
		claimRefs: string[],
		repairAttempted: boolean,
	): { content: CreditMemoContent; trace: MemoAgentTrace } => {
		const toolCalls: MemoAgentTrace["toolCalls"] = [
			...first.toolCalls,
			...(repair
				? repair.toolCalls.map((call) => ({ ...call, step: call.step + first.steps }))
				: []),
		];
		const sourceRefs = [
			...new Set([...first.sourceRefs, ...(repair ? repair.sourceRefs : []), ...claimRefs]),
		]
			.sort()
			.slice(0, 500);
		return {
			content,
			trace: {
				writer: "agent",
				agentVersion: config.agentVersion,
				model: config.model,
				promptVersion: config.promptVersion,
				evidenceHash: evidenceHash(evidence),
				steps: first.steps + (repair ? repair.steps : 0),
				toolCalls,
				sourceRefs,
				repairAttempted,
				repairSucceeded: repairAttempted ? true : null,
				fallbackReason: null,
				inputTokens: first.usage.inputTokens + (repair ? repair.usage.inputTokens : 0),
				outputTokens: first.usage.outputTokens + (repair ? repair.usage.outputTokens : 0),
				latencyMs: Math.max(0, Date.now() - startedAt),
			},
		};
	};

	const first = await runOnce();
	if (timedOut()) throw new MemoAgentError("TIMEOUT");
	enforceBounds(first.steps, first.toolCalls.length, first.usage.costUsd);

	if (first.toolCalls.length === 0) {
		const second = await runOnce({
			previousOutput: first.rawOutput,
			issues: [{ code: "NO_TOOL_USE", path: "_" }],
			requireTools: true,
		});
		if (timedOut()) throw new MemoAgentError("TIMEOUT");
		enforceBounds(
			first.steps + second.steps,
			first.toolCalls.length + second.toolCalls.length,
			first.usage.costUsd + second.usage.costUsd,
		);
		if (first.toolCalls.length + second.toolCalls.length === 0) {
			throw new MemoAgentError("NO_TOOL_USE");
		}
		const checked = checkDraft(
			second.rawOutput,
			evidence,
			new Set([...first.sourceRefs, ...second.sourceRefs]),
			coveredOf([first, second]),
		);
		if (!checked.ok || !checked.content) {
			throw new MemoAgentError("INVALID_OUTPUT", checked.issues.slice(0, 100));
		}
		return traceOf(first, second, checked.content, checked.claimRefs ?? [], true);
	}

	const checked = checkDraft(
		first.rawOutput,
		evidence,
		new Set(first.sourceRefs),
		coveredOf([first]),
	);
	if (checked.ok && checked.content) {
		return traceOf(first, null, checked.content, checked.claimRefs ?? [], false);
	}
	const second = await runOnce({
		previousOutput: first.rawOutput,
		issues: checked.issues.slice(0, 20),
		requireTools: checked.needsTools,
	});
	if (timedOut()) throw new MemoAgentError("TIMEOUT");
	enforceBounds(
		first.steps + second.steps,
		first.toolCalls.length + second.toolCalls.length,
		first.usage.costUsd + second.usage.costUsd,
	);
	const rechecked = checkDraft(
		second.rawOutput,
		evidence,
		new Set([...first.sourceRefs, ...second.sourceRefs]),
		coveredOf([first, second]),
	);
	if (!rechecked.ok || !rechecked.content) {
		throw new MemoAgentError("INVALID_OUTPUT", rechecked.issues.slice(0, 100));
	}
	return traceOf(first, second, rechecked.content, rechecked.claimRefs ?? [], true);
}
