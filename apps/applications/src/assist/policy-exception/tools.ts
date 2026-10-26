// E3 policy-exception tools: allowlisted, case-scoped, never throwing.
//
// The five policy tools project the deterministic registry/context (no model
// choice of mapping, approver, or mitigant) plus the injected policy client
// for section bodies. The four evidence tools delegate to
// `runMemoEvidenceTool`. Unknown names and bad args return tool errors in the
// payload so the model can recover; only the policy client's transport
// failures are typed, never thrown past this module.
import { ruleDefinitionById, type EvidenceBundle, type PolicyRuleDefinition } from "@credit/core";
import { z } from "zod";
import {
	getEvidenceParams,
	listEvidenceParams,
	listUnavailableParams,
	runMemoEvidenceTool,
	searchEvidenceParams,
} from "../memo-tools.js";
import {
	PolicySourceError,
	type CaseRuleContext,
	type PolicyClient,
	type PolicySectionDelivery,
} from "./types.js";

export const POLICY_EXCEPTION_TOOL_NAMES = [
	"list_failed_rules",
	"get_rule_mapping",
	"get_exception_path",
	"search_policy",
	"get_policy_section",
	"list_evidence",
	"search_evidence",
	"get_evidence",
	"list_unavailable",
] as const;

export type PolicyExceptionToolName = (typeof POLICY_EXCEPTION_TOOL_NAMES)[number];

/** Tools that fetch policy bodies; the orchestrator requires ≥1 per run. */
export const POLICY_RETRIEVAL_TOOL_NAMES = ["search_policy", "get_policy_section"] as const;

/** Tools that expose deterministic rule context (no bodies). */
export const RULE_CONTEXT_TOOL_NAMES = [
	"list_failed_rules",
	"get_rule_mapping",
	"get_exception_path",
] as const;

export function isPolicyRetrievalTool(name: string): boolean {
	return (POLICY_RETRIEVAL_TOOL_NAMES as readonly string[]).includes(name);
}

export function isRuleContextTool(name: string): boolean {
	return (RULE_CONTEXT_TOOL_NAMES as readonly string[]).includes(name);
}

export const listFailedRulesParams = z.object({}).strict();

export const getRuleMappingParams = z.object({ ruleId: z.string().min(1).max(64) }).strict();

export const getExceptionPathParams = z.object({ ruleId: z.string().min(1).max(64) }).strict();

export const searchPolicyParams = z
	.object({
		ruleId: z.string().min(1).max(64),
		focus: z.enum(["standard", "exception", "mitigant"]),
	})
	.strict();

export const getPolicySectionParams = z
	.object({
		policyKey: z.string().min(1).max(80),
		sectionId: z.string().min(1).max(64),
	})
	.strict();

export const POLICY_EXCEPTION_TOOL_PARAMS: Record<string, z.ZodType> = {
	list_failed_rules: listFailedRulesParams,
	get_rule_mapping: getRuleMappingParams,
	get_exception_path: getExceptionPathParams,
	search_policy: searchPolicyParams,
	get_policy_section: getPolicySectionParams,
	list_evidence: listEvidenceParams,
	search_evidence: searchEvidenceParams,
	get_evidence: getEvidenceParams,
	list_unavailable: listUnavailableParams,
};

export interface PolicyExceptionToolDeps {
	context: CaseRuleContext;
	/** Case catalog: rule + exception refs resolved for the officer view. */
	catalog: PolicySectionDelivery[];
	evidence: EvidenceBundle;
	policyClient: PolicyClient;
	actorId: string;
	actorRole: string;
	/** Sections fetched by search/get during this run; mutated in place so a
	 * later `get_policy_section` can cite an already-retrieved section. */
	retrieved?: PolicySectionDelivery[];
}

export interface PolicyExceptionToolOutcome {
	payload: unknown;
	resultCount: number;
	sourceTypes: string[];
	refs: string[];
	/** Sections returned by this call (bodies stay in memory; the trace
	 * stores refs only). */
	policySections: PolicySectionDelivery[];
}

export function sectionKey(policyKey: string, sectionId: string): string {
	return `${policyKey}#${sectionId}`;
}

/** Evidence-style ref for a delivered section (ids + hash only, no body). */
export function policyEvidenceRef(section: PolicySectionDelivery): string {
	return `policy_section:${section.policyKey}:${section.policyVersionId}:${section.sectionId}:${section.quoteHash}`;
}

/** Deterministic retrieval query from registry refs/headings. The model
 * supplies only `{ruleId, focus}`; it cannot inject free text. */
