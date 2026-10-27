import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { DashboardBody } from "../../components/DashboardBody";
import { ErrorBox, Page, Skeleton } from "../../components/ui";
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
				<DashboardBody data={dash.data} variant="dashboard" />
			)}
		</Page>
	);
}
