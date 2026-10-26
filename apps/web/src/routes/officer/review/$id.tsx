import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { CaseView } from "../../../components/CaseView";
import { DecisionPanel } from "../../../components/DecisionPanel";
import { DocumentPanel } from "../../../components/DocumentPanel";
import { IntegrityPanel } from "../../../components/IntegrityPanel";
import { MemoPanel } from "../../../components/MemoPanel";
import { PolicyExceptionPanel } from "../../../components/PolicyExceptionPanel";
import { ResearchPanel } from "../../../components/ResearchPanel";
import { EmptyState, ErrorBox, Page, Skeleton } from "../../../components/ui";
import {
	ApiError,
	api,
	apiErrorMessage,
	type CaseDetail,
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
					<DocumentPanel
						applicationId={id}
						mode="officer"
						documentsEnabled={detail.data.application.documentsEnabled ?? false}
						documentProcessingConsent={detail.data.application.documentProcessingConsent}
					/>
					<ResearchPanel
						applicationId={id}
						caseStatus={detail.data.application.status}
						aiResearchConsent={detail.data.application.aiResearchConsent}
						onSelectionChange={setResearchSelection}
					/>
					<PolicyExceptionPanel applicationId={id} caseStatus={detail.data.application.status} />
					<IntegrityPanel applicationId={id} />
					{detail.data.application.status === "pending_review" ? (
						<>
							<MemoPanel applicationId={id} caseStatus={detail.data.application.status} />
							<DecisionPanel
								applicationId={id}
								requestedAmountCents={detail.data.application.amountCents}
								requestedTermMonths={detail.data.application.termMonths}
								maxAmountCents={
									detail.data.policyEvaluation?.maxAmountCents ??
									detail.data.application.amountCents
								}
								product={detail.data.application.product}
								researchSelection={researchSelection}
								onResearchStale={() => setResearchSelection(null)}
								onDecided={() => void navigate({ to: "/officer/review" })}
							/>
						</>
					) : (
						<p className="text-sm text-gray-500">
							Case is {detail.data.application.status} — no decision needed.
						</p>
					)}
				</div>
			)}
		</Page>
	);
}
