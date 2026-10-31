import { loadInstructions } from "@credit/agent-kit";
import type { EvidenceBundle } from "@credit/core";
import type { applications } from "@credit/db/applications";
import { buildDraftRepairPrompt } from "../shared/repair.js";

type ApplicationRow = typeof applications.$inferSelect;

/** Static system prompt (instructions.md, byte-exact). */
export const SYSTEM_PROMPT = loadInstructions(import.meta.url);

export function buildInitialPrompt(application: ApplicationRow, evidence: EvidenceBundle): string {
	return (
		`Draft the credit memorandum for application ${application.reference} ` +
		`(${application.type}, ${application.product}). The evidence bundle holds ` +
		`${evidence.items.length} items and ${evidence.unavailable.length} unavailable ` +
		`sources; it is visible only through the evidence tools. Start by calling them.`
	);
}

export function buildRepairPrompt(
	previousOutput: string,
	issues: Array<{ code: string; path: string }>,
	requireTools: boolean,
): string {
	const tooling = requireTools
		? "You must call the evidence tools before returning the corrected draft: cite only refs the tools returned and cover every evidence category."
		: "Use the evidence tools if you need exact quotes.";
	return buildDraftRepairPrompt({ previousOutput, issues, cited: "claim", tooling });
}
