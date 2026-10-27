// Shared credit-policy citation UI: inline [n] buttons plus a right-side
// section drawer. Click/tap only (no hover-only behaviour); buttons carry
// aria-labels, the drawer is a modal dialog with Escape/backdrop close.
import { useEffect, useRef, useState } from "react";
import {
	apiErrorMessage,
	fetchPolicySection,
	formatDateOnly,
	type PolicyCitation,
	type PolicySection,
} from "../lib/api";
import { ErrorBox, Skeleton } from "./ui";
import { Button } from "./ui/button";

export function PolicyCitationButton({
	citation,
	index,
	onSelect,
}: {
	citation: PolicyCitation;
	index: number;
	onSelect: (citation: PolicyCitation) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect(citation)}
			aria-label={`Policy source ${index + 1}: ${citation.policyKey} section ${citation.sectionId}, ${citation.heading}`}
			title={`${citation.policyKey} §${citation.sectionId} — ${citation.heading}`}
			className="mx-0.5 rounded bg-tag-blue px-1 font-mono text-xs font-medium text-red-link hover:bg-warm hover:underline"
		>
			[{index + 1}]
		</button>
	);
}

function DrawerBody({ citation }: { citation: PolicyCitation }) {
	const [section, setSection] = useState<PolicySection | null>(null);
	const [error, setError] = useState("");

	// Remounted per citation (see key below), so no reset is needed here.
	useEffect(() => {
		let live = true;
		async function load() {
			try {
				const s = await fetchPolicySection(
					citation.policyVersionId,
					citation.sectionId,
					citation.drawerToken,
				);
				if (live) setSection(s);
			} catch (err) {
				if (live) setError(apiErrorMessage(err));
			}
		}
		void load();
		return () => {
			live = false;
		};
	}, [citation]);

	if (error) return <ErrorBox message={error} />;
	if (!section) return <Skeleton label="Loading policy section" />;
	return (
		<div className="space-y-3">
			<dl className="grid gap-x-4 gap-y-0.5 text-xs text-slate sm:grid-cols-2">
				<div>
					<dt className="inline font-medium">Version: </dt>
					<dd className="inline">{section.version}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Effective: </dt>
					<dd className="inline">
						{formatDateOnly(section.effectiveFrom)} →{" "}
						{section.effectiveTo ? formatDateOnly(section.effectiveTo) : "current"}
					</dd>
				</div>
			</dl>
			<blockquote className="border-l-2 border-rule-strong pl-2 text-sm text-slate italic">
				“{citation.quote}”
			</blockquote>
			<div className="whitespace-pre-wrap text-sm text-ink">{section.body}</div>
			{(section.neighbours?.length ?? 0) > 0 && (
				<p className="text-xs text-slate">
					Nearby: {section.neighbours?.map((n) => `§${n.sectionId} ${n.heading}`).join(" · ")}
				</p>
			)}
		</div>
	);
}

export function PolicySectionDrawer({
	citation,
	onClose,
}: {
	citation: PolicyCitation;
	onClose: () => void;
}) {
	const closeRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		closeRef.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div className="fixed inset-0 z-50">
			<div className="absolute inset-0 bg-ink/60" onClick={onClose} aria-hidden="true" />
			<dialog
				open
				aria-label={`Policy ${citation.policyKey} section ${citation.sectionId}`}
				className="absolute top-0 right-0 m-0 h-full max-h-none w-full max-w-md overflow-y-auto border-0 bg-card p-4 sm:p-5"
			>
				<div className="mb-3 flex items-start justify-between gap-2">
					<div>
						<p className="text-xs text-slate">
							{citation.policyKey} · {citation.version}
						</p>
						<h2 className="text-base font-semibold">
							§{citation.sectionId} — {citation.heading}
						</h2>
						<p className="mt-0.5 text-xs text-slate">
							Effective {formatDateOnly(citation.effectiveFrom)}
						</p>
					</div>
					<Button
						ref={closeRef}
						type="button"
						variant="outline"
						size="sm"
						onClick={onClose}
						aria-label={`Close policy section ${citation.sectionId}`}
					>
						✕
					</Button>
				</div>
				<DrawerBody key={`${citation.policyVersionId}/${citation.sectionId}`} citation={citation} />
			</dialog>
		</div>
	);
}

/** One claim per segment with inline citation buttons, plus the drawer. */
export function CitedSegments({
	segments,
	citations,
}: {
	segments: Array<{ text: string; citationIndexes: number[] }>;
	citations: PolicyCitation[];
}) {
	const [selected, setSelected] = useState<PolicyCitation | null>(null);
	return (
		<>
			<div className="space-y-2">
				{segments.map((s) => (
					// Positional: the server sends segments in order with no ids.
					<p key={`${s.citationIndexes.join(",")}-${s.text}`} className="text-sm text-ink">
						{s.text}{" "}
						{s.citationIndexes.map(
							(ci) =>
								citations[ci] && (
									<PolicyCitationButton
										key={ci}
										citation={citations[ci]}
										index={ci}
										onSelect={setSelected}
									/>
								),
						)}
					</p>
				))}
			</div>
			{selected && <PolicySectionDrawer citation={selected} onClose={() => setSelected(null)} />}
		</>
	);
}

/** Numbered source list; buttons reopen the same drawer. */
export function PolicySources({ citations }: { citations: PolicyCitation[] }) {
	const [selected, setSelected] = useState<PolicyCitation | null>(null);
	if (citations.length === 0) return null;
	return (
		<>
			<div>
				<h4 className="text-sm font-semibold">Sources</h4>
				<ol className="mt-1 space-y-1 text-sm text-slate">
					{citations.map((c, i) => (
						<li key={`${c.policyVersionId}/${c.sectionId}`}>
							<PolicyCitationButton citation={c} index={i} onSelect={setSelected} />{" "}
							<span className="font-mono text-xs">
								{c.policyKey} §{c.sectionId}
							</span>{" "}
							— {c.heading} <span className="text-xs text-slate">({c.version})</span>
						</li>
					))}
				</ol>
			</div>
			{selected && <PolicySectionDrawer citation={selected} onClose={() => setSelected(null)} />}
		</>
	);
}
