import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

export const inputCls =
	"h-12 w-full min-w-0 rounded-sm border border-rule-strong bg-white px-4 text-base font-light text-ink outline-none transition-colors placeholder:text-slate-light focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export function Field({
	label,
	error,
	hint,
	children,
}: {
	label: string;
	error?: string;
	hint?: string;
	children: ReactNode;
}) {
	const id = `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
	return (
		<div className="space-y-2">
			<Label htmlFor={id}>{label}</Label>
			{children}
			{hint && !error && <p className="text-xs text-slate">{hint}</p>}
			{error && (
				<p role="alert" className="text-xs text-danger-ink">
					{error}
				</p>
			)}
		</div>
	);
}
