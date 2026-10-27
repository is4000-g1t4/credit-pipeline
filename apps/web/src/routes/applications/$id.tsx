import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CaseView } from "../../components/CaseView";
import { CustomerSnapshot, RequirementsPanel } from "../../components/RequirementsPanel";
import { DocumentPanel } from "../../components/DocumentPanel";
import { EmptyState, ErrorBox, Page, Skeleton } from "../../components/ui";
import { ApiError, apiErrorMessage, fetchCase, isTerminal, queryKeys } from "../../lib/api";
import { RequireAuth } from "../../lib/auth";

export const Route = createFileRoute("/applications/$id")({
	component: () => (
		<RequireAuth>
			<Detail />
		</RequireAuth>
	),
});

function Detail() {
	const { id } = Route.useParams();
	const detail = useQuery({
		queryKey: queryKeys.case(id),
		queryFn: () => fetchCase(id),
		retry: false,
		// Poll every 2s while non-terminal; stop on terminal (SPEC FR-7.4).
		refetchInterval: (query) => {
			const status = query.state.data?.application.status;
			return !status || isTerminal(status) ? false : 2000;
		},
	});
	return (
		<Page>
			{detail.isPending ? (
				<Skeleton label="Loading application" />
			) : detail.isError ? (
				detail.error instanceof ApiError && detail.error.status === 404 ? (
					<EmptyState
						title="Application not found"
						hint="It may belong to another applicant."
						action={
							<Link to="/applications" className="text-sm text-blue-700 hover:underline">
								Back to applications
							</Link>
						}
					/>
				) : (
					<ErrorBox message={apiErrorMessage(detail.error)} onRetry={() => void detail.refetch()} />
				)
			) : (
				<>
					{!isTerminal(detail.data.application.status) && (
						<p className="mb-3 text-xs text-gray-500" aria-live="polite">
							Updating automatically…
						</p>
					)}
					<CaseView data={detail.data} />
					{(detail.data.application.status === "draft" ||
						detail.data.application.status === "submitted") && (
						<>
							<RequirementsPanel applicationId={id} status={detail.data.application.status} />
							<CustomerSnapshot />
						</>
					)}
					<DocumentPanel
						applicationId={id}
						mode="applicant"
						documentsEnabled={detail.data.application.documentsEnabled ?? false}
						documentProcessingConsent={detail.data.application.documentProcessingConsent}
					/>
				</>
			)}
		</Page>
	);
}
