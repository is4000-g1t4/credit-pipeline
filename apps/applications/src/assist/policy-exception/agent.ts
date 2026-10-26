// E3 policy-exception orchestrator (bounded agent runtime).
//
// Deterministic code owns bounds, grounding, repair policy, and the trace; a
// `PolicyExceptionAgentRunner` (the `@openai/agents` SDK runner in
// production, scripted in tests) produces the raw draft only. One initial
// run, one bounded repair, then a typed `PolicyExceptionAgentError`. Fail
// closed: no artifact is ever returned alongside issues.
import { hashCanonical, type EvidenceBundle } from "@credit/core";
import type { MemoAgentTrace } from "../memo-trace.js";
import { composePolicyMemoContent, type PolicyExceptionMemoContent } from "./memo.js";
import { isPolicyRetrievalTool, isRuleContextTool, runPolicyExceptionTool } from "./tools.js";
import {
	knownCasePii,
	validateExplanation,
	validateFollowUp,
	validatePolicyMemoDraft,
} from "./validate.js";
import type {
	CaseRuleContext,
	PolicyClient,
	PolicyExceptionAgentRunner,
	PolicyExceptionAgentRunResult,
	PolicyExplanation,
	PolicyFollowUp,
	PolicySectionDelivery,
} from "./types.js";

export interface PolicyExceptionAgentConfig {
	model: string;
	agentVersion: string;
	promptVersion: string;
	validatorVersion: string;
	registryVersion: string;
	registryHash: string;
	artifactType: string;
	maxSteps: number;
	maxToolCalls: number;
	timeoutMs: number;
	maxCostUsd: number;
	/** Deterministic replay key supplied by the caller; otherwise computed
	 * from stable evidence/context/config (never drawer tokens). */
	replayKey?: string;
}

export type PolicyExceptionAgentErrorCode =
	| "STEP_LIMIT"
	| "TOOL_CALL_LIMIT"
	| "TIMEOUT"
	| "BUDGET_EXCEEDED"
	| "NO_TOOL_USE"
	| "INVALID_OUTPUT"
	| "MODEL_ERROR";

const ERROR_MESSAGES: Record<PolicyExceptionAgentErrorCode, string> = {
	STEP_LIMIT: "policy exception agent step limit exceeded",
	TOOL_CALL_LIMIT: "policy exception agent tool-call limit exceeded",
	TIMEOUT: "policy exception agent timed out",
	BUDGET_EXCEEDED: "policy exception agent cost budget exceeded",
	NO_TOOL_USE: "policy exception agent draft used no tools",
	INVALID_OUTPUT: "policy exception agent output failed validation",
	MODEL_ERROR: "policy exception model request failed",
};

/** Typed failure, never an artifact. Issues carry codes/paths only, never
 * generated text, evidence, or policy bodies. */
export class PolicyExceptionAgentError extends Error {
	readonly code: PolicyExceptionAgentErrorCode;
	readonly issues: Array<{ code: string; path: string }>;
	constructor(
		code: PolicyExceptionAgentErrorCode,
		issues: Array<{ code: string; path: string }> = [],
	) {
		super(ERROR_MESSAGES[code]);
		this.name = "PolicyExceptionAgentError";
		this.code = code;
		this.issues = issues;
	}
}

export type PolicyExceptionAgentContent =
	| PolicyExplanation
	| PolicyFollowUp
	| PolicyExceptionMemoContent;

export interface PolicyExceptionAgentInput {
	mode: "explain" | "followup" | "memo";
	context: CaseRuleContext;
	evidence: EvidenceBundle;
	catalog: PolicySectionDelivery[];
	/** Injected for the tools; the orchestrator itself performs no network. */
	policyClient: PolicyClient;
	config: PolicyExceptionAgentConfig;
	runner: PolicyExceptionAgentRunner;
	actorId: string;
	actorRole: string;
	question?: string;
	signal?: AbortSignal;
	conversationId?: string;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	const trimmed = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	if (trimmed.length === 0) return { ok: false };
	try {
		return { ok: true, value: JSON.parse(trimmed) as unknown };
	} catch {
		return { ok: false };
	}
}

/** Stable replay key: case + rules + versions + catalog refs. Bodies, drawer
 * tokens, query ids, and assembly timestamps are excluded. */
