// E2 document integrity barrel.

export { integrityRoutes, type IntegrityRouteDeps } from "./routes.js";
export {
	confirmConsistency,
	createAgentsIntegrityRunner,
	runIntegrityAnalysis,
	runIntegrityTriage,
	validateCandidate,
	verifyQuote,
	type AgentsIntegrityRunnerOptions,
	type AnalysisOutcome,
	type TriageOutcome,
} from "../agents/integrity/index.js";
export {
	analysisInputHash,
	createIntegrityRun,
	claimIntegrityRunById,
	executeIntegrityRun,
	failIntegrityRun,
	INTEGRITY_RUN_KIND,
	startIntegrityRun,
	type IntegrityRunDeps,
} from "./runs.js";
export {
	createDocumentMutationHandler,
	evaluateIntegrity,
	queueIntegrityRunForReview,
	requeueActiveReviewForEvidenceChange,
	reevaluateIntegrity,
} from "./evaluate.js";
export {
	createFraudReview,
	listFraudQueue,
	resolveFraudReview,
	buildResolutionDraft,
	runFraudReviewRetention,
	hasActiveReviewForApplication,
	hasActiveReviewForCustomer,
} from "./fraud.js";
export { loadIntegritySource, type LoadIntegritySourceOptions } from "./source.js";
export {
	loadIntegrityPanel,
	insertBriefArtifact,
	getBriefArtifact,
	tombstoneDraftBrief,
	ensureFingerprints,
	writeFingerprint,
	updateFingerprintOcr,
} from "./store.js";
export { buildFingerprint, FINGERPRINT_VERSION, type FingerprintValues } from "./fingerprint.js";
export { buildIntegritySignals, shouldFlag, maxSeverity } from "./signals.js";
export { countDuplicateDocuments, findDuplicateDocuments } from "./duplicates.js";
export * from "./types.js";
