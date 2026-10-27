import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
	AreaChart,
	BarRow,
	CodeTag,
	EmptyState,
	ErrorBox,
	Kpi,
	Money,
	Page,
	PageHead,
	Panel,
	SectionHead,
	Skeleton,
	StatusBadge,
	Tag,
} from "../../components/ubs";
import { api } from "../../lib/api";
import { formatDate } from "../../lib/api/format";
import { RequireAuth } from "../../lib/auth";
import { clean, friendlyMessage } from "../../lib/format";

export const Route = createFileRoute("/officer/portfolio")({
	component: () => (
		<RequireAuth allow="officer">
			<Portfolio />
		</RequireAuth>
	),
});

interface PortfolioAlert {
	id: string;
	loanId: string;
	reference: string;
	type: string;
	severity: string;
	status: string;
	createdAt: string;
}

interface PortfolioSummary {
	principalCents: number;
	outstandingCents: number;
	overdueExposureCents: number;
	activeLoans: number;
	overdueLoans: number;
	openAlerts: number;
	alertsTotal: number;
	alertsTruncated: boolean;
	coverageRatio: number | null;
	series: Array<{ weekStart: string; bookedCents: number }>;
	composition: Array<{ product: string; outstandingCents: number }>;
	alerts: PortfolioAlert[];
}

const CHART_COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
	"var(--chart-6)",
];

function productLabel(product: string): string {
	switch (product) {
		case "sme_term_loan":
			return "SME term loans";
		case "personal_loan":
			return "Personal loans";
		default:
			return product;
	}
}

function Portfolio() {
	const queryClient = useQueryClient();
	const summary = useQuery({
		queryKey: ["portfolio-summary"],
		queryFn: () => api<PortfolioSummary>("/api/portfolio/summary"),
		retry: false,
	});

	return (
		<Page>
			<PageHead
				title="Portfolio"
				subtitle="Current book, booked volume and early-warning alerts."
				actions={
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void queryClient.invalidateQueries({ queryKey: ["portfolio-summary"] })}
					>
						Refresh
					</Button>
				}
			/>
			{summary.isPending ? (
				<Skeleton label="Loading portfolio" />
			) : summary.isError ? (
				<ErrorBox message={friendlyMessage(summary.error)} onRetry={() => void summary.refetch()} />
			) : (
				<PortfolioBody data={summary.data} />
			)}
		</Page>
	);
}

function PortfolioBody({ data }: { data: PortfolioSummary }) {
	const totalBooked = data.series.reduce((n, s) => n + s.bookedCents, 0);
	const bookTotal = data.composition.reduce((n, c) => n + c.outstandingCents, 0);

	return (
		<div className="space-y-12">
			<section aria-label="Portfolio summary" className="grid grid-cols-2 gap-6 lg:grid-cols-4">
				<Kpi
					label="Book principal"
					value={<Money cents={data.principalCents} />}
					hint={`${data.activeLoans} active loans`}
				/>
				<Kpi
					label="Outstanding"
					value={<Money cents={data.outstandingCents} />}
					hint="Current book"
				/>
				<Kpi
					label="Overdue exposure"
					value={<Money cents={data.overdueExposureCents} />}
					hint={`${data.overdueLoans} overdue loans`}
				/>
				<Kpi
					label="Active / overdue loans"
					value={`${data.activeLoans} / ${data.overdueLoans}`}
					hint="Overdue is a subset of the book"
				/>
			</section>

			<div className="grid gap-8 lg:grid-cols-3">
				<div className="space-y-8 lg:col-span-2">
					<Panel title="Booked volume" action={<Tag tone="neutral">Last 12 weeks</Tag>} outline>
						<p className="text-4xl font-light text-ink tabular">
							<Money cents={totalBooked} />
						</p>
						<p className="mt-1 text-sm text-slate">Booked principal in the period</p>
						<div className="mt-4">
							<AreaChart
								values={data.series.map((s) => s.bookedCents)}
								labels={data.series.map((s) => s.weekStart.slice(5).replace("-", "/"))}
								unit="Booked principal · USD · by SGT reporting week"
							/>
						</div>
					</Panel>

					<section aria-label="Open alerts">
						<SectionHead
							title="Open alerts"
							action={
								<Tag tone={data.openAlerts > 0 ? "warning" : "neutral"}>{data.openAlerts} open</Tag>
							}
						/>
						{data.alerts.length === 0 ? (
							<EmptyState
								title="No open alerts"
								hint="Early-warning alerts on current-book loans will appear here."
							/>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full min-w-180 text-left text-base">
									<thead>
										<tr className="border-b border-rule-illustrative">
											<th className="overline px-3 py-2">Loan</th>
											<th className="overline px-3 py-2">Type</th>
											<th className="overline px-3 py-2">Severity</th>
											<th className="overline px-3 py-2">Status</th>
											<th className="overline px-3 py-2 text-right">Created</th>
										</tr>
									</thead>
									<tbody>
										{data.alerts.map((alert) => (
											<tr
												key={alert.id}
												className="border-b border-rule-illustrative last:border-0 hover:bg-raised"
											>
												<td className="px-3 py-3">
													<Link
														to="/loans/$id"
														params={{ id: alert.loanId }}
														className="text-red-link hover:underline"
													>
														{clean(alert.reference)}
													</Link>
												</td>
												<td className="px-3 py-3">
													<CodeTag code={alert.type} />
												</td>
												<td className="px-3 py-3">
													<StatusBadge status={alert.severity} />
												</td>
												<td className="px-3 py-3">
													<StatusBadge status={alert.status} />
												</td>
												<td className="px-3 py-3 text-right text-sm text-slate tabular">
													{formatDate(alert.createdAt)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
						{data.alertsTruncated && (
							<p className="mt-2 text-sm text-slate">
								Showing {data.alerts.length} of {data.alertsTotal} — acknowledge alerts on the loan
								page.
							</p>
						)}
					</section>
				</div>

				<aside className="space-y-8">
					<Panel title="Composition" tone="warm">
						<div className="space-y-4">
							{data.composition.length === 0 ? (
								<p className="text-sm text-slate">No current-book exposure.</p>
							) : (
								data.composition.map((entry, i) => (
									<BarRow
										key={entry.product}
										label={productLabel(entry.product)}
										value={clean(
											new Intl.NumberFormat("en-US", {
												style: "currency",
												currency: "USD",
												maximumFractionDigits: 0,
											}).format(entry.outstandingCents / 100),
										)}
										pct={bookTotal > 0 ? (entry.outstandingCents / bookTotal) * 100 : 0}
										color={CHART_COLORS[i % CHART_COLORS.length] ?? "var(--chart-1)"}
									/>
								))
							)}
						</div>
						<div className="mt-6 border-t border-rule pt-4">
							<p className="text-sm text-slate">
								Provision coverage:{" "}
								<span className="tabular">
									{data.coverageRatio === null || data.coverageRatio === undefined
										? "—"
										: `${data.coverageRatio.toFixed(1)}×`}
								</span>
							</p>
							<p className="mt-1 text-xs text-slate">
								No provision source exists; coverage is not computed.
							</p>
						</div>
					</Panel>
				</aside>
			</div>
		</div>
	);
}
