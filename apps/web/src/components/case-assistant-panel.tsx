// Officer case assistant (Ask tab): read-only Q&A over the case evidence.
// Chat state lives in React only — no persistence. Advisory only: answers
// are evidence lookups, never recommendations; they never decide the case.
import { useEffect, useRef, useState } from "react";
import {
	ApiError,
	apiErrorMessage,
	applyToolEvent,
	askCaseAssistant,
	capAssistantHistory,
	toTraceEntries,
	type ToolActivityEntry,
	type CaseAssistantAnswer,
	type CaseAssistantMessage,
} from "../lib/api";
import { clean } from "../lib/format";
import { ToolActivity } from "./tool-activity";
import { PolicySources } from "./policy-citations";
import { Button } from "./ui/button";
import { ErrorBox } from "./ui";
import { Textarea } from "./ui/textarea";

const SUGGESTED = [
	"Why was this case referred?",
	"Summarise affordability",
	"What documents are missing?",
	"What does policy say about the TDSR?",
] as const;

type Entry =
	| { kind: "user"; text: string }
	| { kind: "assistant"; answer: CaseAssistantAnswer; tools: ToolActivityEntry[] };

type PanelError = { message: string; code: string; retryable: boolean };

function toHistory(entries: Entry[]): CaseAssistantMessage[] {
	return capAssistantHistory(
		entries.map((e) =>
			e.kind === "user"
				? { role: "user", text: e.text }
				: { role: "assistant", text: e.answer.answer },
		),
	);
}

function AssistantEntry({
	answer,
	tools,
}: {
	answer: CaseAssistantAnswer;
	tools: ToolActivityEntry[];
}) {
	return (
		<div>
			<ToolActivity entries={tools} />
			<p className={`text-xs font-medium text-slate ${tools.length > 0 ? "mt-2" : ""}`}>
				Assistant
			</p>
			<p className="mt-1 text-sm break-words whitespace-pre-wrap text-ink">
				{clean(answer.answer)}
			</p>
			{answer.limitations.length > 0 && (
				<div className="mt-2">
					<p className="text-xs font-medium text-slate">Limitations</p>
					<ul className="mt-0.5 list-disc pl-5 text-xs text-slate">
						{answer.limitations.map((l) => (
							<li key={l}>{clean(l)}</li>
						))}
					</ul>
				</div>
			)}
			{answer.policyRefs.length > 0 && (
				<div className="mt-2">
					<PolicySources citations={answer.policyRefs} />
				</div>
			)}
		</div>
	);
}

