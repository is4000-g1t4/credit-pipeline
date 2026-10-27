// applicationWorkflow (SPEC FR-6.1/6.2): load+processing → verification +
// data in parallel → check-only decline precedence → data failure →
// score+policy → decline | auto book | refer (officer update or 72h expiry).
// I/O only in activities; Date.now()/condition for time; every error funnels
// through markFailed then rethrows. Core imports come from @credit/core/workflow
// (the Node-builtin-free barrel — the bundler rejects node:crypto).

import {
	type CheckReasonCode,
	DSCR_DECLINE_MIN_X100,
	DTI_DECLINE_MAX_PCT_X100,
	dscrGte,
	dtiLte,
	internalOfficerDecisionSchema,
	monthlyPaymentCents,
	OFFICER_DECISION_UPDATE,
	PERSONAL_MIN_CENTS,
	rateBps,
	SME_MIN_CENTS,
	TERM_MAX_MONTHS,
	TERM_MIN_MONTHS,
} from "@credit/core/workflow";
import {
	ApplicationFailure,
	condition,
	defineUpdate,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type {
	Activities,
	ApplicationWorkflowInput,
	ApplicationWorkflowResult,
	OfficerDecisionInput,
	OfficerDecisionResult,
	ScoringSummary,
} from "../activities/types.js";

export const officerDecisionUpdate = defineUpdate<OfficerDecisionResult, [OfficerDecisionInput]>(
	OFFICER_DECISION_UPDATE,
);

const acts = proxyActivities<Activities>({
	startToCloseTimeout: "10 seconds",
	retry: { maximumAttempts: 3 },
});

const REFER_DEADLINE_MS = 72 * 3600 * 1000;

function rejected(message: string): Error {
	return ApplicationFailure.create({
		message,
		type: "OfficerDecisionRejected",
		nonRetryable: true,
	});
}

// Temporal wraps activity errors (message "Activity task failed"); dig to
// the root message so markFailed records something useful. Pure.
function failureMessage(err: unknown): string {
	let current: unknown = err;
	const seen = new Set<unknown>();
	while (current instanceof Error && !seen.has(current)) {
		seen.add(current);
		const cause = (current as { cause?: unknown }).cause;
		if (!(cause instanceof Error)) break;
		current = cause;
	}
	return current instanceof Error ? current.message : String(current);
}

export async function applicationWorkflow(
	input: ApplicationWorkflowInput,
): Promise<ApplicationWorkflowResult> {
	try {
		return await runApplication(input.applicationId);
	} catch (err) {
		try {
			await acts.markFailed({
				applicationId: input.applicationId,
				reason: err instanceof Error ? err.message : String(err),
			});
		} catch {
			// best-effort: never mask the original failure
		}
		throw err;
	}
}

async function runApplication(applicationId: string): Promise<ApplicationWorkflowResult> {
	let scoring: ScoringSummary | null = null;
	let phase: "running" | "pending" | "done" = "running";
	let decisionInProgress = false;
	let decisionMade = false;
	let storedRequestId: string | null = null;
	let storedResult: OfficerDecisionResult | null = null;
	let inFlight: Promise<OfficerDecisionResult> | null = null;
	let inFlightRequestId: string | null = null;

	// ponytail: control-flow analysis can't see assignments made inside
	// update handlers, so reads go through accessors (else `storedResult`
	// narrows to `null` and property access fails to compile).
	function getStoredResult(): OfficerDecisionResult | null {
		return storedResult;
	}

	setHandler(
		officerDecisionUpdate,
		async (update): Promise<OfficerDecisionResult> => {
			// Same-requestId replay: after success, or joining an in-flight
			// update — one booking call total (booking also dedupes by
			// requestId as a backstop).
			if (storedResult && storedRequestId === update.requestId) {
				return storedResult;
			}
			if (inFlight && inFlightRequestId === update.requestId) {
				return await inFlight;
			}
			decisionInProgress = true;
			inFlightRequestId = update.requestId;
			const pending: Promise<OfficerDecisionResult> = (async () => {
				if (update.outcome === "approve") {
					const booked = await acts.bookLoan({
						applicationId,
						route: "officer",
						approvedAmountCents: update.approvedAmountCents,
						termMonths: update.termMonths,
						requestId: update.requestId,
						officerUserId: update.officerUserId ?? null,
						notes: update.notes ?? null,
						...(update.research !== undefined ? { research: update.research } : {}),
					});
					const result: OfficerDecisionResult = {
						outcome: "booked",
						decisionId: booked.decisionId,
						loanId: booked.loanId,
					};
					return result;
				}
				const declined = await acts.persistOfficerDecline({
					applicationId,
					requestId: update.requestId,
					officerUserId: update.officerUserId ?? null,
					reasonCode: update.reasonCode ?? "OFFICER_JUDGEMENT",
					notes: update.notes ?? "",
					...(update.research !== undefined ? { research: update.research } : {}),
				});
				const result: OfficerDecisionResult = {
					outcome: "declined",
					decisionId: declined.decisionId,
					loanId: null,
				};
				return result;
			})();
			inFlight = pending;
			try {
				const result = await pending;
				decisionMade = true;
				storedResult = result;
				storedRequestId = update.requestId;
				return result;
			} finally {
				decisionInProgress = false;
				inFlight = null;
				inFlightRequestId = null;
			}
		},
		{
			validator: (update) => {
				// Internal updates carry only the server-built `research`
				// bundle: the public selection never reaches the workflow.
				const parsed = internalOfficerDecisionSchema.safeParse({
					requestId: update.requestId,
					outcome: update.outcome,
					...(update.approvedAmountCents !== undefined
						? { approvedAmountCents: update.approvedAmountCents }
						: {}),
					...(update.termMonths !== undefined ? { termMonths: update.termMonths } : {}),
					...(update.reasonCode !== undefined ? { reasonCode: update.reasonCode } : {}),
					...(update.notes !== undefined ? { notes: update.notes } : {}),
					...(update.research !== undefined ? { research: update.research } : {}),
					...(update.officerUserId !== undefined
						? { officerUserId: update.officerUserId }
						: {}),
				});
				if (!parsed.success) {
					throw rejected(
						`invalid officer decision: ${parsed.error.issues[0]?.message ?? "payload rejected"}`,
					);
				}
				if (storedResult && storedRequestId === update.requestId) return;
				if (inFlight && inFlightRequestId === update.requestId) return;
				if (phase !== "pending" || decisionMade || decisionInProgress) {
					throw rejected("case is not awaiting an officer decision");
				}
				if (update.outcome === "approve") {
					if (!scoring) throw rejected("case is not ready for a decision");
					const amount = update.approvedAmountCents ?? scoring.requestedAmountCents;
					const term = update.termMonths ?? scoring.requestedTermMonths;
					const min = scoring.product === "sme_term_loan" ? SME_MIN_CENTS : PERSONAL_MIN_CENTS;
					if (!Number.isInteger(amount) || amount < min || amount > scoring.requestedAmountCents) {
						throw rejected(
							`approved amount must be ${min}–${scoring.requestedAmountCents} (requested)`,
						);
					}
					if (!Number.isInteger(term) || term < TERM_MIN_MONTHS || term > TERM_MAX_MONTHS) {
						throw rejected(`term must be ${TERM_MIN_MONTHS}–${TERM_MAX_MONTHS} months`);
					}
					const rate = rateBps(scoring.grade, scoring.product);
					const payment = monthlyPaymentCents(amount, rate, term);
					if (scoring.kind === "individual") {
						if (
							!dtiLte(
								scoring.existingDebtCents ?? 0,
								payment,
								scoring.monthlyIncomeCents ?? 0,
								DTI_DECLINE_MAX_PCT_X100,
							)
						) {
							throw rejected("adjusted terms breach DTI ≤ 50%");
						}
					} else if (
						!dscrGte(
							scoring.monthlyFcfCents ?? 0,
							payment,
							scoring.existingDebtServiceCents ?? 0,
							DSCR_DECLINE_MIN_X100,
						)
					) {
						throw rejected("adjusted terms breach DSCR ≥ 1.0");
					}
				}
			},
		},
	);

	const loaded = await acts.loadApplicationAndSetProcessing({ applicationId });
	if (loaded === null) {
		const current = await acts.loadApplication({ applicationId });
		phase = "done";
		return {
			applicationId,
			outcome: "already_terminal",
			kind: null,
			decisionId: null,
			loanId: null,
			status: current.status,
		};
	}

	const [identity, sanctions, docs, bureau, bank] = await Promise.allSettled([
		acts.runIdentityCheck({ applicationId }),
		acts.runSanctionsCheck({ applicationId }),
		acts.runDocumentCheck({ applicationId }),
		acts.fetchBureauReport({ applicationId }),
		acts.fetchBankData({ applicationId }),
	]);
	// Check-only decline wins over any data-fetch outcome (FR-2.4).
	const checkReasons: CheckReasonCode[] = [];
	if (identity.status === "fulfilled" && !identity.value.passed) {
		checkReasons.push("IDENTITY_FAILED");
	}
	if (sanctions.status === "fulfilled" && !sanctions.value.passed) {
		checkReasons.push("SANCTIONS_HIT");
	}
	if (checkReasons.length > 0) {
		const declined = await acts.persistCheckOnlyDecline({
			applicationId,
			reasons: checkReasons,
		});
		phase = "done";
		return {
			applicationId,
			outcome: "declined",
			kind: "check_only",
			decisionId: declined.decisionId,
			loanId: null,
		};
	}
	// Name the failing activity: Temporal's wrapper message ("Activity task
	// failed") doesn't say which of the five parallel calls broke, and the
	// inner message may not survive failure conversion.
	const gathered = [
		["runIdentityCheck", identity],
		["runSanctionsCheck", sanctions],
		["runDocumentCheck", docs],
		["fetchBureauReport", bureau],
		["fetchBankData", bank],
	] as const;
	const failed = gathered.find(([, r]) => r.status === "rejected");
	if (failed) {
		const [name, result] = failed;
		const reason = result.status === "rejected" ? result.reason : new Error("unknown");
		throw ApplicationFailure.create({
			message: `data gathering failed: ${name}: ${failureMessage(reason)}`,
			type: "DataGatheringFailed",
			nonRetryable: true,
		});
	}

	scoring = await acts.scoreAndPersist({ applicationId });
	const policy = await acts.evaluateAndPersistPolicy({ applicationId });

	if (policy.outcome === "decline") {
		const declined = await acts.persistDecline({ applicationId });
		phase = "done";
		return {
			applicationId,
			outcome: "declined",
			kind: "policy",
			decisionId: declined.decisionId,
			loanId: null,
		};
	}
	if (policy.outcome === "auto_approve") {
		const booked = await acts.bookLoan({ applicationId, route: "auto" });
		phase = "done";
		return {
			applicationId,
			outcome: "booked",
			kind: "auto",
			decisionId: booked.decisionId,
			loanId: booked.loanId,
		};
	}

	await acts.markPendingReview({ applicationId });
	phase = "pending";
	const deadline = Date.now() + REFER_DEADLINE_MS;
	for (;;) {
		// ponytail: the accessor defeats CFA narrowing (the latch is only
		// assigned inside update handlers, which control flow can't see).
		if (decisionMade) {
			phase = "done";
			const result = getStoredResult() as OfficerDecisionResult;
			return {
				applicationId,
				outcome: result.outcome,
				kind: "officer",
				decisionId: result.decisionId,
				loanId: result.loanId,
			};
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			if (!decisionInProgress) {
				await acts.expireReview({ applicationId });
				phase = "done";
				return {
					applicationId,
					outcome: "expired",
					kind: null,
					decisionId: null,
					loanId: null,
				};
			}
			// An update is in flight at the deadline: wait for it to land,
			// then re-evaluate (a failed update leaves the case pending).
			await condition(() => !decisionInProgress || decisionMade, "5 minutes");
			continue;
		}
		await condition(() => decisionMade, remaining);
	}
}
