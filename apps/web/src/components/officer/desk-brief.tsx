// Desk brief rail: honest, real queue insights only. No AI chat,
// no invented prose or amounts — every row derives from the
// bounded queue items + summary passed in from the dashboard.
import { formatWait, type QueueItem, type QueueSummary } from "../../lib/api";
import { ButtonLink, Overline, Panel } from "../ubs";

function oldestItem(items: QueueItem[], summary: QueueSummary): QueueItem | undefined {
	if (items.length === 0) return undefined;
	if (summary.oldestCaseId) {
		const match = items.find((i) => i.id === summary.oldestCaseId);
		if (match) return match;
	}
	return items.reduce((a, b) => (b.waitMs > a.waitMs ? b : a), items[0]);
}

export function DeskBrief({ items, summary }: { items: QueueItem[]; summary: QueueSummary }) {
	const oldest = oldestItem(items, summary);
	const rows: Array<{ label: string; value: string }> = [
		{
			label: "Oldest case",
			value: oldest ? `${oldest.reference} · ${formatWait(oldest.waitMs)}` : "—",
		},
		{ label: "Median wait", value: formatWait(summary.medianWaitMs) },
		{ label: "Waiting over 24h", value: String(summary.over24hCount) },
		{ label: "Referred", value: String(summary.referredCount) },
		{ label: "Above auto limit", value: String(summary.aboveAutoLimitCount) },
	];

	return (
		<Panel tone="warm" title="Desk brief">
			<Overline>Queue insights · live</Overline>
			<dl className="mt-4 divide-y divide-rule">
				{rows.map((row) => (
					<div key={row.label} className="flex items-baseline justify-between gap-4 py-2">
						<dt className="text-sm text-slate">{row.label}</dt>
						<dd className="text-sm font-medium text-ink tabular">{row.value}</dd>
					</div>
				))}
			</dl>
			<div className="mt-6 flex flex-col gap-3">
				{oldest && <ButtonLink to={`/officer/review/${oldest.id}`}>Open oldest case</ButtonLink>}
				<ButtonLink to="/officer/review" variant="link">
					View full queue
				</ButtonLink>
			</div>
		</Panel>
	);
}
