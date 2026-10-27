import type { ReactNode } from "react";
import { cn } from "cn";

export type TagTone = "neutral" | "success" | "warning" | "danger" | "info" | "brand";

const toneClasses: Record<TagTone, string> = {
	neutral: "bg-tag-sand text-ink",
	success: "bg-tag-green text-success-ink",
	warning: "bg-tag-amber text-warning-ink",
	danger: "bg-tag-red text-danger-ink",
	info: "bg-tag-blue text-ink",
	brand: "bg-red text-white",
};

export function Tag({
	tone = "neutral",
	children,
	className,
}: {
	tone?: TagTone;
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex w-fit items-center gap-1 rounded-sm px-2 py-1 text-xs leading-4 font-medium whitespace-nowrap",
				toneClasses[tone],
				className,
			)}
		>
			{children}
		</span>
	);
}

const statusMeta: Record<string, { tone: TagTone; label: string }> = {
	submitted: { tone: "info", label: "Submitted" },
	processing: { tone: "info", label: "Processing" },
	pending_review: { tone: "warning", label: "In review" },
	booked: { tone: "success", label: "Booked" },
	declined: { tone: "danger", label: "Declined" },
	expired: { tone: "neutral", label: "Expired" },
	failed: { tone: "danger", label: "Failed" },
	active: { tone: "success", label: "Active" },
	overdue: { tone: "danger", label: "Overdue" },
	closed: { tone: "neutral", label: "Closed" },
	scheduled: { tone: "info", label: "Scheduled" },
	paid: { tone: "success", label: "Paid" },
	ready: { tone: "success", label: "Ready" },
	missing: { tone: "warning", label: "Missing" },
	passed: { tone: "success", label: "Passed" },
	verified: { tone: "success", label: "Verified" },
	required: { tone: "neutral", label: "Required" },
	open: { tone: "warning", label: "Open" },
	acknowledged: { tone: "warning", label: "Acknowledged" },
	low: { tone: "success", label: "Low" },
	medium: { tone: "warning", label: "Medium" },
	high: { tone: "danger", label: "High" },
	candidate: { tone: "neutral", label: "Candidate" },
	validated: { tone: "info", label: "Validated" },
	confirmed: { tone: "info", label: "Confirmed" },
	rejected: { tone: "neutral", label: "Rejected" },
	cleared: { tone: "success", label: "Cleared" },
	needs_info: { tone: "warning", label: "Needs info" },
	needs_chase: { tone: "warning", label: "Needs chase" },
	match: { tone: "success", label: "Match" },
	mismatch: { tone: "danger", label: "Mismatch" },
	queued: { tone: "info", label: "Queued" },
	running: { tone: "info", label: "Running" },
	succeeded: { tone: "success", label: "Succeeded" },
	cancelled: { tone: "neutral", label: "Cancelled" },
};

export function StatusBadge({ status }: { status: string }) {
	const meta = statusMeta[status] ?? { tone: "neutral" as const, label: status };
	return (
		<span data-testid={`status-${status}`}>
			<Tag tone={meta.tone}>{meta.label}</Tag>
		</span>
	);
}

/** Machine reason/status codes keep their exact spelling for auditability. */
export function CodeTag({ code }: { code: string }) {
	return (
		<Tag tone="neutral" className="font-mono tracking-normal">
			{code}
		</Tag>
	);
}

export function MockTag() {
	return (
		<Tag tone="neutral" className="border border-dashed border-rule-strong bg-transparent">
			Mock data
		</Tag>
	);
}

export const MockBadge = MockTag;
