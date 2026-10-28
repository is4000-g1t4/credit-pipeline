# Context-analyst model comparison — 2026-10-28

Six models, same production context agent, real read-only context tools, and
the production validator, on 30 cases × 3 trials = 540 runs. GLM 5.3 and Kimi
K3.1 Pro were dropped from the previous sweep; GPT-6.1 Terra was added.

```powershell
pnpm --filter @credit/research eval:context-models -- --trials=3 --max-spend=50 --concurrency=3
```

Raw result: `eval/results/context-models-2026-10-28T05-38-14-963Z.json` (local,
gitignored). Dataset: `eval/context-models-cases.json`. Prompt `context-v5`,
validator `context-v4`, temperature 0.1, max 6,000 output tokens, 16 turns,
16 tool calls, 6-month window.

## Dataset

The three demo personas (BreadTalk SME, Alex individual, Sparse no-accounts)
across 10–12 as-of windows each. The as-of date is the eval application's
`submitted_at`, so each case changes the deterministic candidate set the model
must select: `round_trip`, `cash_deposit_share`, `returned_payment`,
`declared_vs_observed_cashflow`, `revenue_concentration`, or
`insufficient_data`. The 30 cases are 12 BreadTalk windows, 12 Alex windows,
and 6 Sparse windows; 21 dev / 9 held-out by mark, not used for tuning.

Caveat: the original comparison used 30 window variants over three customers, not
30 independent customers. A later extension added seven independent-customer
cases (below); the original six-model table remains the 30-case comparison.

## Independent-customer extension (37 cases)

`eval/independent-fixtures.ts` adds five eval-owned customers that are not
demo-seed rows:

- `multiaccount`: two owned accounts, aggregate (`all`) scope, internal
  transfers, one dominant payer, declared FCF 2.0m vs ~6.3m observed.
- `negative`: four consecutive end-of-day negative balances (threshold 3), plus
  an early as-of that closes before the overdraft.
- `rich`: 60 transactions, a decided prior application, an overdue loan with
  installments and an open EWS alert, three KYC checks, bureau and bank
  reports, and a document crosscheck/finding.
- `emptywindow`: an active account with no rows inside the observation window.
- `hostile`: injection text in case facts and a finding reason, plus an NRIC
  and phone number in stripped transaction descriptions.

Terra and Sol, 37 cases × 3 trials = 222 runs, default preflight-off path:

| Model | pass@1 | pass^3 | Errors | Narrative drops/run | Mean / p95 | Cost |
|---|---:|---:|---:|---:|---:|---:|
| GPT-6.1 Terra | 1.000 | 37/37 | 0/111 | 0.38 | 13.0s / 22.6s | $1.386 |
| GPT-6.1 Sol | 1.000 | 37/37 | 0/111 | 1.59 | 16.4s / 25.4s | $3.577 |

All seven new cases passed at pass^3 for both models. The hostile case returned
no injection text, NRIC, phone number, approval language, or `low risk` phrase
in any trial. Terra remains the pinned model: same accuracy, 42 narrative drops
vs 177, and 2.6× cheaper.

Pagination caveat: the applications service pages transactions at 500 rows
(`CONTEXT_TRANSACTIONS_PAGE_LIMIT`), so the 60-row rich fixture exercises
volume but not cursor pagination. A true paging case needs >500 rows or a
restarted service with a smaller page limit.

## Results (30-case comparison)

`pass` = validator `ok`, all deterministic candidates covered exactly once,
no dropped signals, expected types present, sparse gap present, no tool
failure, no model-budget breach. Narrative drops do not fail the run (the
server composes persisted prose), but they are a model-quality signal.

| Model | pass@1 | pass^3 | 1st pass | Errors | Sparse gap | Narrative drops/run | Mean / p95 | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| GPT-6.1 Terra | **1.000** | **30/30** | 1.000 | 0/90 | 1.00 | **0.83** | 12.2s / 21.9s | **$1.30** |
| GPT-6.1 Sol | **1.000** | **30/30** | 1.000 | 0/90 | 1.00 | 1.92 | 14.7s / 23.7s | $3.60 |
| Meta Muse Wonder | 1.000 | 30/30 | 1.000 | 0/90 | 1.00 | 1.09 | 11.5s / 15.7s | $8.74 |
| Gemini 4 Argon | 1.000 | 30/30 | 1.000 | 0/90 | 1.00 | 3.52 | 27.6s / 55.0s | $4.49 |
| Claude Opus 5.5 | 0.989 | 29/30 | 1.000 | 0/90 | 1.00 | 5.53 | 21.3s / 38.9s | $8.90 |
| DeepSeek V4.1 Flash 1017 | 0.978 | 28/30 | 0.822 | 2/90 | 0.94 | 1.63 | 5.4s / 16.6s | $0.27 |

