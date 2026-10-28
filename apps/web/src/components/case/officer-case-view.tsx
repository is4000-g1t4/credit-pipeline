// Officer case detail (prototype layout): PageHead, fact strip, decision
// banner, fraud warning, 8/4 grid with application/credit/policy/
// verification/documents/DocumentPanel/IntegrityPanel/timeline in main and
// tabbed assist + decision in the rail. Reuses the shared panels unchanged.
import { reasonText } from "@credit/core/browser";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { CaseAssistantPanel } from "../case-assistant-panel";
import { DecisionPanel } from "../decision-panel";
import { DocumentPanel } from "../document-panel";
import { IntegrityPanel } from "../integrity-panel";
import { MemoPanel } from "../memo-panel";
import { PolicyExceptionPanel } from "../policy-exception-panel";
import { ResearchPanel } from "../research-panel";
import { ButtonLink } from "../ubs/button-link";
import {
	BarRow,
	CodeTag,
	Meter,
	Money,
	Overline,
	PageHead,
	Panel,
	StatusBadge,
	Tabs,
	Tag,
} from "../ubs";
import {
	actionLabel,
	fieldLabel,
	formatDate,
	formatDateTime,
	formatFieldValue,
	formatMoney,
	formatWait,
	productLabel,
	typeLabel,
	type CaseDetail,
	type ResearchSelection,
} from "../../lib/api";

type AssistTab = "brief" | "memo" | "policy" | "ask";

/** Queue risk bands (spec §1): low ≥ 760, medium ≥ 640, high below; missing is medium. */
function riskOf(score: number | null | undefined): "low" | "medium" | "high" {
	if (score === null || score === undefined) return "medium";
	if (score >= 760) return "low";
	if (score >= 640) return "medium";
	return "high";
}

function clientNameOf(data: CaseDetail): string {
	const business = (data.application.business ?? null) as Record<string, unknown> | null;
	const identity = (data.application.identity ?? {}) as Record<string, unknown>;
	if (
		business !== null &&
		typeof business.companyName === "string" &&
		business.companyName !== ""
	) {
		return business.companyName;
	}
	if (typeof identity.fullName === "string" && identity.fullName !== "") return identity.fullName;
	return data.application.reference;
}

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="py-1">
			<dt className="text-xs text-slate">{label}</dt>
			<dd className="mt-0.5 text-sm font-medium break-words text-ink">{value}</dd>
		</div>
	);
}

function FraudWarning({ data }: { data: CaseDetail }) {
	const fraud = data.fraudReview;
	if (!fraud) return null;
	return (
		<div
			role="alert"
			className="mt-8 border border-warning bg-tag-amber px-4 py-3 text-sm text-warning-ink"
		>
			<p>
				<span className="font-medium">Open fraud review ({fraud.severity}):</span>{" "}
				<span className="font-mono text-xs">{fraud.reasonCode}</span> · {fraud.status}. Review it
				before deciding — the decision path stays open.
			</p>
			<p className="mt-2">
				<Link
					to="/officer/fraud-review/$id"
					params={{ id: fraud.id }}
					className="inline-flex items-center gap-1 font-medium text-red-link hover:underline"
				>
					Open fraud review
				</Link>
			</p>
		</div>
	);
}

function DecisionBanner({ data }: { data: CaseDetail }) {
	const decision = data.decision;
	if (!decision) return null;
	const approved = decision.outcome === "approved";
	return (
		<output className="mt-8 flex flex-wrap items-center gap-3 border border-rule bg-raised px-4 py-3 text-sm">
			<Tag tone={approved ? "success" : "danger"}>{approved ? "Approved" : "Declined"}</Tag>
			<p className="text-ink">
				Decision: {decision.outcome} ({decision.decidedBy})
				{approved &&
				decision.approvedAmountCents !== null &&
				decision.approvedAmountCents !== undefined
					? ` · ${formatMoney(decision.approvedAmountCents)} over ${decision.termMonths} months`
					: ""}
				{approved && decision.rateBps !== null && decision.rateBps !== undefined
					? ` at ${(decision.rateBps / 100).toFixed(2)}%`
					: ""}
				{!approved && decision.notes ? ` · ${decision.notes}` : ""} ·{" "}
				{formatDateTime(decision.decidedAt)}
			</p>
		</output>
	);
}

