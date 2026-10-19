import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
	Card,
	EmptyState,
	ErrorBox,
	Field,
	inputCls,
	Page,
	Skeleton,
	StatusBadge,
} from "../../components/ui";
import {
	ApiError,
	api,
	apiErrorMessage,
	formatDate,
	formatDateTime,
	formatMoney,
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
		queryKey: ["loan", id],
		queryFn: () => api<LoanDetail>(`/api/loans/${id}`),
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
							<Link to="/loans" className="text-sm text-blue-700 hover:underline">
								Back to loans
							</Link>
						}
					/>
				) : (
					<ErrorBox message={apiErrorMessage(loan.error)} onRetry={() => void loan.refetch()} />
				)
			) : (
				<div className="space-y-4">
					<LoanSummaryCard detail={loan.data} />
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
			)}
		</Page>
	);
}

function LoanSummaryCard({ detail }: { detail: LoanDetail }) {
	const l = detail.loan;
	const openAlerts = detail.alerts.filter((a) => a.status === "open").length;
	return (
		<Card
			title={
				<span className="flex flex-wrap items-center gap-2">
					{l.reference} <StatusBadge status={l.status} />
					{openAlerts > 0 && (
						<span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800">
							{openAlerts} alert{openAlerts === 1 ? "" : "s"}
						</span>
					)}
				</span>
			}
		>
			<dl className="grid gap-1 text-sm sm:grid-cols-2">
				<div className="flex justify-between gap-2">
					<dt className="text-gray-500">Principal</dt>
					<dd className="font-medium tabular-nums">{formatMoney(l.principalCents)}</dd>
				</div>
				<div className="flex justify-between gap-2">
					<dt className="text-gray-500">Rate</dt>
					<dd className="font-medium tabular-nums">{(l.rateBps / 100).toFixed(2)}%</dd>
				</div>
				<div className="flex justify-between gap-2">
					<dt className="text-gray-500">Monthly</dt>
					<dd className="font-medium tabular-nums">{formatMoney(l.monthlyPaymentCents)}</dd>
				</div>
				<div className="flex justify-between gap-2">
					<dt className="text-gray-500">Outstanding</dt>
					<dd className="font-medium tabular-nums">{formatMoney(l.outstandingCents)}</dd>
				</div>
				<div className="flex justify-between gap-2">
					<dt className="text-gray-500">Next due</dt>
					<dd className="font-medium tabular-nums">{formatDate(l.nextDueDate)}</dd>
				</div>
				<div className="flex justify-between gap-2">
					<dt className="text-gray-500">Disbursed</dt>
					<dd className="font-medium tabular-nums">{formatDate(l.disbursedAt)}</dd>
				</div>
			</dl>
		</Card>
	);
}

function ScheduleCard({ detail }: { detail: LoanDetail }) {
	return (
		<Card title="Repayment schedule">
			<div className="overflow-x-auto">
				<table className="w-full min-w-[640px] text-left text-sm">
					<thead className="border-b border-gray-200 text-gray-500">
						<tr>
							<th className="px-2 py-1.5">#</th>
							<th className="px-2 py-1.5">Due</th>
							<th className="px-2 py-1.5">Total</th>
							<th className="px-2 py-1.5">Principal</th>
							<th className="px-2 py-1.5">Interest</th>
							<th className="px-2 py-1.5">Status</th>
							<th className="px-2 py-1.5">Paid</th>
						</tr>
					</thead>
					<tbody>
						{detail.installments.map((i) => (
							<tr key={i.id} className="border-b border-gray-100 last:border-0">
								<td className="px-2 py-1.5 tabular-nums">{i.number}</td>
								<td className="px-2 py-1.5 tabular-nums">{formatDate(i.dueDate)}</td>
								<td className="px-2 py-1.5 tabular-nums">{formatMoney(i.totalCents)}</td>
								<td className="px-2 py-1.5 tabular-nums">{formatMoney(i.principalCents)}</td>
								<td className="px-2 py-1.5 tabular-nums">{formatMoney(i.interestCents)}</td>
								<td className="px-2 py-1.5">
									<StatusBadge status={i.status} />
								</td>
								<td className="px-2 py-1.5 tabular-nums">
									{i.paidAt ? formatDate(i.paidAt) : "—"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{detail.payments.length > 0 && (
				<div className="mt-3">
					<h3 className="mb-1 text-sm font-semibold">Payments</h3>
					<ul className="space-y-1 text-sm">
						{detail.payments.map((p) => (
							<li key={p.id} className="tabular-nums">
								{formatMoney(p.amountCents)} · {formatDateTime(p.paidAt)} · {p.source}
							</li>
						))}
					</ul>
				</div>
			)}
		</Card>
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
				queryKey: ["loan", detail.loan.id],
			});
			onChanged();
		} catch (err) {
			toast(apiErrorMessage(err));
		}
	}
	return (
		<Card title="Alerts">
			{detail.alerts.length === 0 ? (
				<p className="text-sm text-gray-500">No alerts.</p>
			) : (
				<ul className="space-y-2 text-sm">
					{detail.alerts.map((a) => (
						<li key={a.id} className="flex flex-wrap items-center gap-2">
							<StatusBadge status={a.status} />
							<span className="font-medium">{a.type}</span>
							<span className="text-gray-500">severity {a.severity}</span>
							{isOfficer && a.status === "open" && (
								<button
									type="button"
									onClick={() => void acknowledge(a.id)}
									className="rounded border border-gray-300 px-2 py-1 text-xs font-medium"
									aria-label={`Acknowledge alert ${a.type}`}
								>
									Acknowledge
								</button>
							)}
						</li>
					))}
				</ul>
			)}
		</Card>
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
		<Card title="Demo controls (officer, demo mode)">
			<div className="flex flex-wrap items-center gap-2">
				<button
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
					className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
				>
					{busy === "pay"
						? "Paying…"
						: next
							? `Pay next installment (#${next.number})`
							: "All paid"}
				</button>
				<Field label="Age (days)">
					<input
						id="field-age-days"
						inputMode="numeric"
						value={days}
						onChange={(e) => setDays(e.target.value)}
						className={`${inputCls} w-24`}
					/>
				</Field>
				<button
					type="button"
					disabled={busy !== null}
					onClick={() =>
						void run("age", () =>
							api(`/api/demo/loans/${detail.loan.id}/age`, {
								method: "POST",
								body: { days: Number(days) },
							}),
						)
					}
					className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
				>
					{busy === "age" ? "Ageing…" : "Age loan"}
				</button>
				<button
					type="button"
					disabled={busy !== null}
					onClick={() =>
						void run("monitor", () => api("/api/demo/monitoring/run", { method: "POST" }))
					}
					className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
				>
					{busy === "monitor" ? "Running…" : "Run monitoring"}
				</button>
			</div>
			{result && (
				<output className="mt-2 block break-all font-mono text-xs text-gray-600">{result}</output>
			)}
		</Card>
	);
}
