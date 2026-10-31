// Memo-writer output validator: parse the raw draft, run core's grounding
// validation, and require tool-grounded citations plus coverage of every
// source type present in the bundle. Load-bearing; fail closed.
import { validateGeneratedText, type CreditMemoContent, type EvidenceBundle } from "@credit/core";

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

export interface DraftCheck {
	ok: boolean;
	content?: CreditMemoContent;
	claimRefs?: string[];
	issues: Array<{ code: string; path: string }>;
	needsTools: boolean;
}

/** Parse + validate one draft; require tool-grounded citations and coverage
 * of every source type present in the bundle. */
export function checkDraft(
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
