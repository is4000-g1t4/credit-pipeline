# Agentic credit memo

Model-written credit memos under deterministic guardrails. Audience:
developers extending the memo pipeline or enabling the agent writer. Outcome:
you know how a memo is drafted, what bounds the model, what is persisted,
and how to turn the agent writer on.

Related: [API](../reference/api.md#credit-memo-agentic-writer) (route
contract and error codes), [configuration](../reference/configuration.md)
(`ASSIST_MEMO_*`, `OPENROUTER_*`).

## Non-negotiables

- The model never decides credit, invents reasons, or writes uncited claims.
- Tools are an allowlist over the existing `EvidenceBundle` only. No web, no
  cross-case reads, no new data source.
- Deterministic code owns access, citation/claim validation, persistence,
  approval, audit, and idempotent replay.
- The model writes memo prose only. Every claim carries exact `sourceRef`
  citations; unsupported claims become open items.
- One validation/repair attempt on invalid output; if it still fails, no
  artifact persists and a typed error is returned.
- The trace is structured metadata only: tool names, source refs, counts,
  usage, latency. Never prompts, chain-of-thought, or raw evidence text in
  logs.

## Pipeline

`POST /api/assist/cases/:id/memos` on a `pending_review` case:

1. Assemble the EN-01 evidence bundle and hash it (`evidenceHash` over the
   bundle minus volatile assembly metadata).
2. Idempotent replay: identical evidence replays the newest non-deleted memo
   for the case (`200 { artifact, replayed: true }`) instead of regenerating.
3. Draft with the configured writer (`ASSIST_MEMO_WRITER`, default
   `deterministic`), validate with the shared EN-03 validator, and persist a
   `credit_memo` draft artifact with its trace.
4. Edits preserve the generated trace; evidence changes create a new version.
   Approval re-validates citations before superseding the prior version.

## Bounded tool loop

The agent writer (`orchestrator.ts` + `agent.ts` in `apps/applications/src/agents/memo-writer/`) uses
`@openai/agents` (`Agent` + `OpenAIChatCompletionsModel` + `Runner` + `tool`)
over the pure evidence tools. The orchestrator owns bounds, validation,
grounding, repair, and the trace; the SDK runner produces one draft per run.
The applications service is Bun, and the Agents SDK is Bun-compatible.

- Max steps (`ASSIST_MEMO_MAX_STEPS`, default 30), max tool calls
  (`ASSIST_MEMO_MAX_TOOL_CALLS`, default 40), wall-clock timeout
  (`ASSIST_MEMO_TIMEOUT_MS`, default 90s), token/cost budget
  (`ASSIST_MEMO_MAX_COST_USD`, default 0.25). The gateway proxy bound for
  `/api/assist/*` is 120s.
- Model calls retry transient failures (429, 5xx, network) under the shared
  policy in [agent-layout.md](agent-layout.md#model-call-retries), inside the
  same wall-clock timeout. A failed call returns no usage, so its tokens are
  not counted toward the cost budget or the trace.
- Allowlisted evidence tools, all read-only over the passed bundle:
  `list_evidence` (refs, labels, types, counts), `search_evidence`
  (case-insensitive substring/token search, capped), `get_evidence` (exact
  item, capped at 4,000 chars), `list_unavailable` (typed
  missing/unavailable sources). Tool results cap total content; refs are
  stable. No tool can read the DB, the network, or another case.

## Validation and repair

Model output must satisfy the credit-memo schema and the EN-03 citation,
decision-language, PII, and fair-lending checks. On invalid output the loop
gets one repair attempt with the issue list; if the repair still fails, no
artifact persists and the route returns a typed error. A route-level
re-validation runs before persistence, so a model bug fails closed and never
persists a partial memo.

## Trace

Persisted on `generated_artifacts.agent_trace` (jsonb, nullable) and
`generated_artifacts.evidence_hash` (text, nullable), and exposed on the
artifact DTO (`agentTrace` is null for artifacts written before trace
persistence). Fields: `writer` (`deterministic` | `agent`),
`agentVersion`, `model`, `promptVersion`, `evidenceHash`, `steps`,
`toolCalls[]` (`step`, `name`, `resultCount`, `sourceTypes`),
`sourceRefs[]`, `repairAttempted`, `repairSucceeded` (null when no repair),
`fallbackReason`, `inputTokens`, `outputTokens`, `latencyMs`. The officer
panel renders this as "Agent trace (metadata)". Audit rows carry
metadata-only additions (writer, tool-call and source-ref counts, repair
flag) — never memo or evidence text.

## Writer modes

- `deterministic` (default): the template builder writes the memo; the trace
  is agent-shaped provenance with zero tools/tokens, citation-derived source
  refs, and wall-clock latency.
- `agent`: the bounded tool loop writes the memo. Requires
  `OPENROUTER_API_KEY`; without a key the route fails closed at request time
  with 503 `MEMO_AGENT_UNAVAILABLE` (no config detail leaks).

## Failure codes

| Code                     | Status  | Meaning                                                                |
| ------------------------ | ------- | ---------------------------------------------------------------------- |
| `MEMO_AGENT_TIMEOUT`     | 504     | The loop hit `ASSIST_MEMO_TIMEOUT_MS`; retry or decide without a memo  |
| `MEMO_AGENT_UNAVAILABLE` | 502/503 | Model error (502), or no key configured (503); retry or decide without |
| `MEMO_AGENT_BUDGET`      | 422     | Step, tool-call, or cost budget exceeded; evidence may need narrowing  |
| `MEMO_AGENT_INVALID`     | 422     | Output failed validation after the repair attempt; nothing persisted   |

## Enable the agent writer

```powershell
# .env
ASSIST_ENABLED=true
ASSIST_MEMO_WRITER=agent
OPENROUTER_API_KEY=<key>  # unset fails closed with 503 MEMO_AGENT_UNAVAILABLE
```

Restart the applications service afterwards. The deterministic writer stays
the default; the flag-off behavior is unchanged (officer routes 404, the
panel hides).

## Eval note

The checked-in eval (`apps/applications` memo-agent tests) is scripted
mechanics only: loop bounds, tool allowlisting, validation/repair,
idempotent replay, and trace shape. No live model-quality eval was run.
