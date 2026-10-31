// E3 officer surface: rule-context mapping, policy catalog resolve, and
// case evidence assembly for the policy/exception navigator.
//
// Pure mapping plus two impure assemblers. Nothing here logs: bundles and
// contexts may sit beside applicant data, so no names, values, or text may
// leave except the deterministic engine observations the route returns.
import {
	hashQuote,
	POLICY_REGISTRY_HASH,
	POLICY_REGISTRY_VERSION,
	parseSourceRef,
	ruleDefinitionById,
	SCORECARD_VERSION,
	sourceRefKey,
	type EvidenceBundle,
	type EvidenceItem,
} from "@credit/core";
import type { Db } from "@credit/db/applications";
import { HttpError } from "@credit/service-kit";
import { assembleCaseEvidence } from "../evidence.js";
import {
	buildCaseRuleContext,
	type CaseRuleContext as DeterministicContext,
} from "../policy-rules.js";
import { listArtifacts } from "../artifacts.js";
import type { AssistActor } from "../access.js";
import type { AssistRuntime } from "../types.js";
import {
	PolicySourceError,
	policyExceptionReplayKey,
	type CaseRuleContext,
	type PolicyExceptionAgentConfig,
	type PolicySectionDelivery,
} from "../../agents/policy-exception/index.js";

export interface PolicyExceptionViewInput {
	db: Db;
	kase: {
		application: { id: string; reference: string; product: string; amountCents: number };
		assignedToMe: boolean;
	};
	actor: AssistActor;
	runtime: AssistRuntime;
	policyClient?: import("../../agents/policy-exception/index.js").PolicyClient;
	now?: Date;
}

function productKind(product: string): "individual" | "sme" {
	return product === "sme_term_loan" ? "sme" : "individual";
}

function sharedProduct(product: string): "personal_loan" | "sme_term_loan" {
	return product === "sme_term_loan" ? "sme_term_loan" : "personal_loan";
}

function normalizeOutcome(
	deterministic: DeterministicContext,
): "auto_approve" | "refer" | "decline" | "not_applicable" {
	if (deterministic.status === "not_applicable") return "not_applicable";
	if (deterministic.decisionId) {
		if (deterministic.outcome === "approved") {
			return deterministic.reasonCodes.length > 0 ? "refer" : "auto_approve";
		}
		if (deterministic.outcome === "declined") return "decline";
		return "not_applicable";
	}
	if (
		deterministic.outcome === "auto_approve" ||
		deterministic.outcome === "refer" ||
		deterministic.outcome === "decline"
	) {
		return deterministic.outcome;
	}
	return "not_applicable";
}

/** Map the deterministic EN-07 context to the shared agent context. */
export function toSharedCaseRuleContext(
	deterministic: DeterministicContext,
	kase: { application: { id: string; reference: string; product: string; amountCents: number } },
): CaseRuleContext {
	const applicationKind = productKind(kase.application.product);
	const grade = deterministic.grade ?? null;
	const unmapped = deterministic.failedRules
		.filter((rule) => rule.mappingState === "mapping_unavailable")
		.map((rule) => rule.ruleId);
	const unmappedExceptions = deterministic.failedRules
		.filter((rule) => rule.exception.state === "mapping_unavailable")
		.map((rule) => rule.ruleId);
	return {
		applicationId: deterministic.applicationId,
		applicationReference: kase.application.reference ?? null,
		policyAsOf: deterministic.policyAsOf,
		product: sharedProduct(kase.application.product),
		applicationKind,
		outcome: normalizeOutcome(deterministic),
		policyVersion: deterministic.policyVersion ?? null,
		scorecardVersion: deterministic.scorecardVersion ?? SCORECARD_VERSION,
		registryVersion: deterministic.registryVersion,
		score: deterministic.score,
		grade,
		scoreBand: grade,
		amountCents: kase.application.amountCents,
		secured: deterministic.secured,
		securedQualifying: deterministic.securedQualifying,
		status: deterministic.status,
		failedRules: deterministic.failedRules.map((rule) => ({
			ruleId: rule.ruleId,
			reasonCode: rule.reasonCode,
			effect: rule.effect,
			product: rule.product,
			persisted: rule.persisted,
			evaluated: rule.evaluated,
			decisionRelevant: rule.decisionRelevant,
			observed: rule.observed,
			observedValue: rule.observedValue,
			threshold: rule.threshold,
			scoreBand: rule.scoreBand ?? grade ?? "",
			ruleSectionRefs: rule.ruleSectionRefs,
			exception: rule.exception,
			mappingState: rule.mappingState,
			explanationLimitation: rule.explanationLimitation,
		})),
		unmappedRuleIds: [...unmapped],
		unmappedExceptionRuleIds: [...unmappedExceptions],
		limitations: [...deterministic.limitations],
		caseStatus: deterministic.caseStatus,
		reasonCodes: [...deterministic.reasonCodes],
		failedRuleCount: deterministic.failedRuleCount,
		evaluationId: deterministic.evaluationId,
		decisionId: deterministic.decisionId,
	};
}

