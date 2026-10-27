import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { cn } from "cn";
import { buttonVariants, type Button } from "@/components/ui/button";
import type { VariantProps } from "class-variance-authority";

type ButtonVariants = VariantProps<typeof buttonVariants>;

/** Link styled as a UBS action; pages use it for navigation, Button for mutations. */
export function ButtonLink({
	to,
	variant = "default",
	size = "default",
	arrow = true,
	className,
	children,
}: {
	to: string;
	variant?: ButtonVariants["variant"];
	size?: ButtonVariants["size"];
	arrow?: boolean;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<Link to={to as never} className={cn(buttonVariants({ variant, size }), className)}>
			<span>{children}</span>
			{arrow && <ChevronRight className="size-4" strokeWidth={1.5} aria-hidden="true" />}
		</Link>
	);
}

/** Use when the action is a client-side button that navigates after a mutation. */
export type ButtonLinkProps = React.ComponentProps<typeof Button>;
