import { type ReactNode, useEffect, useState } from "react";
import { cn } from "cn";

export function Skeleton({ label = "Loading", className }: { label?: string; className?: string }) {
	return (
		<output className={cn("block animate-pulse space-y-3", className)} aria-label={label}>
			<div className="h-6 w-1/3 rounded-sm bg-warm" />
			<div className="h-24 rounded-sm bg-warm" />
			<div className="h-24 rounded-sm bg-warm" />
		</output>
	);
}

export function EmptyState({
	title,
	hint,
	action,
}: {
	title: string;
	hint?: string;
	action?: ReactNode;
}) {
	return (
		<div className="border border-rule bg-raised px-8 py-12 text-center">
			<p className="text-xl font-light text-ink">{title}</p>
			{hint && <p className="mx-auto mt-2 max-w-md text-sm text-slate">{hint}</p>}
			{action && <div className="mt-5 flex justify-center">{action}</div>}
		</div>
	);
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
	return (
		<div
			role="alert"
			className="border border-danger/30 bg-tag-red px-4 py-3 text-sm text-danger-ink"
		>
			<p>{message}</p>
			{onRetry && (
				<button type="button" onClick={onRetry} className="mt-2 font-medium underline">
					Retry
				</button>
			)}
		</div>
	);
}

export function Toaster() {
	const [notes, setNotes] = useState<Array<{ id: number; message: string }>>([]);
	useEffect(() => {
		let next = 0;
		const onToast = (e: Event) => {
			const id = ++next;
			setNotes((prev) => [...prev, { id, message: (e as CustomEvent<string>).detail }]);
			window.setTimeout(() => setNotes((prev) => prev.filter((n) => n.id !== id)), 5000);
		};
		window.addEventListener("app-toast", onToast);
		return () => window.removeEventListener("app-toast", onToast);
	}, []);
	if (notes.length === 0) return null;
	return (
		<div aria-live="polite" className="fixed right-4 bottom-4 z-50 flex max-w-sm flex-col gap-2">
			{notes.map((n) => (
				<div
					key={n.id}
					role="alert"
					className="border border-rule bg-white px-4 py-3 text-sm text-ink shadow-float"
				>
					{n.message}
				</div>
			))}
		</div>
	);
}
