import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { AppTable } from "../components/app-table";
import { DashboardBody } from "../components/dashboard-body";
import {
	ButtonLink,
	EmptyState,
	ErrorBox,
	Kpi,
	Meter,
	Money,
	Overline,
	Page,
	PageHead,
	Panel,
	Skeleton,
	StatusBadge,
} from "../components/ubs";
import {
	api,
	apiErrorMessage,
	fetchLoan,
	fetchReviewQueue,
	formatDate,
	formatMoney,
	productLabel,
	queryKeys,
	type AppSummary,
	type DashboardSummary,
	type LoanSummary,
} from "../lib/api";
import { useMe } from "../lib/auth";

export { AppTable };

export const Route = createFileRoute("/")({
	component: Landing,
});

function Landing() {
	const me = useMe();
	const navigate = useNavigate();
	useEffect(() => {
		if (me.isFetched && !me.data) void navigate({ to: "/login" });
	}, [me.isFetched, me.data, navigate]);
	if (!me.isFetched) {
		return (
			<Page>
				<Skeleton />
			</Page>
		);
	}
	if (!me.data) return null;
	return me.data.user.role === "officer" ? <OfficerLanding /> : <ApplicantLanding />;
}

const REVIEW_STATUSES = new Set(["submitted", "processing", "pending_review"]);

