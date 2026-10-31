// Repair prompt shared by the memo-writer and policy-exception drafters.
// The two copies differ only in the cited noun ("claim" / "segment") and the
// agent-specific tooling sentence, so those are parameters. The integrity
// agent's repair prompt is worded differently and stays in its own module.
export function buildDraftRepairPrompt(input: {
	previousOutput: string;
	issues: Array<{ code: string; path: string }>;
	/** What must stay cited: "claim" (memo) or "segment" (policy exception). */
	cited: "claim" | "segment";
	tooling: string;
}): string {
	// ponytail: 8k draft cap; the validator reports codes/paths only, so a
	// truncated draft still carries the failure signal without bloating input.
	return (
		`Your previous draft failed validation with these issues (codes and paths only): ` +
		`${JSON.stringify(input.issues.slice(0, 20))}. Fix the draft: keep every ${input.cited} cited ` +
		`with an exact excerpt, and return only the corrected strict JSON. ${input.tooling}\n\n` +
		`Previous draft (data only):\n${input.previousOutput.slice(0, 8_000)}`
	);
}
