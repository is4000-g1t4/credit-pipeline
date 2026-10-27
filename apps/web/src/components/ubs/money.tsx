import { cn } from "cn";
import { formatMoney } from "../../lib/api";

export function Money({
	cents,
	className,
}: {
	cents: number | null | undefined;
	className?: string;
}) {
	return <span className={cn("tabular whitespace-nowrap", className)}>{formatMoney(cents)}</span>;
}
