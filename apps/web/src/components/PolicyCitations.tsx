// Shared credit-policy citation UI: inline [n] buttons plus a right-side
// section drawer. Click/tap only (no hover-only behaviour); buttons carry
// aria-labels, the drawer is a modal dialog with Escape/backdrop close.
import { useEffect, useRef, useState } from "react";
import {
	apiErrorMessage,
	fetchPolicySection,
	type PolicyCitation,
	type PolicySection,
} from "../lib/api";
import { ErrorBox, Skeleton } from "./ui";

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
			className="mx-0.5 rounded bg-blue-50 px-1 font-mono text-xs font-medium text-blue-700 hover:bg-blue-100 hover:underline"
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
			<dl className="grid gap-x-4 gap-y-0.5 text-xs text-gray-600 sm:grid-cols-2">
				<div>
					<dt className="inline font-medium">Version: </dt>
					<dd className="inline">{section.version}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Effective: </dt>
					<dd className="inline">
						{section.effectiveFrom} → {section.effectiveTo ?? "current"}
					</dd>
				</div>
			</dl>
			<blockquote className="border-l-2 border-blue-300 pl-2 text-sm text-gray-700 italic">
				“{citation.quote}”
			</blockquote>
			<div className="whitespace-pre-wrap text-sm text-gray-800">{section.body}</div>
			{(section.neighbours?.length ?? 0) > 0 && (
				<p className="text-xs text-gray-500">
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
			<div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
			<dialog
				open
				aria-label={`Policy ${citation.policyKey} section ${citation.sectionId}`}
				className="absolute top-0 right-0 m-0 h-full max-h-none w-full max-w-md overflow-y-auto border-0 bg-white p-4 shadow-xl sm:p-5"
			>
				<div className="mb-3 flex items-start justify-between gap-2">
					<div>
						<p className="text-xs text-gray-500">
							{citation.policyKey} · {citation.version}
						</p>
						<h2 className="text-base font-semibold">
							§{citation.sectionId} — {citation.heading}
						</h2>
						<p className="mt-0.5 text-xs text-gray-500">Effective {citation.effectiveFrom}</p>
					</div>
					<button
						ref={closeRef}
						type="button"
						onClick={onClose}
						aria-label={`Close policy section ${citation.sectionId}`}
						className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-700"
					>
						✕
					</button>
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
					<p key={`${s.citationIndexes.join(",")}-${s.text}`} className="text-sm text-gray-800">
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
				<ol className="mt-1 space-y-1 text-sm text-gray-700">
					{citations.map((c, i) => (
						<li key={`${c.policyVersionId}/${c.sectionId}`}>
							<PolicyCitationButton citation={c} index={i} onSelect={setSelected} />{" "}
							<span className="font-mono text-xs">
								{c.policyKey} §{c.sectionId}
							</span>{" "}
							— {c.heading} <span className="text-xs text-gray-500">({c.version})</span>
						</li>
					))}
				</ol>
			</div>
			{selected && <PolicySectionDrawer citation={selected} onClose={() => setSelected(null)} />}
		</>
	);
}
