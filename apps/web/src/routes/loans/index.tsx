import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	EmptyState,
	ErrorBox,
	Money,
	Page,
	PageHead,
	Skeleton,
	StatusBadge,
} from "../../components/ubs";
import { api, apiErrorMessage, formatDate, formatMoney, type LoanSummary } from "../../lib/api";
import { RequireAuth } from "../../lib/auth";

export const Route = createFileRoute("/loans/")({
	component: () => (
		<RequireAuth>
			<Loans />
		</RequireAuth>
	),
});

interface LoansPage {
	items: LoanSummary[];
	total: number;
	limit: number;
	offset: number;
	nextOffset: number | null;
	truncated: boolean;
}

const PAGE_SIZE = 50;

function Loans() {
	const loans = useInfiniteQuery({
		queryKey: ["loans"],
		queryFn: ({ pageParam }) => api<LoansPage>(`/api/loans?limit=${PAGE_SIZE}&offset=${pageParam}`),
		initialPageParam: 0,
		getNextPageParam: (lastPage) => lastPage.nextOffset,
	});
	const pages = loans.data?.pages ?? [];
	const items = pages.flatMap((p) => p.items);
	const last = pages[pages.length - 1];
	const total = last?.total ?? null;
	const activeCount = items.filter((l) => l.status === "active").length;
	const overdueCount = items.filter((l) => l.status === "overdue").length;
	const outstanding = items
		.filter((l) => l.status !== "closed")
		.reduce((sum, l) => sum + l.outstandingCents, 0);
	return (
		<Page>
			<PageHead
				title="Loans"
				subtitle={
					items.length > 0
						? `${activeCount} active · ${overdueCount} overdue · ${formatMoney(outstanding)} outstanding.`
						: "Booked facilities, balances and the next payment."
				}
			/>
			{loans.isPending ? (
				<Skeleton />
			) : loans.isError ? (
				<ErrorBox message={apiErrorMessage(loans.error)} onRetry={() => void loans.refetch()} />
			) : items.length === 0 ? (
				<EmptyState title="No loans yet" hint="Booked loans will appear here." />
			) : (
				<>
					{total !== null && (
						<p className="mb-2 text-sm text-slate">
							Showing {items.length} of {total}
						</p>
					)}
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Reference</TableHead>
								<TableHead>
									<span className="block text-right">Principal</span>
								</TableHead>
								<TableHead>
									<span className="block text-right">Rate</span>
								</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>
									<span className="block text-right">Next due</span>
								</TableHead>
								<TableHead>
									<span className="block text-right">Outstanding</span>
								</TableHead>
								<TableHead>
									<span className="sr-only">Open</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{items.map((l) => (
								<TableRow key={l.id}>
									<TableCell>
										<Link
											to="/loans/$id"
											params={{ id: l.id }}
											className="tabular text-ink underline-offset-4 hover:underline"
										>
											{l.reference}
										</Link>
									</TableCell>
									<TableCell>
										<span className="block text-right">
											<Money cents={l.principalCents} />
										</span>
									</TableCell>
									<TableCell>
										<span className="block text-right tabular">
											{(l.rateBps / 100).toFixed(2)}%
										</span>
									</TableCell>
									<TableCell>
										<StatusBadge status={l.status} />
									</TableCell>
									<TableCell>
										<span className="block text-right text-slate">{formatDate(l.nextDueDate)}</span>
									</TableCell>
									<TableCell>
										<span className="block text-right">
											<Money cents={l.outstandingCents} />
										</span>
									</TableCell>
									<TableCell>
										<Link
											to="/loans/$id"
											params={{ id: l.id }}
											className="inline-flex items-center text-red-link hover:underline"
											aria-label={`Open ${l.reference}`}
										>
											<ChevronRight className="size-4" strokeWidth={1.5} aria-hidden="true" />
										</Link>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
					{last && last.nextOffset !== null && (
						<div className="mt-4">
							<Button
								type="button"
								variant="outline"
								disabled={loans.isFetchingNextPage}
								onClick={() => void loans.fetchNextPage()}
							>
								{loans.isFetchingNextPage ? "Loading…" : "Load more"}
							</Button>
						</div>
					)}
					{last && last.truncated && last.nextOffset === null && (
						<p className="mt-3 text-sm text-slate">
							Showing {items.length} of {last.total} loans (paging limit reached).
						</p>
					)}
				</>
			)}
		</Page>
	);
}
