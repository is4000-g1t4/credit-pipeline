import * as React from "react";
import { cn } from "cn";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(
				"h-12 w-full min-w-0 rounded-sm border border-rule-strong bg-white px-4 py-2 text-base text-ink shadow-none transition-colors outline-none",
				"placeholder:text-slate-light disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
				"focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring",
				"aria-invalid:border-danger aria-invalid:ring-danger/20",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
