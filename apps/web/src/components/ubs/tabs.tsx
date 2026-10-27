import { cn } from "cn";

export function Tabs<T extends string>({
	items,
	value,
	onChange,
	ariaLabel,
	className,
}: {
	items: Array<{ value: T; label: string; count?: number | string }>;
	value: T;
	onChange: (value: T) => void;
	ariaLabel?: string;
	className?: string;
}) {
	return (
		<fieldset
			className={cn(
				"m-0 flex flex-wrap items-center gap-6 border-0 border-b border-rule p-0",
				className,
			)}
			aria-label={ariaLabel ?? "Tabs"}
		>
			{items.map((item) => {
				const active = value === item.value;
				return (
					<button
						key={item.value}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(item.value)}
						className={cn(
							"-mb-px inline-flex h-10 items-center gap-2 border-b-2 border-transparent pb-2 text-sm text-slate transition-colors hover:text-ink",
							active && "border-red text-ink",
						)}
					>
						{item.label}
						{item.count !== undefined && (
							<span className="text-xs tabular text-slate">{item.count}</span>
						)}
					</button>
				);
			})}
		</fieldset>
	);
}
