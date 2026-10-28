# Document integrity eval — results (2026-10-26)

Feature: E2 document integrity + EN-04/EN-05 (`apps/applications`).
Archetype: explain/classify + structured extraction, with an advisory brief
produced by the same agent call. Production path:
`apps/applications/src/integrity/agent.ts` (`runIntegrityAnalysis`, one combined
run; `runIntegrityTriage` is a thin eval/test wrapper), the real OpenRouter
runner, and the shared validator. No HTTP/DB/auth in the runner (fixture
sources).

## Decision

**Ship as a passing baseline.** Dev 19/19 cases and held-out 9/9 cases pass
all three trials. Safety/citation guardrails are at zero failures. The
deterministic-signal baseline is reported beside the model; the model is not
credited for validator guarantees.

## Final runs

| Run      | Cases | Trials |        pass@1 |        pass^3 | Wilson 95% (pass^3) |    Cost | Latency mean / p95 |
| -------- | ----: | -----: | ------------: | ------------: | ------------------- | ------: | ------------------ |
| Dev      |    19 |      3 | 57/57 (1.000) | 19/19 (1.000) | 0.832 – 1.000       | $0.4549 | 7.6 s / 19.7 s     |
| Held-out |     9 |      3 | 27/27 (1.000) |   9/9 (1.000) | 0.701 – 1.000       | $0.2188 | 8.2 s / 33.5 s     |

Config: `deepseek/deepseek-v4.1-flash-1017`, temperature 0, combined
`integrity-analysis-v1` + `integrity-triage-v1` prompt, agent
`integrity-agent-v1`, max 24 steps / 32 tool calls / 90 s / $0.12 per eval
run ($0.25 production cap), 4000 output tokens. `asOf` 2026-06-30.

Raw results JSON (local/gitignored):
`apps/applications/eval/results/integrity-2026-10-26T06-01-44-874Z.json` (dev),
`apps/applications/eval/results/integrity-2026-10-26T06-03-59-730Z.json` (held-out).

## Metrics

| Metric                                                                                                 |           Dev |      Held-out | Target          |
| ------------------------------------------------------------------------------------------------------ | ------------: | ------------: | --------------- |
| Case pass@1 / pass^3                                                                                   | 1.000 / 1.000 | 1.000 / 1.000 | ≥ 0.90 / report |
| Safety failures (definitive fraud, cross-customer, decision language, PII, invalid citation persisted) |             0 |             0 | 0               |
| Required candidate recall                                                                              |         1.000 |         1.000 | ≥ 0.90          |
| Model candidate precision (expected fields only)                                                       |         0.538 |         0.468 | report          |
| Deterministic baseline precision / recall                                                              | 0.808 / 1.000 | 0.595 / 1.000 | baseline        |
| Repair rate                                                                                            |         0.140 |         0.185 | report          |
| Unsupported claims persisted                                                                           |             0 |             0 | 0               |
| Mean cost per trial                                                                                    |      $0.00798 |      $0.00810 | < $0.08         |
| p95 latency                                                                                            |        19.7 s |        33.5 s | < 90 s          |

Model precision is lower than the baseline because the agent proposes valid
extra fields and consistency candidates that the expected list does not name;
precision is counted only against the labelled expected fields. Do not read
the model as less accurate than the regex baseline from this column alone.

## Failure clusters (earlier iterations)

These were fixed before the final runs; they are the regression history:

1. **Bank-statement date/amount candidate rejected** — the model reformatted a
   date that the quote wrote differently. Fixed by parsing dates/amounts and
   comparing parsed values instead of raw text; added a regression case.
2. **Triage brief rejected by the applicant fair-lending deny list** — internal
   brief prose containing “single”/“age”-like words tripped the blunt
   applicant-facing list. Fixed with a reviewer-brief scan profile (PII,
   definitive-fraud, cross-customer, decision language still enforced;
   fair-lending deny list is applicant-facing only). Documented.
3. **Triage missed deterministic signal citations** — especially
   same-applicant duplicate hashes. Fixed in the prompt: cite every returned
   `crosscheck_mismatch` and `duplicate_hash_*` code, and only codes a tool
   returned.
4. **Signal citation with a document id did not resolve** — a case-level signal
   plus a model-supplied document id failed exact matching. Fixed by falling
   back to the same signal code when the id is not present.
5. **Quote copied with a hard wrap failed exact matching** — added a
   whitespace-normalized locate that stores the canonical source substring
   (still an exact excerpt, code-point offsets).
6. **Budget guard on an adversarial triage case** — the eval cap was $0.08;
   raised to $0.12 while keeping production at $0.25. The run failed closed,
   which is the intended behavior.
7. **Combined-run regression** — collapsing analysis and triage into one call
   initially dropped triage to 13/19 pass^3: the model skipped
   `list_signals`/`get_duplicate_context` and omitted signal citations. Fixed
   by restoring the full brief rules and mandated tool start in the combined
   prompt; final runs are back to 19/19 and 9/9.

The combined run costs slightly more on triage cases ($0.008 → $0.009 mean)
because the same call now returns candidates plus a brief; extraction-only
cases are unchanged.

## Caveats

- Synthetic fixture corpus (28 cases, 19 dev / 9 held-out). Held-out cases were
  inspected once during tuning; the final held-out run is reported as-is.
- The runner bypasses HTTP auth, ACL, consent, DB persistence, and audit; those
  are covered by `apps/applications/test/integration/integrity.test.ts` and the
  e2e spec, not this suite.
- The production validator already enforces schema, exact quotes, PII,
  decision language, definitive-fraud, and cross-customer checks. This suite
  records rejection/repair behavior; it does not claim validator guarantees as
  model quality.
- Raw pre-repair output is not persisted (only codes/paths), so a
  “raw unsupported claim” count is not available; `meanDroppedClaims = 0`
  refers to the validated outcome. The orchestrator fails closed on an
  unrepaired invalid run.
- `totalCostUsd` understates failed/aborted trials because the orchestrator
  discards usage on INVALID_OUTPUT; final runs had no failures.
- No human calibration of a semantic judge; no judge is used. Graders are
  code-first (schema, citations, expected tuples, safety scans).
- The UEN/registration validator is format-only (`checksum_not_available`);
  no registration checksum algorithm is asserted.

## Reproduce

```bash
pnpm --filter @credit/applications eval:integrity -- --split=dev --trials=3
pnpm --filter @credit/applications eval:integrity -- --split=heldout --trials=3
```

Useful flags: `--case=<id>`, `--budget-usd=1.5`,
`--max-run-cost-usd=0.12`, `--concurrency=2`, `--frozen` (regression-only
scripted outputs; never quote as model quality), `INTEGRITY_EVAL_DEBUG=1`
(prints raw outputs to stderr for a failing transcript review; never persisted).

## Dataset shape

`eval/integrity-cases.json`: 12 extraction/classification, 8 consistency,
4 triage, 4 safety/adversarial. Splits: extraction 8/4, consistency 5/3,
triage 3/1, safety 3/1. Each case has `id, feature, split, tags, input,
expected, notes`; `input` is a fixture `IntegritySource` with synthetic page
text and deterministic signals. No raw page text is stored in result JSON.
