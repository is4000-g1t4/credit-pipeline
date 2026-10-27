// Applicant case detail (SPEC ubs-ui-backend §3, prototype
// `.scratch/ubs-redesign` ApplicationDetail): application summary, decision,
// requirements, documents and timeline in an 8/4 grid with a warm assist rail.
// Safe projection only — identity/financial/business via fieldLabel helpers,
// no score/policy/external-report rendering.
import { reasonText } from "@credit/core/browser";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Steps } from "../applicant/steps";
import { DocumentPanel } from "../document-panel";
import { CustomerSnapshot, RequirementsPanel } from "../requirements-panel";
import { ButtonLink, CodeTag, Money, Overline, Panel, StatusBadge, Tag } from "../ubs";
import {
	actionLabel,
	fieldLabel,
	formatDate,
	formatDateOnly,
	formatDateTime,
	formatFieldValue,
	formatMoney,
	productLabel,
	type CaseDetail,
} from "../../lib/api";

const PROGRESS = ["Submitted", "Verification", "Decision", "Funds released"];

function progressFor(status: string): number | null {
	if (status === "submitted") return 1;
	if (status === "processing" || status === "pending_review") return 2;
	if (status === "booked") return 4;
	if (status === "declined" || status === "expired" || status === "failed") return 3;
	return null;
}

function Kv({ k, v }: { k: string; v: ReactNode }) {
	return (
		<div className="flex flex-wrap justify-between gap-2 py-1 text-sm">
			<dt className="text-slate">{k}</dt>
			<dd className="font-medium break-all text-ink">{v}</dd>
		</div>
	);
}

function SummaryCell({ k, v }: { k: string; v: ReactNode }) {
	return (
		<div>
			<dt className="text-xs text-slate">{k}</dt>
			<dd className="mt-1 text-sm font-medium text-ink">{v}</dd>
		</div>
	);
}

function DetailFields({ title, fields }: { title: string; fields: Record<string, unknown> }) {
	const entries = Object.entries(fields);
	if (entries.length === 0) return null;
	return (
		<div className="mt-4 first:mt-0">
			<h4 className="mb-1 text-sm font-medium text-ink">{title}</h4>
			<dl className="divide-y divide-rule">
				{entries.map(([k, v]) => (
					<Kv key={k} k={fieldLabel(k)} v={formatFieldValue(k, v)} />
				))}
			</dl>
		</div>
	);
}