export function policyExceptionReplayKey(input: {
	context: CaseRuleContext;
	evidence: EvidenceBundle;
	catalog: PolicySectionDelivery[];
	config: PolicyExceptionAgentConfig;
}): string {
	return hashCanonical({
		applicationId: input.context.applicationId,
		policyAsOf: input.context.policyAsOf,
		policyVersion: input.context.policyVersion,
		scorecardVersion: input.context.scorecardVersion,
		score: input.context.score,
		grade: input.context.grade,
		secured: input.context.secured,
		securedQualifying: input.context.securedQualifying,
		failedRuleCount: input.context.failedRuleCount,
		limitations: input.context.limitations,
		rules: input.context.failedRules.map((failure) => ({
			ruleId: failure.ruleId,
			observed: failure.observed,
			threshold: failure.threshold,
			state: failure.exception.state,
		})),
		unmapped: input.context.unmappedRuleIds,
		registryVersion: input.config.registryVersion,
		registryHash: input.config.registryHash,
		model: input.config.model,
		promptVersion: input.config.promptVersion,
		agentVersion: input.config.agentVersion,
		validatorVersion: input.config.validatorVersion,
		catalogRefs: input.catalog.map((section) => `${section.policyKey}#${section.sectionId}`).sort(),
		evidence: {
			applicationId: input.evidence.applicationId,
			asOf: input.evidence.asOf,
			refs: input.evidence.items.map((item) => item.ref).sort(),
		},
	});
}

interface Checked {
	ok: boolean;
	content?: PolicyExceptionAgentContent;
	issues: Array<{ code: string; path: string }>;
	needsTools: boolean;
}

function checkDraft(
	mode: PolicyExceptionAgentInput["mode"],
	rawOutput: string,
	input: PolicyExceptionAgentInput,
	policySections: PolicySectionDelivery[],
	calls: MemoAgentTrace["toolCalls"],
): Checked {
	const toIssues = (
		issues: Array<{ code: string; path: string }>,
	): Array<{ code: string; path: string }> =>
		issues.map((issue) => ({ code: issue.code, path: issue.path }));
	const toolNames = calls.map((call) => call.name);
	const hasTools = calls.length > 0;
	const hasPolicy = calls.some((call) => isPolicyRetrievalTool(call.name) && call.resultCount > 0);
	const hasRuleContext = calls.some((call) => isRuleContextTool(call.name));
	const required = mode === "memo" ? hasRuleContext && hasPolicy : hasTools && hasPolicy;
	void toolNames;

	if (mode === "memo") {
		const parsed = parseJson(rawOutput);
		if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) {
			return {
				ok: false,
				issues: [{ code: "SCHEMA_INVALID", path: "_" }],
				needsTools: !required,
			};
		}
		const value = parsed.value as Record<string, unknown>;
		if (
			typeof value["title"] !== "string" ||
			!Array.isArray(value["sections"]) ||
			!Array.isArray(value["openItems"])
		) {
			return {
				ok: false,
				issues: [{ code: "SCHEMA_INVALID", path: "_" }],
				needsTools: !required,
			};
		}
		const composed = composePolicyMemoContent(
			{
				title: value["title"] as string,
				sections: value["sections"] as PolicyExceptionMemoContent["sections"],
				openItems: value["openItems"] as PolicyExceptionMemoContent["openItems"],
			},
			input.context,
			input.evidence,
		);
		const validation = validatePolicyMemoDraft(
			composed,
			input.context,
			input.catalog,
			input.evidence,
		);
		const issues = toIssues(validation.issues);
		if (!required) {
			issues.push({
				code: hasRuleContext ? "POLICY_RETRIEVAL_MISSING" : "RULE_CONTEXT_MISSING",
				path: "trace.toolCalls",
			});
		}
		if (validation.ok && validation.content && required) {
			return { ok: true, content: validation.content, issues: [], needsTools: false };
		}
		return {
			ok: false,
			issues: issues.slice(0, 100),
			needsTools: !required || issues.length === 0,
		};
	}

	const knownPii = knownCasePii(input.evidence);
	const validation =
		mode === "explain"
			? validateExplanation(rawOutput, input.context, input.catalog, { policySections, knownPii })
			: validateFollowUp(rawOutput, input.context, input.catalog, { policySections, knownPii });
	const issues = toIssues(validation.issues);
	if (!required) {
		issues.push({
			code: !hasTools ? "NO_TOOL_USE" : "POLICY_RETRIEVAL_MISSING",
			path: "trace.toolCalls",
		});
	}
	if (validation.ok && required) {
		return {
			ok: true,
			content: validation.answer as PolicyExceptionAgentContent,
			issues: [],
			needsTools: false,
		};
	}
	return { ok: false, issues: issues.slice(0, 100), needsTools: !required };
}

