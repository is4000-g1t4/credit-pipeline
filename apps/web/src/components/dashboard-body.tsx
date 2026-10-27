// Officer desk body shared by the role landing (/) and /officer: KPI
// strip, bounded work queue with tabs, and recent activity. Real API data
// only — no prototype cases or AI answers.
import { useState } from "react";
import {
	actionLabel,
	formatDateTime,
	formatWait,
	type DashboardSummary,
	type QueueItem,
	type QueueSummary,
} from "../lib/api";
import { ButtonLink, EmptyState, Kpi, PageHead, Panel } from "./ubs";
import { DeskBrief } from "./officer/desk-brief";
import { filterQueueItems, QueueTable, QueueTabs, type QueueTab } from "./officer/queue-table";

function formatAvg(seconds: number | null): string {
	if (seconds === null) return "—";
	const s = Math.round(seconds);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s - m * 60}s`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h ${m - h * 60}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function DashboardBody({
	data,
	items,
	summary,
}: {
	data: DashboardSummary;
	items: QueueItem[];
	summary: QueueSummary;
}) {
	const [tab, setTab] = useState<QueueTab>("all");
	const filtered = filterQueueItems(items, tab);
	const shown = filtered.slice(0, 8);
	const counts = {
		all: summary.total,
		referred: summary.referredCount,
		above: summary.aboveAutoLimitCount,
	};

	return (
		<>
			<PageHead
				title="Credit desk"
				subtitle={
					summary.total === 0
						? "The queue is clear — referred applications will appear here."
						: `${summary.total} open cases · median wait ${formatWait(summary.medianWaitMs)} · oldest first.`
				}
				actions={<ButtonLink to="/officer/review">Open review queue</ButtonLink>}
			/>

			<section aria-label="Desk summary" className="grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-4">
				<Kpi
					label="Pending review"
					value={String(summary.total)}
					hint={`${summary.over24hCount} over 24h`}
				/>
				<Kpi
					label="Decisions today"
					value={data.decisionsToday === null ? "—" : String(data.decisionsToday)}
					hint="Recorded today"
				/>
				<Kpi
					label="Avg. decision"
					value={formatAvg(data.avgDecisionSeconds)}
					hint={`${data.decidedApplications} decided`}
				/>
				<Kpi
					label="Overdue loans"
					value={String(data.loans.overdue ?? 0)}
					hint={`${data.loans.active ?? 0} active loans`}
				/>
			</section>

			<div className="mt-8 grid grid-cols-1 items-start gap-8 lg:grid-cols-3">
				<div className="flex min-w-0 flex-col gap-8 lg:col-span-2">
					<Panel
						title="Work queue"
						action={
							<ButtonLink to="/officer/review" variant="link">
								View all
							</ButtonLink>
						}
						outline
					>
						<div className="mb-4">
							<QueueTabs value={tab} onChange={setTab} counts={counts} />
						</div>
						{filtered.length === 0 ? (
							<EmptyState
								title="Queue is empty"
								hint="Referred applications will appear here, oldest first."
							/>
						) : (
							<>
								<QueueTable items={shown} />
								<p className="mt-4 text-sm text-slate">
									Showing {shown.length} of {summary.total} open cases
									{summary.truncated ? " · the queue is bounded at 100" : ""}.
								</p>
							</>
						)}
					</Panel>

					<Panel title="Recent activity" outline>
						{data.recentFeed.length === 0 ? (
							<p className="text-sm text-slate">No activity yet.</p>
						) : (
							<ul className="divide-y divide-rule">
								{data.recentFeed.slice(0, 6).map((f) => (
									<li key={f.id} className="flex flex-wrap gap-x-2 gap-y-0.5 py-2 text-sm">
										<span className="text-slate tabular">{formatDateTime(f.occurredAt)}</span>
										<span className="font-medium text-ink">{actionLabel(f.type)}</span>
										<span className="text-slate">
											{f.message.length > 120 ? `${f.message.slice(0, 117)}…` : f.message}
										</span>
									</li>
								))}
							</ul>
						)}
					</Panel>
				</div>

				<aside className="min-w-0">
					<DeskBrief items={items} summary={summary} />
				</aside>
			</div>
		</>
	);
}
