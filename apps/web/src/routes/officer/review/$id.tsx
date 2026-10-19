import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CaseView } from "../../../components/CaseView";
import { DecisionPanel } from "../../../components/DecisionPanel";
import { EmptyState, ErrorBox, Page, Skeleton } from "../../../components/ui";
import { ApiError, api, apiErrorMessage, type CaseDetail } from "../../../lib/api";
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
	const detail = useQuery({
		queryKey: ["application", id],
		queryFn: () => api<CaseDetail>(`/api/applications/${id}`),
		retry: false,
		refetchInterval: 5000,
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
							<Link to="/officer/review" className="text-sm text-blue-700 hover:underline">
								Back to queue
							</Link>
						}
					/>
				) : (
					<ErrorBox message={apiErrorMessage(detail.error)} onRetry={() => void detail.refetch()} />
				)
			) : (
				<div className="space-y-4">
					<CaseView data={detail.data} />
					{detail.data.application.status === "pending_review" ? (
						<DecisionPanel
							applicationId={id}
							requestedAmountCents={detail.data.application.amountCents}
							requestedTermMonths={detail.data.application.termMonths}
							maxAmountCents={
								detail.data.policyEvaluation?.maxAmountCents ?? detail.data.application.amountCents
							}
							product={detail.data.application.product}
							onDecided={() => void navigate({ to: "/officer/review" })}
						/>
					) : (
						<p className="text-sm text-gray-500">
							Case is {detail.data.application.status} — no decision needed.
						</p>
					)}
					<section
						aria-label="Agent research brief — Phase 2"
						className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 opacity-60 sm:p-5"
					>
						<h2 className="text-base font-semibold text-gray-500">
							Agent research brief — Phase 2
						</h2>
						<p className="mt-1 text-sm text-gray-400">
							Advisory agentic research on referred cases ships in Phase 2. Disabled in Phase 1
							(SPEC §13).
						</p>
						<button
							type="button"
							disabled
							className="mt-3 cursor-not-allowed rounded border border-gray-300 px-4 py-2 text-sm text-gray-400"
						>
							Research brief (disabled)
						</button>
					</section>
				</div>
			)}
		</Page>
	);
}
