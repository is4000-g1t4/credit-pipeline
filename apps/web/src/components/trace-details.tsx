// Shared agent trace: the same tool timeline used by the case assistant,
// followed by compact run metadata. Metadata only — never prompts or
// chain-of-thought.
import { toTraceEntries } from "../lib/api";
import { clean, shortId } from "../lib/format";
import { ToolActivity } from "./tool-activity";
import { StatusBadge } from "./ui";

export interface TraceFacts {
	model?: string;
	promptVersion?: string;
	agentVersion?: string;
	registryVersion?: string | null;
	registryHash?: string | null;
	validatorVersion?: string | null;
	steps?: number | null;
	toolCalls?: Array<{ step: number; name: string; resultCount: number; sourceTypes: string[] }>;
	sourceRefs?: string[];
	repairAttempted?: boolean;
	repairSucceeded?: boolean | null;
	inputTokens?: number;
	outputTokens?: number;
	latencyMs?: number;
	costUsd?: number;
	/** Memo-only: deterministic/agent writer + evidence hash + fallback. */
	writer?: string;
	evidenceHash?: string | null;
	fallbackReason?: string | null;
	/** Integrity-only: run id/status row + error code. */
	runId?: string;
	runStatus?: string;
	errorCode?: string | null;
}

export function TraceDetails({ trace }: { trace: TraceFacts | null | undefined }) {
	if (!trace) return null;
	return (
		<div>
			<ToolActivity entries={toTraceEntries(trace.toolCalls ?? [])} />
			<dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-slate sm:grid-cols-2">
				{trace.runId !== undefined && (
					<div>
						<dt className="inline font-medium">Run: </dt>
						<dd className="inline font-mono">{shortId(trace.runId)}</dd>
					</div>
				)}
				{trace.runStatus !== undefined && (
					<div>
						<dt className="inline font-medium">Status: </dt>
						<dd className="inline">
							<StatusBadge status={trace.runStatus} />
						</dd>
					</div>
				)}
				{trace.writer !== undefined && (
					<div>
						<dt className="inline font-medium">Writer: </dt>
						<dd className="inline font-mono">{clean(trace.writer)}</dd>
					</div>
				)}
				{trace.model !== undefined && (
					<div>
						<dt className="inline font-medium">Model: </dt>
						<dd className="inline font-mono">{clean(trace.model)}</dd>
					</div>
				)}
				{trace.promptVersion !== undefined && (
					<div>
						<dt className="inline font-medium">Prompt: </dt>
						<dd className="inline font-mono">{clean(trace.promptVersion)}</dd>
					</div>
				)}
				{trace.agentVersion !== undefined && (
					<div>
						<dt className="inline font-medium">Agent: </dt>
						<dd className="inline font-mono">{clean(trace.agentVersion)}</dd>
					</div>
				)}
				{trace.registryVersion !== undefined && (
					<div>
						<dt className="inline font-medium">Registry: </dt>
						<dd className="inline font-mono">
							{trace.registryVersion === null ? "-" : clean(trace.registryVersion)}
						</dd>
					</div>
				)}
				{trace.validatorVersion !== undefined && (
					<div>
						<dt className="inline font-medium">Validator: </dt>
						<dd className="inline font-mono">
							{trace.validatorVersion === null ? "-" : clean(trace.validatorVersion)}
						</dd>
					</div>
				)}
				{trace.evidenceHash !== undefined && trace.evidenceHash !== null && (
					<div>
						<dt className="inline font-medium">Evidence: </dt>
						<dd className="inline font-mono" title={trace.evidenceHash}>
							{trace.evidenceHash.slice(0, 12)}…
						</dd>
					</div>
				)}
				{trace.steps !== undefined && (
					<div>
						<dt className="inline font-medium">Steps: </dt>
						<dd className="inline tabular-nums">
							{trace.steps ?? "—"} · {(trace.toolCalls ?? []).length} tool call
							{(trace.toolCalls ?? []).length === 1 ? "" : "s"} · {(trace.sourceRefs ?? []).length}{" "}
							source
							{(trace.sourceRefs ?? []).length === 1 ? "" : "s"}
						</dd>
					</div>
				)}
				{trace.repairAttempted !== undefined && (
					<div>
						<dt className="inline font-medium">Repair: </dt>
						<dd className="inline">
							{trace.repairAttempted
								? trace.repairSucceeded === true
									? "attempted, succeeded"
									: "attempted, failed"
								: "not needed"}
							{trace.fallbackReason ? ` (${trace.fallbackReason})` : ""}
						</dd>
					</div>
				)}
				{(trace.inputTokens !== undefined ||
					trace.latencyMs !== undefined ||
					trace.costUsd !== undefined) && (
					<div>
						<dt className="inline font-medium">Usage: </dt>
						<dd className="inline tabular-nums">
							{trace.inputTokens ?? "—"} in / {trace.outputTokens ?? "—"} out
							{trace.latencyMs !== undefined ? ` · ${trace.latencyMs}ms` : ""}
							{trace.costUsd !== undefined ? ` · $${trace.costUsd.toFixed(4)}` : ""}
						</dd>
					</div>
				)}
				{trace.errorCode !== undefined && trace.errorCode !== null && trace.errorCode !== "" && (
					<div>
						<dt className="inline font-medium">Error: </dt>
						<dd className="inline font-mono">{clean(trace.errorCode)}</dd>
					</div>
				)}
			</dl>
		</div>
	);
}
