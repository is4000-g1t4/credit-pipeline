import { cn } from "cn";

const toneClasses = {
	success: "bg-success",
	warning: "bg-warning",
	danger: "bg-danger",
	ink: "bg-ink",
} as const;

export function Meter({
	value,
	max = 100,
	tone = "danger",
	label,
	className,
}: {
	value: number;
	max?: number;
	tone?: keyof typeof toneClasses;
	label?: string;
	className?: string;
}) {
	const pct = Math.max(0, Math.min(100, (value / Math.max(max, 1)) * 100));
	return (
		<div className={cn("h-1 w-full bg-warm", className)} aria-hidden="true" title={label}>
			<span className={cn("block h-1", toneClasses[tone])} style={{ width: `${pct}%` }} />
		</div>
	);
}
