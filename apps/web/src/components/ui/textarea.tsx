import * as React from "react";
import { cn } from "cn";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"min-h-28 w-full rounded-sm border border-rule-strong bg-white px-4 py-3 text-base text-ink shadow-none transition-colors outline-none",
				"placeholder:text-slate-light disabled:cursor-not-allowed disabled:opacity-50",
				"focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring",
				"aria-invalid:border-danger aria-invalid:ring-danger/20",
				className,
			)}
			{...props}
		/>
	);
}

export { Textarea };
