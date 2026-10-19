import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState, ErrorBox, Page, Skeleton, StatusBadge } from "../../../components/ui";
import {
	api,
	apiErrorMessage,
	formatDate,
	formatMoney,
	formatWait,
	type QueueItem,
} from "../../../lib/api";
import { RequireAuth } from "../../../lib/auth";

export const Route = createFileRoute("/officer/review/")({
	component: () => (
		<RequireAuth allow="officer">
			<Queue />
		</RequireAuth>
	),
});

function Queue() {
	const queue = useQuery({
		queryKey: ["review-queue"],
		queryFn: () => api<{ items: QueueItem[] }>("/api/review/queue"),
		refetchInterval: 5000,
	});
	return (
		<Page>
			<h1 className="mb-4 text-xl font-bold">Review queue</h1>
			{queue.isPending ? (
				<Skeleton />
			) : queue.isError ? (
				<ErrorBox message={apiErrorMessage(queue.error)} onRetry={() => void queue.refetch()} />
			) : queue.data.items.length === 0 ? (
				<EmptyState
					title="Queue is empty"
					hint="Referred applications will appear here, oldest first."
				/>
			) : (
				<div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
					<table className="w-full min-w-[760px] text-left text-sm">
						<thead className="border-b border-gray-200 text-gray-500">
							<tr>
								<th className="px-3 py-2">Reference</th>
								<th className="px-3 py-2">Type / product</th>
								<th className="px-3 py-2">Amount</th>
								<th className="px-3 py-2">Submitted</th>
								<th className="px-3 py-2">Wait</th>
								<th className="px-3 py-2">Score / grade</th>
								<th className="px-3 py-2">Top reasons</th>
							</tr>
						</thead>
						<tbody>
							{queue.data.items.map((q) => (
								<tr key={q.id} className="border-b border-gray-100 last:border-0">
									<td className="px-3 py-2">
										<Link
											to="/officer/review/$id"
											params={{ id: q.id }}
											className="font-mono text-blue-700 hover:underline"
										>
											{q.reference}
										</Link>
									</td>
									<td className="px-3 py-2">
										{q.type} / {q.product}
									</td>
									<td className="px-3 py-2 tabular-nums">{formatMoney(q.amountCents)}</td>
									<td className="px-3 py-2 tabular-nums">{formatDate(q.submittedAt)}</td>
									<td className="px-3 py-2 tabular-nums">{formatWait(q.waitMs)}</td>
									<td className="px-3 py-2">
										{q.score === null ? (
											"—"
										) : (
											<span className="flex items-center gap-1.5">
												<span className="tabular-nums">{q.score}</span>
												{q.grade && <StatusBadge status={q.grade} />}
											</span>
										)}
									</td>
									<td className="max-w-56 px-3 py-2 font-mono text-xs text-gray-600">
										{[...q.reasons, ...q.topReasons.filter((r) => !q.reasons.includes(r))]
											.slice(0, 3)
											.join(", ") || "—"}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</Page>
	);
}
