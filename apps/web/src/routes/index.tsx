import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Card, EmptyState, Page, Skeleton, StatusBadge } from "../components/ui";
import { type AppSummary, api, type DashboardSummary, formatDate, formatMoney } from "../lib/api";
import { useMe } from "../lib/auth";

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

function ApplicantLanding() {
	const apps = useQuery({
		queryKey: ["applications"],
		queryFn: () => api<{ items: AppSummary[] }>("/api/applications?limit=20"),
	});
	return (
		<Page>
			<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-bold">My applications</h1>
				<Link to="/apply" className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white">
					New application
				</Link>
			</div>
			{apps.isPending ? (
				<Skeleton />
			) : apps.isError ? (
				<p role="alert" className="text-sm text-red-600">
					Could not load applications.
				</p>
			) : apps.data.items.length === 0 ? (
				<EmptyState
					title="No applications yet"
					hint="Start your first credit application."
					action={
						<Link
							to="/apply"
							className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white"
						>
							New application
						</Link>
					}
				/>
			) : (
				<AppTable items={apps.data.items} />
			)}
		</Page>
	);
}

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

function OfficerLanding() {
	const dash = useQuery({
		queryKey: ["dashboard"],
		queryFn: () => api<DashboardSummary>("/api/dashboard/summary"),
	});
	return (
		<Page>
			<h1 className="mb-4 text-xl font-bold">Officer overview</h1>
			<div className="mb-4 grid gap-3 sm:grid-cols-2">
				<Card title="Review queue">
					<p className="mb-3 text-sm text-gray-500">Oldest pending cases first.</p>
					<Link
						to="/officer/review"
						className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white"
					>
						Open review queue
					</Link>
				</Card>
				<Card title="Dashboard">
					<p className="mb-3 text-sm text-gray-500">Counts, loans, decision times.</p>
					<Link
						to="/officer"
						className="rounded border border-gray-300 px-4 py-2 text-sm font-medium"
					>
						Open dashboard
					</Link>
				</Card>
			</div>
			{dash.isPending ? (
				<Skeleton />
			) : dash.isError ? (
				<p role="alert" className="text-sm text-red-600">
					Could not load the dashboard summary.
				</p>
			) : (
				<>
					<Card title="Summary">
						<div className="flex flex-wrap gap-2 text-sm">
							{Object.entries(dash.data.applications).map(([s, n]) => (
								<span key={s} className="flex items-center gap-1.5">
									<StatusBadge status={s} /> <span className="tabular-nums">{n}</span>
								</span>
							))}
						</div>
						<p className="mt-2 text-sm text-gray-600">
							Avg decision time:{" "}
							{dash.data.avgDecisionSeconds === null
								? "—"
								: `${Math.round(dash.data.avgDecisionSeconds)}s over ${dash.data.decidedApplications} decided`}
						</p>
					</Card>
					<div className="mt-4">
						<Card title="Recent activity">
							{dash.data.recentFeed.length === 0 ? (
								<p className="text-sm text-gray-500">No activity yet.</p>
							) : (
								<ul className="space-y-1.5 text-sm">
									{dash.data.recentFeed.slice(0, 10).map((f) => (
										<li key={f.id}>
											<span className="font-medium">{f.type}</span>{" "}
											<span className="text-gray-600">{f.message}</span>
										</li>
									))}
								</ul>
							)}
						</Card>
					</div>
				</>
			)}
		</Page>
	);
}
