import type { ReactNode } from "react";
import { cn } from "cn";

export function PageHead({
	title,
	subtitle,
	actions,
	children,
	className,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	actions?: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<header className={cn("mb-10 border-b border-rule pb-8", className)}>
			<div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
				<div className="flex min-w-0 gap-5">
					<span className="mt-1 w-1 shrink-0 self-stretch bg-red" aria-hidden="true" />
					<div className="min-w-0">
						<h1 className="text-5xl leading-tight tracking-tight text-ink md:text-6xl">{title}</h1>
						{children}
						{subtitle && (
							<p className="mt-4 max-w-2xl text-2xl leading-8 font-light text-slate">{subtitle}</p>
						)}
					</div>
				</div>
				{actions && (
					<div className="flex flex-wrap items-center gap-3 lg:justify-end">{actions}</div>
				)}
			</div>
		</header>
	);
}

export function SectionHead({
	title,
	action,
	tight = false,
	className,
}: {
	title: ReactNode;
	action?: ReactNode;
	tight?: boolean;
	className?: string;
}) {
	return (
		<div className={cn("flex items-end justify-between gap-4", tight ? "mb-3" : "mb-5", className)}>
			<div>
				<h2 className="text-2xl leading-8 font-light text-ink md:text-3xl md:leading-10">
					{title}
				</h2>
				<span className="mt-3 block h-1 w-16 bg-red" aria-hidden="true" />
			</div>
			{action && <div className="shrink-0 pb-1">{action}</div>}
		</div>
	);
}

export function Overline({ children, className }: { children: ReactNode; className?: string }) {
	return <p className={cn("overline", className)}>{children}</p>;
}
