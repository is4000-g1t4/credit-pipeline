import { z } from "zod";
import type { IntegritySource } from "../../../integrity/types.js";
import { MAX_REFS_PER_CALL, type ToolOutcome } from "./shared.js";

export const name = "list_signals" as const;

export const description =
	"List deterministic integrity signals, severities, and unavailable sources.";

export const listSignalsParams = z.object({}).strict();

export function runListSignals(source: IntegritySource): ToolOutcome {
	return {
		payload: {
			signals: source.signals.map((signal) => ({
				code: signal.code,
				severity: signal.severity,
				documentFileId: signal.documentFileId,
				summary: signal.summary,
				count: signal.count,
				sourceRef: signal.sourceRef,
			})),
			unavailable: source.unavailable.slice(0, 20),
		},
		resultCount: source.signals.length,
		sourceTypes: ["context_signal"],
		refs: source.signals.slice(0, MAX_REFS_PER_CALL).map((signal) => signal.sourceRef),
	};
}
