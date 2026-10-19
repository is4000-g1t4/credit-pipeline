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
import { ApiError, api, apiErrorMessage, formatMoney, toast } from "../lib/api";
import { ErrorBox, Field, inputCls, Money } from "./ui";

const DECLINE_CODES = ["OFFICER_JUDGEMENT", "INSUFFICIENT_EVIDENCE", "POLICY_EXCEPTION"] as const;

export function DecisionPanel({
	applicationId,
	requestedAmountCents,
	requestedTermMonths,
	maxAmountCents,
	product,
	onDecided,
}: {
	applicationId: string;
	requestedAmountCents: number;
	requestedTermMonths: number;
	maxAmountCents: number;
	product: string;
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

	async function submit() {
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
							}
						: {
								requestId,
								outcome: "decline",
								reasonCode,
								notes: notes.trim(),
							},
			});
			onDecided();
		} catch (err) {
			if (err instanceof ApiError && err.fields) {
				const flat: Record<string, string> = {};
				for (const [k, v] of Object.entries(err.fields)) flat[k] = v.join(" ");
				setErrors(flat);
			}
			const msg = apiErrorMessage(err);
			setServerError(err instanceof ApiError ? `${err.code}: ${msg}` : msg);
			if (!(err instanceof ApiError) || (err.status !== 409 && err.status !== 422)) toast(msg);
		} finally {
			setBusy(false);
		}
	}

	return (
		<section
			aria-label="Officer decision"
			className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
		>
			<h2 className="mb-3 text-base font-semibold">Officer decision</h2>
			<fieldset className="mb-4 flex gap-2">
				<legend className="sr-only">Decision outcome</legend>
				{(["approve", "decline"] as const).map((m) => (
					<label
						key={m}
						className={`rounded border px-4 py-2 text-sm font-medium ${mode === m ? "border-blue-600 bg-blue-50 text-blue-800" : "border-gray-300 text-gray-600"}`}
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
					<p className="text-xs text-gray-500 sm:col-span-2">
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
			<button
				type="button"
				onClick={submit}
				disabled={busy}
				className="mt-4 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
			>
				{busy ? "Submitting…" : mode === "approve" ? "Approve" : "Decline"}
			</button>
		</section>
	);
}
