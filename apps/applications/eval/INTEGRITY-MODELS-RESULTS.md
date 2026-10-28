# Document-integrity model comparison — 2026-10-28

Six models through the production document-integrity agent and validators:
28 cases × 3 trials = 84 runs per model. GLM 5.3 and Kimi K3.1 Pro were
dropped; GPT-6.1 Terra added.

```powershell
pnpm --filter @credit/applications eval:integrity -- --trials=3 --split=all --budget-usd=25 --max-run-cost-usd=0.5 --concurrency=2
# sweep: DOCUMENT_INTEGRITY_MODEL=<model>
```

Raw results: `eval/results/integrity-2026-10-28T05-*.json` (local, gitignored).

## Results

`pass` is code-only: extraction/triage gates, exact quotes, candidate
recall/precision expectations, and safety scans. There is no LLM judge.

| Model | pass@1 | pass^3 | Candidate recall | Candidate precision | Repair rate | Safety fails | Mean | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **GPT-6.1 Sol** | **1.000** | **28/28** | 1.00 | 0.493 | 0.024 | 0 | 9.3s | $0.432 |
| Meta Muse Wonder | **1.000** | **28/28** | 1.00 | 0.591 | 0.000 | 0 | 13.3s | $0.701 |
| GPT-6.1 Terra | 0.988 | 27/28 | 1.00 | 0.493 | 0.012 | 0 | 10.4s | $0.434 |
| Claude Opus 5.5 | 0.976 | 27/28 | 1.00 | 0.566 | 0.036 | 0 | 12.5s | $0.838 |
| DeepSeek V4.1 Flash 1017 | 0.976 | 26/28 | 1.00 | 0.527 | 0.083 | 0 | 7.5s | $0.633 |
| Gemini 4 Argon | 0.929 | 25/28 | 1.00 | 0.482 | 0.071 | 0 | 23.5s | $0.509 |

## Failure clusters

- **Sol / Muse:** none.
- **Terra:** one triage case (`integrity-triage-benign-explanation` trial 3)
  returned zero alternative explanations; all other trials pass.
- **Opus:** two trials of `integrity-consistency-ambiguous-initials` missed the
  expected `account_holder_name:needs_chase` consistency gate.
- **DeepSeek:** two `INVALID_OUTPUT` triage trials
  (`integrity-triage-benign-explanation`, `integrity-safety-same-customer-reuse`).
- **Gemini:** four failed trials (timeouts and two ambiguous-initials gates);
  slowest at 23.5s mean. No safety failure.

## Verdict

**GPT-6.1 Sol wins document integrity**: perfect pass@3, zero repairs, the
lowest cost among the perfect models (Muse also passes but costs 1.6× and is
slower). Terra is a close third at 0.988; Opus and DeepSeek each miss one
case; Gemini trails on reliability and latency.

## Caveats

- Synthetic fixtures; 19 dev / 9 held-out, no tuning on held-out.
- Usage on failed trials is not recorded, so cost totals understate failures.
- The deterministic baseline covers only label-regex fields; dates, amounts,
  and document types are model-only.
