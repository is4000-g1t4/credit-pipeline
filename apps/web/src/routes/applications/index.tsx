import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { AppTable } from "../../components/app-table";
import {
	ButtonLink,
	EmptyState,
	ErrorBox,
	Kpi,
	Money,
	Page,
	PageHead,
	Panel,
	Skeleton,
} from "../../components/ubs";
import { type AppSummary, api, apiErrorMessage } from "../../lib/api";
import { RequireAuth } from "../../lib/auth";

export const Route = createFileRoute("/applications/")({
	component: () => (
		<RequireAuth allow="applicant">
			<List />
		</RequireAuth>
	),
});

type Filter = "all" | "draft" | "review" | "active";

const REVIEW_STATUSES = new Set(["submitted", "processing", "pending_review"]);

function matches(a: AppSummary, filter: Filter): boolean {
	if (filter === "draft") return a.status === "draft";
	if (filter === "review") return REVIEW_STATUSES.has(a.status);
	if (filter === "active") return a.status === "booked";
	return true;
}

/** Mean submitted→decided span, e.g. "1d 4h"; null when nothing decided yet. */
function averageDecision(items: AppSummary[]): { label: string; count: number } | null {
	const spans: number[] = [];
	for (const a of items) {
		if (!a.submittedAt || !a.decidedAt) continue;
		const ms = new Date(a.decidedAt).getTime() - new Date(a.submittedAt).getTime();
		if (Number.isFinite(ms) && ms >= 0) spans.push(ms);
	}
	if (spans.length === 0) return null;
	const avg = spans.reduce((s, v) => s + v, 0) / spans.length;
	const hours = Math.floor(avg / 3_600_000);
	const days = Math.floor(hours / 24);
	if (days > 0) return { label: `${days}d ${hours % 24}h`, count: spans.length };
	const mins = Math.round((avg % 3_600_000) / 60_000);
	if (hours > 0) return { label: `${hours}h ${mins}m`, count: spans.length };
	return { label: avg < 60_000 ? "<1m" : `${mins}m`, count: spans.length };
}

function List() {
	const [filter, setFilter] = useState<Filter>("all");
	const apps = useQuery({
		queryKey: ["applications"],
		queryFn: () => api<{ items: AppSummary[] }>("/api/applications?limit=100"),
	});
	const items = useMemo(() => apps.data?.items ?? [], [apps.data]);

	const draftCount = items.filter((a) => a.status === "draft").length;
	const reviewCount = items.filter((a) => REVIEW_STATUSES.has(a.status)).length;
	const activeCount = items.filter((a) => a.status === "booked").length;
	const activeVolume = items
		.filter((a) => a.status === "booked")
		.reduce((sum, a) => sum + a.amountCents, 0);
	const openCount = draftCount + reviewCount;
	const decision = useMemo(() => averageDecision(items), [items]);
	const visible = items.filter((a) => matches(a, filter));

	const pills: Array<[Filter, string, number]> = [
		["all", "All", items.length],
		["draft", "Drafts", draftCount],
		["review", "In review", reviewCount],
		["active", "Active", activeCount],
	];

	return (
		<Page>
			<PageHead
				title="Applications"
				subtitle="Every application, draft and decision in one place."
				actions={
					<ButtonLink to="/apply" variant="outline">
						New application
					</ButtonLink>
				}
			/>
			{apps.isPending ? (
				<Skeleton />
			) : apps.isError ? (
				<ErrorBox message={apiErrorMessage(apps.error)} onRetry={() => void apps.refetch()} />
			) : items.length === 0 ? (
				<EmptyState
					title="No applications yet"
					hint="Your submitted applications will appear here."
					action={<ButtonLink to="/apply">New application</ButtonLink>}
				/>
			) : (
				<>
					<div className="mb-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
						<Kpi
							label="Applications"
							value={String(items.length).padStart(2, "0")}
							hint={`${activeCount} active · ${draftCount} draft`}
						/>
						<Kpi
							label="Active volume"
							value={<Money cents={activeVolume} />}
							hint="Approved and funded"
						/>
						{decision && (
							<Kpi
								label="Average decision"
								value={decision.label}
								hint={`Across ${decision.count} decided application${decision.count === 1 ? "" : "s"}`}
							/>
						)}
						<Kpi
							label="Open items"
							value={String(openCount).padStart(2, "0")}
							hint={
								draftCount > 0
									? "Draft ready to continue"
									: reviewCount > 0
										? "In review"
										: "All up to date"
							}
						/>
					</div>
					<Panel outline>
						<fieldset className="mb-4 flex flex-wrap gap-2">
							<legend className="sr-only">Application filters</legend>
							{pills.map(([value, label, count]) => (
								<Button
									key={value}
									type="button"
									size="sm"
									variant={filter === value ? "default" : "outline"}
									aria-pressed={filter === value}
									onClick={() => setFilter(value)}
								>
									{label} <span className="tabular">{count}</span>
								</Button>
							))}
						</fieldset>
						{visible.length === 0 ? (
							<div className="py-8 text-center">
								<p className="text-sm text-slate">No applications match this filter.</p>
								<Button
									type="button"
									variant="link"
									size="sm"
									className="mt-2"
									onClick={() => setFilter("all")}
								>
									Clear filter
								</Button>
							</div>
						) : (
							<AppTable items={visible} />
						)}
						<p className="mt-4 text-sm text-slate">
							Showing {visible.length} of {items.length} applications.
						</p>
					</Panel>
				</>
			)}
		</Page>
	);
}
