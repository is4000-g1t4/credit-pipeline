import { loadInstructions } from "@credit/agent-kit";
import { scrubKnownPii, type EvidenceBundle } from "@credit/core";
import { buildDraftRepairPrompt } from "../shared/repair.js";
import type { CaseRuleContext, PolicySectionDelivery } from "./types.js";

/** Static system prompt (instructions.md, byte-exact). */
export const SYSTEM_PROMPT = loadInstructions(import.meta.url);

/** Appended to the system prompt in memo mode (memo-mode.md, byte-exact). */
export const MEMO_MODE = `\n\n${loadInstructions(import.meta.url, "memo-mode.md")}`;

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

export function buildInitialPrompt(
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

export function buildRepairPrompt(
	previousOutput: string,
	issues: Array<{ code: string; path: string }>,
	requireTools: boolean,
): string {
	const tooling = requireTools
		? "Use only the policy sections already supplied in the conversation, cite exact excerpts, and cover every decision-relevant failed rule. Do not invent a tool call or section."
		: "Use only the policy sections already supplied in the conversation; do not invent a section or quote.";
	return buildDraftRepairPrompt({ previousOutput, issues, cited: "segment", tooling });
}
