// EN-07 case rule-failure context builder.
//
// Pure row-to-context mapping (`buildCaseRuleContextFromRows`, unit-tested
// without a DB) plus a thin DB loader. Decided cases use the frozen
// `decision.snapshot` (`kind:"credit"`); pending cases use the latest
// `policy_evaluations` row. Nothing here logs: inputs may sit beside
// applicant data, so no names, values, or text may leave except the
// deterministic engine observations (numbers/industry bands) the route
// returns. Audit payloads stay metadata-only at the route layer.
import {
	POLICY_REGISTRY_VERSION,
	POLICY_RULE_DEFINITIONS,
	POLICY_VERSION,
	SCORECARD_VERSION,
	explainPolicyRules,
	gradeForScore,
	policyInputsSchema,
	resolveExceptionPath,
	ruleDefinitionFor,
	type Grade,
	type PolicyExceptionPath,
	type PolicyInputs,
	type PolicyReasonCode,
	type PolicySectionRef,
} from "@credit/core";
import { applications, decisions, policyEvaluations, type Db } from "@credit/db/applications";
import { HttpError } from "@credit/service-kit";
import { desc, eq, sql } from "drizzle-orm";

export class RuleContextUnavailableError extends Error {
	readonly code = "RULE_CONTEXT_UNAVAILABLE" as const;
	constructor(message = "rule context is unavailable for this case") {
		super(message);
		this.name = "RuleContextUnavailableError";
	}
}

export class UnsupportedPolicyVersionError extends Error {
	readonly code = "UNSUPPORTED_POLICY_VERSION" as const;
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedPolicyVersionError";
	}
}

export type CaseRuleStatus =
	| "ok"
	| "no_failed_rules"
	| "partial_mapping"
	| "mapping_unavailable"
	| "not_applicable";

export type RuleMappingState = "mapped" | "mapping_unavailable";

export interface CaseRuleFailure {
	ruleId: string;
	reasonCode: string;
	effect: "decline" | "refer" | "informational";
	product: string;
	persisted: boolean;
	evaluated: boolean;
	decisionRelevant: boolean;
	observed: string;
	observedValue: number | string;
	threshold: string;
	scoreBand: Grade;
	ruleSectionRefs: PolicySectionRef[];
	exception: PolicyExceptionPath;
	mappingState: RuleMappingState;
	explanationLimitation: string | null;
}