function ApplicantLanding() {
	const me = useMe();
	const apps = useQuery({
		queryKey: ["applications"],
		queryFn: () => api<{ items: AppSummary[] }>("/api/applications?limit=100"),
	});
	const loans = useQuery({
		queryKey: ["loans", "applicant-overview"],
		queryFn: () => api<{ items: LoanSummary[] }>("/api/loans?limit=50&offset=0"),
	});
	const firstName = (me.data?.user.fullName ?? "").split(" ").find(Boolean) ?? "there";

	const items = useMemo(() => apps.data?.items ?? [], [apps.data]);
	const bookedLoans = useMemo(
		() =>
			(loans.data?.items ?? [])
				.filter((l) => l.status !== "closed")
				.sort((a, b) => (b.disbursedAt ?? "").localeCompare(a.disbursedAt ?? "")),
		[loans.data],
	);
	const latestLoan = bookedLoans.length > 0 ? bookedLoans[0] : null;
	const detail = useQuery({
		queryKey: latestLoan ? queryKeys.loan(latestLoan.id) : ["loan", "none"],
		queryFn: () => fetchLoan(latestLoan!.id),
		enabled: !!latestLoan,
		retry: false,
	});

	const counts = useMemo(() => {
		const draft = items.filter((a) => a.status === "draft").length;
		const review = items.filter((a) => REVIEW_STATUSES.has(a.status)).length;
		const activeVolume = items
			.filter((a) => a.status === "booked")
			.reduce((sum, a) => sum + a.amountCents, 0);
		return { draft, review, open: draft + review, activeVolume };
	}, [items]);

	const subtitle =
		counts.review > 0
			? `We're reviewing ${counts.review} application${counts.review === 1 ? "" : "s"}. Everything else is in order.`
			: counts.draft > 0
				? `${counts.draft} draft${counts.draft === 1 ? " is" : "s are"} ready when you are. Nothing else needs your attention today.`
				: "Your applications and loans in one place. Nothing needs your attention today.";

	const activity = useMemo(() => {
		const events: Array<{ at: string; title: string; reference: string; status: string }> = [];
		for (const a of items) {
			if (a.submittedAt)
				events.push({
					at: a.submittedAt,
					title: "Application submitted",
					reference: a.reference,
					status: "submitted",
				});
			if (a.decidedAt)
				events.push({
					at: a.decidedAt,
					title: a.status === "booked" ? "Decision approved" : `Decision ${a.status}`,
					reference: a.reference,
					status: a.status,
				});
		}
		return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
	}, [items]);

	if (apps.isPending || loans.isPending) {
		return (
			<Page>
				<Skeleton />
			</Page>
		);
	}
	if (apps.isError) {
		return (
			<Page>
				<ErrorBox message={apiErrorMessage(apps.error)} onRetry={() => void apps.refetch()} />
			</Page>
		);
	}
	if (loans.isError) {
		return (
			<Page>
				<ErrorBox message={apiErrorMessage(loans.error)} onRetry={() => void loans.refetch()} />
			</Page>
		);
	}
	if (items.length === 0 && bookedLoans.length === 0) {
		return (
			<Page>
				<PageHead
					title={`Good morning, ${firstName}`}
					subtitle={subtitle}
					actions={
						<ButtonLink to="/apply" variant="outline">
							New application
						</ButtonLink>
					}
				/>
				<EmptyState
					title="No applications yet"
					hint="Start your first credit application."
					action={<ButtonLink to="/apply">New application</ButtonLink>}
				/>
			</Page>
		);
	}

	const paid = detail.data?.installments.filter((i) => i.status === "paid").length;
	const total = detail.data?.installments.length;
	const linkedApp = latestLoan ? items.find((a) => a.id === latestLoan.applicationId) : undefined;

	return (
		<Page>
			<PageHead
				title={`Good morning, ${firstName}`}
				subtitle={subtitle}
				actions={
					<ButtonLink to="/apply" variant="outline">
						New application
					</ButtonLink>
				}
			/>

			{latestLoan ? (
				<Panel className="mb-8">
					<div className="grid gap-8 lg:grid-cols-3">
						<div className="lg:col-span-1">
							<Overline>
								{latestLoan.status === "overdue" ? "Overdue" : "Active"} · {latestLoan.reference}
							</Overline>
							<h2 className="mt-3 text-3xl leading-10 font-light text-ink">
								Your {productLabel(linkedApp?.product ?? "personal_loan").toLowerCase()} of{" "}
								<Money cents={latestLoan.principalCents} /> is{" "}
								{latestLoan.status === "overdue" ? "overdue" : "active"}.
							</h2>
							<p className="mt-3 max-w-xl text-lg leading-7 font-light text-slate">
								{latestLoan.termMonths} months at {(latestLoan.rateBps / 100).toFixed(2)}% fixed
								{linkedApp ? ` · application ${linkedApp.reference}` : ""}. Disbursed{" "}
								{formatDate(latestLoan.disbursedAt)}.
							</p>
							<div className="mt-5 flex flex-wrap gap-3">
								<ButtonLink to={`/loans/${latestLoan.id}`}>View loan</ButtonLink>
								{linkedApp && (
									<ButtonLink to={`/applications/${linkedApp.id}`} variant="outline">
										View application
									</ButtonLink>
								)}
							</div>
						</div>
						<div className="lg:col-span-2 lg:border-l lg:border-rule lg:pl-8">
							<Overline>Next payment</Overline>
							<p className="mt-2 text-4xl leading-tight font-light text-ink tabular">
								<Money cents={latestLoan.monthlyPaymentCents} />
							</p>
							<p className="mt-1 text-sm text-slate">Due {formatDate(latestLoan.nextDueDate)}</p>
							{paid !== undefined && total !== undefined && (
								<div className="mt-4">
									<Meter value={paid} max={total} tone="ink" label="Instalments paid" />
									<p className="mt-2 text-sm text-slate">
										{paid} of {total} instalments paid
									</p>
								</div>
							)}
							<Link
								to="/loans/$id"
								params={{ id: latestLoan.id }}
								className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-ink hover:underline"
							>
								Payment details
								<ChevronRight
									className="size-4 text-red-link"
									strokeWidth={1.5}
									aria-hidden="true"
								/>
							</Link>
						</div>
					</div>
				</Panel>
			) : (
				items[0] && (
					<Panel className="mb-8">
						<Overline>
							{items[0].reference} · {productLabel(items[0].product)}
						</Overline>
						<h2 className="mt-3 text-3xl leading-10 font-light text-ink">
							Your application for <Money cents={items[0].amountCents} /> over {items[0].termMonths}{" "}
							months.
						</h2>
						<p className="mt-3 text-lg leading-7 font-light text-slate">
							Submitted {formatDate(items[0].submittedAt)} ·{" "}
							{items[0].status === "draft" ? "draft, not submitted yet" : items[0].status}
						</p>
						<div className="mt-5">
							<ButtonLink to={`/applications/${items[0].id}`}>View application</ButtonLink>
						</div>
					</Panel>
				)
			)}

			<div className="mb-8 grid gap-6 sm:grid-cols-3">
				<Kpi label="Applications" value={String(items.length).padStart(2, "0")} />
				<Kpi
					label="Active volume"
					value={<Money cents={counts.activeVolume} />}
					hint="Approved and funded"
				/>
				<Kpi
					label="Open items"
					value={String(counts.open).padStart(2, "0")}
					hint={
						counts.draft > 0
							? "Draft ready to continue"
							: counts.review > 0
								? "In review"
								: "All up to date"
					}
				/>
			</div>

			<div className="grid gap-6 lg:grid-cols-3">
				<div className="space-y-8 lg:col-span-2">
					<Panel
						title="Your applications"
						outline
						action={
							<Link
								to="/applications"
								className="inline-flex items-center gap-1 text-sm font-medium text-ink hover:underline"
							>
								All applications
								<ChevronRight
									className="size-4 text-red-link"
									strokeWidth={1.5}
									aria-hidden="true"
								/>
							</Link>
						}
					>
						<AppTable items={items} />
					</Panel>

					{activity.length > 0 && (
						<Panel title="Recent activity" outline>
							<ul className="divide-y divide-rule">
								{activity.map((e) => (
									<li key={`${e.at}-${e.reference}`} className="flex items-center gap-4 py-3">
										<span className="w-24 shrink-0 text-sm text-slate tabular">
											{formatDate(e.at)}
										</span>
										<span className="min-w-0 flex-1 text-sm text-ink">
											<span className="font-medium">{e.title}</span>
											<span className="text-slate"> · {e.reference}</span>
										</span>
										<StatusBadge status={e.status} />
									</li>
								))}
							</ul>
						</Panel>
					)}
				</div>

				<aside className="space-y-6">
					<Panel title="What happens next" tone="warm">
						<ol className="space-y-5">
							{latestLoan?.nextDueDate && (
								<li className="flex gap-3">
									<span className="text-sm font-medium text-slate">01</span>
									<span>
										<strong className="block text-sm font-medium text-ink">
											Your next payment
										</strong>
										<span className="text-sm text-slate">
											{formatMoney(latestLoan.monthlyPaymentCents)} · due{" "}
											{formatDate(latestLoan.nextDueDate)} · {latestLoan.reference}
										</span>
									</span>
								</li>
							)}
							<li className="flex gap-3">
								<span className="text-sm font-medium text-slate">
									{latestLoan?.nextDueDate ? "02" : "01"}
								</span>
								<span>
									<strong className="block text-sm font-medium text-ink">
										Track every application
									</strong>
									<span className="text-sm text-slate">
										Decisions appear here as soon as they are ready.
									</span>
								</span>
							</li>
							<li className="flex gap-3">
								<span className="text-sm font-medium text-slate">
									{latestLoan?.nextDueDate ? "03" : "02"}
								</span>
								<span>
									<strong className="block text-sm font-medium text-ink">
										Thinking about another goal?
									</strong>
									<span className="text-sm text-slate">
										You can start a new application at any time.
									</span>
								</span>
							</li>
						</ol>
						<div className="mt-5">
							<ButtonLink to="/apply" variant="outline">
								Start an application
							</ButtonLink>
						</div>
					</Panel>

					<Panel title="Questions?" outline>
						<p className="text-sm text-slate">
							Demo support: decisions and repayment schedules are explained on each application and
							loan page.
						</p>
						<a
							href="https://www.ubs.com/global/en/contact.html"
							target="_blank"
							rel="noreferrer"
							className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-ink hover:underline"
						>
							Visit the help centre
							<ChevronRight className="size-4 text-red-link" strokeWidth={1.5} aria-hidden="true" />
						</a>
					</Panel>
				</aside>
			</div>
		</Page>
	);
}

function OfficerLanding() {
	const dash = useQuery({
		queryKey: ["dashboard"],
		queryFn: () => api<DashboardSummary>("/api/dashboard/summary"),
	});
	const queue = useQuery({
		queryKey: queryKeys.reviewQueue,
		queryFn: fetchReviewQueue,
		refetchInterval: 5000,
	});
	return (
		<Page>
			{dash.isPending || queue.isPending ? (
				<Skeleton />
			) : dash.isError ? (
				<ErrorBox message={apiErrorMessage(dash.error)} onRetry={() => void dash.refetch()} />
			) : queue.isError ? (
				<ErrorBox message={apiErrorMessage(queue.error)} onRetry={() => void queue.refetch()} />
			) : (
				<DashboardBody data={dash.data} items={queue.data.items} summary={queue.data.summary} />
			)}
		</Page>
	);
}
