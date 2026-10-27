import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { DashboardBody } from "../../components/dashboard-body";
import { ErrorBox, Page, Skeleton } from "../../components/ubs";
import {
	api,
	apiErrorMessage,
	fetchReviewQueue,
	queryKeys,
	type DashboardSummary,
} from "../../lib/api";
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
	const queue = useQuery({
		queryKey: queryKeys.reviewQueue,
		queryFn: fetchReviewQueue,
		refetchInterval: 5000,
	});
	return (
		<Page>
			{dash.isPending || queue.isPending ? (
				<Skeleton />
			) : dash.isError ? (
				<ErrorBox message={apiErrorMessage(dash.error)} onRetry={() => void dash.refetch()} />
			) : queue.isError ? (
				<ErrorBox message={apiErrorMessage(queue.error)} onRetry={() => void queue.refetch()} />
			) : (
				<DashboardBody data={dash.data} items={queue.data.items} summary={queue.data.summary} />
			)}
		</Page>
	);
}
