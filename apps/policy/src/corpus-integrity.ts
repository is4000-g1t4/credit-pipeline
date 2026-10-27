import {
	POLICY_ENGINE_STANDARD_HASH,
	hashCanonical,
	validateRegistryRefs,
} from "@credit/core";

/** Minimal corpus view for integrity checks (DB rows, parsed files, or store listings). */
export interface IntegrityCorpusSection {
	policyKey: string;
	sectionId: string;
	productScope: "individual" | "sme" | "all";
}

export class CorpusIntegrityError extends Error {
	code: "REGISTRY_MAPPING_MISSING" | "STANDARD_CHANGED";

	constructor(code: CorpusIntegrityError["code"], detail: string) {
		super(detail);
		this.code = code;
	}
}

/** Registry refs for both application kinds. */
export function assertRegistryRefs(corpus: IntegrityCorpusSection[]): void {
	const refs = new Set(corpus.map((s) => `${s.policyKey}#${s.sectionId}`));
	for (const kind of ["individual", "sme"] as const) {
		const v = validateRegistryRefs(refs, corpus, kind, true);
		if (
			v.missingRefs.length > 0 ||
			v.scopeMismatches.length > 0 ||
			v.missingExceptionRuleIds.length > 0
		) {
			throw new CorpusIntegrityError(
				"REGISTRY_MAPPING_MISSING",
				`registry refs missing for ${kind}: ${[...v.missingRefs, ...v.scopeMismatches].join(", ")}`,
			);
		}
	}
}

/** POL-CR-009 9.0-9.4 standard hash over sorted `{sectionId, body}` copies. */
export function assertStandardHash(
	standardBodies: Array<{ sectionId: string; body: string }>,
): void {
	const sorted = [...standardBodies].sort((a, b) => (a.sectionId < b.sectionId ? -1 : 1));
	if (hashCanonical(sorted) !== POLICY_ENGINE_STANDARD_HASH) {
		throw new CorpusIntegrityError(
			"STANDARD_CHANGED",
			"decision-engine standard 9.0-9.4 has changed",
		);
	}
}

/** Registry refs for both application kinds plus the POL-CR-009 9.0-9.4
 * standard hash over `standardBodies` (sorted copies; `{sectionId, body}`
 * hash inputs are identical to the approve/import/seed call sites). */
export function assertCorpusIntegrity(
	corpus: IntegrityCorpusSection[],
	standardBodies: Array<{ sectionId: string; body: string }>,
): void {
	assertRegistryRefs(corpus);
	assertStandardHash(standardBodies);
}