export interface CaseRuleContext {
	applicationId: string;
	caseStatus: string;
	status: CaseRuleStatus;
	policyVersion: string;
	/** YYYY-MM-DD of the evaluation/decision the context is pinned to. */
	policyAsOf: string;
	registryVersion: string;
	score: number | null;
	grade: Grade | null;
	scorecardVersion: string | null;
	outcome: string | null;
	product: string;
	reasonCodes: string[];
	secured: boolean;
	securedQualifying: boolean;
	/** Decline breaches + allowed exceptions (refer triggers and structural
	 * remedies never escalate). Drives multi-rule committee escalation. */
	failedRuleCount: number;
	failedRules: CaseRuleFailure[];
	limitations: string[];
	evaluationId: string | null;
	decisionId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const GRADES = new Set<string>(["A", "B", "C", "D", "E"]);

function toReasonCodes(reasons: unknown): string[] {
	if (!Array.isArray(reasons)) return [];
	const codes: string[] = [];
	for (const raw of reasons) {
		if (isRecord(raw) && typeof raw["code"] === "string" && raw["code"].length > 0) {
			codes.push(raw["code"]);
		}
	}
	return codes;
}

// POL-CR-008 8.1 caps property LTV at 75% (completed residential), 60%
// (commercial), 50% (industrial/land); equipment at 70%/50%. The case model
// carries no collateral type, so qualifying collateral uses the strictest
// documented property cap — which also matches the POL-CR-003 3.1 secured
// condition (≤50%) the trading-remedy path requires.
// ponytail: single 50% cap; per-type caps if collateral ever gains a type.
function securedFor(
	business: unknown,
	amountCents: number,
): { secured: boolean; qualifying: boolean; tradingQualifying: boolean } {
	const collateral = isRecord(business) ? business["collateral"] : null;
	const secured = isRecord(collateral) && collateral["hasCollateral"] === true;
	const value = isRecord(collateral) ? collateral["valueCents"] : null;
	const valued = secured && typeof value === "number" && Number.isFinite(value) && value > 0;
	// POL-CR-008 8.1 caps LTV at 75% for completed residential property and
	// lower for other collateral; the case model carries no type, so the most
	// permissive documented cap (75%) is the general floor.
	const qualifying = valued && amountCents * 4 <= value * 3;
	// POL-CR-003 3.1's trading remedy requires the facility to be capped at
	// 50% of the standard limit with qualifying collateral.
	const tradingQualifying = valued && amountCents * 2 <= value;
	return { secured, qualifying, tradingQualifying };
}

function asOfDay(value: Date): string {
	return value.toISOString().slice(0, 10);
}

const ENGINE_ONLY_LIMITATION =
	"Engine rules only; policy eligibility (for example POL-CR-003 3.1) may be stricter than the engine bands.";
const UNVERIFIED_APPROVER_LIMITATION =
	"Staff, PEP, connected-party, and own-application flags are not in the case model and were not evaluated; any approver shown is a minimum and committee routing must be verified.";
const UNSECURED_BRANCH_LIMITATION =
	"Collateral value or loan-to-value is unknown or above the cap; the unsecured branch applies.";
const NO_TAXONOMY_LIMITATION =
	"One or more failed rules have no recorded exception taxonomy; a policy owner is required.";
const CHECK_ONLY_LIMITATION =
	"This decision carries no policy engine inputs, so no rules were evaluated.";

function statusFor(rules: CaseRuleFailure[]): CaseRuleStatus {
	if (rules.length === 0) return "no_failed_rules";
	if (rules.every((rule) => rule.mappingState === "mapping_unavailable")) {
		return "mapping_unavailable";
	}
	if (rules.some((rule) => rule.mappingState === "mapping_unavailable")) {
		return "partial_mapping";
	}
	return "ok";
}

function buildRules(
	inputs: PolicyInputs,
	reasonCodes: string[],
	grade: Grade,
	securedQualifying: boolean,
	tradingSecured: boolean,
): { rules: CaseRuleFailure[]; failedRuleCount: number } {
	let failures;
	try {
		failures = explainPolicyRules(
			inputs,
			reasonCodes.map((code) => ({ code: code as PolicyReasonCode })),
		);
	} catch {
		throw new RuleContextUnavailableError("policy rule evaluation failed for this case");
	}
	const knownPolicyCodes = new Set<string>(
		POLICY_RULE_DEFINITIONS.map((definition) => definition.reasonCode),
	);
	const explainedCodes = new Set(failures.map((failure) => failure.reasonCode));
	const nonPolicyCodes = new Set([
		"IDENTITY_FAILED",
		"SANCTIONS_HIT",
		"OFFICER_JUDGEMENT",
		"INSUFFICIENT_EVIDENCE",
		"POLICY_EXCEPTION",
	]);
	for (const code of reasonCodes) {
		if (knownPolicyCodes.has(code) && !explainedCodes.has(code as never)) {
			throw new RuleContextUnavailableError(
				`persisted policy reason ${code} is not reproducible from the stored inputs`,
			);
		}
	}
	// Unknown codes are a genuine registry gap: show them as unmapped instead
	// of silently dropping the decision reason (EN-06 fail-closed).
	const unknownCodes = reasonCodes.filter(
		(code) => !knownPolicyCodes.has(code) && !nonPolicyCodes.has(code),
	);
	const synthetic: CaseRuleFailure[] = unknownCodes.map((code) => ({
		ruleId: `UNMAPPED:${code}`,
		reasonCode: code,
		effect: "decline",
		product: inputs.kind === "sme" ? "sme_term_loan" : "personal_loan",
		persisted: true,
		evaluated: true,
		decisionRelevant: true,
		observed: "unknown",
		observedValue: "unknown",
		threshold: "not mapped",
		scoreBand: grade,
		ruleSectionRefs: [],
		exception: {
			state: "mapping_unavailable",
			approver: null,
			approverBasis: null,
			approverVerification: "minimum",
			committeeCheckRequired: true,
			dualSignoff: false,
			mitigants: [],
			citations: [],
			conditions: [],
			regularisationPlanMaxMonths: null,
			reason:
				"No policy decision registry entry exists for this reason code; a policy owner is required.",
		},
		mappingState: "mapping_unavailable",
		explanationLimitation:
			"No policy decision registry entry exists for this reason code; a policy owner is required.",
	}));
	// Exception states never depend on the count (only the approver does),
	// so one resolution pass fixes the count and a second applies escalation.
	const states = failures.map((failure) => {
		const definition = ruleDefinitionFor(failure.reasonCode, inputs.kind);
		if (!definition) {
			throw new RuleContextUnavailableError(`unmapped policy rule ${failure.reasonCode}`);
		}
		return {
			failure,
			definition,
			exception: resolveExceptionPath({
				definition,
				observedValue: failure.observedValue,
				amountCents: inputs.amountCents,
				failedRuleCount: 0,
				securedQualifying,
				tradingSecured,
			}),
		};
	});
	const failedRuleCount = states.filter(
		({ failure, exception }) => failure.effect === "decline" || exception.state === "allowed",
	).length;
	const rules = states.map(({ failure, definition, exception }): CaseRuleFailure => {
		const resolved =
			failedRuleCount >= 2 && exception.state === "allowed"
				? resolveExceptionPath({
						definition,
						observedValue: failure.observedValue,
						amountCents: inputs.amountCents,
						failedRuleCount,
						securedQualifying,
						tradingSecured,
					})
				: exception;
		const mappingState: RuleMappingState =
			definition.ruleSectionRefs.length > 0 ? "mapped" : "mapping_unavailable";
		const securedConditional =
			definition.ruleId === "SME-TRADING-REFER" || definition.ruleId === "SME-DSCR-REFER";
		return {
			ruleId: definition.ruleId,
			reasonCode: failure.reasonCode,
			effect: failure.effect,
			product: definition.product,
			persisted: failure.persisted,
			evaluated: failure.evaluated,
			decisionRelevant: failure.decisionRelevant,
			observed: failure.observed,
			observedValue: failure.observedValue,
			threshold: definition.threshold.display,
			scoreBand: grade,
			ruleSectionRefs: definition.ruleSectionRefs,
			exception: resolved,
			mappingState,
			explanationLimitation:
				mappingState === "mapping_unavailable"
					? (resolved.reason ?? definition.notes.join(" "))
					: securedConditional && !securedQualifying
						? "Collateral is not qualifying (a documented value inside the POL-CR-008 8.1 cap is required); the unsecured branch applies."
						: null,
		};
	});
	return { rules: [...rules, ...synthetic], failedRuleCount };
}

function limitationsFor(
	inputs: PolicyInputs,
	rules: CaseRuleFailure[],
	securedQualifying: boolean,
): string[] {
	const limitations = [ENGINE_ONLY_LIMITATION, UNVERIFIED_APPROVER_LIMITATION];
	if (
		inputs.kind === "sme" &&
		!securedQualifying &&
		rules.some((rule) => rule.ruleId === "SME-TRADING-REFER" || rule.ruleId === "SME-DSCR-REFER")
	) {
		limitations.push(UNSECURED_BRANCH_LIMITATION);
	}
	if (rules.some((rule) => rule.exception.state === "mapping_unavailable")) {
		limitations.push(NO_TAXONOMY_LIMITATION);
	}
	return limitations;
}

export interface CaseRuleRowInput {
	application: {
		id: string;
		status: string;
		product: string;
		amountCents: number;
		business: unknown;
	};
	decision: {
		id: string;
		outcome: string;
		snapshot: unknown;
		decidedAt: Date;
	} | null;
	evaluation: {
		id: string;
		policyVersion: string;
		outcome: string;
		reasons: unknown;
		inputs: unknown;
		evaluatedAt: Date | null;
		createdAt: Date;
	} | null;
}

/** Pure row-to-context mapping: no DB, no clock, no logging. */
export function buildCaseRuleContextFromRows(input: CaseRuleRowInput): CaseRuleContext {
	const { application, decision, evaluation } = input;

	if (decision) {
		const snapshot = isRecord(decision.snapshot) ? decision.snapshot : null;
		if (snapshot === null || snapshot["kind"] !== "credit") {
			return {
				applicationId: application.id,
				caseStatus: application.status,
				status: "not_applicable",
				policyVersion: POLICY_VERSION,
				policyAsOf: asOfDay(decision.decidedAt),
				registryVersion: POLICY_REGISTRY_VERSION,
				score: null,
				grade: null,
				scorecardVersion: null,
				outcome: decision.outcome,
				product: application.product,
				reasonCodes: [],
				secured: securedFor(application.business, application.amountCents).secured,
				securedQualifying: securedFor(application.business, application.amountCents).qualifying,
				failedRuleCount: 0,
				failedRules: [],
				limitations: [CHECK_ONLY_LIMITATION],
				evaluationId: null,
				decisionId: decision.id,
			};
		}
		const parsed = policyInputsSchema.safeParse(snapshot["inputs"]);
		if (!parsed.success) {
			throw new RuleContextUnavailableError("decision snapshot has no usable policy inputs");
		}
		const inputs = parsed.data;
		const score = snapshot["score"];
		if (typeof score !== "number" || !Number.isFinite(score)) {
			throw new RuleContextUnavailableError("decision snapshot has no score");
		}
		const grade: Grade = (
			typeof snapshot["grade"] === "string" && GRADES.has(snapshot["grade"])
				? snapshot["grade"]
				: gradeForScore(score)
		) as Grade;
		const reasonCodes = toReasonCodes(snapshot["reasons"]);
		const snapshotPolicyVersion =
			typeof snapshot["policyVersion"] === "string" && snapshot["policyVersion"].length > 0
				? (snapshot["policyVersion"] as string)
				: POLICY_VERSION;
		if (snapshotPolicyVersion !== POLICY_VERSION) {
			throw new UnsupportedPolicyVersionError(
				`unsupported decided policy version ${snapshotPolicyVersion}`,
			);
		}
		const { secured, qualifying, tradingQualifying } = securedFor(
			application.business,
			inputs.amountCents,
		);
		const { rules, failedRuleCount } = buildRules(
			inputs,
			reasonCodes,
			grade,
			qualifying,
			tradingQualifying,
		);
		const decidedAt =
			typeof snapshot["decidedAt"] === "string" && !Number.isNaN(Date.parse(snapshot["decidedAt"]))
				? new Date(snapshot["decidedAt"])
				: decision.decidedAt;
		return {
			applicationId: application.id,
			caseStatus: application.status,
			status: statusFor(rules),
			policyVersion: snapshotPolicyVersion,
			policyAsOf: asOfDay(decidedAt),
			registryVersion: POLICY_REGISTRY_VERSION,
			score,
			grade,
			scorecardVersion:
				typeof snapshot["scorecardVersion"] === "string" &&
				(snapshot["scorecardVersion"] as string).length > 0
					? (snapshot["scorecardVersion"] as string)
					: SCORECARD_VERSION,
			outcome: decision.outcome,
			product: application.product,
			reasonCodes,
			secured,
			securedQualifying: qualifying,
			failedRuleCount,
			failedRules: rules,
			limitations: limitationsFor(inputs, rules, qualifying),
			evaluationId: null,
			decisionId: decision.id,
		};
	}

	if (!evaluation) {
		throw new RuleContextUnavailableError("no policy evaluation for this case");
	}
	if (evaluation.policyVersion !== POLICY_VERSION) {
		throw new UnsupportedPolicyVersionError(
			`unsupported policy version ${evaluation.policyVersion}`,
		);
	}
	const parsed = policyInputsSchema.safeParse(evaluation.inputs);
	if (!parsed.success) {
		throw new RuleContextUnavailableError("policy evaluation has no usable inputs");
	}
	const inputs = parsed.data;
	const score = inputs.kind === "individual" ? inputs.score : inputs.blendedScore;
	const grade = gradeForScore(score);
	const reasonCodes = toReasonCodes(evaluation.reasons);
	const { secured, qualifying, tradingQualifying } = securedFor(
		application.business,
		inputs.amountCents,
	);
	const { rules, failedRuleCount } = buildRules(
		inputs,
		reasonCodes,
		grade,
		qualifying,
		tradingQualifying,
	);
	return {
		applicationId: application.id,
		caseStatus: application.status,
		status: statusFor(rules),
		policyVersion: evaluation.policyVersion,
		policyAsOf: asOfDay(evaluation.evaluatedAt ?? evaluation.createdAt),
		registryVersion: POLICY_REGISTRY_VERSION,
		score,
		grade,
		scorecardVersion: SCORECARD_VERSION,
		outcome: evaluation.outcome,
		product: application.product,
		reasonCodes,
		secured,
		securedQualifying: qualifying,
		failedRuleCount,
		failedRules: rules,
		limitations: limitationsFor(inputs, rules, qualifying),
		evaluationId: evaluation.id,
		decisionId: null,
	};
}

/** DB loader: unknown/draft cases 404 like every other internal case route. */
export async function buildCaseRuleContext(deps: {
	db: Db;
	applicationId: string;
}): Promise<CaseRuleContext> {
	const { db, applicationId } = deps;
	const appRows = await db.select().from(applications).where(eq(applications.id, applicationId));
	const app = appRows[0];
	if (!app || app.status === "draft") {
		throw new HttpError(404, "NOT_FOUND", "not found");
	}
	const decisionRows = await db
		.select()
		.from(decisions)
		.where(eq(decisions.applicationId, applicationId));
	const decisionRow = decisionRows[0] ?? null;
	const evaluationRows = await db
		.select()
		.from(policyEvaluations)
		.where(eq(policyEvaluations.applicationId, applicationId))
		.orderBy(
			sql`${policyEvaluations.evaluatedAt} DESC NULLS LAST`,
			desc(policyEvaluations.createdAt),
			desc(policyEvaluations.id),
		)
		.limit(1);
	const evaluationRow = evaluationRows[0] ?? null;
	return buildCaseRuleContextFromRows({
		application: {
			id: app.id,
			status: app.status,
			product: app.product,
			amountCents: app.amountCents,
			business: app.business,
		},
		decision: decisionRow
			? {
					id: decisionRow.id,
					outcome: decisionRow.outcome,
					snapshot: decisionRow.snapshot,
					decidedAt: decisionRow.decidedAt,
				}
			: null,
		evaluation: evaluationRow
			? {
					id: evaluationRow.id,
					policyVersion: evaluationRow.policyVersion,
					outcome: evaluationRow.outcome,
					reasons: evaluationRow.reasons,
					inputs: evaluationRow.inputs,
					evaluatedAt: evaluationRow.evaluatedAt,
					createdAt: evaluationRow.createdAt,
				}
			: null,
	});
}
