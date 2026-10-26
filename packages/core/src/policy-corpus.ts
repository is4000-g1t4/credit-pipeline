// Pure policy-section selection, shared by the policy store and the policy
// exception eval fixture. The store maps DB rows to `PolicySectionRow`; the
// fixture maps corpus rows to the same shape. One selection rule prevents the
// eval and production from disagreeing about product scope, as-of, or status.

export type PolicyProductScope = "individual" | "sme" | "all";

export interface PolicySectionRow {
	policyId: string;
	policyKey: string;
	title: string;
	policyVersionId: string;
	version: string;
	status: "approved" | "retired";
	effectiveFrom: string;
	effectiveTo: string | null;
	sectionId: string;
	heading: string;
	body: string;
	contentHash: string;
	policyFamily: string;
	productScope: PolicyProductScope;
	jurisdiction: string;
	domain: string;
}

export interface PolicySectionLookup {
	policyKey: string;
	sectionId: string;
	/** Exact version revalidation; bypasses the active-window check. */
	versionId?: string;
}

export interface PolicySectionContext {
	/** YYYY-MM-DD. */
	asOf: string;
	productScope: "individual" | "sme";
	jurisdiction: string;
}

/** Select the exact version when requested; otherwise the approved version
 * effective at `asOf` whose product scope is `all` or matches the case. */
export function selectActiveSection(
	rows: readonly PolicySectionRow[],
	lookup: PolicySectionLookup,
	context: PolicySectionContext,
): PolicySectionRow | null {
	const matches = rows.filter(
		(row) =>
			row.domain === "credit" &&
			row.policyKey === lookup.policyKey &&
			row.sectionId === lookup.sectionId &&
			row.jurisdiction === context.jurisdiction &&
			(row.productScope === "all" || row.productScope === context.productScope),
	);
	if (lookup.versionId !== undefined) {
		return (
			matches.find(
				(row) =>
					row.policyVersionId === lookup.versionId &&
					(row.status === "approved" || row.status === "retired"),
			) ?? null
		);
	}
	return (
		matches.find(
			(row) =>
				row.status === "approved" &&
				row.effectiveFrom <= context.asOf &&
				(row.effectiveTo === null || row.effectiveTo >= context.asOf),
		) ?? null
	);
}