function agentConfigFor(runtime: AssistRuntime): PolicyExceptionAgentConfig {
	const config = runtime.config;
	return {
		model: config.policyExceptionModel,
		agentVersion: config.policyExceptionAgentVersion,
		promptVersion: config.policyExceptionPromptVersion,
		validatorVersion: config.policyExceptionValidatorVersion,
		registryVersion: POLICY_REGISTRY_VERSION,
		registryHash: POLICY_REGISTRY_HASH,
		artifactType: "policy_exception_memo",
		maxSteps: config.policyExceptionMaxSteps,
		maxToolCalls: config.policyExceptionMaxToolCalls,
		timeoutMs: config.policyExceptionTimeoutMs,
		maxCostUsd: config.policyExceptionMaxCostUsd,
	};
}

export function policyCatalogRefs(
	context: CaseRuleContext,
): Array<{ policyKey: string; sectionId: string }> {
	return dedupeRefs(context);
}

function dedupeRefs(context: CaseRuleContext): Array<{ policyKey: string; sectionId: string }> {
	const seen = new Set<string>();
	const out: Array<{ policyKey: string; sectionId: string }> = [];
	for (const failure of context.failedRules) {
		const def = failure.ruleSectionRefs ?? [];
		const exc = [
			...(failure.exception?.citations ?? []),
			...(ruleDefinitionById(failure.ruleId)?.exceptionSectionRefs ?? []),
		];
		for (const ref of [...def, ...exc]) {
			const key = `${ref.policyKey}#${ref.sectionId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ policyKey: ref.policyKey, sectionId: ref.sectionId });
		}
	}
	return out;
}

export async function resolvePolicyCatalog(input: {
	policyClient?: import("../../agents/policy-exception/index.js").PolicyClient;
	context: CaseRuleContext;
	actor: AssistActor;
	extraRefs?: Array<{ policyKey: string; sectionId: string; versionId?: string }>;
}): Promise<{ sections: PolicySectionDelivery[]; sourceStatus: "ok" | "partial" | "unavailable" }> {
	const client = input.policyClient;
	const refs = input.extraRefs ?? dedupeRefs(input.context);
	if (!client || refs.length === 0) {
		if (!client && refs.length > 0) return { sections: [], sourceStatus: "unavailable" };
		return { sections: [], sourceStatus: "ok" };
	}
	const productScope = input.context.applicationKind;
	const merged: PolicySectionDelivery[] = [];
	const seen = new Set<string>();
	let partial = false;
	for (let i = 0; i < refs.length; i += 20) {
		const batch = refs.slice(i, i + 20);
		let response;
		try {
			response = await client.resolveSections({
				applicationId: input.context.applicationId,
				actorId: input.actor.id,
				actorRole: input.actor.role,
				policyAsOf: input.context.policyAsOf,
				productScope,
				refs: batch,
			});
		} catch (err) {
			if (err instanceof PolicySourceError) return { sections: [], sourceStatus: "unavailable" };
			throw err;
		}
		if (response.status === "partial" || response.missing.length > 0) partial = true;
		for (const section of response.sections) {
			const key = `${section.policyKey}#${section.sectionId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(section);
		}
	}
	return { sections: merged, sourceStatus: partial ? "partial" : "ok" };
}

