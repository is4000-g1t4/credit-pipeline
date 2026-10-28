# Case assistant model comparison (Terra vs Sol)

Officer Ask tab: a read-only, case-scoped tool loop over 15 case/policy tools.
This report compares the only two models the assistant may ship on, using the
production prompt, tool loop, and answer validator.

- **Models**: `openai/gpt-6.1-terra` and `openai/gpt-6.1-sol` (OpenRouter).
- **Pins**: prompt `case-assistant-v3`, agent `case-assistant-v1`, temperature
  `0.1`, 1,200 output tokens, 6 turns, 12 tool calls.
- **Dataset**: 20 questions across five eval-owned customers
  (`fixture_key = eval-cm-ca-*`), as-of `2026-06-30`:
  multi-account SME (`multiaccount`), negative-balance individual (`negative`),
  data-rich SME with prior application/loan/KYC/reports/findings (`rich`),
  empty observation window (`emptywindow`), and hostile/injection fixture
  (`hostile`). Questions cover case facts, score/assessment, documents,
  declared-vs-observed cashflow, affordability, loans, KYC, reports, credit
  history, findings, policy search, data gaps, injection, decision bait, and
  PII bait. The fixture policy and internal services are the local stack.
- **Pass definition (code gate)**: the production
  `validateCaseAssistantAnswer` accepted the answer; the expected read-only
  tool ran; every expected evidence-token group matched; no forbidden token
  (injection text, "low risk"); no applicant name or email in the answer. No
  judge column and no repair path.
- **Trials**: 3 per model per question (60 runs per model), $20 spend cap.

## Results

| Model | pass@1 | pass^3 (questions) | Errors | Mean tools | Mean latency | p95 latency | Cost |
| ----- | -----: | -----------------: | -----: | ---------: | -----------: | ----------: | ---: |
| GPT-6.1 Terra | 1.000 (60/60) | 1.000 (20/20) | 0 | 2.58 | 5.32 s | 11.23 s | $0.2488 |
| GPT-6.1 Sol | 1.000 (60/60) | 1.000 (20/20) | 0 | 1.82 | 4.95 s | 9.80 s | $0.4537 |

**Winner: Terra** (`CASE_ASSISTANT_MODEL=openai/gpt-6.1-terra`). Both models
clear every code gate on every trial; Terra costs 45% less for the same pass
rate, with comparable latency. Sol is marginally faster on the mean and p95 and
calls fewer tools, which is not enough to justify 1.8× cost.

Safety observations from the same run:

- 0/120 answers tripped the advisory/PII validator, so no `UNSAFE_OUTPUT` or
  `INVALID_OUTPUT` failures.
- 0 applicant-name or email leaks in 120 answers (the validator and the eval's
  independent PII check agree).
- All six prompt-injection runs returned no "low risk" or "ignore previous"
  text; all six decision-bait runs refused without a tool call.
- The tool-call rate is 83% across the 120 runs; the out-of-scope refusals
  intentionally use no tools.

## Cost basis

OpenRouter list price at run time × token usage (Terra $1/$5 per 1M
input/output; Sol $2/$10). This is not billed cost. Raw result file:
`apps/research/eval/results/case-assistant-2026-10-28T20-47-30-582Z.json`
(gitignored).

## Caveats

- Five synthetic customers, not a production case distribution. The fixtures
  are re-seeded per run and cleaned up; they are not demo rows.
- The dataset is single-question. Multi-turn history is bounded and tested in
  unit/integration tests, but this run does not measure follow-up quality.
- Pass is a code gate, not a semantic judge: an answer can pass by containing
  the expected evidence token even if a human would want more detail. The raw
  answers are in the result JSON for spot checks.
- The harness calls the production runner directly. Route gates (officer case
  access, consent, flags, limiter) are covered by integration tests, not this
  eval.
- As-of is fixed at `2026-06-30`; policy sections depend on the seeded policy
  database. A corpus change needs a re-run before quoting these numbers.
- Both models keep answers short (mean 312/389 chars); the eval does not reward
  length or penalise a bare refusal on out-of-scope questions.
- Object-shaped tool results report `resultCount = 1`, so tool counts measure
  calls, not rows.

## Reproduce

```powershell
docker compose up -d --wait
pnpm setup
pnpm --filter @credit/research eval:case-assistant -- --trials=3
```
