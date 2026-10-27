import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	EmptyState,
	ErrorBox,
	Meter,
	Money,
	Overline,
	Page,
	PageHead,
	Panel,
	SectionHead,
	StatusBadge,
	Tag,
	Skeleton,
} from "../../components/ubs";
import {
	ApiError,
	api,
	apiErrorMessage,
	fetchLoan,
	formatDate,
	formatDateTime,
	formatMoney,
	queryKeys,
	type LoanDetail,
	toast,
} from "../../lib/api";
import { RequireAuth, useMe } from "../../lib/auth";

export const Route = createFileRoute("/loans/$id")({
	component: () => (
		<RequireAuth>
			<LoanPage />
		</RequireAuth>
	),
});

function LoanPage() {
	const { id } = Route.useParams();
	const me = useMe();
	const loan = useQuery({
		queryKey: queryKeys.loan(id),
		queryFn: () => fetchLoan(id),
		retry: false,
	});
	return (
		<Page>
			{loan.isPending ? (
				<Skeleton label="Loading loan" />
			) : loan.isError ? (
				loan.error instanceof ApiError && loan.error.status === 404 ? (
					<EmptyState
						title="Loan not found"
						action={
							<Link to="/loans" className="text-sm text-red-link hover:underline">
								Back to loans
							</Link>
						}
					/>
				) : (
					<ErrorBox message={apiErrorMessage(loan.error)} onRetry={() => void loan.refetch()} />
				)
			) : (
				<div className="space-y-8">
					<LoanHead detail={loan.data} />
					<LoanHero detail={loan.data} />
					<div className="grid gap-6 lg:grid-cols-3">
						<div className="space-y-8 lg:col-span-2">
							<ScheduleCard detail={loan.data} />
							<AlertsCard
								detail={loan.data}
								isOfficer={me.data?.user.role === "officer"}
								onChanged={() => void loan.refetch()}
							/>
							{me.data?.demoMode && me.data.user.role === "officer" && (
								<DemoPanel detail={loan.data} onChanged={() => void loan.refetch()} />
							)}
						</div>
						<aside className="space-y-6">
							<Panel title="Payment details" tone="warm">
								<dl className="grid gap-3">
									<div className="flex items-baseline justify-between gap-4">
										<dt className="text-sm text-slate">Loan reference</dt>
										<dd className="text-sm font-medium text-ink tabular">
											{loan.data.loan.reference}
										</dd>
									</div>
									<div className="flex items-baseline justify-between gap-4">
										<dt className="text-sm text-slate">Status</dt>
										<dd>
											<StatusBadge status={loan.data.loan.status} />
										</dd>
									</div>
									<div className="flex items-baseline justify-between gap-4">
										<dt className="text-sm text-slate">Disbursed</dt>
										<dd className="text-sm text-ink tabular">
											{formatDate(loan.data.loan.disbursedAt)}
										</dd>
									</div>
									<div className="flex items-baseline justify-between gap-4">
										<dt className="text-sm text-slate">Next due</dt>
										<dd className="text-sm font-medium text-ink tabular">
											{formatDate(loan.data.loan.nextDueDate)}
										</dd>
									</div>
									<div className="flex items-baseline justify-between gap-4">
										<dt className="text-sm text-slate">Outstanding</dt>
										<dd className="text-sm font-medium text-ink">
											<Money cents={loan.data.loan.outstandingCents} />
										</dd>
									</div>
								</dl>
							</Panel>
							<Panel title="Need help?" outline>
								<p className="text-sm text-slate">
									If a payment looks unexpected or you need more time, talk to us before the due
									date.
								</p>
								<a
									href="https://www.ubs.com/global/en/contact.html"
									target="_blank"
									rel="noreferrer"
									className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-ink hover:underline"
								>
									Visit the help centre
									<ChevronRight
										className="size-4 text-red-link"
										strokeWidth={1.5}
										aria-hidden="true"
									/>
								</a>
							</Panel>
						</aside>
					</div>
				</div>
			)}
		</Page>
	);
}

