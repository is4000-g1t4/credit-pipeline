// Shared UBS work-queue table for the officer dashboard and review queue.
// Client-side only: callers pass the bounded queue items and filter them.
// Below md the queue becomes a stacked list (design: no squeezed tables).
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { formatMoney, formatWait, type QueueItem } from "../../lib/api";
import { StatusBadge, Tag } from "../ubs";

export type QueueTab = "all" | "referred" | "above";

export function filterQueueItems(items: QueueItem[], tab: QueueTab): QueueItem[] {
	if (tab === "referred") return items.filter((i) => i.flags.referred);
	if (tab === "above") return items.filter((i) => i.flags.aboveAutoLimit);
	return items;
}

export function QueueTabs({
	value,
	onChange,
	counts,
}: {
	value: QueueTab;
	onChange: (tab: QueueTab) => void;
	counts: { all: number; referred: number; above: number };
}) {
	const items: Array<{ value: QueueTab; label: string; count: number }> = [
		{ value: "all", label: "All open", count: counts.all },
		{ value: "referred", label: "Referred", count: counts.referred },
		{ value: "above", label: "Above auto limit", count: counts.above },
	];
	return (
		<fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
			<legend className="sr-only">Queue filter</legend>
			{items.map((item) => {
				const active = value === item.value;
				return (
					<button
						key={item.value}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(item.value)}
						className={
							active
								? "h-8 rounded-sm border border-ink bg-ink px-3 text-sm font-medium text-white"
								: "h-8 rounded-sm border border-rule-strong bg-card px-3 text-sm text-slate hover:bg-warm"
						}
					>
						{item.label} <span className="tabular">{item.count}</span>
					</button>
				);
			})}
		</fieldset>
	);
}

function QueueStatus({ item }: { item: QueueItem }) {
	if (!item.flags.referred && !item.flags.aboveAutoLimit) {
		return <StatusBadge status="pending_review" />;
	}
	return (
		<span className="flex flex-wrap gap-1.5">
			{item.flags.referred && <Tag tone="warning">Referred</Tag>}
			{item.flags.aboveAutoLimit && <Tag tone="danger">Above auto limit</Tag>}
		</span>
	);
}

export function QueueTable({ items }: { items: QueueItem[] }) {
	return (
		<>
			<ul className="md:hidden">
				{items.map((item) => (
					<li key={item.id} className="border-b border-rule-illustrative last:border-0">
						<Link to="/officer/review/$id" params={{ id: item.id }} className="block py-4">
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<span className="block text-sm font-medium whitespace-nowrap text-ink">
										{item.reference}
									</span>
									<span className="block text-sm text-slate">
										{item.clientName}
										{item.city ? ` · ${item.city}` : ""}
									</span>
								</div>
								<ChevronRight className="mt-0.5 size-4 shrink-0 text-red-link" strokeWidth={1.5} />
							</div>
							<div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-right">
								<span className="text-sm text-ink tabular">
									{formatMoney(item.amountCents)}
									<span className="text-slate"> · {item.termMonths} months</span>
								</span>
								<div className="flex flex-wrap items-center justify-end gap-1.5">
									<StatusBadge status={item.risk} />
									<QueueStatus item={item} />
								</div>
							</div>
						</Link>
					</li>
				))}
			</ul>

			<div className="hidden overflow-x-auto md:block">
				<table className="w-full min-w-160 text-left text-sm">
					<thead className="border-b border-rule-illustrative">
						<tr>
							<th scope="col" className="overline px-3 py-2 text-left font-medium">
								Case
							</th>
							<th scope="col" className="overline px-3 py-2 text-left font-medium">
								Client
							</th>
							<th scope="col" className="overline px-3 py-2 text-right font-medium">
								Amount
							</th>
							<th scope="col" className="overline px-3 py-2 text-right font-medium">
								Wait
							</th>
							<th scope="col" className="overline px-3 py-2 text-left font-medium">
								Risk
							</th>
							<th scope="col" className="overline px-3 py-2 text-left font-medium">
								Status
							</th>
							<th scope="col" aria-label="Open" className="px-3 py-2" />
						</tr>
					</thead>
					<tbody>
						{items.map((item) => (
							<tr
								key={item.id}
								className="border-b border-rule-illustrative transition-colors last:border-0 hover:bg-raised"
							>
								<td className="px-3 py-4">
									<Link
										to="/officer/review/$id"
										params={{ id: item.id }}
										className="font-medium text-ink hover:underline"
									>
										{item.reference}
									</Link>
								</td>
								<td className="px-3 py-4">
									<span className="block font-medium text-ink">{item.clientName}</span>
									{item.city && <span className="block text-sm text-slate">{item.city}</span>}
								</td>
								<td className="px-3 py-4 text-right tabular">
									<span className="block text-ink">{formatMoney(item.amountCents)}</span>
									<span className="block text-sm text-slate">{item.termMonths} months</span>
								</td>
								<td className="px-3 py-4 text-right text-slate tabular">
									{formatWait(item.waitMs)}
								</td>
								<td className="px-3 py-4">
									<StatusBadge status={item.risk} />
								</td>
								<td className="px-3 py-4">
									<QueueStatus item={item} />
								</td>
								<td className="px-3 py-4 text-right">
									<Link
										to="/officer/review/$id"
										params={{ id: item.id }}
										aria-label="Open case"
										className="inline-flex items-center justify-center"
									>
										<ChevronRight className="size-4 text-red-link" strokeWidth={1.5} />
									</Link>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</>
	);
}
