// Shared agent-trace renderer: metadata only — never prompts or
// chain-of-thought. One component for the memo, policy-exception, and
// integrity panels; each caller passes only the fields it already showed,
// so labels/order stay identical per panel.
import { clean, shortId } from "../lib/format";
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

export function TraceDetails({
	trace,
	title = "Trace (metadata)",
}: {
	trace: TraceFacts | null | undefined;
	title?: string;
}) {
	if (!trace) return null;
	return (
		<details className="mt-3 rounded border border-rule p-3">
			<summary className="cursor-pointer text-sm font-semibold">{title}</summary>
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
			{(trace.toolCalls?.length ?? 0) > 0 && (
				<table className="mt-2 w-full text-xs">
					<thead>
						<tr className="text-left text-slate">
							<th className="py-1 pr-2 font-medium">Step</th>
							<th className="py-1 pr-2 font-medium">Tool</th>
							<th className="py-1 pr-2 font-medium">Results</th>
							<th className="py-1 font-medium">Source types</th>
						</tr>
					</thead>
					<tbody>
						{(trace.toolCalls ?? []).map((call, i) => (
							<tr key={`${call.step}-${call.name}-${i}`} className="border-t border-rule">
								<td className="py-1 pr-2 tabular-nums">{call.step}</td>
								<td className="py-1 pr-2 font-mono">{clean(call.name)}</td>
								<td className="py-1 pr-2 tabular-nums">{call.resultCount}</td>
								<td className="py-1 text-slate">{clean(call.sourceTypes.join(", ")) || "-"}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</details>
	);
}