interface Prefetched {
	calls: MemoAgentTrace["toolCalls"];
	refs: string[];
	policySections: PolicySectionDelivery[];
}

/** Deterministic tool prefetch for grounding. Pure tools only; never a
 * network search. The model can still call any allowlisted tool. */
async function prefetchContext(input: PolicyExceptionAgentInput): Promise<Prefetched> {
	const calls: MemoAgentTrace["toolCalls"] = [];
	const refs = new Set<string>();
	const policySections: PolicySectionDelivery[] = [];
	if (input.catalog.length === 0) return { calls, refs: [], policySections: [] };
	const deps = {
		context: input.context,
		catalog: input.catalog,
		evidence: input.evidence,
		policyClient: input.policyClient,
		actorId: input.actorId,
		actorRole: input.actorRole,
		retrieved: [] as PolicySectionDelivery[],
	};
	const run = async (name: string, args: unknown): Promise<void> => {
		const outcome = await runPolicyExceptionTool(deps, name, args);
		calls.push({
			step: calls.length + 1,
			name,
			resultCount: outcome.resultCount,
			sourceTypes: outcome.sourceTypes,
		});
		for (const ref of outcome.refs) refs.add(ref);
		for (const section of outcome.policySections) policySections.push(section);
	};
	await run("list_failed_rules", {});
	for (const section of input.catalog) {
		await run("get_policy_section", {
			policyKey: section.policyKey,
			sectionId: section.sectionId,
		});
	}
	return { calls, refs: [...refs].sort(), policySections };
}

