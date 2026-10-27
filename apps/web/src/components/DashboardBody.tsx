// Shared officer dashboard body (role landing + /officer dashboard). One
// component, two variants: the loaded markup stays byte-identical per
// route — only the variant picks the cards, the recent slice, and the
// wrapper the route already used.
import { type DashboardSummary } from "../lib/api";
import { Card, StatusBadge } from "./ui";

function ApplicationsCard({
	data,
	title,
	showAvg,
	gap,
}: {
	data: DashboardSummary;
	title: string;
	showAvg: boolean;
	gap: "gap-2" | "gap-3";
}) {
	return (
		<Card title={title}>
			<div className={`flex flex-wrap ${gap} text-sm`}>
				{Object.entries(data.applications).map(([s, n]) => (
					<span key={s} className="flex items-center gap-1.5">
						<StatusBadge status={s} /> <span className="tabular-nums">{n}</span>
					</span>
				))}
			</div>
			{showAvg && (
				<p className="mt-2 text-sm text-gray-600">
					Avg decision time:{" "}
					{data.avgDecisionSeconds === null
						? "—"
						: `${Math.round(data.avgDecisionSeconds)}s over ${data.decidedApplications} decided`}
				</p>
			)}
		</Card>
	);
}

function LoansCard({ data }: { data: DashboardSummary }) {
	return (
		<Card title="Loans">
			<div className="flex flex-wrap gap-3 text-sm">
				{Object.entries(data.loans).map(([s, n]) => (
					<span key={s} className="flex items-center gap-1.5">
						<StatusBadge status={s} /> <span className="tabular-nums">{n}</span>
					</span>
				))}
				{Object.keys(data.loans).length === 0 && (
					<span className="text-gray-500">No loans yet.</span>
				)}
			</div>
			<p className="mt-2 text-sm text-gray-600">
				Avg decision time:{" "}
				{data.avgDecisionSeconds === null
					? "—"
					: `${Math.round(data.avgDecisionSeconds)}s over ${data.decidedApplications} decided`}
			</p>
		</Card>
	);
}

function RecentCard({ items }: { items: DashboardSummary["recentFeed"] }) {
	return (
		<Card title="Recent activity">
			{items.length === 0 ? (
				<p className="text-sm text-gray-500">No activity yet.</p>
			) : (
				<ul className="space-y-1.5 text-sm">
					{items.map((f) => (
						<li key={f.id}>
							<span className="font-medium">{f.type}</span>{" "}
							<span className="text-gray-600">{f.message}</span>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}

export function DashboardBody({
	data,
	variant,
}: {
	data: DashboardSummary;
	variant: "landing" | "dashboard";
}) {
	if (variant === "landing") {
		return (
			<>
				<ApplicationsCard data={data} title="Summary" showAvg gap="gap-2" />
				<div className="mt-4">
					<RecentCard items={data.recentFeed.slice(0, 10)} />
				</div>
			</>
		);
	}
	return (
		<div className="space-y-4">
			<ApplicationsCard data={data} title="Applications by status" showAvg={false} gap="gap-3" />
			<LoansCard data={data} />
			<RecentCard items={data.recentFeed} />
		</div>
	);
}
