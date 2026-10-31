// get_cashflow_metrics: the deterministic candidate snapshot. Registers
// each candidate (localId c1..cN) and its evidence ids on the run state;
// the validator anchors on these. The model tool exposes no args and always
// calls with {}; `accountIds` stays for server-side scoping and tests.
import { isUuid } from "../../../ids.js";
import {
	ContextToolError,
	emptyParams,
	type CandidateSnapshot,
	type ContextToolSpec,
	type ToolContext,
} from "../tool-context.js";

function numNull(v: unknown): number | null {
	return typeof v === "number" ? v : null;
}

function strArr(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

export const getCashflowMetrics = {
	name: "get_cashflow_metrics",
	description: "The prefetched deterministic candidate snapshot with baselines and evidence ids.",
	parameters: emptyParams,
	async run(ctx: ToolContext, input: { accountIds?: string[] }): Promise<unknown> {
		const { state } = ctx;
		const ids = input.accountIds ?? [];
		if (!Array.isArray(ids) || ids.length > 10 || ids.some((id) => !isUuid(id))) {
			throw new ContextToolError("invalid accountIds: at most 10 UUIDs");
		}
		const cacheKey = [...ids].sort().join(",");
		const cached = ctx.metricsCache.get(cacheKey);
		if (cached !== undefined) return cached;
		const q = ids.length > 0 ? `?accountIds=${ids.map(encodeURIComponent).join(",")}` : "";
		const body = (await ctx.get(
			`/internal/applications/${ctx.deps.applicationId}/context/metrics${q}`,
		)) as { signals?: Array<Record<string, unknown>>; policyVersion?: unknown };
		if (!body || !Array.isArray(body.signals)) {
			throw new ContextToolError("metrics shape drift");
		}
		const signals = body.signals.map((s, i) => {
			const snap: CandidateSnapshot = {
				localId: `c${state.snapshots.length + i + 1}`,
				type: typeof s["type"] === "string" ? (s["type"] as string) : "",
				periodStart: typeof s["periodStart"] === "string" ? (s["periodStart"] as string) : "",
				periodEnd: typeof s["periodEnd"] === "string" ? (s["periodEnd"] as string) : "",
				metric: typeof s["metric"] === "string" ? (s["metric"] as string) : "",
				observed: numNull(s["observed"]),
				expected: numNull(s["expected"]),
				confidence:
					s["confidence"] === "low" || s["confidence"] === "medium" || s["confidence"] === "high"
						? s["confidence"]
						: "low",
				status:
					s["status"] === "review" ||
					s["status"] === "needs_chase" ||
					s["status"] === "insufficient_data"
						? s["status"]
						: "needs_chase",
				policyVersion: typeof s["policyVersion"] === "string" ? (s["policyVersion"] as string) : "",
				accountScope: typeof s["accountScope"] === "string" ? (s["accountScope"] as string) : "",
				evidenceIds: strArr(
					Array.isArray(s["evidence"])
						? (s["evidence"] as Array<Record<string, unknown>>).map((e) => e["id"])
						: [],
				),
			};
			return snap;
		});
		for (const snap of signals) {
			state.snapshots.push(snap);
			ctx.seen(snap.localId, "metric");
			for (const id of snap.evidenceIds) ctx.seen(id, "transaction");
		}
		const result = {
			policyVersion: body.policyVersion ?? null,
			signals: signals.map((s) => ({
				...s,
				evidence: s.evidenceIds.map((id) => ({ kind: "transaction", id })),
			})),
		};
		ctx.metricsCache.set(cacheKey, result);
		return result;
	},
} satisfies ContextToolSpec<{ accountIds?: string[] }>;
