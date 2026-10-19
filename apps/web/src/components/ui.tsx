// Shared primitives: badges, money, cards, fields, skeletons, empty states,
// error boxes, toaster. Routes stay thin; all styling lives here.
import { type ReactNode, useEffect, useState } from "react";
import { formatMoney } from "../lib/api";

const STATUS_CLASSES: Record<string, string> = {
	submitted: "bg-blue-100 text-blue-800",
	processing: "bg-blue-100 text-blue-800",
	pending_review: "bg-amber-100 text-amber-800",
	booked: "bg-green-100 text-green-800",
	declined: "bg-red-100 text-red-800",
	expired: "bg-gray-200 text-gray-700",
	failed: "bg-red-100 text-red-800",
	active: "bg-green-100 text-green-800",
	overdue: "bg-red-100 text-red-800",
	closed: "bg-gray-200 text-gray-700",
	scheduled: "bg-blue-100 text-blue-800",
	paid: "bg-green-100 text-green-800",
	passed: "bg-green-100 text-green-800",
	verified: "bg-green-100 text-green-800",
	required: "bg-gray-200 text-gray-700",
	open: "bg-red-100 text-red-800",
	acknowledged: "bg-amber-100 text-amber-800",
};

export function StatusBadge({ status }: { status: string }) {
	const cls = STATUS_CLASSES[status] ?? "bg-gray-200 text-gray-700";
	return (
		<span
			className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}
			data-testid={`status-${status}`}
		>
			{status}
		</span>
	);
}

export function MockBadge() {
	return (
		<span
			className="inline-block rounded border border-dashed border-gray-400 px-1.5 py-0.5 text-[11px] text-gray-600"
			title="Deterministic mock — no real provider data (SPEC FR-3)"
		>
			Mock data
		</span>
	);
}

export function Money({ cents }: { cents: number | null | undefined }) {
	return <span className="tabular-nums">{formatMoney(cents)}</span>;
}

export function Page({ children }: { children: ReactNode }) {
	return <main className="mx-auto w-full max-w-5xl p-4 sm:p-6">{children}</main>;
}

export function Card({
	title,
	actions,
	children,
}: {
	title?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
			{(title || actions) && (
				<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
					<h2 className="text-base font-semibold">{title}</h2>
					{actions}
				</div>
			)}
			{children}
		</section>
	);
}

export function Field({
	label,
	error,
	children,
}: {
	label: string;
	error?: string;
	children: ReactNode;
}) {
	const id = `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
	return (
		<div>
			<label htmlFor={id} className="mb-1 block text-sm font-medium text-gray-700">
				{label}
			</label>
			{children}
			{error && (
				<p role="alert" className="mt-1 text-sm text-red-600">
					{error}
				</p>
			)}
		</div>
	);
}

export const inputCls =
	"w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";

export function Skeleton({ label = "Loading" }: { label?: string }) {
	return (
		<output className="block animate-pulse space-y-3" aria-label={label}>
			<div className="h-6 w-1/3 rounded bg-gray-200" />
			<div className="h-24 rounded bg-gray-100" />
			<div className="h-24 rounded bg-gray-100" />
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
		<div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
			<p className="font-medium text-gray-800">{title}</p>
			{hint && <p className="mt-1 text-sm text-gray-500">{hint}</p>}
			{action && <div className="mt-4">{action}</div>}
		</div>
	);
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
	return (
		<div
			role="alert"
			className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
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
					className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 shadow"
				>
					{n.message}
				</div>
			))}
		</div>
	);
}
