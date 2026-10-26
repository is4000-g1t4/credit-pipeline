// Policy-exception navigator eval (EN-06/EN-07/E3).
//
//   pnpm --filter @credit/applications eval:policy-exception -- --split=dev --trials=3
//   pnpm --filter @credit/applications eval:policy-exception -- --split=dev --trials=1 --case=pe-explain-01
//
// Real production path: the production rule builder (`buildCaseRuleContextFromRows`),
// registry, orchestrator (`runPolicyExceptionAgent`), validators, and the
// `@openai/agents` SDK runner in live mode. The policy service is a fixture
// implementing `PolicyClient` over the case sections with the shared
// `selectActiveSection` scope/as-of semantics. `--frozen` swaps the model for a
// deterministic baseline draft (regression-only, never model quality).
// Raw model output, quotes beyond hashes, and PII never enter the results JSON.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
	hashQuote,
	ruleDefinitionById,
	selectActiveSection,
	classifyPolicyScope,
	hasDirectIdentifier,
	parseSourceRef,
	POLICY_REGISTRY_VERSION,
	POLICY_REGISTRY_HASH,
	type EvidenceBundle,
	type EvidenceItem,
	type PolicySectionRow,
} from "@credit/core";
import {
	buildCaseRuleContextFromRows,
	RuleContextUnavailableError,
	UnsupportedPolicyVersionError,
	type CaseRuleContext as BuilderCaseRuleContext,
} from "../src/assist/policy-rules.js";
import {
	runPolicyExceptionAgent,
	PolicyExceptionAgentError,
	policyExceptionReplayKey,
	type PolicyExceptionAgentConfig,
} from "../src/assist/policy-exception/agent.js";
import { createAgentsPolicyExceptionRunner } from "../src/assist/policy-exception/agent-sdk.js";
import { toSharedCaseRuleContext } from "../src/assist/policy-exception/view.js";
import {
	runPolicyExceptionTool,
	policyEvidenceRef,
	sectionKey,
} from "../src/assist/policy-exception/tools.js";
import {
	PolicySourceError,
	type CaseRuleContext,
	type PolicyClient,
	type PolicyExceptionAgentRunner,
	type PolicySectionDelivery,
} from "../src/assist/policy-exception/types.js";
import type { PolicyExceptionMemoContent } from "../src/assist/policy-exception/memo.js";
import { applicationObservability } from "../src/observability.js";

const HERE = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(HERE, "..", "..", "..", ".env") });

// --- CLI ---

