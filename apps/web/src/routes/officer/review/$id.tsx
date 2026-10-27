import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { OfficerCaseView } from "../../../components/case/officer-case-view";
import { EmptyState, ErrorBox, Page, Skeleton } from "../../../components/ubs";
import {
	ApiError,
	apiErrorMessage,
	fetchCase,
	isTerminal,
	queryKeys,
	type ResearchSelection,
} from "../../../lib/api";
import { RequireAuth } from "../../../lib/auth";

export const Route = createFileRoute("/officer/review/$id")({
	component: () => (
		<RequireAuth allow="officer">
			<ReviewCase />
		</RequireAuth>
	),
});

function ReviewCase() {
	const { id } = Route.useParams();
	const navigate = useNavigate();
	const [researchSelection, setResearchSelection] = useState<ResearchSelection | null>(null);
	const detail = useQuery({
		queryKey: queryKeys.case(id),
		queryFn: () => fetchCase(id),
		retry: false,
		// Poll while the case is active; stop on terminal (SPEC FR-7.4).
		refetchInterval: (query) => {
			const status = query.state.data?.application.status;
			return !status || isTerminal(status) ? false : 5000;
		},
	});
	return (
		<Page>
			{detail.isPending ? (
				<Skeleton label="Loading case" />
			) : detail.isError ? (
				detail.error instanceof ApiError && detail.error.status === 404 ? (
					<EmptyState
						title="Case not found"
						action={
							<Link
								to="/officer/review"
								className="text-sm font-medium text-red-link hover:underline"
							>
								Back to queue
							</Link>
						}
					/>
				) : (
					<ErrorBox message={apiErrorMessage(detail.error)} onRetry={() => void detail.refetch()} />
				)
			) : (
				<OfficerCaseView
					data={detail.data}
					researchSelection={researchSelection}
					onResearchSelection={setResearchSelection}
					onDecided={() => void navigate({ to: "/officer/review" })}
				/>
			)}
		</Page>
	);
}
