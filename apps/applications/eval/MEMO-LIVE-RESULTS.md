# Live credit-memo eval — 2026-10-28

The scripted `memo-agent-eval.ts` covers mechanics only (bounds, repair,
validation, language). This is the missing model-quality eval: 22 evidence
bundles through the production `runMemoAgent`, `createAgentsMemoRunner`, and
`validateGeneratedText`, with a Terra judge.

```powershell
pnpm --filter @credit/applications eval:memo-live -- --trials=2 --budget-usd=8
```

Raw: `apps/applications/eval/results/memo-live-2026-10-28T14-10-49-640Z.json`
(local, gitignored).

## Dataset

22 cases: happy SME, individual applicant, sparse bundle, 20+ item bundle,
conflicting declared/bank facts, hostile injection in a document, missing
policy section, EWS/prior/default context, zero and negative values, long
document, decision-language temptation in case facts, duplicate evidence refs,
policy quote present/absent, no evidence, unavailable docs, stale signal,
multi-document, adverse external report, mixed score factors, and a
micro-loan/short-term case.

Pass is code-first: accepted, validator ok, full citation and section coverage,
no decision language, no injection echo, and 1..max tool calls. The judge scores
1–5 grounding and completeness on the first accepted trial per model+case; it is
advisory.

## Results

| Model | pass@1 | pass^2 | Judge grounding | Judge completeness | Mean / p95 | Cost |
|---|---:|---:|---:|---:|---:|---:|
| **GPT-6.1 Sol** | **1.000** | **22/22** | **5.00** | 2.41 | **21.5s / 32.8s** | **$0.267** |
| GPT-6.1 Terra | 0.932 | 20/22 | **5.00** | 2.62 | 36.2s / 50.8s | $0.433 |

Terra's three failed trials are `INVALID_OUTPUT`: one `conflicting-facts` and
both `no-evidence` trials. Sol had none.

The pass gate also requires at least one claim when the bundle has items (a
zero-claim memo cannot pass on section bookkeeping alone). A Sol 1-trial rerun
after that gate change is still 22/22, judge completeness 2.64
(`memo-live-2026-10-28T14-51-52-328Z.json`).

**Pin: Sol.** Perfect structural pass, 1.6× cheaper, and 1.7× faster. The
`ASSIST_MEMO_MODEL` default is now `openai/gpt-6.1-sol`.

## Production fix exposed by the eval

The `@openai/agents` SDK forces `strict: true` on zod-declared tools. OpenAI
strict mode rejects a function schema whose optional properties are absent from
`required` (HTTP 400 `invalid_function_parameters`), so the live memo agent
could not call `list_evidence` or `search_evidence` with the old zod schemas.
Both tools now use plain JSON schemas with `strict: false`; runtime validation
still runs in `runMemoEvidenceTool`, so bad arguments remain tool errors in the
payload. This mirrors the earlier context `get_transactions` cursor fix.

## Judge completeness

Both models score 5/5 on grounding but ~2.4/5 on completeness: claims are
supported, yet the memo omits available documents, factors, or application
detail. A prompt A/B asking for exhaustive coverage was reverted: it raised
happy-path completeness but produced an invalid large-bundle draft, so it was
not a safe trade. Treat this as a known quality gap, not a pass/fail gate.

## Caveats

- Judge and generator share the OpenAI family; one judge call per model+case, no
  human calibration. Judge columns are advisory.
- Agent cost is token-project-based because the orchestrator drops the
  provider-billed cost; failed-trial usage is not recorded, so totals understate
  failures.
- The memo prompt/agent version stays `memo-agent-v1`; only the tool schema and
  default model changed.
- The scripted 8-case mechanics suite still runs separately and is not replaced
  by this eval.
