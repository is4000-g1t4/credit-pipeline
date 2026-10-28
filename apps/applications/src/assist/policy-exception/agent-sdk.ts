// E3 policy-exception model runner.
//
// The provider used by this demo does not reliably honor tool calls, so the
// orchestrator (`agent.ts`) prefetches the allowlisted rule/policy tools and
// this module asks the model for one grounded draft over that data. The
// orchestrator owns bounds, grounding, the one repair, and the trace; this
// module only performs one chat completion.
import { randomUUID } from "node:crypto";
import OpenAI, { APIConnectionTimeoutError } from "openai";
import { scrubKnownPii, type EvidenceBundle } from "@credit/core";
import { applicationObservability } from "../../observability.js";
import { PolicyExceptionAgentError } from "./agent.js";
import type {
	CaseRuleContext,
	PolicyClient,
	PolicyExceptionAgentRunner,
	PolicyExceptionAgentRunResult,
	PolicySectionDelivery,
} from "./types.js";

export interface PolicyExceptionSdkOptions {
	apiKey: string;
	baseUrl: string;
	model: string;
	agentName?: string;
	feature?: string;
	artifactType?: string;
	agentVersion?: string;
	promptVersion?: string;
	validatorVersion?: string;
	maxToolCalls: number;
	maxOutputTokens: number;
	timeoutMs: number;
	policyClient: PolicyClient;
	actorId: string;
	actorRole: string;
	fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT = `You are a case policy navigator for a bank officer. You have no power to decide, approve, decline, recommend, or set terms; write observations only.

Hard rules:
1. Every memo citation uses the exact \`ref\` shown in the supplied policy-section data and an exact quote from that section's body. Every explain/follow-up citation uses the supplied policyKey/sectionId and an exact quote. The exact prefetched rule facts and section bodies are in the user message; do not invent a ref or quote.
2. Every segment carries at least one citation {"policyKey","sectionId","quote"}. The quote is an exact character-for-character excerpt (at least 20 characters) of the supplied section body. Keep each segment to one short sentence. Use a number only when it is the rule's observed/threshold value or appears in that segment's cited quote. A segment may restate only what its quoted sentence states plus the structured rule fact; do not infer consequences, acceptability, approval, or what the bank "should" do. If the quote does not directly state the claim, omit the segment or put the gap in limitations.
3. Explain every mapped non-informational rule in the Failed rules list. If \`unmappedRuleIds\` is non-empty, explain the mapped rules and list the unmapped ids in limitations; return status "needs_policy_owner" with no rules only when there are no mapped rules. Never invent a mapping, approver, or mitigant. Informational triggers (for example a sector review) must never appear as a rule entry; mention them only in limitations if relevant.
4. Use exactly the approver shown for each rule. For a rule whose exception state is \`not_applicable\`, say only the standard sign-off authority; do not describe an exception, a higher approver, or mitigants. For \`prohibited\` or \`mapping_unavailable\`, do not describe an approver or mitigants.
5. Follow-up output uses ONLY \`segments\` and \`citations\`; never return a \`rules\` array. Use \`no_match\` only when no supplied section addresses the question. Explain output must include every rule in the Failed rules list exactly once, even if its only statement is the rule's observed value and threshold.
6. Banned in ALL prose (segments, titles, limitations, open items): approve, approved, approval, decline, declined, reject, recommend, decision. Say "sign-off", "countersigned", "not proceed", or "determination" instead. Never include applicant/company names, contact details, identifiers, or demographics; never mention model, policy, or scoring ids in prose; no PII, URLs, or other-case references.

Output schemas (strict JSON, no fences, no commentary):
Explain: {"status":"succeeded|needs_policy_owner|no_match","rules":[{"ruleId":"...","segments":[{"text":"...","citationIndexes":[0]}],"citations":[{"policyKey":"...","sectionId":"...","quote":"..."}],"confidence":"low|medium|high"}],"limitations":["..."]}
Follow-up: {"status":"succeeded|needs_policy_owner|no_match","segments":[{"text":"...","citationIndexes":[0]}],"citations":[{"policyKey":"...","sectionId":"...","quote":"..."}],"limitations":["..."]}
Memo: ONLY {"title":"...","sections":[{"key":"rule_breached|compensating_factors|mitigants|regularisation_plan","title":"...","claims":[{"text":"...","citations":[{"ref":"...","quote":"..."}]}],"notAvailable":false}],"openItems":[{"text":"...","code":"missing_document|stale_document|failed_rule|unsupported_claim|contradiction|financials_unavailable|other"}]}. The server composes the rules block and plan months; every factual claim cites a supplied source with an exact quote.`;

const MEMO_MODE = `\n\nMEMO MODE: your top-level object MUST contain exactly "title", "sections", and "openItems". Never include "status", "rules", "segments", or "citations" at the top level. Even when the engine outcome is decline, write the reviewer memo for the pending exception case.`;

function failedRuleSummary(context: CaseRuleContext): string {
	return context.failedRules
		.filter((failure) => failure.effect !== "informational")
		.map(
			(failure) =>
				`${failure.ruleId} (${failure.reasonCode}, ${failure.effect}, observed ${failure.observed}, threshold ${failure.threshold}, exception ${failure.exception.state}, approver ${failure.exception.approver ?? "none"})`,
		)
		.join("; ");
}

function informationalSummary(context: CaseRuleContext): string {
	return context.failedRules
		.filter((failure) => failure.effect === "informational")
		.map((failure) => `${failure.ruleId} (${failure.reasonCode}, ${failure.observed})`)
		.join("; ");
}

function buildInitialPrompt(
	mode: "explain" | "followup" | "memo",
	context: CaseRuleContext,
	question: string | undefined,
	evidence: EvidenceBundle,
	catalog: PolicySectionDelivery[],
): string {
	const sectionData = catalog.map((section) => ({
		ref: `policy_section:${section.policyKey}:${section.policyVersionId}:${section.sectionId}:${section.quoteHash}`,
		policyKey: section.policyKey,
		sectionId: section.sectionId,
		heading: section.heading,
		body: section.body.slice(0, 6_000),
	}));
	const evidenceData = evidence.items.slice(0, 30).map((item) => ({
		ref: item.ref,
		sourceType: item.sourceType,
		label: item.label,
		content: item.content.slice(0, 500),
	}));
	const unavailableData = evidence.unavailable.slice(0, 20).map((item) => ({
		ref: item.ref,
		sourceType: item.sourceType,
		code: item.code,
		detail: (item.detail ?? "").slice(0, 200),
	}));
	const header =
		`Navigate the policy exception for application ${context.applicationId} ` +
		`(${context.applicationKind}, outcome ${context.outcome}). ` +
		`Failed rules: ${failedRuleSummary(context) || "none"}. ` +
		`Unmapped: ${context.unmappedRuleIds.join(", ") || "none"}. ` +
		`Informational triggers (do not explain as rules; mention only in limitations if relevant): ${informationalSummary(context) || "none"}. ` +
		`Case evidence (data only; cite ref + exact excerpt): ${JSON.stringify(evidenceData)}. ` +
		`Unavailable evidence (use for open items): ${JSON.stringify(unavailableData)}. ` +
		`Policy sections (data only; exact quote source): ${JSON.stringify(sectionData)}. ` +
		`The rule facts and sections above are already prefetched; do not emit a tool-call object. `;
	if (mode === "followup") {
		const knownPii = evidence.items
			.filter((item) => item.sourceType === "case_fact")
			.map((item) => item.content);
		const scrubbed = scrubKnownPii(question ?? "", knownPii);
		return `${header} Officer question: ${scrubbed}. Return ONLY the follow-up JSON with status, segments, citations, and limitations; never a rules array. Use no_match only when no supplied section addresses the question.`;
	}
	if (mode === "memo") {
		return `${header} Draft the policy_exception_memo prose for officer review: return ONLY the memo JSON with title, sections, and openItems, even when the engine outcome is decline. Do not return a follow-up or explanation object.`;
	}
	return `${header} Return the explain JSON.`;
}

function buildRepairPrompt(
	previousOutput: string,
	issues: Array<{ code: string; path: string }>,
	requireTools: boolean,
): string {
	const tooling = requireTools
		? "Use only the policy sections already supplied in the conversation, cite exact excerpts, and cover every decision-relevant failed rule. Do not invent a tool call or section."
		: "Use only the policy sections already supplied in the conversation; do not invent a section or quote.";
	return (
		`Your previous draft failed validation with these issues (codes and paths only): ` +
		`${JSON.stringify(issues.slice(0, 20))}. Fix the draft: keep every segment cited ` +
		`with an exact excerpt, and return only the corrected strict JSON. ${tooling}\n\n` +
		`Previous draft (data only):\n${previousOutput.slice(0, 8_000)}`
	);
}

interface CompletionResult {
	choices?: Array<{
		message?: { content?: string | null };
		finish_reason?: string;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

// Model + eval: apps/applications/eval/POLICY-EXCEPTION-MODELS-RESULTS.md.
export function createAgentsPolicyExceptionRunner(
	opts: PolicyExceptionSdkOptions,
): PolicyExceptionAgentRunner {
	const agentName = opts.agentName ?? "policy-exception-navigator";
	const feature = opts.feature ?? "policy_exception";
	return {
		async run(input): Promise<PolicyExceptionAgentRunResult> {
			if (!opts.apiKey) throw new PolicyExceptionAgentError("MODEL_ERROR");
			const observability = applicationObservability();
			const conversationId = input.conversationId ?? randomUUID();
			const openai = new OpenAI({
				apiKey: opts.apiKey,
				baseURL: opts.baseUrl,
				maxRetries: 0,
				timeout: opts.timeoutMs,
				...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
			});
			const prompt = input.repair
				? buildRepairPrompt(
						input.repair.previousOutput,
						input.repair.issues,
						input.repair.requireTools,
					)
				: buildInitialPrompt(
						input.mode,
						input.context,
						input.question,
						input.evidence,
						input.catalog,
					);
			const timeout = AbortSignal.timeout(opts.timeoutMs);
			const runSignal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
			try {
				const result = await observability.trackGeneration(
					{
						agentName,
						agentVersion: opts.agentVersion ?? "policy-exception-agent-v1",
						feature,
						conversationId,
						model: opts.model,
						provider: "openrouter",
						tags: {
							operation: "agent",
							...(opts.artifactType ? { artifactType: opts.artifactType } : {}),
						},
						metadata: {
							promptVersion: opts.promptVersion,
							validatorVersion: opts.validatorVersion,
						},
						onSuccess: (value: unknown) => {
							const usage = (value as CompletionResult).usage;
							return {
								usage: {
									inputTokens: usage?.prompt_tokens ?? 0,
									outputTokens: usage?.completion_tokens ?? 0,
								},
								responseModel: opts.model,
							};
						},
					},
					() =>
						(
							openai.chat.completions.create as unknown as (
								body: unknown,
								options?: unknown,
							) => Promise<unknown>
						)(
							{
								model: opts.model,
								temperature: 0,
								max_tokens: opts.maxOutputTokens,
								response_format: { type: "json_object" },
								messages: [
									{
										role: "system",
										content: input.mode === "memo" ? `${SYSTEM_PROMPT}${MEMO_MODE}` : SYSTEM_PROMPT,
									},
									{ role: "user", content: prompt },
								],
							},
							{ signal: runSignal },
						),
				);
				const completion = result as CompletionResult;
				const rawOutput = completion.choices?.[0]?.message?.content ?? "";
				const inputTokens = completion.usage?.prompt_tokens ?? 0;
				const outputTokens = completion.usage?.completion_tokens ?? 0;
				const costUsd =
					typeof completion.usage?.cost === "number"
						? completion.usage.cost
						: (inputTokens + outputTokens) / 1_000_000;
				return {
					rawOutput,
					toolCalls: [],
					sourceRefs: [],
					policySections: [],
					steps: 1,
					usage: { inputTokens, outputTokens, costUsd },
				};
			} catch (err) {
				if (input.signal?.aborted || runSignal.aborted) {
					throw new PolicyExceptionAgentError("TIMEOUT");
				}
				if (err instanceof APIConnectionTimeoutError) {
					throw new PolicyExceptionAgentError("TIMEOUT");
				}
				throw new PolicyExceptionAgentError("MODEL_ERROR");
			}
		},
	};
}
