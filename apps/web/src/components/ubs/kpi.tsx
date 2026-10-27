import type { ReactNode } from "react";
import { cn } from "cn";
import { Overline } from "./page-head";

export function Kpi({
	label,
	value,
	hint,
	tone,
	className,
}: {
	label: string;
	value: ReactNode;
	hint?: ReactNode;
	tone?: "up" | "down";
	className?: string;
}) {
	return (
		<div className={cn("border-t border-rule pt-4", className)}>
			<Overline>{label}</Overline>
			<p className="mt-2 text-3xl leading-tight font-light text-ink tabular sm:text-4xl">{value}</p>
			{hint && (
				<p
					className={cn(
						"mt-1 text-sm text-slate",
						tone === "down" && "text-success-ink",
						tone === "up" && "text-danger-ink",
					)}
				>
					{hint}
				</p>
			)}
		</div>
	);
}