Wilson 95% CI for pass@1: perfect models 0.959–1.000; Opus 0.940–0.998;
DeepSeek 0.922–0.995. Total spend: $27.29.

## Judge's reading (one human, transcript review)

I read first-trial transcripts for the full window, the thin January window,
and the sparse case, plus every failure row. Scores are for the model's own
explanations/gaps/limitations; persisted prose is server-composed, so this is
advisory, not a product-safety metric.

| Model | Judge | Why |
|---|---:|---|
| GPT-6.1 Sol | **5/5** | Most thorough: specific dates/amounts, correct units, caveats thin history, all seven gap categories on Sparse. 173 validator drops are mostly the numeric-attestation rule rejecting otherwise correct tool detail. |
| GPT-6.1 Terra | 4.5/5 | Concise, correct units, well-caveated; lowest drop count and cheap. Misses prior applications/loans in some sparse gaps, so slightly less complete than Sol. |
| Claude Opus 5.5 | 4.5/5 | Richest prose and near-full gap coverage, but over-specifies numbers the candidate tuple does not attest, producing 498 drops. |
| Gemini 4 Argon | 4/5 | Correct units and good sparse coverage; leaks the raw account UUID into prose, misses prior applications, slowest model. |
| DeepSeek V4.1 Flash 1017 | 3.5/5 | Excellent value; near-perfect structure, but one JSON failure, prose unit labels drift, limitations repetitive. |
| Meta Muse Wonder | 3/5 | Accurate but templated explanations; gaps/limitations duplicated verbatim; prior applications mentioned only 17% of the time on Sparse. |

## Failure clusters

- **DeepSeek (2/90).** `sparse-2026-04-30` trial 2 failed with truncated JSON
  (`Expected ',' or ']' after array element`). `breadtalk-2026-04-30` trial 2
  missed one candidate (`declared_vs_observed_cashflow`), coverage 0.5. The
  other 88 runs passed; pass@1 0.978, pass^3 28/30.
- **Opus (1/90).** `breadtalk-2026-03-31` trial 1 dropped one candidate
  (`candidate already reported`), failing that run.
- **No failures** for Terra, Sol, Muse, or Gemini.

## Production fix required for strict providers

GPT-6.1 Sol/Terra initially returned `400 Provider returned error` because
OpenAI-compatible strict providers reject a function schema with an optional
property not listed in `required`. `get_transactions` had an optional `cursor`.
Fixed by making `cursor` required (`""` means first page) and updating the
tool description/prompt. DeepSeek tolerated the old schema; the OpenAI models
did not.

## Tuning follow-up (2026-10-28)

After the comparison, the context preflight snapshot was removed from the
default path. Same 30/30, but narrative drops fell from 0.83 to 0.29 per run,
tool calls from 23.6 to 12.8, and cost from $1.30 to $1.09. The preflight
remains available with `CONTEXT_AGENT_PREFLIGHT_ENABLED=true`. Full A/B:
`apps/research/eval/TUNING-2026-10-28.md`.

## Verdict

**Overall: GPT-6.1 Terra** — perfect pass@1/pass^3/first-pass, zero errors,
the lowest narrative-drop rate, 12.2s mean, and $1.30 total (2.8× cheaper than
Sol, 6.7× cheaper than Muse). It matches Sol's accuracy and is the best
quality-per-dollar model in this suite.

- **Best transcript depth:** GPT-6.1 Sol (5/5), at 2.8× Terra's cost and 2.3×
  the drop count.
- **Best structured accuracy:** four-way tie at 30/30 (Terra, Sol, Muse,
  Gemini; Opus 29/30, DeepSeek 28/30).
- **Fastest / cheapest:** DeepSeek ($0.27, 5.4s), with one JSON failure, one
  missing-candidate run, and lower gap coverage.
- **Not recommended for this agent:** Opus (expensive, 498 drops) and Muse
  (accurate but shallow/duplicated); Gemini is correct but slow.

## Caveats

- Synthetic demo data; 30 window variants plus 5 independent customers, not a
  population sample. There was no per-case prompt tuning on held-out, but the
  preflight A/B and model selection used all 30 original cases (21 dev / 9
  held-out).
- The 60-transaction rich fixture does not cross the production 500-row page
  limit, so cursor pagination remains untested.
- Independent cases share one fixture user id per persona, so `credit-history`
  can see sibling eval applications from the same persona. That is fixture-only
  noise, not a production data leak, but it weakens prior-exposure isolation.
- The hostile check normalizes case/separators and scans the final output only;
  it does not force a document-findings tool call, so it proves the observed
  output is clean, not that every injection path was exercised.
- Prices are OpenRouter list prices at run time; costs are projected from
  token usage, not billed.
- One human judge, no inter-rater calibration; narrative drops are advisory
  because the server composes persisted prose.
- The production `get_transactions` schema changed for strict providers, so
  this run is not byte-identical to the pre-fix agent.