function arg(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const TRIALS = Math.max(1, Number(arg("trials", "3")) || 3);
const SPLIT = arg("split", "dev");
const ONLY = arg("case", "");
const BUDGET_USD = Number(arg("budget-usd", "4")) || 4;
const MAX_RUN_COST_USD = Number(arg("max-run-cost-usd", "0.15")) || 0.15;
const DELAY_MS = Math.max(0, Number(arg("delay", "0")) || 0);
const MAX_STEPS = Math.max(1, Number(arg("max-steps", "30")) || 30);
const MAX_TOOL_CALLS = Math.max(1, Number(arg("max-tool-calls", "40")) || 40);
const FROZEN = flag("frozen");
const LIVE = flag("live");

if (!["dev", "heldout", "all"].includes(SPLIT)) {
	console.error(`policy-exception eval: --split must be dev|heldout|all (got ${SPLIT})`);
	process.exit(1);
}

function envStr(name: string, fallback: string): string {
	const value = process.env[name];
	return value === undefined || value === "" ? fallback : value;
}

const API_KEY = process.env["OPENROUTER_API_KEY"] ?? "";
const BASE_URL = envStr("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
const MODEL = envStr("POLICY_EXCEPTION_MODEL", "deepseek/deepseek-v4.1-flash-1017");
const PROMPT_VERSION = envStr("POLICY_EXCEPTION_PROMPT_VERSION", "policy-exception-v1");
const AGENT_VERSION = envStr("POLICY_EXCEPTION_AGENT_VERSION", "policy-exception-agent-v1");
const VALIDATOR_VERSION = envStr(
	"POLICY_EXCEPTION_VALIDATOR_VERSION",
	"policy-exception-validator-v1",
);
const JUDGE_MODEL = envStr("POLICY_EXCEPTION_JUDGE_MODEL", MODEL);

if (!FROZEN && API_KEY === "") {
	console.error(
		"policy-exception eval: OPENROUTER_API_KEY is missing (loaded from the repo-root .env). " +
			"Set it, pass --live with a key, or re-run with --frozen for the regression-only scripted runner.",
	);
	process.exit(1);
}
if (LIVE && API_KEY === "") {
	console.error("policy-exception eval: --live needs OPENROUTER_API_KEY.");
	process.exit(1);
}

// --- Cases ---

interface FixtureSection {
	policyKey: string;
	sectionId: string;
	policyId: string;
	policyVersionId: string;
	version: string;
	heading: string;
	body: string;
	effectiveFrom: string;
	effectiveTo: string | null;
	productScope: "individual" | "sme" | "all";
	status: "approved" | "retired";
	contentHash: string;
}

interface EvalCase {
	id: string;
	feature: string;
	scenario: "explain" | "followup" | "memo";
	split: "dev" | "heldout";
	tags: string[];
	input: {
		application: {
			id: string;
			reference: string;
			status: string;
			product: string;
			amountCents: number;
			business: unknown;
		};
		policyInputs: Record<string, unknown>;
		decision: null | {
			id: string;
			outcome: string;
			snapshot: unknown;
			decidedAt: string;
		};
		policyEvaluation: null | {
			id: string;
			policyVersion: string;
			outcome: string;
			reasons: unknown;
			inputs: Record<string, unknown>;
			evaluatedAt: string | null;
			createdAt: string;
		};
		evidence: Array<{
			ref: string;
			sourceType: string;
			label: string;
			content: string;
			metadata?: Record<string, string | number | boolean | null>;
		}>;
		sections: FixtureSection[];
		question: string;
		unmappedRuleIds: string[];
	};
	expected: {
		failedRuleIds: string[];
		persistedRuleIds: string[];
		ruleMapping: Record<
			string,
			{ ruleSections: string[]; exceptionSections: string[]; state: string }
		>;
		exceptionPath: Record<
			string,
			{
				state: string;
				approver: string | null;
				dualSignoff: boolean;
				mitigantCodes: string[];
				planMonths: number | null;
			}
		>;
		status:
			| "succeeded"
			| "needs_policy_owner"
			| "no_match"
			| "mapping_unavailable"
			| "source_unavailable"
			| "unsupported_policy_version"
			| "rule_context_unavailable";
		requiredSections: string[];
		forbiddenText: string[];
		referenceAnswer: string;
		mustCiteRuleIds: string[];
	};
	notes: string;
}

const ALL_CASES: EvalCase[] = (
	JSON.parse(readFileSync(join(HERE, "policy-exception-cases.json"), "utf8")) as {
		cases: EvalCase[];
	}
).cases;
const CASES = ALL_CASES.filter(
	(c) => (SPLIT === "all" || c.split === SPLIT) && (ONLY === "" || c.id === ONLY),
);
if (CASES.length === 0) {
	console.error(`policy-exception eval: no cases match split=${SPLIT} case=${ONLY || "(any)"}`);
	process.exit(1);
}

const DATASET_HASH = createHash("sha256").update(JSON.stringify(ALL_CASES), "utf8").digest("hex");

// --- Held-out manifest: refuse a second live held-out run after tuning ---

const MANIFEST_PATH = join(HERE, "results", "policy-exception-heldout.json");
function heldoutRequested(): boolean {
	return CASES.some((c) => c.split === "heldout");
}
if (heldoutRequested() && !FROZEN && existsSync(MANIFEST_PATH)) {
	try {
		const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
			datasetHash?: string;
			resultFile?: string;
		};
		if (manifest.datasetHash === DATASET_HASH) {
			console.error(
				`policy-exception eval: held-out split already consumed (${manifest.resultFile ?? MANIFEST_PATH}). ` +
					`Refusing a second live held-out run after tuning. Delete ${MANIFEST_PATH} to deliberately re-run.`,
			);
			process.exit(1);
		}
		console.error(
			"policy-exception eval: WARNING the dataset changed since the held-out run; " +
				"proceeding, but the held-out number is no longer clean. Recording dataset-changed in the manifest.",
		);
	} catch {
		console.error(
			`policy-exception eval: WARNING unreadable held-out manifest at ${MANIFEST_PATH}; proceeding.`,
		);
	}
}

// --- Fixture policy client (shared selectActiveSection semantics) ---

function uuidFor(seed: string): string {
	const h = createHash("sha256").update(seed).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const POLICY_IDS: Record<string, string> = {
	"POL-CR-009": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
	"POL-CR-001": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
	"POL-CR-002": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
	"POL-CR-003": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
	"POL-CR-005": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
};

function toDeliveries(sections: FixtureSection[]): PolicySectionDelivery[] {
	return sections.map((s) => ({
		policyId: s.policyId || POLICY_IDS[s.policyKey] || uuidFor(`policy:${s.policyKey}`),
		policyVersionId: s.policyVersionId,
		policyKey: s.policyKey,
		sectionId: s.sectionId,
		version: s.version,
		heading: s.heading,
		body: s.body,
		truncated: false,
		effectiveFrom: s.effectiveFrom,
		effectiveTo: s.effectiveTo,
		contentHash:
			s.contentHash && s.contentHash.length > 0
				? s.contentHash
				: createHash("sha256").update(s.body, "utf8").digest("hex"),
		quoteHash: hashQuote(s.body),
		drawerToken: "fixture",
	}));
}

function toRows(sections: FixtureSection[]): PolicySectionRow[] {
	return sections.map((s) => ({
		policyId: s.policyId || POLICY_IDS[s.policyKey] || uuidFor(`policy:${s.policyKey}`),
		policyKey: s.policyKey,
		title: s.policyKey,
		policyVersionId: s.policyVersionId,
		version: s.version,
		status: s.status,
		effectiveFrom: s.effectiveFrom,
		effectiveTo: s.effectiveTo,
		sectionId: s.sectionId,
		heading: s.heading,
		body: s.body,
		contentHash:
			s.contentHash && s.contentHash.length > 0
				? s.contentHash
				: createHash("sha256").update(s.body, "utf8").digest("hex"),
		policyFamily: "underwriting",
		productScope: s.productScope,
		jurisdiction: "SG",
		domain: "credit",
	}));
}

function scoreOverlap(query: string, section: PolicySectionDelivery): number {
	// Deterministic top-K: registry-built queries always name the mapped
	// refs, so exact key/sectionId hits dominate; token overlap breaks ties.
	const q = query.toLowerCase();
	let score = 0;
	if (q.includes(section.policyKey.toLowerCase())) score += 10;
	if (q.includes(section.sectionId.toLowerCase())) score += 10;
	const tokens = new Set(q.split(/[^a-z0-9]+/g).filter((t) => t.length > 2));
	const hay = `${section.heading} ${section.body}`.toLowerCase();
	for (const token of tokens) if (hay.includes(token)) score += 1;
	return score;
}

function createFixturePolicyClient(
	sections: FixtureSection[],
	opts: { sourceDown: boolean },
): PolicyClient {
	const deliveries = toDeliveries(sections);
	const rows = toRows(sections);
	const fail = (): never => {
		throw new PolicySourceError("POLICY_SOURCE_UNAVAILABLE");
	};
	return {
		resolveSections: async (input) => {
			if (opts.sourceDown) fail();
			const found: PolicySectionDelivery[] = [];
			const missing: Array<{
				policyKey: string;
				sectionId: string;
				reason: "not_found" | "not_effective" | "forbidden" | "truncated";
			}> = [];
			for (const ref of input.refs) {
				const hit = selectActiveSection(
					rows,
					{
						policyKey: ref.policyKey,
						sectionId: ref.sectionId,
						...(ref.versionId ? { versionId: ref.versionId } : {}),
					},
					{
						asOf: input.policyAsOf,
						productScope: input.productScope,
						jurisdiction: "SG",
					},
				);
				const delivery = hit
					? deliveries.find(
							(d) =>
								d.policyKey === hit.policyKey &&
								d.sectionId === hit.sectionId &&
								d.policyVersionId === hit.policyVersionId,
						)
					: undefined;
				if (delivery) {
					found.push(delivery);
					continue;
				}
				const anyKey = rows.some(
					(r) => r.policyKey === ref.policyKey && r.sectionId === ref.sectionId,
				);
				if (!anyKey) {
					missing.push({ policyKey: ref.policyKey, sectionId: ref.sectionId, reason: "not_found" });
					continue;
				}
				const scopeHit = rows.some(
					(r) =>
						r.policyKey === ref.policyKey &&
						r.sectionId === ref.sectionId &&
						(r.productScope === "all" || r.productScope === input.productScope),
				);
				missing.push({
					policyKey: ref.policyKey,
					sectionId: ref.sectionId,
					reason: scopeHit ? "not_effective" : "forbidden",
				});
			}
			return { status: missing.length > 0 ? "partial" : "ok", sections: found, missing };
		},
		searchSections: async (input) => {
			if (opts.sourceDown) fail();
			const inScope = deliveries.filter((d) => {
				const row = rows.find(
					(r) =>
						r.policyKey === d.policyKey &&
						r.sectionId === d.sectionId &&
						r.policyVersionId === d.policyVersionId,
				);
				if (!row) return false;
				return (
					selectActiveSection(
						rows,
						{ policyKey: d.policyKey, sectionId: d.sectionId },
						{ asOf: input.policyAsOf, productScope: input.productScope, jurisdiction: "SG" },
					)?.policyVersionId === d.policyVersionId
				);
			});
			const ranked = inScope
				.map((d) => ({ d, score: scoreOverlap(input.query, d) }))
				.filter((r) => r.score > 0)
				.sort((a, b) => b.score - a.score || a.d.sectionId.localeCompare(b.d.sectionId));
			const topK = Math.min(Math.max(1, input.topK ?? 8), 12);
			return { status: "ok", sections: ranked.slice(0, topK).map((r) => r.d), missing: [] };
		},
	};
}

// --- Builder rows -> shared agent context (as the officer routes will map it) ---

function buildRows(testCase: EvalCase): {
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
} {
	const app = testCase.input.application;
	const decision = testCase.input.decision
		? {
				id: testCase.input.decision.id,
				outcome: testCase.input.decision.outcome,
				snapshot: testCase.input.decision.snapshot,
				decidedAt: new Date(testCase.input.decision.decidedAt),
			}
		: null;
	const pe = testCase.input.policyEvaluation;
	return {
		application: {
			id: app.id,
			status: app.status,
			product: app.product,
			amountCents: app.amountCents,
			business: app.business,
		},
		decision,
		evaluation: pe
			? {
					id: pe.id,
					policyVersion: pe.policyVersion,
					outcome: pe.outcome,
					reasons: pe.reasons,
					inputs: pe.inputs ?? testCase.input.policyInputs,
					evaluatedAt: pe.evaluatedAt ? new Date(pe.evaluatedAt) : null,
					createdAt: new Date(pe.createdAt),
				}
			: null,
	};
}

/** Production mapping from the deterministic EN-07 context to the shared
 * agent context. Keep this identical to the officer route. */
function toAgentContext(
	builder: BuilderCaseRuleContext,
	app: EvalCase["input"]["application"],
): CaseRuleContext {
	return toSharedCaseRuleContext(builder as never, {
		application: {
			id: app.id,
			reference: app.reference,
			product: app.product,
			amountCents: app.amountCents,
		},
	});
}

// --- Evidence bundle: input items + RULE_ failure items + policy items ---

function buildEvidenceBundle(
	testCase: EvalCase,
	builder: BuilderCaseRuleContext,
	catalog: PolicySectionDelivery[],
): EvidenceBundle {
	const items: EvidenceItem[] = testCase.input.evidence.map((e) => ({
		ref: e.ref,
		sourceType: e.sourceType as EvidenceItem["sourceType"],
		label: e.label,
		content: e.content,
		access: { retentionUntil: null, legalHold: false },
		metadata: e.metadata ?? {},
	}));
	const scoreId = builder.evaluationId ?? builder.decisionId ?? testCase.input.application.id;
	for (const failure of builder.failedRules) {
		items.push({
			ref: `score_reason:${scoreId}:RULE_${failure.reasonCode}`,
			sourceType: "score_reason",
			label: "rule failure",
			content: `observed=${failure.observed}; threshold=${failure.threshold}`,
			access: { retentionUntil: null, legalHold: false },
			metadata: { reasonCode: failure.reasonCode, ruleId: failure.ruleId },
		});
	}
	for (const section of catalog) {
		items.push({
			ref: policyEvidenceRef(section),
			sourceType: "policy_section",
			label: section.heading,
			content: section.body,
			access: { retentionUntil: null, legalHold: false },
			metadata: { policyKey: section.policyKey, sectionId: section.sectionId },
		});
	}
	const asOf = testCase.input.decision
		? new Date(testCase.input.decision.decidedAt)
		: new Date(
				testCase.input.policyEvaluation?.evaluatedAt ??
					testCase.input.policyEvaluation?.createdAt ??
					"2026-06-15T10:00:00.000Z",
			);
	if (items.length > 500) {
		throw new Error(`evidence bundle exceeds 500 items for ${testCase.id}`);
	}
	return {
		applicationId: testCase.input.application.id,
		asOf: asOf.toISOString(),
		assembledAt: new Date(asOf.getTime() + 3_600_000).toISOString(),
		items,
		unavailable: [],
	};
}

// --- Gates (follow-up): identifier / cross-case / scope refuse without a model ---

const LOOSE_APP_REF_RE = /\bAPP-\d{4}-[A-Z0-9]{6}\b/gi;

function followupGate(
	testCase: EvalCase,
	appReference: string,
): { status: "no_match"; gate: string } | null {
	const question = testCase.input.question;
	if (hasDirectIdentifier(question)) return { status: "no_match", gate: "identifier-blocked" };
	const refs = question.match(LOOSE_APP_REF_RE) ?? [];
	if (refs.some((r) => r.toUpperCase() !== appReference.toUpperCase())) {
		return { status: "no_match", gate: "cross-case-refused" };
	}
	if (classifyPolicyScope(question) === "out_of_scope") {
		return { status: "no_match", gate: "out-of-scope" };
	}
	return null;
}

// --- Deterministic baseline: one neutral sentence + exact quote per rule ---

function quoteFor(body: string): string {
	return body.slice(0, 140);
}

function requiredRules(context: CaseRuleContext): CaseRuleContext["failedRules"] {
	return context.failedRules.filter(
		(f) => f.decisionRelevant && f.mappingState === "mapped" && f.effect !== "informational",
	);
}

function citationFor(section: PolicySectionDelivery): {
	policyKey: string;
	sectionId: string;
	quote: string;
} {
	return {
		policyKey: section.policyKey,
		sectionId: section.sectionId,
		quote: quoteFor(section.body),
	};
}

function byKey(catalog: PolicySectionDelivery[]): Map<string, PolicySectionDelivery> {
	return new Map(catalog.map((s) => [sectionKey(s.policyKey, s.sectionId), s]));
}

function firstSection(
	catalog: Map<string, PolicySectionDelivery>,
	refs: Array<{ policyKey: string; sectionId: string }>,
	fallback: PolicySectionDelivery,
): PolicySectionDelivery {
	for (const ref of refs) {
		const hit = catalog.get(sectionKey(ref.policyKey, ref.sectionId));
		if (hit) return hit;
	}
	return fallback;
}

function buildDeterministicDraft(
	mode: "explain" | "followup" | "memo",
	context: CaseRuleContext,
	catalog: PolicySectionDelivery[],
	testCase: EvalCase,
): string {
	const map = byKey(catalog);
	const rules = requiredRules(context);
	if (mode === "explain") {
		const out = rules.map((failure) => {
			const definition = ruleDefinitionById(failure.ruleId);
			const sections: PolicySectionDelivery[] = [];
			for (const ref of [
				...(definition?.ruleSectionRefs ?? []),
				...(definition?.exceptionSectionRefs ?? []),
			]) {
				const hit = map.get(sectionKey(ref.policyKey, ref.sectionId));
				if (hit && !sections.includes(hit)) sections.push(hit);
			}
			const prohibited = failure.exception.state === "prohibited";
			return {
				ruleId: failure.ruleId,
				segments: sections.map((section, i) => ({
					text:
						i === 0
							? `The file records ${failure.ruleId} with the observed value against the stated threshold.` +
								(prohibited ? " No exception route is available for this rule." : "")
							: `The file records the route stated for ${failure.ruleId}.`,
					citationIndexes: [i],
				})),
				citations: sections.map(citationFor),
				confidence: "medium",
			};
		});
		return JSON.stringify({ status: "succeeded", rules: out, limitations: context.limitations });
	}
	if (mode === "followup") {
		const wanted =
			testCase.expected.requiredSections.length > 0
				? testCase.expected.requiredSections
				: rules.flatMap((f) => {
						const d = ruleDefinitionById(f.ruleId);
						return d ? d.ruleSectionRefs.map((r) => `${r.policyKey}#${r.sectionId}`) : [];
					});
		const seen = new Set<string>();
		const citations: Array<{ policyKey: string; sectionId: string; quote: string }> = [];
		for (const key of wanted) {
			if (seen.has(key)) continue;
			seen.add(key);
			const section = map.get(key) ?? catalog[0];
			if (section) citations.push(citationFor(section));
		}
		return JSON.stringify({
			status: "succeeded",
			segments: citations.map(() => ({
				text: "The file records the position stated in the cited section.",
				citationIndexes: citations.map((_, i) => i).slice(0, 1),
			})),
			citations,
			limitations: context.limitations.slice(0, 2),
		});
	}
	// Memo prose; the orchestrator merges the deterministic rules block + plan.
	const mapped = context.failedRules.filter((f) => f.mappingState === "mapped");
	const allowedExists = mapped.some(
		(f) => f.exception.state === "allowed" || f.exception.state === "structural_remedy",
	);
	// Coverage uses every decision-relevant rule, mapped or not: an
	// unavailable mapping still has to be named (the open items or claims
	// carry the rule id for the policy owner).
	const decisionRelevant = context.failedRules.filter(
		(f) => f.decisionRelevant && f.effect !== "informational",
	);
	const cited = new Set<string>();
	const claimsFor = (
		ruleId: string,
		refs: Array<{ policyKey: string; sectionId: string }>,
		text: string,
	): Array<{ text: string; citations: Array<{ ref: string; quote: string }> }> => {
		const out: Array<{ text: string; citations: Array<{ ref: string; quote: string }> }> = [];
		for (const ref of refs) {
			const key = `${ref.policyKey}#${ref.sectionId}`;
			if (cited.has(key)) continue;
			const section = map.get(key);
			if (!section) continue;
			cited.add(key);
			out.push({
				text,
				citations: [{ ref: policyEvidenceRef(section), quote: quoteFor(section.body) }],
			});
		}
		return out;
	};
	const breachClaims: Array<{ text: string; citations: Array<{ ref: string; quote: string }> }> =
		[];
	for (const failure of decisionRelevant) {
		const definition = ruleDefinitionById(failure.ruleId);
		const need = testCase.expected.requiredSections.filter((key) => {
			const all = [
				...(definition?.ruleSectionRefs ?? []),
				...(definition?.exceptionSectionRefs ?? []),
			].map((r) => `${r.policyKey}#${r.sectionId}`);
			return all.includes(key);
		});
		const refs =
			need.length > 0
				? need.map((key) => {
						const [policyKey, sectionId] = key.split("#") as [string, string];
						return { policyKey, sectionId };
					})
				: (definition?.ruleSectionRefs ?? []).slice(0, 1);
		breachClaims.push(
			...claimsFor(
				failure.ruleId,
				refs,
				`The file records ${failure.ruleId} with the observed value against the stated threshold.`,
			),
		);
	}
	// Cover any remaining required section from the first decision-relevant rule.
	for (const key of testCase.expected.requiredSections) {
		if (cited.has(key)) continue;
		const first = decisionRelevant[0];
		if (!first) break;
		const [policyKey, sectionId] = key.split("#") as [string, string];
		breachClaims.push(
			...claimsFor(
				first.ruleId,
				[{ policyKey, sectionId }],
				`The file records the route stated for ${first.ruleId}.`,
			),
		);
	}
	// Every decision-relevant rule must be named in the claims, even when
	// its sections are already cited or its mapping is unavailable.
	for (const failure of decisionRelevant) {
		if (breachClaims.some((claim) => claim.text.includes(failure.ruleId))) continue;
		const definition = ruleDefinitionById(failure.ruleId);
		const section = definition
			? firstSection(map, definition.ruleSectionRefs, catalog[0] as PolicySectionDelivery)
			: catalog[0];
		if (!section) continue;
		breachClaims.push({
			text: `The file records ${failure.ruleId} with the observed value against the stated threshold.`,
			citations: [{ ref: policyEvidenceRef(section), quote: quoteFor(section.body) }],
		});
	}
	const structural = mapped.some((f) => f.exception.state === "structural_remedy");
	const mitigantClaims = !allowedExists
		? []
		: [
				{
					text: structural
						? "The reviewable facility condition stated for the file is recorded."
						: "A limit reduction with dual sign-off is recorded for the file.",
					citations: (() => {
						const pool = mapped.flatMap((f) => {
							const d = ruleDefinitionById(f.ruleId);
							return d ? d.exceptionSectionRefs : [];
						});
						const pick =
							pool.find((r) => r.policyKey === "POL-CR-005" && r.sectionId === "5.3") ?? pool[0];
						if (!pick) return [];
						const section = map.get(sectionKey(pick.policyKey, pick.sectionId));
						return section
							? [{ ref: policyEvidenceRef(section), quote: quoteFor(section.body) }]
							: [];
					})(),
				},
			];
	const PLAN_SECTIONS = new Set(["5.1", "2.2", "3.1"]);
	const planClaims = !allowedExists
		? []
		: (() => {
				const pool = mapped.flatMap((f) => {
					const d = ruleDefinitionById(f.ruleId);
					return d ? d.exceptionSectionRefs : [];
				});
				const pick = pool.find((r) => PLAN_SECTIONS.has(r.sectionId)) ?? pool[0];
				if (!pick) return [];
				const section = map.get(sectionKey(pick.policyKey, pick.sectionId));
				return section
					? [
							{
								text: "A time-bound regularisation plan is recorded for the file.",
								citations: [{ ref: policyEvidenceRef(section), quote: quoteFor(section.body) }],
							},
						]
					: [];
			})();
	const compensatingClaims = !allowedExists
		? []
		: (() => {
				const first = mapped[0] ?? decisionRelevant[0];
				if (!first) return [];
				const d = ruleDefinitionById(first.ruleId);
				const section = d
					? firstSection(map, d.ruleSectionRefs, catalog[0] as PolicySectionDelivery)
					: catalog[0];
				return section
					? [
							{
								text: "The file shows steady repayment capacity for the period.",
								citations: [{ ref: policyEvidenceRef(section), quote: quoteFor(section.body) }],
							},
						]
					: [];
			})();
	const section = (
		key: string,
		title: string,
		claims: Array<{ text: string; citations: Array<{ ref: string; quote: string }> }>,
		notAvailable: boolean,
	) => ({ key, title, claims, notAvailable });
	return JSON.stringify({
		title: "Policy exception memo draft",
		sections: [
			section("rule_breached", "Rule breached", breachClaims, breachClaims.length === 0),
			section(
				"compensating_factors",
				"Compensating factors",
				compensatingClaims,
				compensatingClaims.length === 0,
			),
			section("mitigants", "Mitigants", mitigantClaims, mitigantClaims.length === 0),
			section("regularisation_plan", "Regularisation plan", planClaims, planClaims.length === 0),
		],
		openItems:
			allowedExists || mapped.length > 0
				? []
				: [
						{
							text: "No exception route is available for the failed rules; mitigants are not applicable and policy owner review is required for any further step.",
							code: "other",
						},
					],
	});
}

// --- Scripted runner: executes the real tools, returns a fixed draft ---

function createScriptedRunner(
	draft: string,
	deps: {
		context: CaseRuleContext;
		catalog: PolicySectionDelivery[];
		evidence: EvidenceBundle;
		policyClient: PolicyClient;
	},
): PolicyExceptionAgentRunner {
	const retrieved: PolicySectionDelivery[] = [];
	return {
		async run(
			_input,
		): Promise<import("../src/assist/policy-exception/types.js").PolicyExceptionAgentRunResult> {
			const toolCalls: import("../src/assist/policy-exception/types.js").PolicyExceptionAgentRunResult["toolCalls"] =
				[];
			const refs = new Set<string>();
			const fresh: PolicySectionDelivery[] = [];
			const call = async (name: string, args: unknown): Promise<void> => {
				const outcome = await runPolicyExceptionTool(
					{ actorId: "eval-officer", actorRole: "officer", ...deps, retrieved },
					name,
					args,
				);
				// Mirror the production SDK runner: every section returned by a
				// tool call counts as retrieved for citation validation.
				for (const section of outcome.policySections) fresh.push(section);
				toolCalls.push({
					step: toolCalls.length + 1,
					name,
					resultCount: outcome.resultCount,
					sourceTypes: outcome.sourceTypes,
				});
				for (const ref of outcome.refs) refs.add(ref);
			};
			await call("list_failed_rules", {});
			for (const failure of deps.context.failedRules) {
				await call("get_rule_mapping", { ruleId: failure.ruleId });
				await call("get_exception_path", { ruleId: failure.ruleId });
				await call("search_policy", { ruleId: failure.ruleId, focus: "exception" });
			}
			// Fetch every catalog section so exception-path citations validate.
			for (const section of deps.catalog) {
				await call("get_policy_section", {
					policyKey: section.policyKey,
					sectionId: section.sectionId,
				});
			}
			await call("list_evidence", {});
			return {
				rawOutput: draft,
				toolCalls,
				sourceRefs: [...refs].sort(),
				policySections: fresh,
				steps: toolCalls.length + 1,
				usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
			};
		},
	};
}

// --- Graders ---

interface MappingCheck {
	ok: boolean;
	diffs: string[];
}

function checkMapping(testCase: EvalCase, builder: BuilderCaseRuleContext): MappingCheck {
	const diffs: string[] = [];
	const gotFailed = builder.failedRules.map((f) => f.ruleId);
	if (JSON.stringify(gotFailed) !== JSON.stringify(testCase.expected.failedRuleIds)) {
		diffs.push(`failedRuleIds: got [${gotFailed}] want [${testCase.expected.failedRuleIds}]`);
	}
	if (JSON.stringify(builder.reasonCodes) !== JSON.stringify(testCase.expected.persistedRuleIds)) {
		diffs.push(
			`persistedRuleIds: got [${builder.reasonCodes}] want [${testCase.expected.persistedRuleIds}]`,
		);
	}
	for (const [ruleId, want] of Object.entries(testCase.expected.ruleMapping)) {
		const failure = builder.failedRules.find((f) => f.ruleId === ruleId);
		if (!failure) {
			diffs.push(`${ruleId}: missing from builder output`);
			continue;
		}
		const definition = ruleDefinitionById(ruleId);
		const gotRule = (definition?.ruleSectionRefs ?? []).map((r) => `${r.policyKey}#${r.sectionId}`);
		const gotExc = (definition?.exceptionSectionRefs ?? []).map(
			(r) => `${r.policyKey}#${r.sectionId}`,
		);
		if (JSON.stringify(gotRule) !== JSON.stringify(want.ruleSections)) {
			diffs.push(`${ruleId}.ruleSections: got [${gotRule}] want [${want.ruleSections}]`);
		}
		if (JSON.stringify(gotExc) !== JSON.stringify(want.exceptionSections)) {
			diffs.push(`${ruleId}.exceptionSections: got [${gotExc}] want [${want.exceptionSections}]`);
		}
		if (failure.exception.state !== want.state) {
			diffs.push(`${ruleId}.state: got ${failure.exception.state} want ${want.state}`);
		}
	}
	for (const [ruleId, want] of Object.entries(testCase.expected.exceptionPath)) {
		const failure = builder.failedRules.find((f) => f.ruleId === ruleId);
		if (!failure) {
			diffs.push(`${ruleId}: missing exception path`);
			continue;
		}
		if (failure.exception.state !== want.state)
			diffs.push(`${ruleId}.exception.state: got ${failure.exception.state} want ${want.state}`);
		if ((failure.exception.approver ?? null) !== want.approver)
			diffs.push(`${ruleId}.approver: got ${failure.exception.approver} want ${want.approver}`);
		if (failure.exception.dualSignoff !== want.dualSignoff)
			diffs.push(
				`${ruleId}.dualSignoff: got ${failure.exception.dualSignoff} want ${want.dualSignoff}`,
			);
		const gotMit = failure.exception.mitigants.map((m) => m.code);
		if (JSON.stringify(gotMit) !== JSON.stringify(want.mitigantCodes))
			diffs.push(`${ruleId}.mitigants: got [${gotMit}] want [${want.mitigantCodes}]`);
		if ((failure.exception.regularisationPlanMaxMonths ?? null) !== want.planMonths)
			diffs.push(
				`${ruleId}.planMonths: got ${failure.exception.regularisationPlanMaxMonths} want ${want.planMonths}`,
			);
	}
	return { ok: diffs.length === 0, diffs };
}

const APPROVER_RE = /single[\s_-]*officer|team[\s_-]*manager|credit[\s_-]*committee/gi;
const MITIGANT_RE =
	/pricing\s*uplift|limit\s*reduction|exposure\s*reduction|collateral\s*top-?up|director\s*guarantee|reviewable|dual\s*sign/i;
const PROHIBIT_RE = /prohibit|no exception|not exception-eligible|not an exception/i;

function approverLevelOf(mention: string): "single_officer" | "team_manager" | "credit_committee" {
	const lowered = mention.toLowerCase();
	if (lowered.startsWith("single")) return "single_officer";
	if (lowered.startsWith("team")) return "team_manager";
	return "credit_committee";
}

function collectProse(testCase: EvalCase, content: unknown): { chunks: string[]; text: string } {
	const chunks: string[] = [];
	if (testCase.scenario === "memo") {
		const memo = content as PolicyExceptionMemoContent;
		chunks.push(memo.title);
		for (const s of memo.sections ?? []) {
			chunks.push(s.title);
			for (const c of s.claims ?? []) chunks.push(c.text);
		}
		for (const item of memo.openItems ?? []) chunks.push(item.text);
	} else if (testCase.scenario === "explain") {
		const answer = content as {
			rules: Array<{ segments: Array<{ text: string }> }>;
			limitations: string[];
		};
		for (const rule of answer.rules ?? [])
			for (const seg of rule.segments ?? []) chunks.push(seg.text);
		for (const limitation of answer.limitations ?? []) chunks.push(limitation);
	} else {
		const answer = content as { segments: Array<{ text: string }>; limitations: string[] };
		for (const seg of answer.segments ?? []) chunks.push(seg.text);
		for (const limitation of answer.limitations ?? []) chunks.push(limitation);
	}
	return { chunks, text: chunks.join("\n") };
}

function citedKeys(testCase: EvalCase, content: unknown): string[] {
	const keys = new Set<string>();
	if (testCase.scenario === "memo") {
		const memo = content as PolicyExceptionMemoContent;
		for (const s of memo.sections ?? []) {
			for (const c of s.claims ?? []) {
				for (const citation of c.citations ?? []) {
					const ref = (citation as { ref?: unknown }).ref;
					if (typeof ref !== "string") continue;
					const parsed = parseSourceRef(ref);
					if (parsed?.type === "policy_section")
						keys.add(`${parsed.policyKey}#${parsed.sectionId}`);
				}
			}
		}
	} else if (testCase.scenario === "explain") {
		const answer = content as {
			rules: Array<{ citations: Array<{ policyKey: string; sectionId: string }> }>;
		};
		for (const rule of answer.rules ?? [])
			for (const citation of rule.citations ?? [])
				keys.add(`${citation.policyKey}#${citation.sectionId}`);
	} else {
		const answer = content as { citations: Array<{ policyKey: string; sectionId: string }> };
		for (const citation of answer.citations ?? [])
			keys.add(`${citation.policyKey}#${citation.sectionId}`);
	}
	return [...keys].sort();
}

function checkFidelity(
	testCase: EvalCase,
	context: CaseRuleContext,
	content: unknown,
): { score: number; failures: string[] } {
	const failures: string[] = [];
	const { chunks, text } = collectProse(testCase, content);
	const expectedApprovers = new Set(
		context.failedRules.map((f) => f.exception.approver).filter((a) => a !== null) as string[],
	);
	let approverChecks = 0;
	let approverOk = 0;
	const approverRank = { single_officer: 0, team_manager: 1, credit_committee: 2 } as const;
	const expectedLevels = [...expectedApprovers].filter(
		(level): level is "single_officer" | "team_manager" | "credit_committee" => level !== null,
	);
	for (const chunk of chunks) {
		const mentions = chunk.match(APPROVER_RE) ?? [];
		if (mentions.length === 0) continue;
		approverChecks += 1;
		const qualified = /\bminimum\b/i.test(chunk);
		const matches = mentions.every((m) => {
			const level = approverLevelOf(m);
			if (expectedLevels.length === 0) return false;
			if (qualified) {
				return approverRank[level] >= Math.min(...expectedLevels.map((e) => approverRank[e]));
			}
			return expectedApprovers.has(level);
		});
		if (matches) {
			approverOk += 1;
		} else {
			failures.push(`approver-mention:${mentions[0]?.toLowerCase().replaceAll(/[\s_-]+/g, "_")}`);
		}
	}
	let mitigantOk: number | null = null;
	let mitigantChecks = 0;
	const claimTexts: string[] = [];
	if (testCase.scenario === "memo") {
		const memo = content as PolicyExceptionMemoContent;
		for (const section of memo.sections ?? [])
			for (const claim of section.claims ?? []) claimTexts.push(claim.text);
	} else if (testCase.scenario === "explain") {
		const answer = content as { rules: Array<{ segments: Array<{ text: string }> }> };
		for (const rule of answer.rules ?? [])
			for (const segment of rule.segments ?? []) claimTexts.push(segment.text);
	} else {
		const answer = content as { segments: Array<{ text: string }> };
		for (const segment of answer.segments ?? []) claimTexts.push(segment.text);
	}
	const mitigantText = claimTexts.join("\n");
	const negativeMitigant =
		/\b(?:no|not|without|never)\b[^.]{0,80}\b(?:mitigant|pricing uplift|limit reduction|collateral top-?up|director guarantee|reviewable|dual sign)/i.test(
			mitigantText,
		);
	if (MITIGANT_RE.test(mitigantText) && !negativeMitigant) {
		mitigantChecks = 1;
		const anyMitigants = context.failedRules.some((f) => f.exception.mitigants.length > 0);
		mitigantOk = anyMitigants ? 1 : 0;
		if (!anyMitigants) failures.push("mitigant-without-path");
	}
	let prohibitOk: number | null = null;
	let prohibitChecks = 0;
	// Only decision-relevant prohibitions must be stated: an evaluated but
	// unpersisted check (first-match decline shadowing) is not part of the
	// required explanation, so it must not force prohibition language.
	if (context.failedRules.some((f) => f.exception.state === "prohibited" && f.decisionRelevant)) {
		prohibitChecks = 1;
		prohibitOk = PROHIBIT_RE.test(text) ? 1 : 0;
		if (!prohibitOk) failures.push("prohibited-without-language");
	}
	const parts: number[] = [];
	if (approverChecks > 0) parts.push(approverOk / approverChecks);
	if (mitigantChecks > 0) parts.push(mitigantOk as number);
	if (prohibitChecks > 0) parts.push(prohibitOk as number);
	const score = parts.length === 0 ? 1 : parts.reduce((a, b) => a + b, 0) / parts.length;
	return { score, failures };
}

/** Word-aware action-language scan mirroring the production validator:
 * `approver` is fine, `approved`/`approval` are not. */
function forbiddenHit(text: string, term: string): boolean {
	const patterns: Record<string, RegExp> = {
		approve: /\bapprov(?:e|ed|es|al|als|ing)\b/i,
		decline: /\bdeclin(?:e|ed|es|ing)\b/i,
		reject: /\breject(?:ed|ion|ions|ing|s)?\b/i,
		recommend: /\brecommend(?:ed|ation|ations|ing|s)?\b/i,
		decision: /\bdecisions?\b/i,
	};
	const pattern = patterns[term.toLowerCase()];
	if (pattern) return pattern.test(text);
	return text.toLowerCase().includes(term.toLowerCase());
}

function checkStructural(
	testCase: EvalCase,
	context: CaseRuleContext,
	content: unknown,
): { pass: boolean; gateFailures: string[]; statuses: Record<string, string | number | boolean> } {
	const gateFailures: string[] = [];
	const statuses: Record<string, string | number | boolean> = {};
	// Memo content carries no status field; returning composable content at
	// all is the success signal for that mode.
	const statusOf =
		testCase.scenario === "memo" ? "memo" : ((content as { status?: string }).status ?? "missing");
	statuses["status"] = statusOf;
	if (
		testCase.scenario === "memo"
			? testCase.expected.status !== "succeeded"
			: statusOf !== testCase.expected.status
	) {
		gateFailures.push(`status:${statusOf}`);
		return { pass: false, gateFailures, statuses };
	}
	// Rule coverage.
	const must = testCase.expected.mustCiteRuleIds;
	if (testCase.scenario === "explain") {
		const answer = content as { rules: Array<{ ruleId: string }> };
		const have = new Set(answer.rules.map((r) => r.ruleId));
		for (const id of must) if (!have.has(id)) gateFailures.push(`rule-coverage:${id}`);
	} else if (testCase.scenario === "memo") {
		const memo = content as PolicyExceptionMemoContent;
		if (memo.rules.length !== context.failedRules.length) {
			gateFailures.push(`memo-rules:${memo.rules.length}`);
		}
		const breachTexts = (memo.sections ?? [])
			.flatMap((s) => (s.key === "rule_breached" ? (s.claims ?? []).map((c) => c.text) : []))
			.join("\n");
		const openTexts = (memo.openItems ?? []).map((o) => o.text).join("\n");
		for (const id of must) {
			if (!breachTexts.includes(id) && !openTexts.includes(id))
				gateFailures.push(`rule-coverage:${id}`);
		}
		const wantPlan = Object.values(testCase.expected.exceptionPath).some(
			(p) => p.state === "allowed" || p.state === "structural_remedy",
		)
			? 12
			: null;
		if ((memo.regularisationPlanMonths ?? null) !== wantPlan) {
			gateFailures.push(`plan-months:${memo.regularisationPlanMonths}`);
		}
		const mitigants = (memo.sections ?? []).find((s) => s.key === "mitigants");
		if (wantPlan !== null) {
			if (!mitigants || mitigants.notAvailable || (mitigants.claims ?? []).length === 0) {
				gateFailures.push("mitigants-missing");
			}
		} else if (!mitigants?.notAvailable) {
			gateFailures.push("mitigants-should-be-na");
		}
	}
	// Required sections cited.
	const haveKeys = new Set(citedKeys(testCase, content));
	const missing = testCase.expected.requiredSections.filter((k) => !haveKeys.has(k));
	for (const key of missing) gateFailures.push(`section-miss:${key}`);
	statuses["citedSections"] = haveKeys.size;
	// Forbidden text in prose (quotes excluded).
	const { text } = collectProse(testCase, content);
	for (const term of testCase.expected.forbiddenText) {
		if (term.trim() !== "" && forbiddenHit(text, term)) {
			gateFailures.push(`forbidden-text:${term.toLowerCase()}`);
		}
	}
	return { pass: gateFailures.length === 0, gateFailures, statuses };
}

// --- Judge (OpenRouter chat completions, temperature 0, hash cache) ---

const RUBRIC = readFileSync(join(HERE, "judges", "claim-support.md"), "utf8");
const RUBRIC_HASH = createHash("sha256").update(RUBRIC, "utf8").digest("hex");

interface JudgeUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

async function chatJson(
	system: string,
	user: string,
): Promise<{ json: unknown; usage: JudgeUsage }> {
	const body = {
		model: JUDGE_MODEL,
		temperature: 0,
		max_tokens: 500,
		response_format: { type: "json_object" },
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
	};
	let lastStatus = 0;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const res = await fetch(`${BASE_URL}/chat/completions`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${API_KEY}`,
					"HTTP-Referer": "https://credit-pipeline.local",
					"X-Title": "Credit policy-exception eval",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(60_000),
			});
			if (res.ok) {
				const json = (await res.json()) as {
					choices?: Array<{ message?: { content?: unknown } }>;
					usage?: { prompt_tokens?: number; completion_tokens?: number; total_cost?: number };
				};
				const content = json.choices?.[0]?.message?.content;
				if (typeof content !== "string") throw new Error("judge returned no content");
				return {
					json: JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")),
					usage: {
						inputTokens: json.usage?.prompt_tokens ?? 0,
						outputTokens: json.usage?.completion_tokens ?? 0,
						costUsd:
							json.usage?.total_cost ??
							((json.usage?.prompt_tokens ?? 0) + (json.usage?.completion_tokens ?? 0)) / 1_000_000,
					},
				};
			}
			lastStatus = res.status;
			if (res.status !== 429 && res.status < 500) break;
		} catch {
			// retry with backoff below
		}
		if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
	}
	throw new Error(`judge request failed (status ${lastStatus})`);
}

const judgeCache = new Map<string, string>();
let judgeSpend = 0;

async function judgeSupport(
	claim: string,
	quote: string,
	heading: string,
): Promise<{ verdict: string; usage: JudgeUsage }> {
	const key = createHash("sha256")
		.update(`${JUDGE_MODEL}\u0000${RUBRIC_HASH}\u0000${heading}\u0000${claim}\u0000${quote}`)
		.digest("hex");
	const cached = judgeCache.get(key);
	if (cached) return { verdict: cached, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
	if (!quote.trim())
		return { verdict: "unknown", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
	const user = RUBRIC.replace("{{heading}}", heading.slice(0, 300))
		.replace("{{claim}}", claim.slice(0, 1200))
		.replace("{{quote}}", quote.slice(0, 3000));
	try {
		const { json, usage } = await chatJson("Return JSON only.", user);
		const raw = (json as { verdict?: unknown }).verdict;
		const verdict =
			raw === "supported" || raw === "partial" || raw === "unsupported" || raw === "unknown"
				? raw
				: "unknown";
		judgeCache.set(key, verdict);
		return { verdict, usage };
	} catch {
		return { verdict: "unknown", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
	}
}

function judgeClaimsOf(
	testCase: EvalCase,
	content: unknown,
	catalog: PolicySectionDelivery[],
): Array<{ claim: string; quote: string; heading: string }> {
	const map = byKey(catalog);
	const out: Array<{ claim: string; quote: string; heading: string }> = [];
	if (testCase.scenario === "explain") {
		const answer = content as {
			rules: Array<{
				segments: Array<{ text: string; citationIndexes: number[] }>;
				citations: Array<{ policyKey: string; sectionId: string; quote: string }>;
			}>;
		};
		for (const rule of answer.rules ?? []) {
			for (const seg of rule.segments ?? []) {
				const citation = rule.citations[seg.citationIndexes[0] ?? -1];
				if (!citation) continue;
				const section = map.get(sectionKey(citation.policyKey, citation.sectionId));
				out.push({ claim: seg.text, quote: citation.quote, heading: section?.heading ?? "" });
			}
		}
	} else if (testCase.scenario === "followup") {
		const answer = content as {
			segments: Array<{ text: string; citationIndexes: number[] }>;
			citations: Array<{ policyKey: string; sectionId: string; quote: string }>;
		};
		for (const seg of answer.segments ?? []) {
			const citation = answer.citations[seg.citationIndexes[0] ?? -1];
			if (!citation) continue;
			const section = map.get(sectionKey(citation.policyKey, citation.sectionId));
			out.push({ claim: seg.text, quote: citation.quote, heading: section?.heading ?? "" });
		}
	} else {
		const memo = content as PolicyExceptionMemoContent;
		for (const s of memo.sections ?? []) {
			for (const claim of s.claims ?? []) {
				for (const citation of claim.citations ?? []) {
					const ref = (citation as { ref?: unknown; quote?: unknown }).ref;
					const quote = (citation as { quote?: unknown }).quote;
					if (typeof ref !== "string" || typeof quote !== "string") continue;
					const parsed = parseSourceRef(ref);
					const heading =
						parsed?.type === "policy_section"
							? (map.get(`${parsed.policyKey}#${parsed.sectionId}`)?.heading ?? "")
							: "";
					out.push({ claim: claim.text, quote, heading });
				}
			}
		}
	}
	return out;
}

