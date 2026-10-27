import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import {
	filterQueueItems,
	QueueTable,
	QueueTabs,
	type QueueTab,
} from "../../../components/officer/queue-table";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
	EmptyState,
	ErrorBox,
	Kpi,
	Page,
	PageHead,
	Panel,
	Skeleton,
} from "../../../components/ubs";
import {
	apiErrorMessage,
	fetchReviewQueue,
	formatWait,
	queryKeys,
	type QueueItem,
} from "../../../lib/api";
import { RequireAuth } from "../../../lib/auth";

export const Route = createFileRoute("/officer/review/")({
	component: () => (
		<RequireAuth allow="officer">
			<Queue />
		</RequireAuth>
	),
});

function Queue() {
	const queue = useQuery({
		queryKey: queryKeys.reviewQueue,
		queryFn: fetchReviewQueue,
		refetchInterval: 5000,
	});
	const [tab, setTab] = useState<QueueTab>("all");
	const [search, setSearch] = useState("");

	return (
		<Page>
			<PageHead
				title="Review queue"
				subtitle="Oldest cases first. Cases stay here until an officer records a decision."
				actions={
					queue.data?.summary.oldestCaseId ? (
						<Link
							to="/officer/review/$id"
							params={{ id: queue.data.summary.oldestCaseId }}
							className="inline-flex items-center gap-1 text-sm font-medium text-red-link hover:underline"
						>
							Open oldest case <ChevronRight className="size-4" strokeWidth={1.5} />
						</Link>
					) : undefined
				}
			/>
			{queue.isPending ? (
				<Skeleton />
			) : queue.isError ? (
				<ErrorBox message={apiErrorMessage(queue.error)} onRetry={() => void queue.refetch()} />
			) : (
				<QueueBody
					items={queue.data.items}
					summary={queue.data.summary}
					tab={tab}
					onTab={setTab}
					search={search}
					onSearch={setSearch}
				/>
			)}
		</Page>
	);
}

function QueueBody({
	items,
	summary,
	tab,
	onTab,
	search,
	onSearch,
}: {
	items: QueueItem[];
	summary: {
		total: number;
		medianWaitMs: number;
		over24hCount: number;
		referredCount: number;
		aboveAutoLimitCount: number;
		truncated: boolean;
	};
	tab: QueueTab;
	onTab: (tab: QueueTab) => void;
	search: string;
	onSearch: (value: string) => void;
}) {
	if (items.length === 0) {
		return (
			<EmptyState
				title="Queue is empty"
				hint="Referred applications will appear here, oldest first."
			/>
		);
	}
	const q = search.trim().toLowerCase();
	const filtered = filterQueueItems(items, tab).filter((item) =>
		q.length === 0
			? true
			: `${item.reference} ${item.clientName} ${item.city ?? ""} ${item.product}`
					.toLowerCase()
					.includes(q),
	);
	return (
		<>
			<section
				aria-label="Queue summary"
				className="grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-4"
			>
				<Kpi
					label="Open cases"
					value={String(summary.total)}
					hint={`${summary.referredCount} referred · ${summary.aboveAutoLimitCount} above auto limit`}
				/>
				<Kpi
					label="Median wait"
					value={formatWait(summary.medianWaitMs)}
					hint={`${summary.over24hCount} over 24h`}
				/>
				<Kpi label="Over 24h" value={String(summary.over24hCount)} hint="Waiting more than a day" />
				<Kpi
					label="Referred"
					value={String(summary.referredCount)}
					hint="Need an officer decision"
				/>
			</section>

			<Panel title="Cases" outline className="mt-8">
				<div className="mb-4 flex flex-col gap-3">
					<div>
						<label htmlFor="queue-search" className="sr-only">
							Search cases
						</label>
						<Input
							id="queue-search"
							type="search"
							value={search}
							onChange={(e) => onSearch(e.target.value)}
							placeholder="Search case, client or product"
							className="max-w-md"
						/>
					</div>
					<QueueTabs
						value={tab}
						onChange={onTab}
						counts={{
							all: summary.total,
							referred: summary.referredCount,
							above: summary.aboveAutoLimitCount,
						}}
					/>
				</div>
				{filtered.length === 0 ? (
					<EmptyState
						title="No cases match this filter."
						action={
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => {
									onTab("all");
									onSearch("");
								}}
							>
								Clear filters
							</Button>
						}
					/>
				) : (
					<>
						<QueueTable items={filtered} />
						<p className="mt-4 text-sm text-slate">
							Showing {filtered.length} of {summary.total} open cases
							{summary.truncated ? " · the queue is bounded at 100" : ""}.
						</p>
					</>
				)}
			</Panel>
		</>
	);
}
