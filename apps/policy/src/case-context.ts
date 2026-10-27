// Compatibility surface: the case-context contract lives in @credit/core
// (single source of truth with research and applications).
export {
	POLICY_SIGNAL_TYPES,
	POLICY_SIGNAL_METRICS,
	POLICY_DOCUMENT_FIELDS,
	POLICY_DOCUMENT_STATUSES,
	policyCaseContextSchema,
	signalRef,
	documentRef,
	isMetricPairAllowed,
	type PolicySignalType,
	type PolicySignalMetric,
	type PolicyCaseContext,
	type PolicyCaseSignal,
} from "@credit/core";