function FactStrip({ data }: { data: CaseDetail }) {
	const app = data.application;
	const score = data.score?.score ?? null;
	const grade = data.score?.grade ?? null;
	const aff = data.score?.affordability;
	const isSme = app.type === "sme";
	const ratio = isSme
		? aff?.dscr !== undefined
			? `${aff.dscr.toFixed(2)}×`
			: "—"
		: aff?.dti !== undefined
			? `${(aff.dti * 100).toFixed(2)}%`
			: "—";
	const [nowMs] = useState(() => Date.now());
	const submittedMs = app.submittedAt ? new Date(app.submittedAt).getTime() : Number.NaN;
	const wait =
		Number.isNaN(submittedMs) || Number.isNaN(nowMs)
			? "—"
			: formatWait(Math.max(0, nowMs - submittedMs));
	return (
		<section
			aria-label="Case facts"
			className="grid grid-cols-2 gap-6 border-y border-rule py-6 sm:grid-cols-4 lg:grid-cols-7"
		>
			<div>
				<Overline>Requested</Overline>
				<p className="mt-2 text-lg font-light text-ink tabular">{formatMoney(app.amountCents)}</p>
			</div>
			<div>
				<Overline>Term</Overline>
				<p className="mt-2 text-lg font-light text-ink tabular">{app.termMonths} months</p>
			</div>
			<div>
				<Overline>Score/Grade</Overline>
				<p className="mt-2 text-lg font-light text-ink tabular">
					{score === null ? "—" : `${score}${grade ? ` / ${grade}` : ""}`}
				</p>
			</div>
			<div>
				<Overline>{isSme ? "DSCR" : "DTI"}</Overline>
				<p className="mt-2 text-lg font-light text-ink tabular">{ratio}</p>
			</div>
			<div>
				<Overline>Risk</Overline>
				<p className="mt-2">
					<StatusBadge status={riskOf(score)} />
				</p>
			</div>
			<div>
				<Overline>Wait</Overline>
				<p className="mt-2 text-lg font-light text-ink tabular">{wait}</p>
			</div>
			<div>
				<Overline>Status</Overline>
				<p className="mt-2">
					<StatusBadge status={app.status} />
				</p>
			</div>
		</section>
	);
}

function ApplicationPanel({ data }: { data: CaseDetail }) {
	const app = data.application;
	const identity = (app.identity ?? {}) as Record<string, unknown>;
	const business = (app.business ?? null) as Record<string, unknown> | null;
	const aff = data.score?.affordability;
	const dti = aff?.dti !== undefined ? `${(aff.dti * 100).toFixed(2)}%` : null;
	const rows: Array<[string, React.ReactNode]> = [
		["Applicant", (identity.fullName as string) ?? "—"],
	];
	if (business?.companyName) rows.push(["Company", String(business.companyName)]);
	rows.push(["Segment", typeLabel(app.type)]);
	rows.push(["Product", productLabel(app.product)]);
	rows.push(["Purpose", app.purpose]);
	rows.push(["Submitted", formatDate(app.submittedAt)]);
	rows.push(["Location", identity.city ? String(identity.city) : "—"]);
	if (business?.registrationNumber)
		rows.push(["Registration number", String(business.registrationNumber)]);
	if (business?.industry) rows.push(["Industry", formatFieldValue("industry", business.industry)]);
	if (business?.employees !== undefined && business.employees !== null)
		rows.push(["Employees", String(business.employees)]);
	if (business?.yearsTrading !== undefined && business.yearsTrading !== null)
		rows.push(["Trading history", `${String(business.yearsTrading)} years`]);
	if (typeof business?.annualRevenueCents === "number")
		rows.push(["Annual revenue", formatMoney(business.annualRevenueCents as number)]);
	if (typeof business?.monthlyFcfCents === "number")
		rows.push(["Monthly free cash flow", formatMoney(business.monthlyFcfCents as number)]);
	if (typeof business?.existingDebtServiceCents === "number")
		rows.push([
			"Existing debt service",
			`${formatMoney(business.existingDebtServiceCents as number)} / month`,
		]);
	if (dti) rows.push(["DTI", dti]);
	return (
		<Panel title="Application" outline>
			<dl className="grid gap-x-8 sm:grid-cols-2">
				{rows.map(([label, value]) => (
					<Kv key={label} label={label} value={value} />
				))}
			</dl>
		</Panel>
	);
}