// --- Trial records ---

interface TrialRecord {
	caseId: string;
	trial: number;
	mode: "agent" | "baseline";
	ok: boolean;
	pass: boolean;
	structuralPass: boolean | null;
	semanticPass: "pass" | "fail" | "skipped";
	mappingOk: boolean | null;
	status: string | null;
	errorCode: string | null;
	aborted: boolean;
	modelSkipped: boolean;
	gate: string | null;
	latencyMs: number;
	costUsd: number;
	toolCalls: number;
	ruleTools: number;
	policyTools: number;
	sourceRefs: number;
	repairAttempted: boolean;
	fidelity: number | null;
	fidelityFailures: string[];
	judge: { supported: number; partial: number; unsupported: number; unknown: number };
	unsupportedClaims: number;
	safetyHits: string[];
	gateFailures: string[];
	rawHash: string | null;
}

const AGENT_CONFIG: PolicyExceptionAgentConfig = {
	model: MODEL,
	agentVersion: AGENT_VERSION,
	promptVersion: PROMPT_VERSION,
	validatorVersion: VALIDATOR_VERSION,
	registryVersion: POLICY_REGISTRY_VERSION,
	registryHash: POLICY_REGISTRY_HASH,
	artifactType: "policy_exception_memo",
	maxSteps: MAX_STEPS,
	maxToolCalls: MAX_TOOL_CALLS,
	timeoutMs: 120_000,
	maxCostUsd: MAX_RUN_COST_USD,
};

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function createLiveRunner(policyClient: PolicyClient): PolicyExceptionAgentRunner {
	return createAgentsPolicyExceptionRunner({
		apiKey: API_KEY,
		baseUrl: BASE_URL,
		model: MODEL,
		agentVersion: AGENT_VERSION,
		promptVersion: PROMPT_VERSION,
		validatorVersion: VALIDATOR_VERSION,
		maxToolCalls: MAX_TOOL_CALLS,
		maxOutputTokens: 8_000,
		timeoutMs: 120_000,
		policyClient,
		actorId: "00000000-0000-0000-0000-000000000001",
		actorRole: "officer",
	});
}

