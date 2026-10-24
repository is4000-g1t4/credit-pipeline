// Human review (SPEC FR-6.2, FR-7): STATELESS. Queue + decision state live
// in the applications service (signed internal API); the officer decision
// itself travels via the Temporal update. This service validates, replays a
// terminal decision on matching requestId (fetching the loan id from the
// loans service when needed), and otherwise awaits the update.
//
// Officer enforcement happens inside the service (the gateway only proves
// identity): applicants get 403, unsigned requests never reach here (401).
import {
	officerDecisionSchema,
	researchBundleSchema,
	caseFactsSchema,
	type ResearchBundle,
} from "@credit/core";
import {
	GatewayError,
	HttpError,
	internalFetch,
	readJson,
	requireOfficer,
	type ServiceApp,
	type ServiceVariables,
	type WorkflowGateway,
	zodFields,
} from "@credit/service-kit";
import { Hono } from "hono";
import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const viewSchema = z.object({ runId: z.uuid() }).strict();

const findingReviewSchema = z
	.object({
		action: z.enum(["accepted", "rejected"]),
		note: z.string().max(1000).optional(),
	})
	.strict();

export interface ReviewRouteDeps {
	gateway: WorkflowGateway;
	applicationsUrl: string;
	loansUrl: string;
	/** Research service base URL. */
	researchUrl: string;
	/** Gates the officer research routes (SPEC §10). */
	agentsEnabled: boolean;
	caseBriefEnabled: boolean;
	internalSecret: string;
	fetchImpl?: typeof fetch;
}

/**
 * Phase 2 research selection (SPEC §3.5): the public decision carries only
 * `agentRunId` + `acceptedFindingIds`. Review resolves them to the
 * app-scoped frozen bundle and forwards it as internal `research`.
 */
export interface ResearchDecisionSelection {
	agentRunId: string;
	acceptedFindingIds: string[];
}

interface DecisionProbe {
	status: string;
	decision: { id: string; outcome: string; requestId: string | null } | null;
}