function CreditPanel({ data }: { data: CaseDetail }) {
	const score = data.score;
	const aff = score?.affordability;
	return (
		<Panel
			title="Credit assessment"
			action={
				score ? <span className="text-xs text-slate">Model {score.modelVersion}</span> : undefined
			}
			outline
		>
			{!score ? (
				<p className="text-sm text-slate">Not scored yet.</p>
			) : (
				<div>
					<div className="flex flex-wrap items-end justify-between gap-4">
						<div>
							<p className="text-4xl leading-none font-light text-ink tabular">{score.score}</p>
							<p className="mt-1 text-sm text-slate">Grade {score.grade}</p>
						</div>
						<div className="text-right text-sm text-slate">
							{aff?.dscr !== undefined && <p>DSCR {aff.dscr.toFixed(2)}×</p>}
							{aff?.dti !== undefined && <p>DTI {(aff.dti * 100).toFixed(2)}%</p>}
						</div>
					</div>
					<div className="mt-3">
						<Meter
							value={score.score - 300}
							max={550}
							tone={score.score >= 720 ? "success" : score.score >= 640 ? "warning" : "danger"}
							label={`Score ${score.score}`}
						/>
						<div className="mt-1 flex justify-between text-xs text-slate tabular">
							<span>300</span>
							<span>580</span>
							<span>650</span>
							<span>720</span>
							<span>850</span>
						</div>
					</div>
					<ul className="mt-4 space-y-3">
						{[...score.factors]
							.sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
							.slice(0, 5)
							.map((f) => (
								<li key={f.code}>
									<BarRow
										label={`${f.label} (${f.code})`}
										value={f.points > 0 ? `+${f.points}` : `${f.points}`}
										pct={Math.min(100, Math.abs(f.points))}
										color={f.points >= 0 ? "var(--success)" : "var(--danger)"}
									/>
								</li>
							))}
					</ul>
					{aff?.newPaymentCents !== undefined && (
						<p className="mt-3 text-sm text-slate">
							New payment <Money cents={aff.newPaymentCents} />
						</p>
					)}
				</div>
			)}
		</Panel>
	);
}

function PolicyPanel({ data }: { data: CaseDetail }) {
	const policy = data.policyEvaluation;
	return (
		<Panel
			title="Policy check"
			action={
				<Link
					to="/officer/policies"
					className="inline-flex items-center gap-1 text-sm font-medium text-red-link hover:underline"
				>
					Open policy
				</Link>
			}
			outline
		>
			{!policy ? (
				<p className="text-sm text-slate">No policy outcome.</p>
			) : (
				<div>
					<p className="text-sm text-ink">
						Outcome: <CodeTag code={policy.outcome} /> · max <Money cents={policy.maxAmountCents} />{" "}
						· {policy.policyVersion}
					</p>
					<ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
						{policy.reasons.map((r) => (
							<li key={r.code}>
								<CodeTag code={r.code} /> — {reasonText(r.code)}
							</li>
						))}
					</ul>
				</div>
			)}
		</Panel>
	);
}

function VerificationDocuments({ data }: { data: CaseDetail }) {
	return (
		<div className="grid gap-8 md:grid-cols-2">
			<Panel title="Verification" outline>
				{data.checks.length === 0 ? (
					<p className="text-sm text-slate">No checks yet.</p>
				) : (
					<ul className="space-y-1.5 text-sm">
						{data.checks.map((c) => (
							<li key={c.type} className="flex items-center gap-2">
								<StatusBadge status={c.status} />
								<span className="text-ink">{c.type}</span>
							</li>
						))}
					</ul>
				)}
			</Panel>
			<Panel
				title="Evidence files"
				action={<span className="text-xs text-slate">{data.documents.length} files</span>}
				outline
			>
				{data.documents.length === 0 ? (
					<p className="text-sm text-slate">No documents.</p>
				) : (
					<ul className="space-y-1.5 text-sm">
						{data.documents.map((d) => (
							<li key={d.kind} className="flex items-center gap-2">
								<StatusBadge status={d.status} />
								<span className="text-ink">{fieldLabel(d.kind)}</span>
								{d.note && <span className="text-slate">— {d.note}</span>}
							</li>
						))}
					</ul>
				)}
			</Panel>
		</div>
	);
}

function TimelinePanel({ data }: { data: CaseDetail }) {
	const hidden = /^(access\.|context\.read|policy_exception\.viewed)/;
	const visible = data.timeline.filter((e) => !hidden.test(e.action ?? "")).slice(0, 20);
	return (
		<Panel title="Timeline" outline>
			{visible.length === 0 ? (
				<p className="text-sm text-slate">No activity yet.</p>
			) : (
				<>
					<ol className="divide-y divide-rule text-sm">
						{visible.map((e, index) => (
							<li
								// Audit rows can share the same millisecond and action
								// (e.g. several document.reused); index keeps them keyed.
								key={`${e.at}-${e.kind ?? "audit"}-${e.action ?? e.type ?? ""}-${index}`}
								className="flex flex-wrap gap-x-3 gap-y-0.5 py-2"
							>
								<span className="tabular text-slate">{formatDateTime(e.at)}</span>
								<span className="font-medium text-ink">
									{actionLabel(e.kind === "feed" ? e.type : e.action)}
								</span>
								{e.kind === "feed" && e.message && <span className="text-slate">{e.message}</span>}
							</li>
						))}
					</ol>
					{visible.length < data.timeline.length && (
						<p className="mt-2 text-xs text-slate">
							Showing the latest {visible.length} business events.
						</p>
					)}
				</>
			)}
		</Panel>
	);
}

