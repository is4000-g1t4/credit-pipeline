import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Card, ErrorBox, Page, Skeleton, StatusBadge } from "../../components/ui";
import { api, apiErrorMessage, type DashboardSummary } from "../../lib/api";
import { RequireAuth } from "../../lib/auth";

export const Route = createFileRoute("/officer/")({
	component: () => (
		<RequireAuth allow="officer">
			<Dashboard />
		</RequireAuth>
	),
});

function Dashboard() {
	const dash = useQuery({
		queryKey: ["dashboard"],
		queryFn: () => api<DashboardSummary>("/api/dashboard/summary"),
	});
	return (
		<Page>
			<h1 className="mb-4 text-xl font-bold">Dashboard</h1>
			{dash.isPending ? (
				<Skeleton />
			) : dash.isError ? (
				<ErrorBox message={apiErrorMessage(dash.error)} onRetry={() => void dash.refetch()} />
			) : (
				<div className="space-y-4">
					<Card title="Applications by status">
						<div className="flex flex-wrap gap-3 text-sm">
							{Object.entries(dash.data.applications).map(([s, n]) => (
								<span key={s} className="flex items-center gap-1.5">
									<StatusBadge status={s} /> <span className="tabular-nums">{n}</span>
								</span>
							))}
						</div>
					</Card>
					<Card title="Loans">
						<div className="flex flex-wrap gap-3 text-sm">
							{Object.entries(dash.data.loans).map(([s, n]) => (
								<span key={s} className="flex items-center gap-1.5">
									<StatusBadge status={s} /> <span className="tabular-nums">{n}</span>
								</span>
							))}
							{Object.keys(dash.data.loans).length === 0 && (
								<span className="text-gray-500">No loans yet.</span>
							)}
						</div>
						<p className="mt-2 text-sm text-gray-600">
							Avg decision time:{" "}
							{dash.data.avgDecisionSeconds === null
								? "—"
								: `${Math.round(dash.data.avgDecisionSeconds)}s over ${dash.data.decidedApplications} decided`}
						</p>
					</Card>
					<Card title="Recent activity">
						{dash.data.recentFeed.length === 0 ? (
							<p className="text-sm text-gray-500">No activity yet.</p>
						) : (
							<ul className="space-y-1.5 text-sm">
								{dash.data.recentFeed.map((f) => (
									<li key={f.id}>
										<span className="font-medium">{f.type}</span>{" "}
										<span className="text-gray-600">{f.message}</span>
									</li>
								))}
							</ul>
						)}
					</Card>
				</div>
			)}
		</Page>
	);
}
