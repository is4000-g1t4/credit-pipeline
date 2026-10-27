// Shared applicant application table (routes/index + applications/index).
import { Link } from "@tanstack/react-router";
import { type AppSummary, formatDate, formatMoney } from "../lib/api";
import { StatusBadge } from "./ui";

export function AppTable({ items }: { items: AppSummary[] }) {
	return (
		<div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
			<table className="w-full min-w-[640px] text-left text-sm">
				<thead className="border-b border-gray-200 text-gray-500">
					<tr>
						<th className="px-3 py-2">Reference</th>
						<th className="px-3 py-2">Type / product</th>
						<th className="px-3 py-2">Amount</th>
						<th className="px-3 py-2">Status</th>
						<th className="px-3 py-2">Submitted</th>
					</tr>
				</thead>
				<tbody>
					{items.map((a) => (
						<tr key={a.id} className="border-b border-gray-100 last:border-0">
							<td className="px-3 py-2">
								<Link
									to="/applications/$id"
									params={{ id: a.id }}
									className="font-mono text-blue-700 hover:underline"
								>
									{a.reference}
								</Link>
							</td>
							<td className="px-3 py-2">
								{a.type} / {a.product}
							</td>
							<td className="px-3 py-2 tabular-nums">{formatMoney(a.amountCents)}</td>
							<td className="px-3 py-2">
								<StatusBadge status={a.status} />
							</td>
							<td className="px-3 py-2 tabular-nums">{formatDate(a.submittedAt)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
