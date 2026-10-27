import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ApplicantCaseView } from "../../components/case/applicant-case-view";
import {
	ButtonLink,
	CodeTag,
	EmptyState,
	ErrorBox,
	Page,
	PageHead,
	Skeleton,
	StatusBadge,
} from "../../components/ubs";
import {
	ApiError,
	apiErrorMessage,
	fetchCase,
	formatMoney,
	isTerminal,
	productLabel,
	queryKeys,
} from "../../lib/api";
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
							<Link to="/applications" className="text-sm text-red-link hover:underline">
								Back to applications
							</Link>
						}
					/>
				) : (
					<ErrorBox message={apiErrorMessage(detail.error)} onRetry={() => void detail.refetch()} />
				)
			) : (
				<div className="space-y-8">
					<PageHead
						title={detail.data.application.purpose || "Application"}
						subtitle={`${detail.data.application.reference} · ${formatMoney(detail.data.application.amountCents)} · ${detail.data.application.termMonths} months · ${productLabel(detail.data.application.product)}`}
						actions={
							<>
								{detail.data.application.status === "booked" ? (
									<ButtonLink to={detail.data.loan ? `/loans/${detail.data.loan.id}` : "/loans"}>
										View loan
									</ButtonLink>
								) : (
									<>
										<StatusBadge status={detail.data.application.status} />
										{detail.data.application.status === "pending_review" && (
											<CodeTag code={detail.data.application.status} />
										)}
									</>
								)}
								<Link to="/applications" className="text-sm text-red-link hover:underline">
									Back to applications
								</Link>
							</>
						}
					/>
					{!isTerminal(detail.data.application.status) && (
						<p className="text-xs text-slate" aria-live="polite">
							Updating automatically…
						</p>
					)}
					<ApplicantCaseView data={detail.data} />
				</div>
			)}
		</Page>
	);
}