export function reviewRoutes(deps: ReviewRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { gateway, applicationsUrl, loansUrl, researchUrl, internalSecret, fetchImpl } = deps;

	// Phase 2 gate (SPEC §10): applicants already 403 above; officer routes
	// below 404 while the feature is disabled.
	const requireResearch = (): void => {
		if (!deps.agentsEnabled || !deps.caseBriefEnabled) {
			throw new HttpError(404, "RESEARCH_DISABLED", "agentic research is disabled");
		}
	};

	const get = async (
		baseUrl: string,
		path: string,
		user: ServiceVariables["user"],
	): Promise<Response> => internalFetch(baseUrl, path, user, { secret: internalSecret, fetchImpl });

	const post = async (
		baseUrl: string,
		path: string,
		user: ServiceVariables["user"],
		body: unknown,
	): Promise<Response> =>
		internalFetch(baseUrl, path, user, { method: "POST", body, secret: internalSecret, fetchImpl });

	app.get("/api/review/queue", requireOfficer, async (c) => {
		const res = await get(applicationsUrl, "/internal/review/queue", c.var.user);
		if (!res.ok) throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
		return c.json(await res.json());
	});

	app.post("/api/review/:id/decision", requireOfficer, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = officerDecisionSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(422, "VALIDATION_ERROR", "invalid decision", zodFields(parsed.error));
		}
		const input = parsed.data;
		// Terminal replay first (FR-6.2): same requestId → original 200,
		// different id → 409. Only then send the update.
		const probeRes = await get(applicationsUrl, `/internal/applications/${id}/decision`, me);
		if (probeRes.status === 404) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!probeRes.ok) throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
		const probe = (await probeRes.json()) as DecisionProbe;
		if (probe.decision) {
			if (probe.decision.requestId === input.requestId) {
				// A declined replay is terminal as-is. An approved replay is
				// only terminal once the loan exists: no loan yet means the
				// booking saga is still converging (reconciler retries), so
				// 409 and let the officer retry rather than report booked.
				if (probe.decision.outcome !== "approved") {
					return c.json({
						outcome: "declined",
						decisionId: probe.decision.id,
						loanId: null,
					});
				}
				const loanRes = await get(loansUrl, `/internal/loans/by-application/${id}`, me);
				if (loanRes.ok) {
					return c.json({
						outcome: "booked",
						decisionId: probe.decision.id,
						loanId: ((await loanRes.json()) as { loan: { id: string } }).loan.id,
					});
				}
				if (loanRes.status !== 404) {
					throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
				}
				throw new HttpError(409, "BOOKING_INCOMPLETE", "booking is still converging; retry");
			}
			throw new HttpError(409, "DECISION_CONFLICT", "case was already decided");
		}
		if (probe.status !== "pending_review") {
			throw new HttpError(409, "CASE_NOT_PENDING", "case is not awaiting an officer decision");
		}
		// Phase 2 frozen bundle (SPEC §2.1.7): the public payload carries
		// only the selection (`agentRunId` + `acceptedFindingIds` — never a
		// client-built bundle). Resolve it server-side to the app-scoped
		// frozen bundle and forward that as internal `research`, stripping
		// the selection. Ordinary decisions skip this entirely. A bundle
		// failure never blocks deciding without research (503 + decide-
		// without path); replay above already returned, so this runs only
		// for undecided cases.
		let research: ResearchBundle | undefined;
		if (input.agentRunId !== undefined || input.acceptedFindingIds !== undefined) {
			// Phase 2 gate first: a selection while disabled is 404 without
			// touching the research service. Ordinary decisions skip this.
			requireResearch();
			research = await resolveResearchBundle(me, id, {
				agentRunId: input.agentRunId ?? "",
				acceptedFindingIds: input.acceptedFindingIds ?? [],
			});
		}
		try {
			const result = await gateway.sendOfficerDecision(id, {
				requestId: input.requestId,
				outcome: input.outcome,
				...(input.approvedAmountCents !== undefined
					? { approvedAmountCents: input.approvedAmountCents }
					: {}),
				...(input.termMonths !== undefined ? { termMonths: input.termMonths } : {}),
				...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
				...(input.notes !== undefined ? { notes: input.notes } : {}),
				...(research !== undefined ? { research } : {}),
				officerUserId: me.id,
			});
			return c.json(result);
		} catch (err) {
			if (err instanceof GatewayError) {
				throw new HttpError(err.status, err.code, err.message);
			}
			throw err;
		}
	});

	async function resolveResearchBundle(
		me: ServiceVariables["user"],
		applicationId: string,
		selection: ResearchDecisionSelection,
	): Promise<ResearchBundle> {
		// The officer identity signs the bundle fetch (SPEC §5: app-scoped).
		// Failure mapping is precise so the officer always has a next step:
		// transport/5xx → 503 retryable; 404 (run missing, cross-app, or not
		// succeeded) and upstream 409 (stale/empty) → 409 non-retryable;
		// schema/selection mismatch → 422/409, never an endless 503.
		let res: Response;
		try {
			res = await get(
				researchUrl,
				`/internal/research/applications/${applicationId}/runs/${selection.agentRunId}/bundle`,
				me,
			);
		} catch {
			throw researchUnavailable();
		}
		if (res.status === 404)
			throw researchSelectionStale("research run is not available for decision");
		if (!res.ok && res.status !== 409) throw researchUnavailable();
		let data: unknown = null;
		try {
			data = await readUpstream(res);
		} catch (err) {
			// Upstream 409 carries the stale reason; anything else is retryable.
			if (res.status === 409 && err instanceof HttpError) {
				throw researchSelectionStale(
					err.code === "BAD_GATEWAY" ? "research selection is stale" : err.message,
				);
			}
			throw researchUnavailable();
		}
		const parsed = researchBundleSchema.safeParse((data as { bundle?: unknown })?.bundle);
		if (!parsed.success) {
			// An empty accepted list fails the min(1) shape: that is stale
			// (all findings re-reviewed away), not a validation surprise.
			const maybeAccepted = (data as { bundle?: { acceptedFindings?: unknown } })?.bundle
				?.acceptedFindings;
			if (Array.isArray(maybeAccepted) && maybeAccepted.length === 0) {
				throw researchSelectionStale("no accepted findings remain on this run");
			}
			throw new HttpError(422, "VALIDATION_ERROR", "research bundle failed validation");
		}
		const bundle = parsed.data;
		if (bundle.applicationId !== applicationId || bundle.agentRunId !== selection.agentRunId) {
			throw researchSelectionStale("research selection does not match the frozen bundle");
		}
		const accepted = new Set(bundle.acceptedFindings.map((f) => f.findingId));
		if (!selection.acceptedFindingIds.every((f) => accepted.has(f))) {
			throw researchSelectionStale("research selection does not match the frozen bundle");
		}
		// §8.6: freeze exactly the used research — narrow the forwarded
		// bundle to the accepted selection, never the whole accepted list.
		const wanted = new Set(selection.acceptedFindingIds);
		return {
			...bundle,
			acceptedFindings: bundle.acceptedFindings.filter((f) => wanted.has(f.findingId)),
		};
	}

	// Phase 2 research routes (SPEC §5): officer-only, gated, advisory.
	// Applicants 403 in the `officer` middleware before any other check;
	// officer + disabled flag 404s; consent 403s; non-pending 409s.

	app.post("/api/review/:id/research", requireOfficer, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		requireResearch();
		// Officer-signed case facts; the applications service allowlists the
		// fields (no DOB/ID/address/bureau/docs/purpose).
		const factsRes = await get(applicationsUrl, `/internal/applications/${id}/case-facts`, me);
		if (factsRes.status === 404) throw new HttpError(404, "NOT_FOUND", "not found");
		// Single core schema, fail-closed: unknown keys (PII beyond the
		// allowlist) reject the request instead of travelling to research.
		const factsParsed = caseFactsSchema.safeParse(await readUpstream(factsRes));
		if (!factsParsed.success) {
			throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
		}
		const caseFacts = factsParsed.data;
		if (caseFacts.applicationId !== id) {
			throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
		}
		if (caseFacts.aiResearchConsent !== true) {
			throw new HttpError(403, "CONSENT_REQUIRED", "AI research consent is required");
		}
		if (caseFacts.status !== "pending_review") {
			throw new HttpError(409, "CASE_NOT_PENDING", "case is not awaiting an officer decision");
		}
		const ensureRes = await post(researchUrl, "/internal/research/runs/ensure", me, {
			applicationId: id,
			caseFacts,
			aiResearchConsent: true,
		});
		const ensured = (await readUpstream(ensureRes)) as {
			run: { id: string; status: string };
		};
		return c.json({ runId: ensured.run.id, status: ensured.run.status }, 202);
	});

	app.get("/api/review/:id/research", requireOfficer, async (c) => {
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		requireResearch();
		// Latest full aggregate; never records a view (SPEC §2.1.5).
		const res = await get(researchUrl, `/internal/research/applications/${id}/latest`, c.var.user);
		return c.json(await readUpstream(res));
	});

	// T11 auto-trigger audit (SPEC §5): officer-only, gated, app-scoped.
	// Proxies the research internal auto-audit so skip reasons (consent
	// off, not pending, caps/budget) stay visible when no run exists. No
	// consent/status gate here by design: gating on those would hide the
	// very skips this endpoint exists to surface. Case existence is
	// checked (404 for unknown cases, no orphan grant); cross-officer
	// reads 404 via the research claim, passed through untouched.
	app.get("/api/review/:id/research/audit", requireOfficer, async (c) => {
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		requireResearch();
		const probe = await get(applicationsUrl, `/internal/applications/${id}/decision`, c.var.user);
		if (probe.status === 404) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!probe.ok) throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
		const res = await get(researchUrl, `/internal/research/applications/${id}/audit`, c.var.user);
		return c.json(await readUpstream(res));
	});

	app.post("/api/review/:id/research/view", requireOfficer, async (c) => {
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		requireResearch();
		const parsed = viewSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(422, "VALIDATION_ERROR", "invalid view request", zodFields(parsed.error));
		}
		const res = await post(
			researchUrl,
			`/internal/research/applications/${id}/runs/${parsed.data.runId}/view`,
			c.var.user,
			{},
		);
		return c.json(await readUpstream(res));
	});

	app.post("/api/review/:id/research/findings/:findingId", requireOfficer, async (c) => {
		const id = c.req.param("id");
		const findingId = c.req.param("findingId");
		if (!UUID_RE.test(id) || !UUID_RE.test(findingId)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		requireResearch();
		const parsed = findingReviewSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(422, "VALIDATION_ERROR", "invalid review", zodFields(parsed.error));
		}
		const res = await post(
			researchUrl,
			`/internal/research/applications/${id}/findings/${findingId}/review`,
			c.var.user,
			parsed.data,
		);
		// 201 created; 404 on run/application mismatch; 409 unless succeeded.
		return c.json(await readUpstream(res), 201);
	});

	// T18 context proxies (SPEC-t17-t18 §3.5/§3.6, D4): officer-only, gated
	// like every other research route. Retry resolves the latest run first
	// (the research retry is run-scoped) and forwards its 202 — the stage
	// runs in the background, so this never waits on a model call. Signal
	// review appends and returns the updated signal (201).
	app.post("/api/review/:id/research/context/retry", requireOfficer, async (c) => {
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		requireResearch();
		// Latest 404s (no run, cross-officer) pass through untouched — the
		// same non-disclosure as a direct research read.
		const latest = (await readUpstream(
			await get(researchUrl, `/internal/research/applications/${id}/latest`, c.var.user),
		)) as { run?: { id?: unknown } };
		const runId = latest?.run?.id;
		if (typeof runId !== "string" || !UUID_RE.test(runId)) {
			throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
		}
		const res = await post(
			researchUrl,
			`/internal/research/applications/${id}/runs/${runId}/context/retry`,
			c.var.user,
			{},
		);
		// 202 claimed (stage token/version — poll latest); 409 unless the
		// run is terminal with a failed/skipped stage and a retry left.
		return c.json(await readUpstream(res), 202);
	});

	app.post(
		"/api/review/:id/research/context/signals/:signalId/review",
		requireOfficer,
		async (c) => {
			const id = c.req.param("id");
			const signalId = c.req.param("signalId");
			if (!UUID_RE.test(id) || !UUID_RE.test(signalId)) {
				throw new HttpError(404, "NOT_FOUND", "not found");
			}
			requireResearch();
			const parsed = findingReviewSchema.safeParse(await readJson(c));
			if (!parsed.success) {
				throw new HttpError(422, "VALIDATION_ERROR", "invalid review", zodFields(parsed.error));
			}
			const res = await post(
				researchUrl,
				`/internal/research/applications/${id}/context/signals/${signalId}/review`,
				c.var.user,
				parsed.data,
			);
			// 201 with the updated signal; 404 on signal/run/application
			// mismatch; 409 on a superseded signal.
			return c.json(await readUpstream(res), 201);
		},
	);

	return app;
}

/** Parse an upstream JSON body; non-2xx rethrows with its status/code. */
async function readUpstream(res: Response): Promise<unknown> {
	let data: unknown = null;
	try {
		data = await res.json();
	} catch {
		throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
	}
	if (!res.ok) {
		const err = (data as { error?: { code?: string; message?: string } })?.error;
		throw new HttpError(
			res.status,
			err?.code ?? "BAD_GATEWAY",
			err?.message ?? "upstream service unavailable",
		);
	}
	return data;
}

function researchUnavailable(): HttpError {
	return new HttpError(
		503,
		"RESEARCH_UNAVAILABLE",
		"research is temporarily unavailable; retry or decide without research",
		{ retryable: ["true"] },
	);
}

/** Non-retryable: the selection no longer resolves (reaped run, rejected
 * findings, cross-app). The officer re-reviews or decides without research. */
function researchSelectionStale(message: string): HttpError {
	return new HttpError(409, "RESEARCH_SELECTION_STALE", message);
}