export function ruleFailureRef(evaluationId: string, reasonCode: string): string {
	return ruleEvidenceRef(evaluationId, reasonCode);
}

function ruleEvidenceRef(evaluationId: string, reasonCode: string): string {
	return sourceRefKey({ type: "score_reason", scoreId: evaluationId, code: `RULE_${reasonCode}` });
}

export function policySectionRefFor(section: PolicySectionDelivery): string {
	return policyEvidenceRef(section);
}

function policyEvidenceRef(section: PolicySectionDelivery): string {
	return sourceRefKey({
		type: "policy_section",
		policyKey: section.policyKey,
		policyVersionId: section.policyVersionId,
		sectionId: section.sectionId,
		quoteHash: section.quoteHash,
	});
}

function stablePolicyMetadata(
	section: PolicySectionDelivery,
): Record<string, string | number | boolean | null> {
	return {
		policyKey: section.policyKey,
		version: section.version,
		sectionId: section.sectionId,
		effectiveFrom: section.effectiveFrom,
		effectiveTo: section.effectiveTo,
		heading: section.heading,
		truncated: section.truncated,
		contentHash: section.contentHash,
	};
}

function withPolicyEvidence(
	bundle: EvidenceBundle,
	context: CaseRuleContext,
	catalog: PolicySectionDelivery[],
): EvidenceBundle {
	const pinnedId = context.evaluationId ?? context.decisionId ?? context.applicationId;
	const items: EvidenceItem[] = [...bundle.items];
	for (const failure of context.failedRules) {
		items.push({
			ref: ruleEvidenceRef(pinnedId, failure.reasonCode),
			sourceType: "score_reason",
			label: failure.ruleId.slice(0, 200),
			content: `observed=${failure.observed}; threshold=${failure.threshold}`,
			access: { retentionUntil: null, legalHold: false },
			metadata: {
				kind: "rule_failure",
				ruleId: failure.ruleId,
				effect: failure.effect,
				persisted: failure.persisted,
			},
		});
	}
	for (const section of catalog) {
		items.push({
			ref: policyEvidenceRef(section),
			sourceType: "policy_section",
			label: section.heading.slice(0, 200),
			content: section.body,
			access: { retentionUntil: null, legalHold: false },
			metadata: stablePolicyMetadata(section),
		});
	}
	const seen = new Set<string>();
	const deduped = items.filter((item) => (seen.has(item.ref) ? false : (seen.add(item.ref), true)));
	deduped.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
	if (deduped.length > 500) {
		throw new HttpError(422, "POLICY_EXCEPTION_INVALID", "policy evidence exceeds the bundle cap");
	}
	return { ...bundle, items: deduped };
}

async function baseEvidence(input: {
	db: Db;
	kase: PolicyExceptionViewInput["kase"] & {
		application: { id: string } & Record<string, unknown>;
	};
	actor: AssistActor;
	runtime: AssistRuntime;
	now: Date;
	pinned: { evaluationId?: string; decisionId?: string };
}): Promise<EvidenceBundle> {
	const application = input.kase.application as unknown as Parameters<
		typeof assembleCaseEvidence
	>[0]["application"];
	const assembled = await assembleCaseEvidence({
		db: input.db,
		application,
		officer: input.actor,
		assignedToMe: input.kase.assignedToMe,
		documentsEnabled: input.runtime.documentsEnabled,
		now: input.now,
		pinned: { ...input.pinned, snapshot: undefined },
		research: {
			url: input.runtime.config.researchUrl,
			secret: input.runtime.config.internalSecret,
			timeoutMs: input.runtime.config.researchTimeoutMs,
			fetchImpl: input.runtime.researchFetchImpl,
		},
	});
	// Drop the research pseudo policy ref: every research `policy_section`
	// item and only the `policy_section` unavailable entries. Document,
	// score, and context gaps stay so `list_unavailable` still reports them.
	return {
		...assembled,
		items: assembled.items.filter((item) => item.sourceType !== "policy_section"),
		unavailable: assembled.unavailable.filter((item) => item.sourceType !== "policy_section"),
	};
}

