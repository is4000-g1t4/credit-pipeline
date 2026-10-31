// Shared plumbing for the read-only context tools (agent-private): the
// run state, the call budget, and the signed GET helper. Every tool file in
// ./tools receives one `ToolContext`; `applicationId` is bound here, never a
// model-supplied arg.
import { signInternalHeaders } from "@credit/service-kit";
import { z } from "zod";
import type { ResearchEnv } from "../../env.js";

export class ContextToolError extends Error {}

/** Parameters of every no-argument tool. */
export const emptyParams = z.object({}).strict();

export interface CandidateSnapshot {
	localId: string;
	type: string;
	periodStart: string;
	periodEnd: string;
	metric: string;
	observed: number | null;
	expected: number | null;
	confidence: "low" | "medium" | "high";
	status: "review" | "needs_chase" | "insufficient_data";
	policyVersion: string;
	accountScope: string;
	evidenceIds: string[];
}

export interface ContextToolState {
	snapshots: CandidateSnapshot[];
	/** Evidence id → kinds seen across tool results. */
	seenEvidence: Map<string, Set<string>>;
	toolCalls: number;
}

export interface ToolDeps {
	env: ResearchEnv;
	applicationId: string;
	caseFacts: Record<string, unknown>;
	externalSummary: unknown;
	/** Preflight HTTP allowance (CONTEXT_AGENT_PREFLIGHT_TOOL_CALLS). Model
	 * invocations are capped separately in the runner; model-phase HTTP
	 * rides `modelHttpBackstop` and never consumes this pool. */
	maxCalls: number;
	/** Total-HTTP backstop once the model phase begins (generous: each
	 * model invocation spends ≤2 HTTP calls). Unset means unbounded. */
	modelHttpBackstop?: number;
	/** YYYY-MM-DD observation end; bounds the loans read. Falls back to
	 * caseFacts.asOf when absent. */
	asOfDate?: string;
	fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface ToolContext {
	deps: ToolDeps;
	state: ContextToolState & { modelPhase: boolean };
	/** Memoised cashflow metric reads, keyed by the sorted account scope. */
	metricsCache: Map<string, unknown>;
	/** Records an evidence id the model-visible results exposed. */
	seen(id: string, kind: string): void;
	/** Counts one call against the active budget; throws past the limit. */
	budget(): void;
	/** Signed GET against another service (counts against the budget). */
	getFrom(baseUrl: string, path: string): Promise<unknown>;
	/** Signed GET against the applications service. */
	get(path: string): Promise<unknown>;
}

export function createToolContext(deps: ToolDeps): ToolContext {
	const state: ToolContext["state"] = {
		snapshots: [],
		seenEvidence: new Map(),
		toolCalls: 0,
		modelPhase: false,
	};
	const seen = (id: string, kind: string): void => {
		const kinds = state.seenEvidence.get(id) ?? new Set<string>();
		kinds.add(kind);
		state.seenEvidence.set(id, kinds);
	};

	const budget = (): void => {
		state.toolCalls += 1;
		// Preflight HTTP counts against the preflight allowance. In the model
		// phase invocations are capped by the runner, so HTTP rides the
		// generous backstop only — a 2-call screen like getLoans cannot
		// exhaust the preflight pool.
		const limit = state.modelPhase ? (deps.modelHttpBackstop ?? Infinity) : deps.maxCalls;
		if (state.toolCalls > limit) throw new ContextToolError("tool budget exceeded");
	};

	const getFrom = async (baseUrl: string, path: string): Promise<unknown> => {
		budget();
		// The service HMAC signs the pathname only (`requireInternal`
		// verifies `c.req.path`, no query string) — the query rides the URL.
		const queryAt = path.indexOf("?");
		const signPath = queryAt < 0 ? path : path.slice(0, queryAt);
		const headers = signInternalHeaders(deps.env.internalSecret, {
			userId: deps.env.autoTriggerServiceUserId,
			role: "service",
			email: deps.env.autoTriggerServiceEmail,
			method: "GET",
			path: signPath,
		});
		const fetchImpl = deps.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
		let res: Response;
		try {
			// Bounded per call; the stage deadline owns the overall budget.
			res = await fetchImpl(`${baseUrl}${path}`, {
				headers,
				signal: AbortSignal.timeout(10_000),
			});
		} catch (err) {
			throw new ContextToolError(
				`context tool unreachable: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (!res.ok) {
			throw new ContextToolError(`context tool returned ${res.status}`, { cause: undefined });
		}
		try {
			return (await res.json()) as unknown;
		} catch {
			throw new ContextToolError("context tool returned invalid JSON");
		}
	};

	return {
		deps,
		state,
		metricsCache: new Map(),
		seen,
		budget,
		getFrom,
		get: (path) => getFrom(deps.env.applicationsUrl, path),
	};
}

/** One model-callable context tool: its schema plus the data read it runs. */
export interface ContextToolSpec<Args = never> {
	/** Allowlisted tool name (see CONTEXT_TOOL_NAMES). */
	name: string;
	description: string;
	parameters: z.ZodType;
	/** The read itself: budget-counted, shape-checked, evidence-recording. */
	run(ctx: ToolContext, args: Args): unknown;
	/** Optional model-facing projection of `run`'s result (cost control). */
	view?(result: unknown): unknown;
}
