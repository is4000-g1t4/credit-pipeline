import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState, ErrorBox, Page, Skeleton } from "../../components/ui";
import { type AppSummary, api, apiErrorMessage } from "../../lib/api";
import { RequireAuth } from "../../lib/auth";
import { AppTable } from "../index";

export const Route = createFileRoute("/applications/")({
	component: () => (
		<RequireAuth allow="applicant">
			<List />
		</RequireAuth>
	),
});

function List() {
	const apps = useQuery({
		queryKey: ["applications"],
		queryFn: () => api<{ items: AppSummary[] }>("/api/applications?limit=100"),
	});
	return (
		<Page>
			<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-bold">Applications</h1>
				<Link to="/apply" className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white">
					New application
				</Link>
			</div>
			{apps.isPending ? (
				<Skeleton />
			) : apps.isError ? (
				<ErrorBox message={apiErrorMessage(apps.error)} onRetry={() => void apps.refetch()} />
			) : apps.data.items.length === 0 ? (
				<EmptyState
					title="No applications yet"
					hint="Your submitted applications will appear here."
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