/** Officer view: deterministic context plus the resolved policy catalog and
 * the latest visible memo summary. Policy-source failure degrades to
 * `sourceStatus: "unavailable"`, never a throw. */
export async function buildPolicyExceptionView(
	input: PolicyExceptionViewInput,
): Promise<import("../../agents/policy-exception/index.js").PolicyExceptionView> {
	const deterministic = await buildCaseRuleContext({
		db: input.db,
		applicationId: input.kase.application.id,
	});
	const context = toSharedCaseRuleContext(
		deterministic,
		input.kase as unknown as Parameters<typeof toSharedCaseRuleContext>[1],
	);
	const client = input.policyClient ?? input.runtime.policyClient;
	const { sections, sourceStatus } = await resolvePolicyCatalog({
		policyClient: client,
		context,
		actor: input.actor,
	});
	const rows = await listArtifacts(input.db, input.kase.application.id, "policy_exception_memo");
	const visible = rows.filter(
		(artifact) =>
			artifact.status !== "deleted" &&
			artifact.status !== "superseded" &&
			(input.kase.assignedToMe || !artifact.documentDerived),
	);
	const latest = visible[0] ?? null;
	return {
		context,
		sections,
		sourceStatus,
		latestArtifact: latest
			? {
					id: latest.id,
					version: latest.version,
					revision: latest.revision,
					status: latest.status,
					updatedAt: latest.updatedAt,
					retentionUntil: latest.retentionUntil,
				}
			: null,
	};
}

export interface PolicyExceptionEvidence {
	bundle: EvidenceBundle;
	context: CaseRuleContext;
	catalog: PolicySectionDelivery[];
	replayKey: string;
	sourceStatus: "ok" | "partial" | "unavailable";
}

/** Full evidence for explain/follow-up/memo: pinned case bundle plus
 * deterministic rule-failure and policy-section items. */
export async function loadPolicyExceptionEvidence(input: {
	db: Db;
	kase: PolicyExceptionViewInput["kase"] & {
		application: { id: string } & Record<string, unknown>;
	};
	actor: AssistActor;
	runtime: AssistRuntime;
	policyClient?: import("../../agents/policy-exception/index.js").PolicyClient;
	now?: Date;
}): Promise<PolicyExceptionEvidence> {
	const deterministic = await buildCaseRuleContext({
		db: input.db,
		applicationId: (input.kase.application as { id: string }).id,
	});
	const context = toSharedCaseRuleContext(
		deterministic,
		input.kase as unknown as Parameters<typeof toSharedCaseRuleContext>[1],
	);
	const now = input.now ?? input.runtime.now();
	const bundle = await baseEvidence({
		db: input.db,
		kase: input.kase as PolicyExceptionViewInput["kase"] & {
			application: { id: string } & Record<string, unknown>;
		},
		actor: input.actor,
		runtime: input.runtime,
		now,
		pinned: {
			evaluationId: deterministic.evaluationId ?? undefined,
			decisionId: deterministic.decisionId ?? undefined,
		},
	});
	const client = input.policyClient ?? input.runtime.policyClient;
	const { sections, sourceStatus } = await resolvePolicyCatalog({
		policyClient: client,
		context,
		actor: input.actor,
	});
	const full = withPolicyEvidence(bundle, context, sections);
	const replayKey = policyExceptionReplayKey({
		context,
		evidence: full,
		catalog: sections,
		config: agentConfigFor(input.runtime),
	});
	return { bundle: full, context, catalog: sections, replayKey, sourceStatus };
}

