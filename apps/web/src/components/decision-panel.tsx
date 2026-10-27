// Officer decision panel (SPEC FR-7.3): approve (amount ≤ requested, ≥
// product min; term 12–60) or decline (reason code + notes required). One
// requestId per action, generated once and reused across HTTP retries.
import {
	PERSONAL_MIN_CENTS,
	SME_MIN_CENTS,
	TERM_MAX_MONTHS,
	TERM_MIN_MONTHS,
} from "@credit/core/browser";
import { useState } from "react";
import {
	ApiError,
	api,
	apiErrorMessage,
	formatMoney,
	toast,
	type ResearchSelection,
} from "../lib/api";
import { Button } from "./ui/button";
import { ErrorBox, Field, inputCls, Money, Panel } from "./ui";

const DECLINE_CODES = ["OFFICER_JUDGEMENT", "INSUFFICIENT_EVIDENCE", "POLICY_EXCEPTION"] as const;

export function DecisionPanel({
	applicationId,
	requestedAmountCents,
	requestedTermMonths,
	maxAmountCents,
	product,
	researchSelection,
	onResearchStale,
	onDecided,
}: {
	applicationId: string;
	requestedAmountCents: number;
	requestedTermMonths: number;
	maxAmountCents: number;
	product: string;
	/** Accepted research selection; sent as IDs only — review freezes the bundle. */
	researchSelection?: ResearchSelection | null;
	/** Fired when the server reports the selection stale, so the parent clears it. */
	onResearchStale?: () => void;
	onDecided: () => void;
}) {
	const [mode, setMode] = useState<"approve" | "decline">("approve");
	// One id per action intent — retries reuse it, so replays return the
	// original decision instead of conflicting (SPEC FR-6.2).
	const [requestId] = useState(() => crypto.randomUUID());
	const minCents = product === "sme_term_loan" ? SME_MIN_CENTS : PERSONAL_MIN_CENTS;
	const [amount, setAmount] = useState(String(maxAmountCents / 100));
	const [term, setTerm] = useState(String(requestedTermMonths));
	const [reasonCode, setReasonCode] = useState<string>(DECLINE_CODES[0]);
	const [notes, setNotes] = useState("");
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [serverError, setServerError] = useState("");
	const [busy, setBusy] = useState(false);
	// 503 RESEARCH_UNAVAILABLE: the research-selected decision cannot
	// resolve its bundle right now — offer retry or decide-without.
	const [researchDown, setResearchDown] = useState(false);
	// 409 RESEARCH_SELECTION_STALE: the accepted findings no longer resolve
	// (reaped run, re-rejected findings). Non-retryable with research — the
	// selection is cleared via onResearchStale; decide-without remains.
	const [researchStale, setResearchStale] = useState(false);

	async function submit(useResearch = true) {
		const next: Record<string, string> = {};
		let amountCents = 0;
		let termMonths = 0;
		if (mode === "approve") {
			amountCents = Math.round(Number(amount) * 100);
			termMonths = Number(term);
			if (!Number.isFinite(amountCents) || amountCents <= 0)
				next.amount = "enter an amount in dollars";
			else if (amountCents > requestedAmountCents)
				next.amount = `must be ≤ requested ${formatMoney(requestedAmountCents)}`;
			else if (amountCents < minCents)
				next.amount = `must be ≥ product minimum ${formatMoney(minCents)}`;
			if (
				!Number.isInteger(termMonths) ||
				termMonths < TERM_MIN_MONTHS ||
				termMonths > TERM_MAX_MONTHS
			)
				next.term = `term must be ${TERM_MIN_MONTHS}–${TERM_MAX_MONTHS} months`;
		} else {
			if (!reasonCode) next.reasonCode = "reason code is required";
			if (notes.trim().length === 0) next.notes = "notes are required to decline";
		}
		setErrors(next);
		if (Object.keys(next).length > 0) return;
		setBusy(true);
		setServerError("");
		setResearchDown(false);
		setResearchStale(false);
		// Advisory research rides the decision as IDs only; the server
		// freezes the bundle. Never send claim/evidence text from here.
		const research =
			useResearch && researchSelection && researchSelection.acceptedFindingIds.length > 0
				? {
						agentRunId: researchSelection.agentRunId,
						acceptedFindingIds: researchSelection.acceptedFindingIds,
					}
				: {};
		try {
			await api(`/api/review/${applicationId}/decision`, {
				method: "POST",
				body:
					mode === "approve"
						? {
								requestId,
								outcome: "approve",
								approvedAmountCents: amountCents,
								termMonths,
								...(notes.trim() ? { notes: notes.trim() } : {}),
								...research,
							}
						: {
								requestId,
								outcome: "decline",
								reasonCode,
								notes: notes.trim(),
								...research,
							},
			});
			onDecided();
		} catch (err) {
			if (err instanceof ApiError && err.fields) {
				const flat: Record<string, string> = {};
				for (const [k, v] of Object.entries(err.fields)) flat[k] = v.join(" ");
				setErrors(flat);
			}
			if (err instanceof ApiError && err.status === 503 && err.code === "RESEARCH_UNAVAILABLE") {
				setResearchDown(true);
			}
			if (
				err instanceof ApiError &&
				err.status === 409 &&
				err.code === "RESEARCH_SELECTION_STALE"
			) {
				setResearchStale(true);
				onResearchStale?.();
			}
			const msg = apiErrorMessage(err);
			setServerError(err instanceof ApiError ? `${err.code}: ${msg}` : msg);
			if (
				!(err instanceof ApiError) ||
				(err.status !== 409 && err.status !== 422 && err.status !== 503)
			)
				toast(msg);
		} finally {
			setBusy(false);
		}
	}

	return (
		<section aria-label="Officer decision">
			<Panel title="Officer decision" outline>
				<fieldset className="mb-4 flex gap-2">
					<legend className="sr-only">Decision outcome</legend>
					{(["approve", "decline"] as const).map((m) => (
						<label
							key={m}
							className={
								mode === m
									? "rounded-sm border border-ink bg-ink px-4 py-2 text-sm font-medium text-white"
									: "rounded-sm border border-rule-strong bg-card px-4 py-2 text-sm font-medium text-slate"
							}
						>
							<input
								type="radio"
								name="decision-outcome"
								value={m}
								checked={mode === m}
								onChange={() => setMode(m)}
								className="mr-2"
							/>
							{m === "approve" ? "Approve" : "Decline"}
						</label>
					))}
				</fieldset>
				{mode === "approve" ? (
					<div className="grid gap-3 sm:grid-cols-2">
						<Field label="Amount (USD)" error={errors.approvedAmountCents ?? errors.amount}>
							<input
								id="field-amount-usd"
								inputMode="decimal"
								value={amount}
								onChange={(e) => setAmount(e.target.value)}
								className={inputCls}
							/>
						</Field>
						<Field label="Term (months)" error={errors.termMonths ?? errors.term}>
							<input
								id="field-term-months"
								inputMode="numeric"
								value={term}
								onChange={(e) => setTerm(e.target.value)}
								className={inputCls}
							/>
						</Field>
						<p className="text-xs text-slate sm:col-span-2">
							Requested <Money cents={requestedAmountCents} /> / {requestedTermMonths}m · policy max{" "}
							<Money cents={maxAmountCents} /> · product min <Money cents={minCents} />
						</p>
					</div>
				) : (
					<div className="grid gap-3">
						<Field label="Reason code" error={errors.reasonCode}>
							<select
								id="field-reason-code"
								value={reasonCode}
								onChange={(e) => setReasonCode(e.target.value)}
								className={inputCls}
							>
								{DECLINE_CODES.map((c) => (
									<option key={c} value={c}>
										{c}
									</option>
								))}
							</select>
						</Field>
					</div>
				)}
				<div className="mt-3">
					<Field
						label={mode === "approve" ? "Note (optional)" : "Notes (required)"}
						error={errors.notes}
					>
						<textarea
							id={mode === "approve" ? "field-note-optional" : "field-notes-required"}
							value={notes}
							onChange={(e) => setNotes(e.target.value)}
							rows={3}
							className={inputCls}
						/>
					</Field>
				</div>
				{serverError && (
					<div className="mt-3">
						<ErrorBox message={serverError} />
					</div>
				)}
				{researchSelection && researchSelection.acceptedFindingIds.length > 0 && (
					<p className="mt-3 text-xs text-slate">
						Using research: {researchSelection.acceptedFindingIds.length} accepted finding
						{researchSelection.acceptedFindingIds.length === 1 ? "" : "s"} (run{" "}
						{researchSelection.agentRunId.slice(0, 8)}…). Advisory only — the decision is yours, and
						the cited evidence is frozen into the audit.
					</p>
				)}
				{researchStale && (
					<div className="mt-3 rounded-sm border border-warning bg-tag-amber p-3 text-sm text-warning-ink">
						<p>
							The accepted research no longer matches the frozen brief (the run was superseded or
							the findings were re-reviewed). The selection was cleared — re-review the brief, or
							decide without research.
						</p>
						<div className="mt-2 flex gap-2">
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => void submit(false)}
								disabled={busy}
							>
								Decide without research
							</Button>
						</div>
					</div>
				)}
				{researchDown && (
					<div className="mt-3 rounded-sm border border-warning bg-tag-amber p-3 text-sm text-warning-ink">
						<p>Research is temporarily unavailable. You can retry, or decide without research.</p>
						<div className="mt-2 flex gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void submit(true)}
								disabled={busy}
							>
								Retry with research
							</Button>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => void submit(false)}
								disabled={busy}
							>
								Decide without research
							</Button>
						</div>
					</div>
				)}
				<Button
					type="button"
					size="sm"
					onClick={() => void submit(true)}
					disabled={busy}
					className="mt-4"
				>
					{busy ? "Submitting…" : mode === "approve" ? "Approve" : "Decline"}
				</Button>
			</Panel>
		</section>
	);
}
