// Full case view (SPEC FR-7.2) — shared by the applicant case page and the
// officer review page. Renders everything the API delivers; null-safe for
// check-only decisions (null amounts render as "—").
import { REASON_TEXT } from "@credit/core/browser";
import { type CaseDetail, formatDate, formatDateTime, formatMoney } from "../lib/api";
import { Card, MockBadge, Money, StatusBadge } from "./ui";

function reasonText(code: string): string {
	return (REASON_TEXT as Record<string, string>)[code] ?? code;
}

function FactorList({
	factors,
}: {
	factors: Array<{ code: string; label: string; points: number }>;
}) {
	const top = [...factors].sort((a, b) => Math.abs(b.points) - Math.abs(a.points)).slice(0, 5);
	if (top.length === 0) return <p className="text-sm text-gray-500">No factors recorded.</p>;
	return (
		<ul className="divide-y divide-gray-100 text-sm">
			{top.map((f) => (
				<li key={f.code} className="flex items-center justify-between gap-2 py-1.5">
					<span>
						<span className="font-medium">{f.label}</span>{" "}
						<span className="text-gray-400">({f.code})</span>
					</span>
					<span
						className={`font-mono tabular-nums ${f.points > 0 ? "text-green-700" : f.points < 0 ? "text-red-700" : "text-gray-500"}`}
					>
						{f.points > 0 ? `+${f.points}` : f.points}
					</span>
				</li>
			))}
		</ul>
	);
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
	return (
		<div className="flex flex-wrap justify-between gap-2 py-1 text-sm">
			<dt className="text-gray-500">{k}</dt>
			<dd className="font-medium break-all">{v}</dd>
		</div>
	);
}

function Timeline({ entries }: { entries: CaseDetail["timeline"] }) {
	if (entries.length === 0) return <p className="text-sm text-gray-500">No activity yet.</p>;
	return (
		<ol className="space-y-2 text-sm">
			{entries.map((e) => (
				<li
					key={`${e.at}-${e.kind}-${e.action ?? e.type ?? ""}`}
					className="flex flex-wrap gap-x-2 gap-y-0.5"
				>
					<span className="text-gray-400 tabular-nums">{formatDateTime(e.at)}</span>
					<span className="font-medium">{e.kind === "audit" ? e.action : e.type}</span>
					{e.kind === "feed" && e.message && <span className="text-gray-600">{e.message}</span>}
					{e.kind === "audit" && e.actor && <span className="text-gray-400">by {e.actor}</span>}
				</li>
			))}
		</ol>
	);
}