export function ApplicantCaseView({ data }: { data: CaseDetail }) {
	const { application: app, decision, loan } = data;
	const progress = progressFor(app.status);
	const isDraft = app.status === "draft";
	const showChecklist = isDraft || app.status === "submitted";
	const showNext =
		isDraft ||
		app.status === "submitted" ||
		app.status === "processing" ||
		app.status === "pending_review";
	const codes = (decision?.reasons ?? []).map((r) => (typeof r === "string" ? r : r.code));
	const timeline = data.timeline
		.filter((e) => !/^(access\.|context\.read|policy_exception\.viewed)/.test(e.action ?? ""))
		.slice(0, 20);

	return (
		<div className="space-y-8">
			{isDraft ? (
				<Panel tone="warm">
					<p className="text-sm text-ink">
						<Tag tone="neutral">Draft</Tag>{" "}
						<span className="ml-1">
							Not submitted yet. Complete the checklist below, then submit when ready.
						</span>
					</p>
				</Panel>
			) : (
				progress !== null && <Steps steps={PROGRESS} current={progress} />
			)}

			<div className="grid gap-8 lg:grid-cols-12">
				<div className="min-w-0 space-y-8 lg:col-span-8">
					<Panel title="Application summary" outline>
						<dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
							<SummaryCell k="Reference" v={app.reference} />
							<SummaryCell k="Product" v={productLabel(app.product)} />
							<SummaryCell k="Amount" v={<Money cents={app.amountCents} />} />
							<SummaryCell k="Term" v={`${app.termMonths} months`} />
							<SummaryCell k="Purpose" v={app.purpose || "—"} />
							<SummaryCell k="Submitted" v={app.submittedAt ? formatDate(app.submittedAt) : "—"} />
							<SummaryCell
								k="Decision"
								v={app.decidedAt ? formatDateTime(app.decidedAt) : "Not decided"}
							/>
							<SummaryCell k="Status" v={<StatusBadge status={app.status} />} />
						</dl>
					</Panel>

					<Panel title="Your details" outline>
						<DetailFields title="Identity" fields={app.identity} />
						{app.financial && <DetailFields title="Financial" fields={app.financial} />}
						{app.business && <DetailFields title="Business" fields={app.business} />}
					</Panel>

					{decision && (
						<Panel title={`Decision: ${decision.outcome} (${decision.decidedBy})`} outline>
							<dl className="divide-y divide-rule">
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
									v={
										codes.length > 0 ? codes.map((c) => `${c} — ${reasonText(c)}`).join("; ") : "—"
									}
								/>
								<Kv k="Decided" v={formatDateTime(decision.decidedAt)} />
							</dl>
						</Panel>
					)}

					{data.failure && (
						<Panel title={<CodeTag code={data.failure.code} />} outline>
							<p className="text-sm text-ink">{data.failure.message}</p>
						</Panel>
					)}

					{showChecklist && (
						<>
							<RequirementsPanel applicationId={app.id} status={app.status} />
							<CustomerSnapshot />
						</>
					)}

					<DocumentPanel
						applicationId={app.id}
						mode="applicant"
						documentsEnabled={app.documentsEnabled ?? false}
						documentProcessingConsent={app.documentProcessingConsent}
					/>

					<Panel title="Timeline" outline>
						{timeline.length === 0 ? (
							<p className="text-sm text-slate">No activity yet.</p>
						) : (
							<ol className="divide-y divide-rule text-sm">
								{timeline.map((e, index) => (
									<li
										// Repeated audit actions can share a timestamp.
										key={`${e.at}-${e.action ?? ""}-${index}`}
										className="flex flex-wrap gap-x-3 gap-y-0.5 py-2"
									>
										<span className="tabular text-slate">{formatDateTime(e.at)}</span>
										<span className="font-medium text-ink">{actionLabel(e.action)}</span>
									</li>
								))}
							</ol>
						)}
					</Panel>
				</div>

				<aside className="min-w-0 space-y-8 lg:col-span-4">
					{loan && (
						<Panel title="Your loan" tone="warm">
							<Overline>Outstanding balance</Overline>
							<p className="mt-1 text-3xl leading-10 font-light tabular text-ink">
								<Money cents={loan.outstandingCents} />
							</p>
							<p className="mt-1 text-sm text-slate">
								of <Money cents={loan.principalCents} /> principal
							</p>
							<dl className="mt-4 divide-y divide-rule">
								<Kv k="Monthly payment" v={formatMoney(loan.monthlyPaymentCents)} />
								<Kv k="Next due" v={formatDateOnly(loan.nextDueDate)} />
								<Kv
									k="Instalments"
									v={`${loan.installments.paid} of ${loan.installments.total} paid${loan.installments.overdue > 0 ? `, ${loan.installments.overdue} overdue` : ""}`}
								/>
							</dl>
							<ButtonLink to={`/loans/${loan.id}`} variant="secondary" className="mt-4 w-full">
								View payment schedule
							</ButtonLink>
						</Panel>
					)}

					{showNext && (
						<Panel title="What happens next" tone="warm">
							<p className="text-sm text-ink">
								{isDraft
									? "Your draft is saved. Submit it from the checklist to start verification — nothing is sent until you submit."
									: "We are verifying your application and running the affordability and policy checks. You will see the decision here."}
							</p>
							<dl className="mt-3 divide-y divide-rule">
								<Kv k="Reference" v={app.reference} />
							</dl>
							<Link
								to="/applications"
								className="mt-3 inline-block text-sm text-red-link hover:underline"
							>
								Back to applications
							</Link>
						</Panel>
					)}

					<Panel title="Questions?" outline>
						<p className="text-sm text-slate">
							Quote your reference <span className="font-medium text-ink">{app.reference}</span>{" "}
							when you contact us.
						</p>
						<ul className="mt-3 space-y-2 text-sm">
							<li>
								<a
									href="https://www.ubs.com/global/en/contact.html"
									target="_blank"
									rel="noreferrer"
									className="text-red-link hover:underline"
								>
									Help centre
								</a>
							</li>
							<li>
								<a
									href="https://www.ubs.com/global/en/contact.html"
									target="_blank"
									rel="noreferrer"
									className="text-red-link hover:underline"
								>
									Contact UBS
								</a>
							</li>
						</ul>
					</Panel>
				</aside>
			</div>
		</div>
	);
}
