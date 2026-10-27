import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppTable } from "../components/AppTable";
import { DashboardBody } from "../components/DashboardBody";
import { Card, EmptyState, Page, Skeleton } from "../components/ui";
import { type AppSummary, api, type DashboardSummary } from "../lib/api";
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
				<DashboardBody data={dash.data} variant="landing" />
			)}
		</Page>
	);
}
