import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";

const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-2 rounded-sm text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:bg-disabled disabled:text-slate aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-red-deep",
				destructive: "bg-destructive text-white hover:bg-red-deep",
				outline: "border border-ink bg-transparent text-ink hover:bg-warm",
				secondary: "border border-ink bg-transparent text-ink hover:bg-warm",
				ghost: "text-ink hover:bg-warm",
				link: "text-red-link underline-offset-4 hover:underline",
			},
			size: {
				default: "h-12 px-6",
				xs: "h-6 px-2 text-xs",
				sm: "h-8 px-3 text-xs",
				lg: "h-12 px-6",
				icon: "size-10",
				"icon-sm": "size-8",
				"icon-lg": "size-12",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	asChild = false,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
	}) {
	const Comp = asChild ? Slot.Root : "button";

	return (
		<Comp
			data-slot="button"
			data-variant={variant}
			data-size={size}
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