export function buildPolicySearchQuery(
	definition: PolicyRuleDefinition,
	focus: "standard" | "exception" | "mitigant",
): string {
	const refs = focus === "standard" ? definition.ruleSectionRefs : definition.exceptionSectionRefs;
	const refPart = refs.map((ref) => `${ref.policyKey} ${ref.sectionId}`).join(" ");
	const focusTerms =
		focus === "standard"
			? "rule threshold"
			: focus === "exception"
				? "exception approval authority"
				: "mitigant conditions reviewable";
	return `Credit policy ${definition.ruleId} ${definition.reasonCode} ${refPart} ${focusTerms} ${definition.threshold.display}`.slice(
		0,
		1_000,
	);
}

function toolError(message: string): PolicyExceptionToolOutcome {
	return {
		payload: { error: message },
		resultCount: 0,
		sourceTypes: [],
		refs: [],
		policySections: [],
	};
}

function allSections(deps: PolicyExceptionToolDeps): PolicySectionDelivery[] {
	return [...deps.catalog, ...(deps.retrieved ?? [])];
}

function byKey(sections: PolicySectionDelivery[]): Map<string, PolicySectionDelivery> {
	return new Map(
		sections.map((section) => [sectionKey(section.policyKey, section.sectionId), section]),
	);
}

function recordSections(
	sections: PolicySectionDelivery[],
	deps: PolicyExceptionToolDeps,
): { refs: string[]; fresh: PolicySectionDelivery[] } {
	const known = new Set(
		allSections(deps).map((section) => sectionKey(section.policyKey, section.sectionId)),
	);
	const fresh: PolicySectionDelivery[] = [];
	for (const section of sections) {
		if (!known.has(sectionKey(section.policyKey, section.sectionId))) {
			known.add(sectionKey(section.policyKey, section.sectionId));
			fresh.push(section);
		}
	}
	if (fresh.length > 0) {
		if (!deps.retrieved) deps.retrieved = [];
		deps.retrieved.push(...fresh);
	}
	return { refs: sections.map(policyEvidenceRef), fresh };
}

function listFailedRules(deps: PolicyExceptionToolDeps): PolicyExceptionToolOutcome {
	const rules = deps.context.failedRules.map((failure) => ({
		ruleId: failure.ruleId,
		reasonCode: failure.reasonCode,
		effect: failure.effect,
		observed: failure.observed,
		threshold: failure.threshold,
		decisionRelevant: failure.decisionRelevant,
		evaluated: failure.evaluated,
		persisted: failure.persisted,
		mappingState: failure.mappingState,
		exceptionState: failure.exception.state,
	}));
	return {
		payload: {
			rules,
			// Unmapped ids are reported, never explained: the validator bans
			// them from `rules` and prose alike.
			unmappedRuleIds: deps.context.unmappedRuleIds,
			unmappedExceptionRuleIds: deps.context.unmappedExceptionRuleIds,
			totalFailed: rules.length,
		},
		resultCount: rules.length,
		sourceTypes: [],
		refs: [],
		policySections: [],
	};
}

function getRuleMapping(deps: PolicyExceptionToolDeps, args: unknown): PolicyExceptionToolOutcome {
	const parsed = getRuleMappingParams.safeParse(args);
	if (!parsed.success) return toolError("ruleId is required");
	const definition = ruleDefinitionById(parsed.data.ruleId);
	if (!definition) return toolError(`unknown rule id: ${parsed.data.ruleId.slice(0, 64)}`);
	const failure = deps.context.failedRules.find((entry) => entry.ruleId === definition.ruleId);
	return {
		payload: {
			ruleId: definition.ruleId,
			reasonCode: definition.reasonCode,
			effect: definition.effect,
			threshold: definition.threshold,
			ruleSectionRefs: definition.ruleSectionRefs,
			exceptionSectionRefs: definition.exceptionSectionRefs,
			exceptionKind: definition.exceptionKind,
			mappingState: failure?.mappingState ?? "mapping_unavailable",
			notes: definition.notes,
		},
		resultCount: 1,
		sourceTypes: [],
		refs: [],
		policySections: [],
	};
}

