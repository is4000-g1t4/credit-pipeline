// Document-integrity eval: production analysis/triage path, code-first graders.
//
//   pnpm --filter @credit/applications eval:integrity -- --split=dev --trials=1
//
// Real model by default (OPENROUTER_API_KEY from the repo-root .env).
// --frozen runs a deterministic label-regex/scripted runner instead of the
// model; results are labelled regression-only and must not be quoted as
// model quality. Never store raw page text or raw model output in results.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
	containsApplicationReference,
	containsBriefDecisionLanguage,
	containsDefinitiveFraudLanguage,
} from "@credit/core";
import { runIntegrityAnalysis, runIntegrityTriage } from "../src/integrity/agent.js";
import { createAgentsIntegrityRunner } from "../src/integrity/agent-sdk.js";
import { applicationObservability } from "../src/observability.js";
import { signalSourceRef, shouldFlag } from "../src/integrity/signals.js";
import {
	IntegrityAgentError,
	type DeterministicSignal,
	type IntegrityAgentMode,
	type IntegrityAgentRunner,
	type IntegrityCandidateField,
	type IntegrityConfig,
	type IntegrityConsistencyField,
	type IntegritySeverity,
	type IntegritySignalCode,
	type IntegritySource,
} from "../src/integrity/types.js";
import {
	extractCurrency,
	normalizeCandidateValue,
	parseAmountValue,
} from "../src/integrity/validators.js";
import {
	extractCandidates,
	normalizeNameTokens,
	normalizeRegistration,
} from "../src/documents/crosscheck.js";

const HERE = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(HERE, "..", "..", "..", ".env") });

function hashText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

// --- CLI ---

function arg(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const TRIALS = Math.max(1, Number(arg("trials", "3")) || 3);
const SPLIT = arg("split", "all");
const ONLY = arg("case", "");
const BUDGET_USD = Number(arg("budget-usd", "1.5")) || 1.5;
const MAX_RUN_COST_USD = Number(arg("max-run-cost-usd", "0.12")) || 0.12;
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "2")) || 2);
const FROZEN = flag("frozen");
const TIMEOUT_MS = Number(arg("timeout-ms", "90000")) || 90000;
const AS_OF = "2026-06-30";

// --- Config from env/defaults (mirrors apps/applications/src/env.ts) ---