function LoanHead({ detail }: { detail: LoanDetail }) {
	const l = detail.loan;
	const openAlerts = detail.alerts.filter((a) => a.status === "open").length;
	return (
		<PageHead
			title={l.reference}
			subtitle={`${formatMoney(l.principalCents)} over ${l.termMonths} months at ${(
				l.rateBps / 100
			).toFixed(2)}% fixed.`}
			actions={
				<>
					<StatusBadge status={l.status} />
					{openAlerts > 0 && (
						<Tag tone="danger">
							{openAlerts} alert{openAlerts === 1 ? "" : "s"}
						</Tag>
					)}
				</>
			}
		/>
	);
}

function LoanHero({ detail }: { detail: LoanDetail }) {
	const l = detail.loan;
	const paid = detail.installments.filter((i) => i.status === "paid").length;
	const total = detail.installments.length;
	const overdue = detail.installments.filter((i) => i.status === "overdue").length;
	const openAlerts = detail.alerts.filter((a) => a.status === "open").length;
	return (
		<Panel>
			<div className="grid gap-8 lg:grid-cols-3">
				<div>
					<Overline>Outstanding balance</Overline>
					<p className="mt-2 text-4xl leading-tight font-light text-ink tabular">
						<Money cents={l.outstandingCents} />
					</p>
					<p className="mt-1 text-sm text-slate">
						of <Money cents={l.principalCents} /> principal · {paid} of {total} instalments paid
					</p>
					<Meter value={paid} max={Math.max(total, 1)} tone="ink" label="Instalments paid" />
				</div>
				<div className="grid gap-6 sm:grid-cols-3 lg:col-span-2 lg:border-l lg:border-rule lg:pl-8">
					<div>
						<Overline>Next payment</Overline>
						<p className="mt-2 text-2xl leading-8 font-light text-ink tabular">
							<Money cents={l.monthlyPaymentCents} />
						</p>
						<p className="mt-1 text-sm text-slate">Due {formatDate(l.nextDueDate)}</p>
					</div>
					<div>
						<Overline>Rate</Overline>
						<p className="mt-2 text-2xl leading-8 font-light text-ink tabular">
							{(l.rateBps / 100).toFixed(2)}%
						</p>
						<p className="mt-1 text-sm text-slate">Fixed for the term</p>
					</div>
					<div>
						<Overline>Overdue</Overline>
						<p className="mt-2 text-2xl leading-8 font-light text-ink tabular">{overdue}</p>
						<p className="mt-1 text-sm text-slate">
							{openAlerts > 0
								? `${openAlerts} open alert${openAlerts === 1 ? "" : "s"}`
								: "No alerts"}
						</p>
					</div>
				</div>
			</div>
		</Panel>
	);
}