/** Rebuild evidence for an existing memo (PATCH/approve): the stored
 * citations pin exact policy versions, so resolve those refs with their
 * `versionId` before re-running validation. */
export async function policyExceptionEvidenceForArtifact(input: {
	db: Db;
	kase: PolicyExceptionViewInput["kase"] & {
		application: { id: string } & Record<string, unknown>;
	};
	actor: AssistActor;
	artifact: { citations: Array<{ ref: string }> };
	runtime: AssistRuntime;
	policyClient?: import("../../agents/policy-exception/index.js").PolicyClient;
	now?: Date;
}): Promise<PolicyExceptionEvidence> {
	const deterministic = await buildCaseRuleContext({
		db: input.db,
		applicationId: (input.kase.application as { id: string }).id,
	});
	const context = toSharedCaseRuleContext(
		deterministic,
		input.kase as unknown as Parameters<typeof toSharedCaseRuleContext>[1],
	);
	const now = input.now ?? input.runtime.now();
	const bundle = await baseEvidence({
		db: input.db,
		kase: input.kase as PolicyExceptionViewInput["kase"] & {
			application: { id: string } & Record<string, unknown>;
		},
		actor: input.actor,
		runtime: input.runtime,
		now,
		pinned: {
			evaluationId: deterministic.evaluationId ?? undefined,
			decisionId: deterministic.decisionId ?? undefined,
		},
	});
	const client = input.policyClient ?? input.runtime.policyClient;
	const ruleRefs = dedupeRefs(context);
	const versioned = new Map<string, { policyKey: string; sectionId: string; versionId?: string }>();
	for (const ref of ruleRefs) versioned.set(`${ref.policyKey}#${ref.sectionId}`, ref);
	for (const citation of input.artifact.citations) {
		const parsed = parseSourceRef(citation.ref);
		if (parsed?.type !== "policy_section") continue;
		const key = `${parsed.policyKey}#${parsed.sectionId}`;
		if (!versioned.has(key)) {
			versioned.set(key, {
				policyKey: parsed.policyKey,
				sectionId: parsed.sectionId,
				versionId: parsed.policyVersionId,
			});
		} else {
			// Prefer the exact stored version when the artifact cites one.
			versioned.set(key, {
				policyKey: parsed.policyKey,
				sectionId: parsed.sectionId,
				versionId: parsed.policyVersionId,
			});
		}
	}
	const { sections, sourceStatus } = await resolvePolicyCatalog({
		policyClient: client,
		context,
		actor: input.actor,
		extraRefs: [...versioned.values()],
	});
	// Hardening: the stored quote hash identifies the exact body; drop any
	// delivery whose body diverges so a retired version cannot validate.
	const byKey = new Map(
		sections.map((section) => [`${section.policyKey}#${section.sectionId}`, section]),
	);
	const filtered = [...byKey.values()].filter((section) => {
		for (const citation of input.artifact.citations) {
			const parsed = parseSourceRef(citation.ref);
			if (
				parsed?.type === "policy_section" &&
				parsed.policyKey === section.policyKey &&
				parsed.sectionId === section.sectionId
			) {
				if (
					parsed.quoteHash !== section.quoteHash &&
					parsed.quoteHash !== hashQuote(section.body)
				) {
					return false;
				}
			}
		}
		return true;
	});
	const full = withPolicyEvidence(bundle, context, filtered);
	const replayKey = policyExceptionReplayKey({
		context,
		evidence: full,
		catalog: filtered,
		config: agentConfigFor(input.runtime),
	});
	return { bundle: full, context, catalog: filtered, replayKey, sourceStatus };
}
