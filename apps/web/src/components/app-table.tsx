// Shared applicant application table (routes/index + applications/index).
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { type AppSummary, formatDate, productLabel, typeLabel } from "../lib/api";
import { Money, StatusBadge } from "./ubs";

export function AppTable({ items }: { items: AppSummary[] }) {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Reference</TableHead>
					<TableHead>Type / product</TableHead>
					<TableHead>
						<span className="block text-right">Amount</span>
					</TableHead>
					<TableHead>Status</TableHead>
					<TableHead>
						<span className="block text-right">Submitted</span>
					</TableHead>
					<TableHead>
						<span className="sr-only">Open</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{items.map((a) => (
					<TableRow key={a.id}>
						<TableCell>
							<Link
								to="/applications/$id"
								params={{ id: a.id }}
								className="tabular text-ink underline-offset-4 hover:underline"
							>
								{a.reference}
							</Link>
						</TableCell>
						<TableCell>
							<span className="text-slate">
								{typeLabel(a.type)} / {productLabel(a.product)}
							</span>
						</TableCell>
						<TableCell>
							<span className="block text-right">
								<Money cents={a.amountCents} />
							</span>
						</TableCell>
						<TableCell>
							<StatusBadge status={a.status} />
						</TableCell>
						<TableCell>
							<span className="block text-right text-slate">{formatDate(a.submittedAt)}</span>
						</TableCell>
						<TableCell>
							<Link
								to="/applications/$id"
								params={{ id: a.id }}
								className="inline-flex items-center text-red-link hover:underline"
								aria-label={`Open ${a.reference}`}
							>
								<ChevronRight className="size-4" strokeWidth={1.5} aria-hidden="true" />
							</Link>
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
