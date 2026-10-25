// E2 document integrity barrel.

export { integrityRoutes, type IntegrityRouteDeps } from "./routes.js";
export { createAgentsIntegrityRunner, type AgentsIntegrityRunnerOptions } from "./agent-sdk.js";
export {
	runIntegrityAnalysis,
	runIntegrityTriage,
	type AnalysisOutcome,
	type TriageOutcome,
} from "./agent.js";
export {
	analysisInputHash,
	triageInputHash,
	createIntegrityRun,
	enqueueTriageRun,
	drainIntegrityRuns,
	drainIntegrityRunsSafely,
	startIntegrityWorker,
	type IntegrityRunDeps,
} from "./runs.js";
export { evaluateIntegrity, queueTriageForReview, reevaluateIntegrity } from "./evaluate.js";
export {
	createFraudReview,
	listFraudQueue,
	resolveFraudReview,
	assignFraudReview,
	grantFraudReviewer,
	revokeFraudReviewer,
	buildResolutionDraft,
	runFraudReviewRetention,
	isFraudReviewer,
	hasActiveReviewForApplication,
	hasActiveReviewForCustomer,
	activeDocumentHolds,
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
export { verifyQuote, validateCandidate, confirmConsistency } from "./validators.js";
export { countDuplicateDocuments, findDuplicateDocuments } from "./duplicates.js";
export * from "./types.js";