function envStr(name: string, fallback: string): string {
	const value = process.env[name];
	return value === undefined || value === "" ? fallback : value;
}
function envInt(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const API_KEY = process.env["OPENROUTER_API_KEY"] ?? "";
if (!FROZEN && API_KEY === "") {
	console.error(
		"integrity eval: OPENROUTER_API_KEY is missing (loaded from the repo-root .env). " +
			"Set it or re-run with --frozen for the regression-only scripted runner.",
	);
	process.exit(1);
}

const CONFIG: IntegrityConfig = {
	enabled: true,
	fraudReviewEnabled: true,
	agentEnabled: true,
	triageEnabled: true,
	// Document-integrity winner: docs/eval/applications/INTEGRITY-MODELS-RESULTS.md.
	model: envStr("DOCUMENT_INTEGRITY_MODEL", "openai/gpt-6.1-sol"),
	promptVersion: envStr("DOCUMENT_INTEGRITY_PROMPT_VERSION", "integrity-analysis-v1"),
	agentVersion: envStr("DOCUMENT_INTEGRITY_AGENT_VERSION", "integrity-agent-v1"),
	triagePromptVersion: envStr("DOCUMENT_INTEGRITY_TRIAGE_PROMPT_VERSION", "integrity-triage-v1"),
	maxSteps: envInt("DOCUMENT_INTEGRITY_MAX_STEPS", 24),
	maxToolCalls: envInt("DOCUMENT_INTEGRITY_MAX_TOOL_CALLS", 32),
	timeoutMs: TIMEOUT_MS,
	maxCostUsd: MAX_RUN_COST_USD,
	maxOutputTokens: envInt("DOCUMENT_INTEGRITY_MAX_OUTPUT_TOKENS", 4000),
	flagSeverity: "high",
	retentionDays: 365,
	systemUserId: "00000000-0000-0000-0000-000000000000",
	maxRunsPerHash: 3,
	openRouterApiKey: API_KEY === "" ? null : API_KEY,
	openRouterBaseUrl: envStr("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
};

// --- Cases ---

interface FixtureDocument {
	alias: string;
	kind: string;
	pages: string[];
	ocrStatus?: string;
	textLayerRisk?: boolean;
	ocrConfidence?: number | null;
	documentDate?: string | null;
	periodEnd?: string | null;
	source?: string;
	readable?: boolean;
	sha256?: string;
}
interface FixtureSignal {
	code: string;
	severity: IntegritySeverity;
	documentAlias?: string | null;
	summary: string;
	count?: number;
}
interface FixtureCrosscheckFinding {
	field: string;
	status: "mismatch" | "needs_chase";
	confidence: "low" | "medium" | "high";
	expected: string | null;
	observed: string | null;
	documentAlias: string | null;
	pageNumber: number | null;
	reason?: string;
}
interface EvalCase {
	id: string;
	feature: string;
	mode: IntegrityAgentMode;
	split: string;
	tags: string[];
	input: {
		applicationType?: string;
		product?: string;
		caseFacts?: Array<{ field: string; label: string; value: string }>;
		documents: FixtureDocument[];
		signals?: FixtureSignal[];
		crosscheck?: { findings: FixtureCrosscheckFinding[] };
		duplicateCounts?: {
			sameApplication: number;
			sameApplicantOther: number;
			crossApplicant: number;
		};
		duplicateMatches?: Array<{
			sourceAlias: string;
			matchAlias: string;
			kind: string;
			relation: string;
		}>;
		customerDocuments?: Array<{ alias: string; kind: string; pages: string[] }>;
		unavailable?: Array<{ code: string; label: string }>;
		includeCustomerEvidence?: boolean;
		documentConsent?: boolean;
		contextConsent?: boolean;
		otherRefs?: string[];
	};
	expected: {
		requiredCandidateFields?: string[];
		expectedCandidates?: Array<{ field: string; value: string }>;
		forbiddenCandidateValues?: string[];
		expectedConsistency?: Array<{ field: string; proposedKind: string; findingState: string }>;
		triageRequiredSignalCodes?: string[];
		triageMustValidate?: boolean;
		minContradictions?: number;
		minAlternativeExplanations?: number;
		forbiddenText?: string[];
		mustNotFlag?: boolean;
		maxDroppedClaims?: number;
	};
	notes: string;
}

const ALL_CASES: EvalCase[] = (
	JSON.parse(readFileSync(join(HERE, "integrity-cases.json"), "utf8")) as { cases: EvalCase[] }
).cases;
const CASES = ALL_CASES.filter(
	(c) => (SPLIT === "all" || c.split === SPLIT) && (ONLY === "" || c.id === ONLY),
);
if (CASES.length === 0) {
	console.error(`integrity eval: no cases match split=${SPLIT} case=${ONLY || "(any)"}`);
	process.exit(1);
}

// --- Fixture → IntegritySource (no DB) ---

function uuidFor(seed: string): string {
	const h = createHash("sha256").update(seed).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function buildSource(
	caseId: string,
	input: EvalCase["input"],
): {
	source: IntegritySource;
	docIds: Map<string, string>;
	otherRefs: string[];
} {
	const docIds = new Map<string, string>();
	for (const doc of input.documents) docIds.set(doc.alias, uuidFor(`${caseId}:doc:${doc.alias}`));
	const custIds = new Map<string, string>();
	for (const doc of input.customerDocuments ?? [])
		custIds.set(doc.alias, uuidFor(`${caseId}:cust:${doc.alias}`));
	const appId = uuidFor(`${caseId}:app`);
	const appType = input.applicationType === "individual" ? "individual" : "sme";
	const caseFacts =
		input.caseFacts ??
		(appType === "individual"
			? [{ field: "applicantName", label: "Applicant name", value: "Daniel Koh" }]
			: [
					{ field: "companyName", label: "Company name", value: "Merlion Foods Pte Ltd" },
					{ field: "registrationNumber", label: "Registration number", value: "201912345K" },
				]);
	const documents = input.documents.map((doc, index) => {
		const readable = doc.readable ?? true;
		return {
			documentFileId: docIds.get(doc.alias) as string,
			kind: doc.kind as IntegritySource["documents"][number]["kind"],
			pageCount: Math.max(1, doc.pages.length),
			ocrStatus: (doc.ocrStatus ?? "ready") as IntegritySource["documents"][number]["ocrStatus"],
			textLayerRisk: doc.textLayerRisk ?? false,
			sha256: doc.sha256 ?? createHash("sha256").update(`${caseId}:${doc.alias}`).digest("hex"),
			sizeBytes: 1024 + index,
			mimeType: "application/pdf",
			ocrConfidence: doc.ocrConfidence ?? (doc.ocrStatus === "unsupported" ? null : 0.97),
			documentDate: doc.documentDate ?? null,
			periodEnd: doc.periodEnd ?? null,
			source: doc.source ?? "upload",
			uploadedAt: new Date("2026-06-01T00:00:00.000Z"),
			pages: readable
				? doc.pages.map((text, pageIndex) => ({
						pageNumber: pageIndex + 1,
						text,
						source: (doc.source === "ocr" ? "ocr" : "pdf_text") as "pdf_text" | "ocr",
						confidence: doc.ocrConfidence ?? 0.97,
						textSha256: hashText(text),
					}))
				: [],
			readable,
			...(readable ? {} : { unavailableCode: "missing" as const }),
		};
	});
	const signals: DeterministicSignal[] = (input.signals ?? []).map((signal) => ({
		code: signal.code as IntegritySignalCode,
		severity: signal.severity,
		documentFileId: signal.documentAlias ? (docIds.get(signal.documentAlias) as string) : null,
		summary: signal.summary,
		sourceRef: signalSourceRef(
			signal.code as IntegritySignalCode,
			signal.documentAlias ? (docIds.get(signal.documentAlias) as string) : undefined,
		),
		...(signal.count === undefined ? {} : { count: signal.count }),
	}));
	const source: IntegritySource = {
		applicationId: appId,
		applicationReference: `APP-2026-${caseId
			.slice(-6)
			.toUpperCase()
			.replaceAll(/[^A-Z0-9]/g, "X")}`,
		applicationType: appType,
		product: input.product ?? "sme_term_loan",
		applicantUserId: uuidFor(`${caseId}:user`),
		customerProfileId: uuidFor(`${caseId}:customer`),
		documentConsent: input.documentConsent ?? true,
		contextConsent: input.contextConsent ?? true,
		caseFacts,
		documents,
		customerDocuments: (input.customerDocuments ?? []).map((doc) => ({
			customerDocumentId: custIds.get(doc.alias) as string,
			kind: doc.kind as IntegritySource["customerDocuments"][number]["kind"],
			pageCount: Math.max(1, doc.pages.length),
			ocrStatus: "ready",
			sha256Prefix: createHash("sha256")
				.update(`${caseId}:cust:${doc.alias}`)
				.digest("hex")
				.slice(0, 16),
			documentDate: null,
			periodEnd: null,
			readable: true,
			pages: doc.pages.map((text, pageIndex) => ({
				pageNumber: pageIndex + 1,
				text,
				source: "pdf_text" as const,
				confidence: 0.97,
				textSha256: hashText(text),
			})),
		})),
		crosscheck: input.crosscheck
			? {
					id: uuidFor(`${caseId}:crosscheck`),
					findings: input.crosscheck.findings.map((finding) => ({
						id: uuidFor(`${caseId}:finding:${finding.field}`),
						field: finding.field,
						status: finding.status,
						confidence: finding.confidence,
						expected: finding.expected,
						observed: finding.observed,
						documentFileId: finding.documentAlias
							? (docIds.get(finding.documentAlias) as string)
							: null,
						pageNumber: finding.pageNumber,
						quote: null,
						quoteStart: null,
						quoteEnd: null,
						quoteHash: null,
						reason: finding.reason ?? "eval fixture",
					})),
				}
			: null,
		signals,
		duplicateCounts: input.duplicateCounts ?? {
			sameApplication: 0,
			sameApplicantOther: 0,
			crossApplicant: 0,
		},
		duplicateMatches: (input.duplicateMatches ?? []).map((match) => ({
			sourceDocumentFileId: docIds.get(match.sourceAlias) as string,
			matchingDocumentFileId: uuidFor(`${caseId}:match:${match.matchAlias}`),
			kind: match.kind,
			relation: match.relation as IntegritySource["duplicateMatches"][number]["relation"],
		})),
		unavailable: (input.unavailable ?? []).map((item) => ({
			code: item.code as IntegritySource["unavailable"][number]["code"],
			label: item.label,
		})),
		includeCustomerEvidence:
			input.includeCustomerEvidence ?? (input.customerDocuments ?? []).length > 0,
	};
	return { source, docIds, otherRefs: input.otherRefs ?? [] };
}

// --- Frozen runner (regression-only: no model call) ---

function frozenCandidates(source: IntegritySource): unknown[] {
	const out: unknown[] = [];
	for (const doc of source.documents) {
		if (!doc.readable || doc.pages.length === 0) continue;
		const first = doc.pages[0];
		if (first && first.text.trim().length > 0) {
			out.push({
				documentFileId: doc.documentFileId,
				field: "document_type",
				value: doc.kind,
				pageNumber: first.pageNumber,
				quote: [...first.text].slice(0, 80).join(""),
				confidence: 0.9,
			});
		}
		const pages = doc.pages.map((page) => ({
			pageNumber: page.pageNumber,
			text: page.text,
			confidence: page.confidence,
			textSource: page.source,
		}));
		for (const [labelField, candidateField] of [
			["company_name", "issuer"],
			["registration_number", "registration_number"],
			["account_holder_name", "account_holder_name"],
		] as const) {
			for (const hit of extractCandidates(labelField, pages)) {
				out.push({
					documentFileId: doc.documentFileId,
					field: candidateField,
					value: hit.observed.slice(0, 200),
					pageNumber: hit.pageNumber,
					quote: hit.quote,
					confidence: hit.confidence,
				});
			}
		}
	}
	return out;
}

function createFrozenRunner(): IntegrityAgentRunner {
	return {
		async run(input) {
			const generateBrief = input.generateBrief === true;
			const toolCalls = generateBrief
				? [
						{
							step: 1,
							name: "list_signals",
							resultCount: input.source.signals.length,
							sourceTypes: ["context_signal"],
							refs: [],
						},
					]
				: [
						{
							step: 1,
							name: "list_documents",
							resultCount: input.source.documents.length,
							sourceTypes: ["document"],
							refs: [],
						},
					];
			const signalTokens = input.source.signals.slice(0, 4).map((signal) => ({
				kind: "signal",
				signalCode: signal.code,
				...(signal.documentFileId ? { documentFileId: signal.documentFileId } : {}),
			}));
			const citations =
				signalTokens.length > 0
					? signalTokens
					: (() => {
							const doc = input.source.documents.find((d) => d.readable && d.pages.length > 0);
							const page = doc?.pages[0];
							return doc && page
								? [
										{
											kind: "document",
											documentFileId: doc.documentFileId,
											pageNumber: page.pageNumber,
											quote: [...page.text].slice(0, 60).join(""),
										},
									]
								: [];
						})();
			const brief = generateBrief
				? {
						title: "Integrity triage brief (frozen regression output)",
						summary: {
							text: "The deterministic signals list items for officer review.",
							citations,
						},
						candidateContradictions: [],
						missingEvidence: [],
						alternativeExplanations: [],
						questionsForReviewer: ["Could the reviewer confirm the flagged items?"],
						suggestedPriority: "low",
					}
				: undefined;
			return {
				rawOutput: JSON.stringify({
					candidates: frozenCandidates(input.source),
					consistency: [],
					...(brief ? { brief } : {}),
				}),
				toolCalls,
				sourceRefs: [],
				steps: toolCalls.length + 1,
				usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
			};
		},
	};
}

function createRunner(): IntegrityAgentRunner {
	const base = FROZEN
		? createFrozenRunner()
		: createAgentsIntegrityRunner({
				apiKey: API_KEY,
				baseUrl: CONFIG.openRouterBaseUrl,
				model: CONFIG.model,
				agentVersion: CONFIG.agentVersion,
				promptVersion: CONFIG.promptVersion,
				maxToolCalls: CONFIG.maxToolCalls,
				maxOutputTokens: CONFIG.maxOutputTokens,
				timeoutMs: CONFIG.timeoutMs,
			});
	if (process.env.INTEGRITY_EVAL_DEBUG !== "1") return base;
	return {
		async run(input) {
			const result = await base.run(input);
			console.error(`[integrity eval raw ${input.mode}] ${result.rawOutput.slice(0, 6_000)}`);
			return result;
		},
	};
}

// --- Scans ---

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const NRIC_RE = /\b[STFGM]\d{7}[A-Z]\b/i;
const PHONE_RE = /(?:\+?65[\s-]?)?[689]\d{3}[\s-]?\d{4}\b/;

function scanText(text: string, otherRefs: string[]): Record<string, number> {
	const lowered = text.toLowerCase();
	return {
		definitiveFraud: containsDefinitiveFraudLanguage(text) ? 1 : 0,
		decision: containsBriefDecisionLanguage(text) ? 1 : 0,
		crossCustomer:
			containsApplicationReference(text) ||
			otherRefs.some((ref) => ref.trim() !== "" && lowered.includes(ref.toLowerCase()))
				? 1
				: 0,
		directIdentifier: EMAIL_RE.test(text) || NRIC_RE.test(text) || PHONE_RE.test(text) ? 1 : 0,
	};
}

function briefProse(content: {
	title: string;
	summary: { text: string };
	candidateContradictions: Array<{ text: string }>;
	alternativeExplanations: Array<{ text: string }>;
	missingEvidence: Array<{ text: string }>;
	questionsForReviewer: string[];
}): string {
	return [
		content.title,
		content.summary.text,
		...content.candidateContradictions.map((c) => c.text),
		...content.alternativeExplanations.map((c) => c.text),
		...content.missingEvidence.map((c) => c.text),
		...content.questionsForReviewer,
	].join("\n");
}

// --- Trial ---

interface TrialResult {
	caseId: string;
	trial: number;
	mode: IntegrityAgentMode;
	ok: boolean;
	pass: boolean;
	errorCode: string | null;
	aborted?: boolean;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	toolCalls: number;
	repairAttempted: boolean;
	droppedClaims: number;
	candidateTotal: number;
	candidateMatched: number;
	candidateExpectedTotal: number;
	consistencyTotal: number;
	consistencyConfirmed: number;
	consistencyMatched: number;
	consistencyExpectedTotal: number;
	citationCount: number;
	signalCodesCited: string[];
	priority: string | null;
	missingEvidenceCount: number;
	missingEvidenceCoverage: boolean | null;
	scansRaw: Record<string, number>;
	scansValidated: Record<string, number>;
	forbiddenHits: string[];
	mustNotFlagViolated: boolean;
	gateFailures: string[];
	issues: Array<{ code: string; path: string }>;
}

function matchState(kind: "match" | "mismatch" | null, findingState: string): boolean {
	if (findingState === "match") return kind === "match";
	if (findingState === "mismatch") return kind === "mismatch";
	if (findingState === "needs_chase") return kind === null;
	return false;
}

/** Amount comparison for the grader: digits must agree; a currency the model
 * states must agree with the expected one, but a missing currency is not a
 * miss — the production validator accepts bare values as validated. */
function candidateMatches(
	field: string,
	wantValue: string,
	candidate: { normalizedValue: string; value: string },
): boolean {
	if (field !== "material_amount") {
		return (
			candidate.normalizedValue ===
			normalizeCandidateValue(field as IntegrityCandidateField, wantValue)
		);
	}
	const wantAmount = parseAmountValue(wantValue);
	const gotAmount = parseAmountValue(candidate.value);
	if (wantAmount === null || gotAmount === null || wantAmount !== gotAmount) return false;
	const wantCurrency = extractCurrency(wantValue);
	const gotCurrency = extractCurrency(candidate.value);
	if (gotCurrency !== null && wantCurrency !== null && gotCurrency !== wantCurrency) return false;
	return true;
}

async function runTrial(
	testCase: EvalCase,
	trial: number,
	runner: IntegrityAgentRunner,
): Promise<TrialResult> {
	const { source, otherRefs } = buildSource(testCase.id, testCase.input);
	const expected = testCase.expected;
	const base: TrialResult = {
		caseId: testCase.id,
		trial,
		mode: testCase.mode,
		ok: false,
		pass: false,
		errorCode: null,
		latencyMs: 0,
		inputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		toolCalls: 0,
		repairAttempted: false,
		droppedClaims: 0,
		candidateTotal: 0,
		candidateMatched: 0,
		candidateExpectedTotal: (expected.expectedCandidates ?? []).length,
		consistencyTotal: 0,
		consistencyConfirmed: 0,
		consistencyMatched: 0,
		consistencyExpectedTotal: (expected.expectedConsistency ?? []).length,
		citationCount: 0,
		signalCodesCited: [],
		priority: null,
		missingEvidenceCount: 0,
		missingEvidenceCoverage: null,
		scansRaw: { definitiveFraud: 0, decision: 0, crossCustomer: 0, directIdentifier: 0 },
		scansValidated: { definitiveFraud: 0, decision: 0, crossCustomer: 0, directIdentifier: 0 },
		forbiddenHits: [],
		mustNotFlagViolated: false,
		gateFailures: [],
		issues: [],
	};
	const gate = (name: string): void => {
		base.gateFailures.push(name);
	};
	let observedLatencyMs = 0;
	try {
		const observed: IntegrityAgentRunner = {
			async run(input) {
				const started = Date.now();
				try {
					return await runner.run(input);
				} finally {
					observedLatencyMs += Date.now() - started;
				}
			},
		};
		if (testCase.mode === "analysis") {
			const outcome = await runIntegrityAnalysis({
				source,
				runner: observed,
				config: CONFIG,
				conversationId: `integrity-eval:${testCase.id}:${trial}`,
			});
			base.ok = true;
			base.latencyMs = outcome.latencyMs;
			base.inputTokens = outcome.usage.inputTokens;
			base.outputTokens = outcome.usage.outputTokens;
			base.costUsd = outcome.usage.costUsd;
			base.toolCalls = outcome.toolCalls.length;
			base.repairAttempted = outcome.repairAttempted;
			base.droppedClaims = outcome.droppedClaims;
			base.scansRaw = scanText(outcome.rawOutput, otherRefs);
			base.candidateTotal = outcome.candidates.length;
			base.consistencyTotal = outcome.consistency.length;
			base.consistencyConfirmed = outcome.consistency.filter((c) => c.kind !== null).length;
			for (const field of expected.requiredCandidateFields ?? []) {
				if (!outcome.candidates.some((c) => c.field === field)) gate(`missing-field:${field}`);
			}
			let matched = 0;
			for (const want of expected.expectedCandidates ?? []) {
				const hit = outcome.candidates.some(
					(c) => c.field === want.field && candidateMatches(want.field, want.value, c),
				);
				if (hit) matched += 1;
				else gate(`candidate-miss:${want.field}:${want.value}`);
			}
			base.candidateMatched = matched;
			for (const forbidden of expected.forbiddenCandidateValues ?? []) {
				const lowered = forbidden.toLowerCase();
				const hit = outcome.candidates.some(
					(c) =>
						c.value.toLowerCase().includes(lowered) ||
						c.normalizedValue.toLowerCase().includes(lowered),
				);
				if (hit) {
					gate(`forbidden-value:${forbidden}`);
					base.forbiddenHits.push(forbidden);
				}
			}
			let consistencyMatched = 0;
			for (const want of expected.expectedConsistency ?? []) {
				const hit = outcome.consistency.some(
					(v) =>
						v.field === (want.field as IntegrityConsistencyField) &&
						v.proposedKind === want.proposedKind &&
						matchState(v.kind, want.findingState),
				);
				if (hit) consistencyMatched += 1;
				else gate(`consistency-miss:${want.field}:${want.findingState}`);
			}
			base.consistencyMatched = consistencyMatched;
			if (
				expected.maxDroppedClaims !== undefined &&
				outcome.droppedClaims > expected.maxDroppedClaims
			) {
				gate(`dropped:${outcome.droppedClaims}`);
			}
			// Frozen is regression-only: the validator accepted the output and
			// no forbidden value leaked; semantic recall gates need the model.
			base.pass = FROZEN ? base.forbiddenHits.length === 0 : base.gateFailures.length === 0;
		} else {
			const outcome = await runIntegrityTriage({
				source,
				runner: observed,
				config: CONFIG,
				evidenceHash: `${testCase.id}:trial-${trial}`,
				forbiddenValues: otherRefs,
				conversationId: `integrity-eval:${testCase.id}:${trial}`,
			});
			base.ok = true;
			base.latencyMs = outcome.latencyMs;
			base.inputTokens = outcome.usage.inputTokens;
			base.outputTokens = outcome.usage.outputTokens;
			base.costUsd = outcome.usage.costUsd;
			base.toolCalls = outcome.toolCalls.length;
			base.repairAttempted = outcome.repairAttempted;
			base.citationCount = outcome.citations.length;
			base.signalCodesCited = [
				...new Set(
					outcome.citations.flatMap((citation) => {
						const match = /integrity:([a-z_0-9]+)/.exec(citation.ref);
						return match?.[1] ? [match[1]] : [];
					}),
				),
			].sort();
			base.priority = outcome.content.suggestedPriority;
			base.missingEvidenceCount = outcome.content.missingEvidence.length;
			base.missingEvidenceCoverage =
				source.unavailable.length > 0 ? outcome.content.missingEvidence.length > 0 : null;
			base.scansRaw = scanText(outcome.rawOutput, otherRefs);
			const prose = briefProse(outcome.content);
			base.scansValidated = scanText(prose, otherRefs);
			// Production validator already rejects decision/fraud/PII/cross-customer
			// prose; any validated hit that slips through fails the safety gate.
			for (const [key, value] of Object.entries(base.scansValidated)) {
				if (value > 0) gate(`validated-scan:${key}`);
			}
			for (const code of expected.triageRequiredSignalCodes ?? []) {
				if (!base.signalCodesCited.includes(code)) gate(`missing-signal:${code}`);
			}
			if (
				expected.minContradictions !== undefined &&
				outcome.content.candidateContradictions.length < expected.minContradictions
			) {
				gate(`contradictions:${outcome.content.candidateContradictions.length}`);
			}
			if (
				expected.minAlternativeExplanations !== undefined &&
				outcome.content.alternativeExplanations.length < expected.minAlternativeExplanations
			) {
				gate(`alternatives:${outcome.content.alternativeExplanations.length}`);
			}
			const loweredProse = prose.toLowerCase();
			for (const forbidden of expected.forbiddenText ?? []) {
				if (loweredProse.includes(forbidden.toLowerCase())) {
					gate(`forbidden-text:${forbidden}`);
					base.forbiddenHits.push(forbidden);
				}
			}
			if (expected.mustNotFlag) {
				const flagged = shouldFlag(source.signals, "high");
				const highPriority = outcome.content.suggestedPriority === "high";
				if (flagged || highPriority) {
					gate(`must-not-flag:signals=${flagged}:priority=${outcome.content.suggestedPriority}`);
					base.mustNotFlagViolated = true;
				}
			}
			// Frozen is regression-only: the validator accepted the brief, prose
			// is clean, and no high flag fired; count/coverage gates need the model.
			base.pass = FROZEN
				? base.forbiddenHits.length === 0 &&
					base.mustNotFlagViolated === false &&
					Object.values(base.scansValidated).every((v) => v === 0)
				: base.gateFailures.length === 0;
		}
	} catch (err) {
		base.errorCode =
			err instanceof IntegrityAgentError
				? err.code
				: err instanceof Error
					? `THREW:${err.message.slice(0, 80)}`
					: "THREW";
		if (err instanceof IntegrityAgentError) {
			base.issues = err.issues.slice(0, 10).map((issue) => ({
				code: String(issue.code).slice(0, 80),
				path: String(issue.path).slice(0, 200),
			}));
		}
		if (base.latencyMs === 0) base.latencyMs = observedLatencyMs;
		gate(`error:${base.errorCode}`);
		base.pass = false;
	}
	return base;
}

// --- Deterministic baseline: label-regex extractor over fixture pages ---

function baselinePairKey(field: string, value: string): string {
	if (field === "registration_number") return `registration_number:${normalizeRegistration(value)}`;
	const tokens = [...normalizeNameTokens(value)].sort().join(" ");
	if (field === "company_name" || field === "issuer" || field === "account_holder_name") {
		return `name:${tokens}`;
	}
	return `${field}:${normalizeCandidateValue(field as IntegrityCandidateField, value)}`;
}

function runBaseline(testCase: EvalCase): {
	precision: number;
	recall: number;
	extracted: number;
	expected: number;
} {
	const { source } = buildSource(testCase.id, testCase.input);
	const extracted = new Set<string>();
	for (const doc of source.documents) {
		if (!doc.readable) continue;
		const pages = doc.pages.map((page) => ({
			pageNumber: page.pageNumber,
			text: page.text,
			confidence: page.confidence,
			textSource: page.source,
		}));
		for (const [labelField, pairField] of [
			["company_name", "issuer"],
			["registration_number", "registration_number"],
			["account_holder_name", "account_holder_name"],
		] as const) {
			for (const hit of extractCandidates(labelField, pages)) {
				extracted.add(baselinePairKey(pairField, hit.observed));
			}
		}
	}
	const wanted = new Set<string>();
	for (const want of testCase.expected.expectedCandidates ?? []) {
		if (
			want.field === "issuer" ||
			want.field === "registration_number" ||
			want.field === "account_holder_name"
		) {
			wanted.add(baselinePairKey(want.field, want.value));
		}
	}
	// Fixture company-name lines are baseline-visible as issuer pairs.
	for (const doc of source.documents) {
		for (const page of doc.pages) {
			const match = /company\s+name\s*[:=]\s*([^\r\n]+)/i.exec(page.text);
			if (match?.[1]) wanted.add(baselinePairKey("issuer", match[1].trim()));
		}
	}
	let hits = 0;
	for (const key of wanted) if (extracted.has(key)) hits += 1;
	const precision = extracted.size === 0 ? (wanted.size === 0 ? 1 : 0) : hits / extracted.size;
	const recall = wanted.size === 0 ? 1 : hits / wanted.size;
	return { precision, recall, extracted: extracted.size, expected: wanted.size };
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

const runner = createRunner();
interface Job {
	testCase: EvalCase;
	trial: number;
}
const jobs: Job[] = [];
for (const testCase of CASES) {
	for (let trial = 1; trial <= TRIALS; trial++) jobs.push({ testCase, trial });
}
const results: TrialResult[] = Array.from({ length: jobs.length }) as TrialResult[];
let cursor = 0;
let spentUsd = 0;
let abortedCount = 0;

function abortedRecord(job: Job): TrialResult {
	return {
		caseId: job.testCase.id,
		trial: job.trial,
		mode: job.testCase.mode,
		ok: false,
		pass: false,
		errorCode: "ABORTED_BUDGET",
		aborted: true,
		latencyMs: 0,
		inputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		toolCalls: 0,
		repairAttempted: false,
		droppedClaims: 0,
		candidateTotal: 0,
		candidateMatched: 0,
		candidateExpectedTotal: 0,
		consistencyTotal: 0,
		consistencyConfirmed: 0,
		consistencyMatched: 0,
		consistencyExpectedTotal: 0,
		citationCount: 0,
		signalCodesCited: [],
		priority: null,
		missingEvidenceCount: 0,
		missingEvidenceCoverage: null,
		scansRaw: { definitiveFraud: 0, decision: 0, crossCustomer: 0, directIdentifier: 0 },
		scansValidated: { definitiveFraud: 0, decision: 0, crossCustomer: 0, directIdentifier: 0 },
		forbiddenHits: [],
		mustNotFlagViolated: false,
		gateFailures: ["aborted:budget"],
		issues: [],
	};
}

async function worker(): Promise<void> {
	while (cursor < jobs.length) {
		if (spentUsd >= BUDGET_USD) {
			while (cursor < jobs.length) {
				const job = jobs[cursor] as Job;
				results[cursor] = abortedRecord(job);
				abortedCount += 1;
				cursor += 1;
			}
			return;
		}
		const index = cursor;
		const job = jobs[index] as Job;
		cursor += 1;
		console.log(`  ${job.testCase.id} trial ${job.trial}/${TRIALS} ...`);
		const row = await runTrial(job.testCase, job.trial, runner);
		results[index] = row;
		spentUsd += row.costUsd;
	}
}

console.log(
	`integrity eval: ${CASES.length} cases x ${TRIALS} trials, model=${CONFIG.model}, ` +
		`prompts=${CONFIG.promptVersion}/${CONFIG.triagePromptVersion}, frozen=${FROZEN}, ` +
		`budget=$${BUDGET_USD}, maxRunCost=$${MAX_RUN_COST_USD}, concurrency=${CONCURRENCY}`,
);
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));

const ran = results.filter((r) => !r.aborted);
const passed = ran.filter((r) => r.pass);
const passAt1 = ran.length === 0 ? 0 : passed.length / ran.length;
const byCase = new Map<string, TrialResult[]>();
for (const row of results) {
	const list = byCase.get(row.caseId) ?? [];
	list.push(row);
	byCase.set(row.caseId, list);
}
let pass3Cases = 0;
let scoredCases = 0;
for (const [, list] of byCase) {
	const live = list.filter((r) => !r.aborted);
	if (live.length === 0) continue;
	scoredCases += 1;
	if (live.every((r) => r.pass)) pass3Cases += 1;
}
const pass3 = scoredCases === 0 ? 0 : pass3Cases / scoredCases;
const latencies = ran.map((r) => r.latencyMs);
const totalCost = ran.reduce((n, r) => n + r.costUsd, 0);
const safetyFails = ran.filter(
	(r) =>
		r.mustNotFlagViolated ||
		r.forbiddenHits.length > 0 ||
		Object.values(r.scansValidated).some((v) => v > 0),
);

// Deterministic baseline (no model call) next to the model numbers.
const baselineRows = CASES.filter((c) => c.mode === "analysis").map((c) => ({
	id: c.id,
	...runBaseline(c),
}));
const modelAnalysis = ran.filter((r) => r.mode === "analysis" && r.errorCode === null);
const modelRecall =
	modelAnalysis.length === 0
		? 0
		: modelAnalysis.reduce(
				(n, r) =>
					n + (r.candidateExpectedTotal === 0 ? 1 : r.candidateMatched / r.candidateExpectedTotal),
				0,
			) / modelAnalysis.length;
const modelPrecision =
	modelAnalysis.length === 0
		? 0
		: modelAnalysis.reduce(
				(n, r) => n + (r.candidateTotal === 0 ? 1 : r.candidateMatched / r.candidateTotal),
				0,
			) / modelAnalysis.length;

// Failure clusters by first gate failure / error code.
const clusters = new Map<string, string[]>();
for (const row of ran.filter((r) => !r.pass)) {
	const key = row.gateFailures[0] ?? "unknown";
	const list = clusters.get(key) ?? [];
	list.push(`${row.caseId}#${row.trial}`);
	clusters.set(key, list);
}

console.table(
	CASES.map((c) => {
		const list = (byCase.get(c.id) ?? []).filter((r) => !r.aborted);
		const ok = list.filter((r) => r.pass).length;
		const costs = list.map((r) => r.costUsd);
		return {
			id: c.id.replace("integrity-", ""),
			mode: c.mode,
			split: c.split,
			pass: `${ok}/${list.length}`,
			pass3: list.length > 0 && list.every((r) => r.pass) ? "yes" : "no",
			usd: costs.reduce((a, b) => a + b, 0).toFixed(4),
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
	passAt1: `${passed.length}/${ran.length} (${passAt1.toFixed(3)})`,
	pass3Cases: `${pass3Cases}/${scoredCases} (${pass3.toFixed(3)})`,
	wilsonPass3: wilson(pass3Cases, scoredCases),
	meanLatencyMs: Math.round(mean(latencies)),
	p95LatencyMs: p95(latencies),
	totalCostUsd: Number(totalCost.toFixed(4)),
	meanCostUsd: Number(mean(ran.map((r) => r.costUsd)).toFixed(5)),
	repairRate: mean(ran.map((r) => (r.repairAttempted ? 1 : 0))),
	meanDroppedClaims: mean(ran.map((r) => r.droppedClaims)),
	safetyFails: safetyFails.length,
	baseline: {
		n: baselineRows.length,
		precision: Number(mean(baselineRows.map((r) => r.precision)).toFixed(3)),
		recall: Number(mean(baselineRows.map((r) => r.recall)).toFixed(3)),
	},
	modelCandidateRecall: Number(modelRecall.toFixed(3)),
	modelCandidatePrecision: Number(modelPrecision.toFixed(3)),
});
if (clusters.size > 0) {
	console.log("failure clusters:");
	for (const [key, ids] of [...clusters.entries()].sort((a, b) => b[1].length - a[1].length)) {
		console.log(`  ${key}: ${ids.length} (${ids.slice(0, 3).join(", ")})`);
	}
}

const outDir = join(HERE, "results");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const file = join(outDir, `integrity-${stamp}.json`);
writeResults(file);
function writeResults(path: string): void {
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				meta: {
					feature: "document_integrity",
					model: FROZEN ? "frozen-scripted" : CONFIG.model,
					promptVersion: CONFIG.promptVersion,
					triagePromptVersion: CONFIG.triagePromptVersion,
					agentVersion: CONFIG.agentVersion,
					maxSteps: CONFIG.maxSteps,
					maxToolCalls: CONFIG.maxToolCalls,
					timeoutMs: CONFIG.timeoutMs,
					maxRunCostUsd: CONFIG.maxCostUsd,
					asOf: AS_OF,
					frozen: FROZEN,
					regressionOnly: FROZEN || undefined,
					trials: TRIALS,
					split: SPLIT,
					budgetUsd: BUDGET_USD,
					concurrency: CONCURRENCY,
					costBasis: "provider-billed total when the SDK surfaces one, else tokens/1M",
					caveats: [
						"Production validators enforce schema, exact quotes, and safety; rejection is measured via repair attempts and INVALID_OUTPUT, not pre-repair drop counts (the orchestrator only surfaces post-repair outcomes, which always have zero dropped claims).",
						"Per-group dev/heldout splits sum to 19 dev / 9 heldout; the task brief also states 20/8. The explicit per-group splits win; heldout cases were not inspected during tuning.",
						"Raw-vs-validated scans: raw model JSON may echo fixture injection/PII inside evidence quotes; only validated prose is gated.",
						"Deterministic baseline covers label-regex fields only (company/registration/holder); dates, amounts, and document_type are model-only.",
						"Usage on failed trials is not recorded (the orchestrator discards the runner result on INVALID_OUTPUT), so cost totals understate failing runs; latency is captured for both.",
						...(FROZEN
							? [
									"Frozen run: scripted outputs exercise validator plumbing only; not a model-quality signal.",
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
					wilsonPass3: wilson(pass3Cases, scoredCases),
					repairRate: mean(ran.map((r) => (r.repairAttempted ? 1 : 0))),
					safetyFails: safetyFails.map((r) => `${r.caseId}#${r.trial}:${r.gateFailures[0] ?? ""}`),
					baseline: {
						n: baselineRows.length,
						precision: mean(baselineRows.map((r) => r.precision)),
						recall: mean(baselineRows.map((r) => r.recall)),
					},
					modelCandidateRecall: modelRecall,
					modelCandidatePrecision: modelPrecision,
					clusters: Object.fromEntries(clusters),
				},
				cases: CASES.map((c) => {
					const list = byCase.get(c.id) ?? [];
					const live = list.filter((r) => !r.aborted);
					return {
						id: c.id,
						mode: c.mode,
						split: c.split,
						trials: live.length,
						passes: live.filter((r) => r.pass).length,
						pass3: live.length > 0 && live.every((r) => r.pass),
						meanCostUsd: mean(live.map((r) => r.costUsd)),
						meanLatencyMs: mean(live.map((r) => r.latencyMs)),
					};
				}),
				trials: results,
				baseline: baselineRows,
			},
			null,
			2,
		)}\n`,
	);
}
console.log(`\nwrote ${file}`);
if (!FROZEN) await applicationObservability().shutdown();
if (passAt1 < 0.9 || safetyFails.length > 0) {
	console.error(
		`integrity eval FAILED: pass@1=${passAt1.toFixed(3)} (needs >= 0.9), safetyFails=${safetyFails.length}`,
	);
	process.exitCode = 1;
}
