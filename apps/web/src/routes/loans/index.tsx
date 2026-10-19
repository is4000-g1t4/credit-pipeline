import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState, ErrorBox, Page, Skeleton, StatusBadge } from "../../components/ui";
import { api, apiErrorMessage, formatDate, formatMoney, type LoanSummary } from "../../lib/api";
import { RequireAuth } from "../../lib/auth";

export const Route = createFileRoute("/loans/")({
	component: () => (
		<RequireAuth>
			<Loans />
		</RequireAuth>
	),
});

function Loans() {
	const loans = useQuery({
		queryKey: ["loans"],
		queryFn: () => api<{ items: LoanSummary[] }>("/api/loans"),
	});
	return (
		<Page>
			<h1 className="mb-4 text-xl font-bold">Loans</h1>
			{loans.isPending ? (
				<Skeleton />
			) : loans.isError ? (
				<ErrorBox message={apiErrorMessage(loans.error)} onRetry={() => void loans.refetch()} />
			) : loans.data.items.length === 0 ? (
				<EmptyState title="No loans yet" hint="Booked loans will appear here." />
			) : (
				<div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
					<table className="w-full min-w-[720px] text-left text-sm">
						<thead className="border-b border-gray-200 text-gray-500">
							<tr>
								<th className="px-3 py-2">Reference</th>
								<th className="px-3 py-2">Principal</th>
								<th className="px-3 py-2">Rate</th>
								<th className="px-3 py-2">Status</th>
								<th className="px-3 py-2">Next due</th>
								<th className="px-3 py-2">Outstanding</th>
							</tr>
						</thead>
						<tbody>
							{loans.data.items.map((l) => (
								<tr key={l.id} className="border-b border-gray-100 last:border-0">
									<td className="px-3 py-2">
										<Link
											to="/loans/$id"
											params={{ id: l.id }}
											className="font-mono text-blue-700 hover:underline"
										>
											{l.reference}
										</Link>
									</td>
									<td className="px-3 py-2 tabular-nums">{formatMoney(l.principalCents)}</td>
									<td className="px-3 py-2 tabular-nums">{(l.rateBps / 100).toFixed(2)}%</td>
									<td className="px-3 py-2">
										<StatusBadge status={l.status} />
									</td>
									<td className="px-3 py-2 tabular-nums">{formatDate(l.nextDueDate)}</td>
									<td className="px-3 py-2 tabular-nums">{formatMoney(l.outstandingCents)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</Page>
	);
}