export function CaseAssistantPanel({
	applicationId,
	contextAnalysisConsent,
}: {
	applicationId: string;
	contextAnalysisConsent?: boolean;
}) {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [draft, setDraft] = useState("");
	const [pending, setPending] = useState(false);
	const [liveTools, setLiveTools] = useState<ToolActivityEntry[]>([]);
	const [error, setError] = useState<PanelError | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const lastScrollTop = useRef(0);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		const el = scrollRef.current;
		if (el && stick.current && el.scrollHeight > 0) {
			el.scrollTop = el.scrollHeight;
			lastScrollTop.current = el.scrollTop;
		}
	}, [entries, pending, liveTools]);

	async function run(question: string, history: CaseAssistantMessage[]) {
		setPending(true);
		setError(null);
		setLiveTools([]);
		let live: ToolActivityEntry[] = [];
		try {
			const answer = await askCaseAssistant(applicationId, question, history, (event) => {
				live = applyToolEvent(live, event);
				setLiveTools(live);
			});
			const tools = live.length > 0 ? live : toTraceEntries(answer.toolCalls);
			setEntries((prev) => [...prev, { kind: "assistant", answer, tools }]);
			setLiveTools([]);
		} catch (err) {
			const status = err instanceof ApiError ? err.status : 0;
			setError({
				message: apiErrorMessage(err),
				code: err instanceof ApiError ? err.code : "",
				retryable: status === 0 || status === 429 || status >= 500,
			});
		} finally {
			setPending(false);
			inputRef.current?.focus();
		}
	}

	function send(question: string) {
		const q = question.slice(0, 1000).trim();
		if (pending || q.length < 3) return;
		const history = toHistory(entries);
		stick.current = true;
		setEntries((prev) => [...prev, { kind: "user", text: q }]);
		setDraft("");
		void run(q, history);
	}

	/** Re-send the last user turn without duplicating it in the transcript. */
	function retry() {
		if (pending) return;
		let idx = -1;
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i]?.kind === "user") {
				idx = i;
				break;
			}
		}
		if (idx === -1) return;
		const entry = entries[idx];
		if (entry?.kind !== "user") return;
		stick.current = true;
		void run(entry.text, toHistory(entries.slice(0, idx)));
	}

	const disabled = error?.code === "CASE_ASSISTANT_DISABLED";
	const consentMissing = contextAnalysisConsent === false;

	return (
		<section aria-label="Case assistant" className="rounded-sm border border-rule bg-card p-4">
			<h3 className="text-base font-semibold">Case assistant</h3>
			<p className="mt-0.5 text-xs text-slate">
				Read-only. No recommendations — the decision is yours.
			</p>

			<div
				ref={scrollRef}
				role="log"
				aria-label="Assistant conversation"
				className="mt-3 max-h-96 space-y-4 overflow-y-auto"
				onScroll={(e) => {
					const el = e.currentTarget;
					const near = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
					// Only a deliberate scroll up detaches; programmatic growth
					// during streaming must not stop the follow.
					if (near) stick.current = true;
					else if (el.scrollTop < lastScrollTop.current) stick.current = false;
					lastScrollTop.current = el.scrollTop;
				}}
			>
				{entries.length === 0 && !pending && (
					<div className="flex flex-wrap gap-2">
						{SUGGESTED.map((s) => (
							<Button
								key={s}
								type="button"
								variant="outline"
								size="sm"
								onClick={() => send(s)}
								disabled={disabled || consentMissing}
								aria-label={`Ask: ${s}`}
							>
								{s}
							</Button>
						))}
					</div>
				)}
				{entries.map((entry, i) =>
					entry.kind === "user" ? (
						<div key={`${i}-${entry.text}`}>
							<p className="text-xs font-medium text-slate">You</p>
							<p className="mt-1 inline-block max-w-full rounded-sm bg-warm px-3 py-2 text-sm break-words whitespace-pre-wrap text-ink">
								{clean(entry.text)}
							</p>
						</div>
					) : (
						<AssistantEntry
							key={`${i}-${entry.answer.latencyMs}`}
							answer={entry.answer}
							tools={entry.tools}
						/>
					),
				)}
				{pending && <ToolActivity entries={liveTools} running />}
				{!pending && error && liveTools.length > 0 && <ToolActivity entries={liveTools} />}
			</div>

			{consentMissing && (
				<p className="mt-3 text-xs text-slate">
					This case does not have context-analysis consent, so the assistant cannot read the case
					evidence. Ask the customer to enable context analysis first.
				</p>
			)}
			{disabled && (
				<p className="mt-3 text-xs text-slate">
					The case assistant is not enabled for this environment.
				</p>
			)}
			{error && !disabled && (
				<div className="mt-3">
					<ErrorBox message={error.message} onRetry={error.retryable ? retry : undefined} />
				</div>
			)}

			{!disabled && (
				<form
					className="mt-3 space-y-2"
					onSubmit={(e) => {
						e.preventDefault();
						send(draft);
					}}
				>
					<label htmlFor="case-assistant-question" className="sr-only">
						Ask about this case
					</label>
					<Textarea
						id="case-assistant-question"
						ref={inputRef}
						value={draft}
						maxLength={1000}
						rows={2}
						placeholder="Ask about this case…"
						disabled={consentMissing}
						readOnly={pending}
						aria-describedby={draft.length > 800 ? "case-assistant-count" : undefined}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.nativeEvent.isComposing) return;
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								send(draft);
							}
						}}
						className="min-h-12 text-sm"
					/>
					<div className="flex items-center justify-between gap-2">
						{draft.length > 800 ? (
							<p id="case-assistant-count" className="text-xs text-slate tabular">
								{draft.length}/1000
							</p>
						) : (
							<span />
						)}
						<Button
							type="submit"
							size="sm"
							disabled={pending || consentMissing || draft.trim().length < 3}
						>
							{pending ? "Asking…" : "Ask"}
						</Button>
					</div>
				</form>
			)}
		</section>
	);
}
