import type { ReactNode } from "react";
import { cn } from "cn";

type Tone = "white" | "warm" | "raised" | "ink" | "cream";

const toneClasses: Record<Tone, string> = {
	white: "border-rule bg-card text-ink",
	warm: "border-transparent bg-warm text-ink",
	raised: "border-rule bg-raised text-ink",
	ink: "border-ink bg-ink text-white",
	cream: "border-rule bg-cream text-ink",
};

export function Panel({
	title,
	action,
	children,
	tone = "white",
	outline = false,
	className,
	id,
}: {
	title?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	tone?: Tone;
	outline?: boolean;
	className?: string;
	id?: string;
}) {
	return (
		<section
			id={id}
			className={cn(
				"rounded-sm border p-6",
				toneClasses[tone],
				!outline && tone === "white" && "border-transparent",
				className,
			)}
		>
			{(title || action) && (
				<div className="mb-4 flex items-start justify-between gap-4">
					{title && <h3 className="text-2xl leading-8 font-light">{title}</h3>}
					{action && <div className="shrink-0">{action}</div>}
				</div>
			)}
			{children}
		</section>
	);
}