export function OfficerCaseView({
	data,
	researchSelection,
	onResearchSelection,
	onDecided,
}: {
	data: CaseDetail;
	researchSelection: ResearchSelection | null;
	onResearchSelection: (selection: ResearchSelection | null) => void;
	onDecided: () => void;
}) {
	const app = data.application;
	const decided = app.status !== "pending_review";
	const [assistTab, setAssistTab] = useState<AssistTab>("brief");
	return (
		<>
			<PageHead
				title={clientNameOf(data)}
				subtitle={`${app.reference} · ${formatMoney(app.amountCents)} requested · ${app.termMonths} months · ${app.purpose}`}
				actions={
					<>
						<StatusBadge status={app.status} />
						<Link
							to="/officer/review"
							className="inline-flex items-center gap-1 text-sm font-medium text-red-link hover:underline"
						>
							Back to queue
						</Link>
					</>
				}
			/>

			<FactStrip data={data} />
			<DecisionBanner data={data} />
			<FraudWarning data={data} />

			<div className="mt-8 grid gap-8 lg:grid-cols-12">
				<div className="min-w-0 space-y-8 lg:col-span-8">
					<ApplicationPanel data={data} />
					<CreditPanel data={data} />
					<PolicyPanel data={data} />
					<VerificationDocuments data={data} />
					<DocumentPanel
						applicationId={app.id}
						mode="officer"
						documentsEnabled={app.documentsEnabled ?? false}
						documentProcessingConsent={app.documentProcessingConsent}
					/>
					<IntegrityPanel applicationId={app.id} />
					<TimelinePanel data={data} />
				</div>
				<aside className="min-w-0 lg:col-span-4">
					<div className="space-y-8 lg:sticky lg:top-6">
						<section aria-label="AI case assist" className="rounded-sm bg-warm p-6">
							<div className="mb-2 flex items-start justify-between gap-4">
								<div>
									<Overline>Advisory</Overline>
									<h2 className="mt-1 text-2xl leading-8 font-light text-ink">Case assist</h2>
								</div>
								<Tag tone="neutral">AI</Tag>
							</div>
							<p className="mb-4 text-sm text-slate">Evidence only — the decision is yours.</p>
							<Tabs
								ariaLabel="Case assist"
								items={[
									{ value: "brief", label: "Brief" },
									{ value: "memo", label: "Memo" },
									{ value: "policy", label: "Policy" },
									{ value: "ask", label: "Ask" },
								]}
								value={assistTab}
								onChange={setAssistTab}
							/>
							<div className="mt-4">
								<div hidden={assistTab !== "brief"}>
									<ResearchPanel
										applicationId={app.id}
										caseStatus={app.status}
										aiResearchConsent={app.aiResearchConsent}
										onSelectionChange={onResearchSelection}
									/>
								</div>
								<div hidden={assistTab !== "memo"}>
									<MemoPanel applicationId={app.id} caseStatus={app.status} />
								</div>
								<div hidden={assistTab !== "policy"}>
									<PolicyExceptionPanel applicationId={app.id} caseStatus={app.status} />
								</div>
								<div hidden={assistTab !== "ask"}>
									<CaseAssistantPanel
										key={app.id}
										applicationId={app.id}
										contextAnalysisConsent={app.contextAnalysisConsent}
									/>
								</div>
							</div>
						</section>
						{decided ? (
							<Panel title="Officer decision" outline>
								<p className="text-sm text-slate">Case is {app.status} — no decision needed.</p>
								{data.loan && (
									<p className="mt-3">
										<ButtonLink to="/officer/portfolio" variant="link">
											View portfolio
										</ButtonLink>
									</p>
								)}
							</Panel>
						) : (
							<DecisionPanel
								applicationId={app.id}
								requestedAmountCents={app.amountCents}
								requestedTermMonths={app.termMonths}
								maxAmountCents={data.policyEvaluation?.maxAmountCents ?? app.amountCents}
								product={app.product}
								researchSelection={researchSelection}
								onResearchStale={() => onResearchSelection(null)}
								onDecided={onDecided}
							/>
						)}
					</div>
				</aside>
			</div>
		</>
	);
}