function ScheduleCard({ detail }: { detail: LoanDetail }) {
	return (
		<Panel title="Repayment schedule" outline>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>#</TableHead>
						<TableHead>
							<span className="block text-right">Due</span>
						</TableHead>
						<TableHead>
							<span className="block text-right">Total</span>
						</TableHead>
						<TableHead>
							<span className="block text-right">Principal</span>
						</TableHead>
						<TableHead>
							<span className="block text-right">Interest</span>
						</TableHead>
						<TableHead>Status</TableHead>
						<TableHead>
							<span className="block text-right">Paid</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{detail.installments.map((i) => (
						<TableRow key={i.id}>
							<TableCell>
								<span className="tabular">{i.number}</span>
							</TableCell>
							<TableCell>
								<span className="block text-right tabular">{formatDate(i.dueDate)}</span>
							</TableCell>
							<TableCell>
								<span className="block text-right tabular">
									<Money cents={i.totalCents} />
								</span>
							</TableCell>
							<TableCell>
								<span className="block text-right tabular">
									<Money cents={i.principalCents} />
								</span>
							</TableCell>
							<TableCell>
								<span className="block text-right tabular">
									<Money cents={i.interestCents} />
								</span>
							</TableCell>
							<TableCell>
								<StatusBadge status={i.status} />
							</TableCell>
							<TableCell>
								<span className="block text-right tabular">
									{i.paidAt ? formatDate(i.paidAt) : "—"}
								</span>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
			{detail.payments.length > 0 && (
				<div className="mt-6">
					<h3 className="mb-2 text-lg font-light text-ink">Payments</h3>
					<ul className="space-y-1 text-sm text-ink">
						{detail.payments.map((p) => (
							<li key={p.id} className="tabular">
								<Money cents={p.amountCents} /> · {formatDateTime(p.paidAt)} · {p.source}
							</li>
						))}
					</ul>
				</div>
			)}
		</Panel>
	);
}

function AlertsCard({
	detail,
	isOfficer,
	onChanged,
}: {
	detail: LoanDetail;
	isOfficer: boolean;
	onChanged: () => void;
}) {
	const queryClient = useQueryClient();
	async function acknowledge(alertId: string) {
		try {
			await api(`/api/loans/${detail.loan.id}/alerts/${alertId}/acknowledge`, {
				method: "POST",
			});
			await queryClient.invalidateQueries({
				queryKey: queryKeys.loan(detail.loan.id),
			});
			onChanged();
		} catch (err) {
			toast(apiErrorMessage(err));
		}
	}
	return (
		<section>
			<SectionHead title="Alerts" />
			{detail.alerts.length === 0 ? (
				<p className="text-sm text-slate">No alerts.</p>
			) : (
				<ul className="space-y-2 text-sm">
					{detail.alerts.map((a) => (
						<li key={a.id} className="flex flex-wrap items-center gap-2">
							<StatusBadge status={a.status} />
							<span className="font-medium text-ink">{a.type}</span>
							<span className="text-slate">severity {a.severity}</span>
							{isOfficer && a.status === "open" && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void acknowledge(a.id)}
									aria-label={`Acknowledge alert ${a.type}`}
								>
									Acknowledge
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function DemoPanel({ detail, onChanged }: { detail: LoanDetail; onChanged: () => void }) {
	const [days, setDays] = useState("30");
	const [result, setResult] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const next = detail.installments
		.filter((i) => i.status !== "paid")
		.sort((a, b) => a.number - b.number)[0];

	async function run(label: string, fn: () => Promise<unknown>) {
		setBusy(label);
		setResult("");
		try {
			const out = await fn();
			setResult(JSON.stringify(out));
			onChanged();
		} catch (err) {
			const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : apiErrorMessage(err);
			setResult(msg);
			toast(msg);
		} finally {
			setBusy(null);
		}
	}

	return (
		<Panel title="Demo controls (officer, demo mode)" outline>
			<div className="flex flex-wrap items-end gap-3">
				<Button
					type="button"
					disabled={busy !== null || !next}
					onClick={() =>
						void run("pay", () =>
							api(`/api/demo/loans/${detail.loan.id}/pay`, {
								method: "POST",
								body: { installmentId: next?.id },
							}),
						)
					}
				>
					{busy === "pay"
						? "Paying…"
						: next
							? `Pay next installment (#${next.number})`
							: "All paid"}
				</Button>
				<div className="space-y-2">
					<Label htmlFor="field-age-days">Age (days)</Label>
					<div className="w-24">
						<Input
							id="field-age-days"
							inputMode="numeric"
							value={days}
							onChange={(e) => setDays(e.target.value)}
						/>
					</div>
				</div>
				<Button
					type="button"
					variant="outline"
					disabled={busy !== null}
					onClick={() =>
						void run("age", () =>
							api(`/api/demo/loans/${detail.loan.id}/age`, {
								method: "POST",
								body: { days: Number(days) },
							}),
						)
					}
				>
					{busy === "age" ? "Ageing…" : "Age loan"}
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={busy !== null}
					onClick={() =>
						void run("monitor", () => api("/api/demo/monitoring/run", { method: "POST" }))
					}
				>
					{busy === "monitor" ? "Running…" : "Run monitoring"}
				</Button>
			</div>
			{result && <output className="mt-2 block text-xs break-all text-slate">{result}</output>}
		</Panel>
	);
}