async function runAgentTrial(
	testCase: EvalCase,
	trial: number,
	context: CaseRuleContext,
	evidence: EvidenceBundle,
	catalog: PolicySectionDelivery[],
	policyClient: PolicyClient,
	mapping: MappingCheck,
	label: "agent" | "baseline",
): Promise<TrialRecord> {
	const base: TrialRecord = {
		caseId: testCase.id,
		trial,
		mode: label,
		ok: false,
		pass: false,
		structuralPass: null,
		semanticPass: "skipped",
		mappingOk: mapping.ok,
		status: null,
		errorCode: null,
		aborted: false,
		modelSkipped: false,
		gate: null,
		latencyMs: 0,
		costUsd: 0,
		toolCalls: 0,
		ruleTools: 0,
		policyTools: 0,
		sourceRefs: 0,
		repairAttempted: false,
		fidelity: null,
		fidelityFailures: [],
		judge: { supported: 0, partial: 0, unsupported: 0, unknown: 0 },
		unsupportedClaims: 0,
		safetyHits: [],
		gateFailures: [],
		rawHash: null,
	};
	const started = Date.now();
	try {
		let runner: PolicyExceptionAgentRunner;
		if (label === "agent" && !FROZEN) {
			runner = createLiveRunner(policyClient);
		} else {
			const draft = buildDeterministicDraft(testCase.scenario, context, catalog, testCase);
			runner = createScriptedRunner(draft, { context, catalog, evidence, policyClient });
		}
		const { content, trace } = await runPolicyExceptionAgent({
			mode: testCase.scenario,
			context,
			evidence,
			catalog,
			policyClient,
			config: AGENT_CONFIG,
			runner,
			actorId: "00000000-0000-0000-0000-000000000001",
			actorRole: "officer",
			...(testCase.scenario === "followup" ? { question: testCase.input.question } : {}),
		});
		base.latencyMs = trace.latencyMs;
		base.ok = true;
		base.costUsd += trace.costUsd ?? 0;
		base.toolCalls = trace.toolCalls.length;
		base.ruleTools = trace.toolCalls.filter((t) =>
			["list_failed_rules", "get_rule_mapping", "get_exception_path"].includes(t.name),
		).length;
		base.policyTools = trace.toolCalls.filter((t) =>
			["search_policy", "get_policy_section"].includes(t.name),
		).length;
		base.sourceRefs = trace.sourceRefs.length;
		base.repairAttempted = trace.repairAttempted;
		base.status = (content as { status?: string }).status ?? "memo";
		base.rawHash = createHash("sha256")
			.update(
				`${testCase.id}\u0000${policyExceptionReplayKey({ context, evidence, catalog, config: AGENT_CONFIG })}`,
				"utf8",
			)
			.digest("hex");
		const structural = checkStructural(testCase, context, content);
		base.structuralPass = structural.pass;
		base.gateFailures = structural.gateFailures;
		// Deterministic label check, recorded on every trial (codes only).
		if (!mapping.ok) {
			base.gateFailures = [
				...mapping.diffs.slice(0, 3).map((d) => `mapping:${d.slice(0, 120)}`),
				...base.gateFailures,
			];
		}
		const fidelity = checkFidelity(testCase, context, content);
		base.fidelity = fidelity.score;
		base.fidelityFailures = fidelity.failures;
		// Returned content is validator-clean by construction (the orchestrator
		// throws instead of returning invalid drafts); the forbidden-text scan
		// is the explicit second net.
		base.safetyHits = structural.gateFailures.filter((g) => g.startsWith("forbidden-text"));
		if (label === "agent" && !FROZEN && structural.pass) {
			const claims = judgeClaimsOf(testCase, content, catalog);
			for (const claim of claims) {
				const judged = await judgeSupport(claim.claim, claim.quote, claim.heading);
				base.costUsd += judged.usage.costUsd;
				if (judged.verdict === "supported") base.judge.supported += 1;
				else if (judged.verdict === "partial") base.judge.partial += 1;
				else if (judged.verdict === "unsupported") base.judge.unsupported += 1;
				else base.judge.unknown += 1;
			}
			base.unsupportedClaims = base.judge.unsupported + base.judge.unknown;
			base.semanticPass = base.unsupportedClaims === 0 ? "pass" : "fail";
		}
		base.pass =
			structural.pass &&
			mapping.ok &&
			fidelity.failures.length === 0 &&
			(label === "baseline" || FROZEN || base.semanticPass === "pass");
		return base;
	} catch (err) {
		base.latencyMs = Date.now() - started;
		base.errorCode =
			err instanceof PolicyExceptionAgentError
				? err.code
				: err instanceof Error
					? `THREW:${err.message.slice(0, 60)}`
					: "THREW";
		// Issue codes/paths only: never generated text, evidence, or bodies.
		const issues =
			err instanceof PolicyExceptionAgentError
				? err.issues.slice(0, 5).map((i) => `${i.code}@${i.path}`)
				: [];
		base.gateFailures = [`error:${base.errorCode}`, ...issues];
		base.pass = false;
		return base;
	}
}