export function CaseView({ data }: { data: CaseDetail }) {
	const { application: app, score, policyEvaluation: policy, decision, loan } = data;
	const bureau = data.externalReports.find((r) => r.kind === "bureau")?.payload;
	const bank = data.externalReports.find((r) => r.kind === "bank")?.payload;
	const aff = score?.affordability;

	return (
		<div className="space-y-4">
			<Card
				title={
					<span>
						{app.reference} <StatusBadge status={app.status} />
					</span>
				}
			>
				<dl className="divide-y divide-gray-100">
					<Kv k="Type / product" v={`${app.type} / ${app.product}`} />
					<Kv k="Amount" v={<Money cents={app.amountCents} />} />
					<Kv k="Term" v={`${app.termMonths} months`} />
					<Kv k="Purpose" v={app.purpose} />
					<Kv k="Submitted" v={formatDateTime(app.submittedAt)} />
					{app.decidedAt && <Kv k="Decided" v={formatDateTime(app.decidedAt)} />}
					{app.failedReason && <Kv k="Failure" v={app.failedReason} />}
				</dl>
			</Card>

			<Card title="Identity">
				<dl className="divide-y divide-gray-100">
					{Object.entries(app.identity).map(([k, v]) => (
						<Kv key={k} k={k} v={String(v)} />
					))}
				</dl>
			</Card>

			{app.financial && (
				<Card title="Financial (individual)">
					<dl className="divide-y divide-gray-100">
						{Object.entries(app.financial).map(([k, v]) => (
							<Kv
								key={k}
								k={k}
								v={k.toLowerCase().includes("cents") ? formatMoney(v as number) : String(v)}
							/>
						))}
					</dl>
				</Card>
			)}
			{app.business && (
				<Card title="Business (SME)">
					<dl className="divide-y divide-gray-100">
						{Object.entries(app.business).map(([k, v]) => (
							<Kv
								key={k}
								k={k}
								v={
									k.toLowerCase().includes("cents")
										? formatMoney(v as number)
										: typeof v === "object"
											? JSON.stringify(v)
											: String(v)
								}
							/>
						))}
					</dl>
				</Card>
			)}

			<Card
				title={
					<span className="flex items-center gap-2">
						Verification <MockBadge />
					</span>
				}
			>
				<p className="mb-2 text-xs text-gray-500">Mock verification — no documents stored.</p>
				<ul className="space-y-1.5 text-sm">
					{data.checks.length === 0 && <li className="text-gray-500">No checks yet.</li>}
					{data.checks.map((c) => (
						<li key={c.type} className="flex items-center gap-2">
							<StatusBadge status={c.status} />
							<span>{c.type}</span>
						</li>
					))}
				</ul>
				<ul className="mt-3 space-y-1.5 text-sm">
					{data.documents.map((d) => (
						<li key={d.kind} className="flex items-center gap-2">
							<StatusBadge status={d.status} />
							<span>{d.kind}</span>
							{d.note && <span className="text-gray-400">— {d.note}</span>}
						</li>
					))}
				</ul>
			</Card>

			{(bureau || bank) && (
				<Card
					title={
						<span className="flex items-center gap-2">
							External data <MockBadge />
						</span>
					}
				>
					{bureau && (
						<div className="mb-3">
							<h3 className="text-sm font-semibold">Bureau ({String(bureau.provider ?? "")})</h3>
							<dl className="divide-y divide-gray-100">
								<Kv k="Score" v={String(bureau.bureauScore ?? "—")} />
								<Kv k="Delinquencies" v={String(bureau.delinquencies ?? "—")} />
								<Kv k="Utilization" v={`${String(bureau.utilizationPct ?? "—")}%`} />
								<Kv k="Inquiries (6m)" v={String(bureau.inquiries6m ?? "—")} />
							</dl>
						</div>
					)}
					{bank && (
						<div>
							<h3 className="text-sm font-semibold">Bank ({String(bank.provider ?? "")})</h3>
							<dl className="divide-y divide-gray-100">
								<Kv k="Monthly inflow" v={formatMoney(bank.monthlyInflowCents as number)} />
								<Kv
									k="Monthly free cash flow"
									v={formatMoney(bank.monthlyFreeCashFlowCents as number)}
								/>
								<Kv k="Account age" v={`${String(bank.accountAgeYears ?? "—")} y`} />
							</dl>
						</div>
					)}
				</Card>
			)}

			{score ? (
				<Card title={`Score ${score.score} / grade ${score.grade}`}>
					<p className="mb-2 text-xs text-gray-500">Model {score.modelVersion}</p>
					{score.components && (
						<p className="mb-2 text-sm">
							Owner {String(score.components.ownerScore ?? "—")} · Business{" "}
							{String(score.components.businessScore ?? "—")}
						</p>
					)}
					<FactorList factors={score.factors} />
					{aff && (
						<div className="mt-3 border-t border-gray-100 pt-2 text-sm">
							<Kv k="New payment" v={formatMoney(aff.newPaymentCents)} />
							{aff.dti !== undefined && <Kv k="DTI" v={`${(aff.dti * 100).toFixed(2)}%`} />}
							{aff.dscr !== undefined && <Kv k="DSCR" v={`${aff.dscr.toFixed(2)}×`} />}
						</div>
					)}
				</Card>
			) : (
				<Card title="Score">
					<p className="text-sm text-gray-500">Not scored yet.</p>
				</Card>
			)}

			{policy && (
				<Card title={`Policy: ${policy.outcome}`}>
					<p className="mb-2 text-xs text-gray-500">
						{policy.policyVersion} · max <Money cents={policy.maxAmountCents} />
					</p>
					<ul className="list-disc space-y-1 pl-5 text-sm">
						{policy.reasons.map((r) => (
							<li key={r.code}>
								<span className="font-mono text-xs">{r.code}</span> — {reasonText(r.code)}
							</li>
						))}
					</ul>
				</Card>
			)}

			{decision && (
				<Card title={`Decision: ${decision.outcome} (${decision.decidedBy})`}>
					<dl className="divide-y divide-gray-100">
						{decision.approvedAmountCents !== null &&
							decision.approvedAmountCents !== undefined && (
								<Kv k="Approved amount" v={formatMoney(decision.approvedAmountCents)} />
							)}
						{decision.termMonths !== null && decision.termMonths !== undefined && (
							<Kv k="Term" v={`${decision.termMonths} months`} />
						)}
						{decision.rateBps !== null && decision.rateBps !== undefined && (
							<Kv k="Rate" v={`${(decision.rateBps / 100).toFixed(2)}%`} />
						)}
						<Kv
							k="Reasons"
							v={decision.reasons
								.map((r) => (typeof r === "string" ? r : r.code))
								.map((c) => `${c} — ${reasonText(c)}`)
								.join("; ")}
						/>
						{decision.notes && <Kv k="Notes" v={decision.notes} />}
						<Kv k="Decided" v={formatDateTime(decision.decidedAt)} />
					</dl>
				</Card>
			)}

			{loan && (
				<Card title={`Loan ${loan.status}`}>
					<dl className="divide-y divide-gray-100">
						<Kv k="Principal" v={formatMoney(loan.principalCents)} />
						<Kv k="Rate" v={`${(loan.rateBps / 100).toFixed(2)}%`} />
						<Kv k="Monthly" v={formatMoney(loan.monthlyPaymentCents)} />
						<Kv k="Outstanding" v={formatMoney(loan.outstandingCents)} />
						<Kv k="Next due" v={formatDate(loan.nextDueDate)} />
						<Kv
							k="Installments"
							v={`${loan.installments.paid}/${loan.installments.total} paid, ${loan.installments.overdue} overdue`}
						/>
					</dl>
				</Card>
			)}

			<Card title="Timeline">
				<Timeline entries={data.timeline} />
			</Card>
		</div>
	);
}