export async function runPolicyExceptionAgent(input: {
	mode: "explain" | "followup" | "memo";
	context: CaseRuleContext;
	evidence: EvidenceBundle;
	catalog: PolicySectionDelivery[];
	policyClient: PolicyClient;
	config: PolicyExceptionAgentConfig;
	runner: PolicyExceptionAgentRunner;
	actorId: string;
	actorRole: string;
	question?: string;
	signal?: AbortSignal;
	conversationId?: string;
}): Promise<{ content: PolicyExceptionAgentContent; trace: MemoAgentTrace }> {
	const { config, runner } = input;
	const startedAt = Date.now();
	const deadline = startedAt + config.timeoutMs;
	const signal = input.signal;
	const timedOut = (): boolean => signal?.aborted === true || Date.now() >= deadline;
	// Deterministic prefetch: the model may skip tool calls on some providers.
	// Call the allowlisted, pure case/rule tools once so the model always has
	// the exact rule facts and canonical section bodies, and so the trace
	// records the required retrieval step. The model can still call tools.
	const prefetched = await prefetchContext(input);
	// The tools own the only network path (the injected policy client); this
	// reference keeps the boundary explicit for reviewers.
	void input.policyClient;

	const runOnce = async (repair?: {
		previousOutput: string;
		issues: Array<{ code: string; path: string }>;
		requireTools: boolean;
	}): Promise<PolicyExceptionAgentRunResult> => {
		if (timedOut()) throw new PolicyExceptionAgentError("TIMEOUT");
		const remaining = Math.max(0, deadline - Date.now());
		const runSignal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(remaining)])
			: AbortSignal.timeout(remaining);
		try {
			const result = await runner.run({
				mode: input.mode,
				...(input.question !== undefined ? { question: input.question } : {}),
				context: input.context,
				evidence: input.evidence,
				catalog: input.catalog,
				actorId: input.actorId,
				actorRole: input.actorRole,
				signal: runSignal,
				maxTurns: config.maxSteps,
				...(input.conversationId ? { conversationId: input.conversationId } : {}),
				...(repair ? { repair } : {}),
			});
			return {
				...result,
				toolCalls: [...prefetched.calls, ...result.toolCalls],
				sourceRefs: [...new Set([...prefetched.refs, ...result.sourceRefs])].sort().slice(0, 500),
				policySections: [...prefetched.policySections, ...result.policySections],
				steps: result.steps + prefetched.calls.length,
			};
		} catch (err) {
			if (err instanceof PolicyExceptionAgentError) throw err;
			throw new PolicyExceptionAgentError("MODEL_ERROR");
		}
	};

	const enforceBounds = (steps: number, toolCallCount: number, costUsd: number): void => {
		if (steps > config.maxSteps) throw new PolicyExceptionAgentError("STEP_LIMIT");
		if (toolCallCount > config.maxToolCalls) throw new PolicyExceptionAgentError("TOOL_CALL_LIMIT");
		if (costUsd > config.maxCostUsd) throw new PolicyExceptionAgentError("BUDGET_EXCEEDED");
	};

	const traceOf = (
		first: PolicyExceptionAgentRunResult,
		repair: PolicyExceptionAgentRunResult | null,
		content: PolicyExceptionAgentContent,
		repairAttempted: boolean,
	): { content: PolicyExceptionAgentContent; trace: MemoAgentTrace } => {
		const toolCalls: MemoAgentTrace["toolCalls"] = [
			...first.toolCalls,
			...(repair
				? repair.toolCalls.map((call) => ({ ...call, step: call.step + first.steps }))
				: []),
		];
		const sourceRefs = [...new Set([...first.sourceRefs, ...(repair ? repair.sourceRefs : [])])]
			.sort()
			.slice(0, 500);
		return {
			content,
			trace: {
				writer: "agent",
				agentVersion: config.agentVersion,
				model: config.model,
				promptVersion: config.promptVersion,
				evidenceHash: config.replayKey ?? policyExceptionReplayKey(input),
				steps: first.steps + (repair ? repair.steps : 0),
				toolCalls,
				sourceRefs,
				repairAttempted,
				repairSucceeded: repairAttempted ? true : null,
				fallbackReason: null,
				inputTokens: first.usage.inputTokens + (repair ? repair.usage.inputTokens : 0),
				outputTokens: first.usage.outputTokens + (repair ? repair.usage.outputTokens : 0),
				costUsd: first.usage.costUsd + (repair ? repair.usage.costUsd : 0),
				latencyMs: Math.max(0, Date.now() - startedAt),
				registryVersion: config.registryVersion,
				registryHash: config.registryHash,
				validatorVersion: config.validatorVersion,
				artifactType: config.artifactType,
			},
		};
	};

	const first = await runOnce();
	if (timedOut()) throw new PolicyExceptionAgentError("TIMEOUT");
	enforceBounds(first.steps, first.toolCalls.length, first.usage.costUsd);

	const checked = checkDraft(
		input.mode,
		first.rawOutput,
		input,
		first.policySections,
		first.toolCalls,
	);
	if (checked.ok && checked.content) {
		return traceOf(first, null, checked.content, false);
	}
	if (first.toolCalls.length === 0 && checked.issues.length === 0) {
		checked.issues.push({ code: "NO_TOOL_USE", path: "trace.toolCalls" });
	}
	const second = await runOnce({
		previousOutput: first.rawOutput,
		issues: checked.issues.slice(0, 20),
		requireTools: checked.needsTools || first.toolCalls.length === 0,
	});
	if (timedOut()) throw new PolicyExceptionAgentError("TIMEOUT");
	enforceBounds(
		first.steps + second.steps,
		first.toolCalls.length + second.toolCalls.length,
		first.usage.costUsd + second.usage.costUsd,
	);
	const combined: MemoAgentTrace["toolCalls"] = [...first.toolCalls, ...second.toolCalls];
	if (combined.length === 0) throw new PolicyExceptionAgentError("NO_TOOL_USE");
	const rechecked = checkDraft(
		input.mode,
		second.rawOutput,
		input,
		[...first.policySections, ...second.policySections],
		combined,
	);
	if (!rechecked.ok || !rechecked.content) {
		throw new PolicyExceptionAgentError("INVALID_OUTPUT", rechecked.issues.slice(0, 100));
	}
	return traceOf(first, second, rechecked.content, true);
}