// --- Stats ---

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
function p95(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] as number;
}
function wilson(passes: number, total: number): { low: number; high: number } {
	if (total === 0) return { low: 0, high: 0 };
	const z = 1.96;
	const p = passes / total;
	const denom = 1 + (z * z) / total;
	const centre = (p + (z * z) / (2 * total)) / denom;
	const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
	return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

// --- Main ---

const results: TrialRecord[] = [];
const mappingByCase = new Map<string, MappingCheck>();
let spentUsd = 0;
let abortedCount = 0;

function abortedRecord(testCase: EvalCase, trial: number, mode: "agent" | "baseline"): TrialRecord {
	return {
		caseId: testCase.id,
		trial,
		mode,
		ok: false,
		pass: false,
		structuralPass: null,
		semanticPass: "skipped",
		mappingOk: mappingByCase.get(testCase.id)?.ok ?? null,
		status: null,
		errorCode: "ABORTED_BUDGET",
		aborted: true,
		modelSkipped: false,
		gate: null,
		latencyMs: 0,
		costUsd: 0,
		toolCalls: 0,
		ruleTools: 0,
		policyTools: 0,
		sourceRefs: 0,
		repairAttempted: false,
		fidelity: null,
		fidelityFailures: [],
		judge: { supported: 0, partial: 0, unsupported: 0, unknown: 0 },
		unsupportedClaims: 0,
		safetyHits: [],
		gateFailures: ["aborted:budget"],
		rawHash: null,
	};
}

console.log(
	`policy-exception eval: ${CASES.length} cases x ${TRIALS} trials, model=${FROZEN ? "frozen-scripted" : MODEL}, ` +
		`judge=${FROZEN ? "skipped" : JUDGE_MODEL}, frozen=${FROZEN}, budget=$${BUDGET_USD}, maxRunCost=$${MAX_RUN_COST_USD}`,
);

for (const testCase of CASES) {
	console.log(`  ${testCase.id} (${testCase.scenario}/${testCase.split}) ...`);
	const sourceDown = testCase.tags.includes("source-down");
	const policyClient = createFixturePolicyClient(testCase.input.sections, { sourceDown });
	// 1. Deterministic context (fail-closed before any model call).
	let builder: BuilderCaseRuleContext | null = null;
	let builderError: string | null = null;
	try {
		builder = buildCaseRuleContextFromRows(buildRows(testCase));
	} catch (err) {
		builderError =
			err instanceof RuleContextUnavailableError || err instanceof UnsupportedPolicyVersionError
				? err.code
				: err instanceof Error
					? `THREW:${err.message.slice(0, 60)}`
					: "THREW";
	}
	// 2. Mapping/exception fidelity: labelled registry self-check (deterministic).
	if (builder) {
		const mapping = checkMapping(testCase, builder);
		mappingByCase.set(testCase.id, mapping);
		if (!mapping.ok) {
			console.log(`    mapping diffs: ${mapping.diffs.slice(0, 4).join(" | ")}`);
		}
	}
	if (!builder) {
		const pass =
			(builderError === "RULE_CONTEXT_UNAVAILABLE" &&
				testCase.expected.status === "rule_context_unavailable") ||
			(builderError === "UNSUPPORTED_POLICY_VERSION" &&
				testCase.expected.status === "unsupported_policy_version");
		for (let trial = 1; trial <= TRIALS; trial++) {
			results.push({
				...abortedRecord(testCase, trial, "agent"),
				errorCode: builderError,
				aborted: false,
				modelSkipped: true,
				gateFailures: pass ? [] : [`builder:${builderError}`],
				gate: "builder-fail-closed",
				pass,
				ok: pass,
			});
		}
		console.log(`    builder fail-closed (${builderError}) -> ${pass ? "pass" : "FAIL"}`);
		continue;
	}
	const mapping = mappingByCase.get(testCase.id) as MappingCheck;
	const context = toAgentContext(builder, testCase.input.application);
	// 3. Catalog via the fixture client (exercises resolve scope/as-of).
	let catalog: PolicySectionDelivery[];
	try {
		const refs = testCase.input.sections.map((s) => ({
			policyKey: s.policyKey,
			sectionId: s.sectionId,
		}));
		const response = await policyClient.resolveSections({
			applicationId: context.applicationId,
			actorId: "00000000-0000-0000-0000-000000000001",
			actorRole: "officer",
			policyAsOf: context.policyAsOf,
			productScope: context.applicationKind,
			refs,
		});
		catalog = response.sections;
		if (catalog.length === 0) throw new Error("empty catalog");
	} catch (err) {
		const code = err instanceof PolicySourceError ? err.code : "CATALOG_FAILED";
		const pass =
			testCase.expected.status === "source_unavailable" && code === "POLICY_SOURCE_UNAVAILABLE";
		for (let trial = 1; trial <= TRIALS; trial++) {
			results.push({
				...abortedRecord(testCase, trial, "agent"),
				errorCode: code,
				aborted: false,
				modelSkipped: true,
				gate: "catalog-fail-closed",
				pass,
				ok: pass,
				gateFailures: pass ? [] : [`catalog:${code}`],
			});
		}
		console.log(`    catalog fail-closed (${code}) -> ${pass ? "pass" : "FAIL"}`);
		continue;
	}
	const evidence = buildEvidenceBundle(testCase, builder, catalog);
	// 4. Follow-up gates refuse without a model call.
	if (testCase.scenario === "followup") {
		const gate = followupGate(testCase, testCase.input.application.reference);
		if (gate) {
			const pass = testCase.expected.status === gate.status;
			for (let trial = 1; trial <= TRIALS; trial++) {
				results.push({
					...abortedRecord(testCase, trial, "agent"),
					aborted: false,
					modelSkipped: true,
					gate: gate.gate,
					status: gate.status,
					structuralPass: pass,
					mappingOk: mapping.ok,
					pass: pass && mapping.ok,
					ok: pass,
					gateFailures: pass ? [] : [`gate:${gate.gate}`],
				});
			}
			console.log(`    gate ${gate.gate} -> ${pass ? "pass" : "FAIL"}`);
			continue;
		}
	}
	// 5. Agent trials (+ deterministic baseline graded separately).
	for (let trial = 1; trial <= TRIALS; trial++) {
		if (spentUsd >= BUDGET_USD) {
			results.push({ ...abortedRecord(testCase, trial, "agent") });
			abortedCount += 1;
			continue;
		}
		if (DELAY_MS > 0 && trial > 1) await sleep(DELAY_MS);
		console.log(`    trial ${trial}/${TRIALS} ...`);
		const mappedRules = context.failedRules.filter((rule) => rule.mappingState === "mapped");
		if (testCase.expected.status === "mapping_unavailable" && mappedRules.length === 0) {
			results.push({
				...abortedRecord(testCase, trial, "agent"),
				aborted: false,
				modelSkipped: true,
				gate: "mapping-unavailable",
				status: "mapping_unavailable",
				structuralPass: true,
				mappingOk: mapping.ok,
				pass: mapping.ok,
				ok: true,
				errorCode: null,
				gateFailures: mapping.ok ? [] : ["mapping:self-check"],
			});
			continue;
		}
		if (testCase.expected.status === "mapping_unavailable") {
			// A context with no explainable failed rules (unmapped persisted
			// reason) fails closed without an agent call, since the builder
			// drops unknown codes. Source-down must fail closed in the run.
			if (context.failedRules.length === 0) {
				for (const row of [{ ...abortedRecord(testCase, trial, "agent"), aborted: false }]) {
					row.gate = "no-explainable-rules";
					row.pass = true;
					row.ok = true;
					row.mappingOk = mapping.ok;
					results.push(row);
				}
				continue;
			}
			const row = await runAgentTrial(
				testCase,
				trial,
				context,
				evidence,
				catalog,
				policyClient,
				mapping,
				"agent",
			);
			spentUsd += row.costUsd;
			const failClosed = !row.ok && row.status === null;
			row.pass = failClosed;
			row.gateFailures = failClosed ? [] : [`expected-fail-closed:${row.status ?? row.errorCode}`];
			results.push(row);
			continue;
		}
		const row = await runAgentTrial(
			testCase,
			trial,
			context,
			evidence,
			catalog,
			policyClient,
			mapping,
			"agent",
		);
		spentUsd += row.costUsd;
		results.push(row);
	}
	// Baseline: one deterministic run per case, graded structurally only.
	if (testCase.expected.status === "succeeded" || testCase.expected.status === "no_match") {
		if (spentUsd < BUDGET_USD) {
			const row = await runAgentTrial(
				testCase,
				0,
				context,
				evidence,
				catalog,
				policyClient,
				mapping,
				"baseline",
			);
			results.push(row);
		} else {
			results.push({ ...abortedRecord(testCase, 0, "baseline") });
			abortedCount += 1;
		}
	}
	if (DELAY_MS > 0) await sleep(DELAY_MS);
}

// --- Calibration (live only, budget permitting) ---

interface CalibrationExample {
	id: string;
	claim: string;
	quote: string;
	heading: string;
	human: string;
}
const CALIBRATION: CalibrationExample[] = (
	JSON.parse(readFileSync(join(HERE, "judges", "calibration.json"), "utf8")) as {
		examples: CalibrationExample[];
	}
).examples;
let calibrationAgreement: number | null = null;
let calibrationSkipped: string | null = null;
const calibrationRows: Array<{ id: string; human: string; judged: string; match: boolean }> = [];
if (!FROZEN) {
	if (spentUsd + 0.05 >= BUDGET_USD) {
		calibrationSkipped = "budget";
	} else {
		let matches = 0;
		for (const example of CALIBRATION) {
			const judged = await judgeSupport(example.claim, example.quote, example.heading);
			judgeSpend += judged.usage.costUsd;
			spentUsd += judged.usage.costUsd;
			const match = judged.verdict === example.human;
			if (match) matches += 1;
			calibrationRows.push({ id: example.id, human: example.human, judged: judged.verdict, match });
		}
		calibrationAgreement = CALIBRATION.length === 0 ? null : matches / CALIBRATION.length;
	}
} else {
	calibrationSkipped = "frozen";
}

// --- Stats ---

const agentTrials = results.filter((r) => r.mode === "agent");
const gradedTrials = results.filter(
	(r) => r.mode === "agent" && !r.aborted && !r.modelSkipped && r.gate === null,
);
const baselineTrials = results.filter((r) => r.mode === "baseline" && !r.aborted);
const ran = results.filter((r) => !r.aborted);
const passed = agentTrials.filter((r) => !r.aborted && r.pass);
const passAt1 = agentTrials.length === 0 ? 0 : passed.length / agentTrials.length;
const byCase = new Map<string, TrialRecord[]>();
for (const row of results.filter((r) => r.mode === "agent")) {
	const list = byCase.get(row.caseId) ?? [];
	list.push(row);
	byCase.set(row.caseId, list);
}
let pass3Cases = 0;
let scoredCases = 0;
for (const [, list] of byCase) {
	if (list.length === 0) continue;
	scoredCases += 1;
	if (list.every((r) => !r.aborted && r.pass)) pass3Cases += 1;
}
const pass3 = scoredCases === 0 ? 0 : pass3Cases / scoredCases;
const latencies = gradedTrials.map((r) => r.latencyMs);
const totalCost = results.reduce((n, r) => n + r.costUsd, 0);
const structuralDenom = gradedTrials.filter((r) => r.structuralPass !== null);
const structuralPass =
	structuralDenom.length === 0
		? 0
		: structuralDenom.filter((r) => r.structuralPass === true).length / structuralDenom.length;
const semanticTrials = gradedTrials.filter((r) => r.semanticPass !== "skipped");
const semanticPass =
	semanticTrials.length === 0
		? null
		: semanticTrials.filter((r) => r.semanticPass === "pass").length / semanticTrials.length;
const mappingCases = [...mappingByCase.values()];
const mappingRate =
	mappingCases.length === 0 ? null : mappingCases.filter((m) => m.ok).length / mappingCases.length;
const fidelityRows = gradedTrials.filter((r) => r.fidelity !== null);
const meanFidelity =
	fidelityRows.length === 0 ? null : mean(fidelityRows.map((r) => r.fidelity as number));
const baselineRate =
	baselineTrials.length === 0
		? null
		: baselineTrials.filter((r) => r.pass).length / baselineTrials.length;
const toolCoverage =
	gradedTrials.length === 0
		? 0
		: gradedTrials.filter((r) => r.ruleTools > 0 && r.policyTools > 0).length / gradedTrials.length;
const repairRate =
	gradedTrials.length === 0 ? 0 : mean(gradedTrials.map((r) => (r.repairAttempted ? 1 : 0)));
const safetyFails = agentTrials.filter(
	(r) => r.safetyHits.length > 0 || r.gateFailures.some((g) => g.startsWith("forbidden-text")),
);
const unsupportedTotal = agentTrials.reduce((n, r) => n + r.unsupportedClaims, 0);
let requiredSections = 0;
let missingSections = 0;
for (const row of gradedTrials) {
	const expected = CASES.find((c) => c.id === row.caseId)?.expected;
	if (!expected) continue;
	requiredSections += expected.requiredSections.length;
	missingSections += row.gateFailures.filter((g) => g.startsWith("section-miss:")).length;
}
const citationCoverage = requiredSections === 0 ? null : 1 - missingSections / requiredSections;

const clusters = new Map<string, string[]>();
for (const row of agentTrials.filter((r) => !r.pass)) {
	const key = row.gateFailures[0] ?? "unknown";
	const list = clusters.get(key) ?? [];
	list.push(`${row.caseId}#${row.trial}`);
	clusters.set(key, list);
}

console.table(
	CASES.map((c) => {
		const list = (byCase.get(c.id) ?? []).filter((r) => !r.aborted);
		const ok = list.filter((r) => r.pass).length;
		return {
			id: c.id.replace("pe-", ""),
			mode: c.scenario,
			split: c.split,
			pass: `${ok}/${list.length}`,
			pass3: list.length > 0 && list.every((r) => r.pass) ? "yes" : "no",
			usd: list.reduce((a, b) => a + b.costUsd, 0).toFixed(4),
			ms: Math.round(mean(list.map((r) => r.latencyMs))),
			firstFailure: (byCase.get(c.id) ?? []).find((r) => !r.pass)?.gateFailures[0] ?? "",
		};
	}),
);
console.log({
	cases: CASES.length,
	trialsPerCase: TRIALS,
	ran: ran.length,
	aborted: abortedCount,
	passAt1: `${passed.length}/${agentTrials.length} (${passAt1.toFixed(3)})`,
	pass3Cases: `${pass3Cases}/${scoredCases} (${pass3.toFixed(3)})`,
	wilsonPass3: wilson(pass3Cases, scoredCases),
	structuralPass: structuralPass.toFixed(3),
	semanticPass: semanticPass === null ? "skipped" : semanticPass.toFixed(3),
	mappingRate,
	meanFidelity: meanFidelity === null ? null : Number(meanFidelity.toFixed(3)),
	baselineStructural: baselineRate === null ? null : Number(baselineRate.toFixed(3)),
	toolCoverage: toolCoverage.toFixed(3),
	repairRate: repairRate.toFixed(3),
	safetyFails: safetyFails.length,
	unsupportedClaims: unsupportedTotal,
	citationCoverage,
	calibrationAgreement,
	calibrationSkipped,
	totalCostUsd: Number(totalCost.toFixed(4)),
	meanLatencyMs: Math.round(mean(latencies)),
	p95LatencyMs: p95(latencies),
});
if (clusters.size > 0) {
	console.log("failure clusters:");
	for (const [key, ids] of [...clusters.entries()].sort((a, b) => b[1].length - a[1].length)) {
		console.log(`  ${key}: ${ids.length} (${ids.slice(0, 3).join(", ")})`);
	}
}

// --- Results JSON (no content: hashes, codes, and counts only) ---

const outDir = join(HERE, "results");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const file = join(outDir, `policy-exception-${stamp}.json`);
writeFileSync(
	file,
	`${JSON.stringify(
		{
			meta: {
				feature: "policy_exception",
				model: FROZEN ? "frozen-scripted" : MODEL,
				judgeModel: FROZEN ? null : JUDGE_MODEL,
				promptVersion: PROMPT_VERSION,
				agentVersion: AGENT_VERSION,
				validatorVersion: VALIDATOR_VERSION,
				registryVersion: POLICY_REGISTRY_VERSION,
				registryHash: POLICY_REGISTRY_HASH,
				rubric: "eval/judges/claim-support.md",
				rubricHash: RUBRIC_HASH,
				frozen: FROZEN,
				regressionOnly: FROZEN || undefined,
				trials: TRIALS,
				split: SPLIT,
				maxSteps: MAX_STEPS,
				maxToolCalls: MAX_TOOL_CALLS,
				budgetUsd: BUDGET_USD,
				maxRunCostUsd: MAX_RUN_COST_USD,
				datasetHash: DATASET_HASH,
				timestamp: stamp,
				costBasis:
					"provider-billed total when the SDK surfaces one, else tokens/1M; judge via OpenRouter usage",
				calibrationLabels:
					"eval/judges/calibration.json (20 human labels, outside the judge prompt)",
				caveats: [
					"Single-file dataset: dev labels and held-out labels are co-located; held-out discipline rests on the manifest plus a single live run.",
					"Same-family judge and generator; self-preference bias noted, judge columns advisory until calibration clears 85%.",
					"Fixture policy client, not the policy service: no network, no ACL/tenant check, no budget reservation.",
					"Agent-context mapping (applicationReference, scoreBand, unmapped arrays) mirrors the intended route mapping; the officer routes are not in this path.",
					"Usage on failed trials is not recorded (the orchestrator discards the runner result on INVALID_OUTPUT), so cost totals understate failing runs.",
					"unknown judge verdicts count as unsupported.",
					...(FROZEN
						? [
								"Frozen run: scripted deterministic drafts exercise validator plumbing only; not a model-quality signal.",
							]
						: []),
				],
			},
			summary: {
				passAt1,
				pass3,
				n: CASES.length,
				ran: ran.length,
				abortedTrials: abortedCount,
				meanLatencyMs: mean(latencies),
				p95LatencyMs: p95(latencies),
				totalCostUsd: totalCost,
				judgeSpendUsd: judgeSpend,
				wilsonPass3: wilson(pass3Cases, scoredCases),
				structuralPass,
				semanticPass,
				mappingRate,
				meanFidelity,
				baselineStructural: baselineRate,
				toolCoverage,
				repairRate,
				safetyFails: safetyFails.map((r) => `${r.caseId}#${r.trial}`),
				unsupportedClaims: unsupportedTotal,
				citationCoverage,
				calibrationAgreement,
				calibrationSkipped,
				clusters: Object.fromEntries(clusters),
			},
			mapping: [...mappingByCase.entries()].map(([caseId, m]) => ({
				caseId,
				ok: m.ok,
				diffs: m.diffs,
			})),
			cases: CASES.map((c) => {
				const list = (byCase.get(c.id) ?? []).filter((r) => !r.aborted);
				const base = baselineTrials.find((r) => r.caseId === c.id);
				return {
					id: c.id,
					scenario: c.scenario,
					split: c.split,
					trials: list.length,
					passes: list.filter((r) => r.pass).length,
					pass3: list.length > 0 && list.every((r) => r.pass),
					meanCostUsd: mean(list.map((r) => r.costUsd)),
					meanLatencyMs: mean(list.map((r) => r.latencyMs)),
					mappingOk: mappingByCase.get(c.id)?.ok ?? null,
					meanFidelity: mean(
						list.filter((r) => r.fidelity !== null).map((r) => r.fidelity as number),
					),
					baselinePass: base ? base.pass : null,
				};
			}),
			trials: results,
			calibration: {
				agreement: calibrationAgreement,
				skipped: calibrationSkipped,
				rows: calibrationRows,
			},
		},
		null,
		2,
	)}\n`,
);
console.log(`\nwrote ${file}`);

// --- Held-out manifest (live runs only) ---

if (heldoutRequested() && !FROZEN) {
	writeFileSync(
		MANIFEST_PATH,
		`${JSON.stringify(
			{
				datasetHash: DATASET_HASH,
				model: MODEL,
				judgeModel: JUDGE_MODEL,
				promptVersion: PROMPT_VERSION,
				agentVersion: AGENT_VERSION,
				validatorVersion: VALIDATOR_VERSION,
				trials: TRIALS,
				split: SPLIT,
				timestamp: stamp,
				resultFile: file,
			},
			null,
			2,
		)}\n`,
	);
	console.log(`held-out manifest: ${MANIFEST_PATH}`);
}

if (!FROZEN) await applicationObservability().shutdown();
const failed = passAt1 < 0.8 || safetyFails.length > 0;
if (failed) {
	console.error(
		`policy-exception eval FAILED: pass@1=${passAt1.toFixed(3)} (needs >= 0.800), safetyFails=${safetyFails.length}`,
	);
	process.exitCode = 1;
}