function getExceptionPath(
	deps: PolicyExceptionToolDeps,
	args: unknown,
): PolicyExceptionToolOutcome {
	const parsed = getExceptionPathParams.safeParse(args);
	if (!parsed.success) return toolError("ruleId is required");
	const failure = deps.context.failedRules.find((entry) => entry.ruleId === parsed.data.ruleId);
	if (!failure) return toolError(`no failed rule: ${parsed.data.ruleId.slice(0, 64)}`);
	return {
		payload: {
			ruleId: failure.ruleId,
			exceptionState: failure.exception.state,
			approver: failure.exception.approver,
			approverBasis: failure.exception.approverBasis,
			dualSignoff: failure.exception.dualSignoff,
			mitigants: failure.exception.mitigants.map((mitigant) => ({
				code: mitigant.code,
				label: mitigant.label,
			})),
			conditions: failure.exception.conditions,
			citations: failure.exception.citations,
			regularisationPlanMaxMonths: failure.exception.regularisationPlanMaxMonths,
			reason: failure.exception.reason,
			observed: failure.observed,
			threshold: failure.threshold,
		},
		resultCount: 1,
		sourceTypes: [],
		refs: [],
		policySections: [],
	};
}

async function searchPolicy(
	deps: PolicyExceptionToolDeps,
	args: unknown,
): Promise<PolicyExceptionToolOutcome> {
	const parsed = searchPolicyParams.safeParse(args);
	if (!parsed.success) return toolError("ruleId and focus are required");
	const definition = ruleDefinitionById(parsed.data.ruleId);
	if (!definition) return toolError(`unknown rule id: ${parsed.data.ruleId.slice(0, 64)}`);
	const query = buildPolicySearchQuery(definition, parsed.data.focus);
	let response;
	try {
		response = await deps.policyClient.searchSections({
			applicationId: deps.context.applicationId,
			actorId: deps.actorId,
			actorRole: deps.actorRole,
			policyAsOf: deps.context.policyAsOf,
			productScope: deps.context.applicationKind,
			query,
			topK: 8,
		});
	} catch (err) {
		if (err instanceof PolicySourceError) return toolError(err.code);
		return toolError("POLICY_SOURCE_UNAVAILABLE");
	}
	const { refs } = recordSections(response.sections, deps);
	return {
		payload: {
			query,
			total: response.sections.length,
			sections: response.sections.map((section) => ({
				policyKey: section.policyKey,
				sectionId: section.sectionId,
				heading: section.heading,
				body: section.body,
				version: section.version,
				truncated: section.truncated,
			})),
			missing: response.missing,
		},
		resultCount: response.sections.length,
		sourceTypes: response.sections.length > 0 ? ["policy_section"] : [],
		refs,
		policySections: response.sections,
	};
}

function getPolicySection(
	deps: PolicyExceptionToolDeps,
	args: unknown,
): PolicyExceptionToolOutcome {
	const parsed = getPolicySectionParams.safeParse(args);
	if (!parsed.success) return toolError("policyKey and sectionId are required");
	const found = byKey(allSections(deps)).get(
		sectionKey(parsed.data.policyKey, parsed.data.sectionId),
	);
	// Catalog-scoped: the model can only quote sections resolved for this
	// case (rule/exception refs) or already retrieved via search_policy.
	if (!found) return toolError("unknown policy section for this case");
	return {
		payload: {
			policyKey: found.policyKey,
			sectionId: found.sectionId,
			heading: found.heading,
			body: found.body,
			version: found.version,
			truncated: found.truncated,
		},
		resultCount: 1,
		sourceTypes: ["policy_section"],
		refs: [policyEvidenceRef(found)],
		policySections: [found],
	};
}

/** Run one allowlisted tool. Never throws: unknown names, bad args, and
 * policy transport failures all return `{error}` payloads. */
export async function runPolicyExceptionTool(
	deps: PolicyExceptionToolDeps,
	name: string,
	args: unknown,
): Promise<PolicyExceptionToolOutcome> {
	try {
		switch (name) {
			case "list_failed_rules":
				if (!listFailedRulesParams.safeParse(args).success)
					return toolError("no arguments expected");
				return listFailedRules(deps);
			case "get_rule_mapping":
				return getRuleMapping(deps, args);
			case "get_exception_path":
				return getExceptionPath(deps, args);
			case "search_policy":
				return await searchPolicy(deps, args);
			case "get_policy_section":
				return getPolicySection(deps, args);
			case "list_evidence":
			case "search_evidence":
			case "get_evidence":
			case "list_unavailable": {
				const outcome = runMemoEvidenceTool(name, args, deps.evidence);
				return { ...outcome, policySections: [] };
			}
			default:
				return toolError(`unknown tool: ${name.slice(0, 80)}`);
		}
	} catch {
		return toolError("POLICY_SOURCE_UNAVAILABLE");
	}
}
