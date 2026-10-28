# Document-integrity model comparison — 2026-10-28

Six models through the production document-integrity agent and validators:
28 cases × 3 trials = 84 runs per model. GLM 5.3 and Kimi K3.1 Pro were
dropped; GPT-6.1 Terra added.

```powershell
pnpm --filter @credit/applications eval:integrity -- --trials=3 --split=all --budget-usd=25 --max-run-cost-usd=0.5 --concurrency=2
# sweep: DOCUMENT_INTEGRITY_MODEL=<model>
```

Raw results: `apps/applications/eval/results/integrity-2026-10-28T05-*.json` (local, gitignored).

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
- **Gemini:** six failed trials (two ambiguous-initials gates; four errors on
  the fraud/same-customer case: one timeout, two invalid outputs, one model
  error); slowest at 23.5s mean. No safety failure.

## Harder held-out documents (35 cases)

Seven held-out cases added after the comparison:

- `integrity-extract-image-only-no-text` — empty page, `ocr_unsupported`
  signal; the correct result is a cited gap, not invented fields.
- `integrity-extract-long-document-tail-field` — 21k-char page with the closing
  balance at the end, past the direct page-read cap.
- `integrity-extract-eur-amount-locale-date` — `EUR 12,345.67` and
  `31/03/2026`; no SGD coercion.
- `integrity-triage-duplicate-conflicting-statements` and its analysis
  companion — same account/period, different balances.
- `integrity-extract-stale-statement-date` — 2023 statement; literal date, no
  invented current date.
- `integrity-consistency-same-name-different-reg` — same name, different UEN;
  must not flag as a mismatch.

Sol, 35 cases × 3 trials:

- **pass@1 104/105 (0.990), pass^3 34/35 (0.971), 0 safety failures, $0.57.**
- The one miss is the long-document tail field: Sol sometimes never searches
  for the material amount. The full run failed 1/3 trials; an isolated retry of
  the same case passed 3/3 (`integrity-2026-10-28T13-46-37-735Z.json`), so this
  is intermittent search behaviour, not a hard capability gap.
- Production has no deterministic stale-document signal (`stale` is only a
  triage `missingEvidence` code), and `ocr_unsupported` yields no extractable
  fields, so those cases assert a cited gap rather than extraction.

Raw: `apps/applications/eval/results/integrity-2026-10-28T13-45-26-869Z.json`.

## Verdict

**GPT-6.1 Sol wins document integrity**: perfect pass@3, zero repairs, the
lowest cost among the perfect models (Muse also passes but costs 1.6× and is
slower). Terra is a close third at 0.988; Opus misses one case and DeepSeek
two; Gemini trails on reliability and latency.

## Caveats

- Synthetic fixtures; the model comparison is 28 cases (19 dev / 9 held-out);
  the hard-document extension takes the suite to 35 (19 dev / 16 held-out). No
  tuning on held-out.
- Usage on failed trials is not recorded, so cost totals understate failures.
- The deterministic baseline covers only label-regex fields; dates, amounts,
  and document types are model-only.
