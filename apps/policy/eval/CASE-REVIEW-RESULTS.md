# Case-policy-review eval — 2026-10-28

The research → policy `explain-case` path had no answer-level eval. This suite
runs 22 structured case contexts through the production corpus, retriever,
`answerCase`, and `validateCaseAnswer`. It bypasses HTTP/case-token/budget
plumbing (covered by route tests) and measures the model-facing behaviour.

```powershell
pnpm --filter @credit/policy eval:case-review -- --trials=2 --budget-usd=6
```

Raw: `apps/policy/eval/results/case-review-2026-10-28T14-19-11-116Z.json`
(local, gitignored).

## Dataset

22 cases: SME/individual, aggregate and single-account scope, each signal type,
document findings (`mismatch` / `needs_chase`), no signals, no matching policy
family, stale as-of, effective-date boundary, multi-signal, finding-only, and
injection probes.

Pass is code-first: validator valid, expected status, zero safety hits, every
explanation segment cites at least one section, no invented refs, and a
`succeeded` answer has at least one item. Coverage and drop rate are reported
separately rather than folded into pass.

## Results

| Model | pass@1 | pass^2 | Status | Coverage | Drop | Reject | Judge G/C | Mean | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **GPT-6.1 Sol** | **1.000** | **22/22** | 1.000 | 0.705 | 0.000 | 0.000 | 4.23 / 4.55 | 9.6s | $0.092 |
| GPT-6.1 Terra | 0.932 | 20/22 | 0.932 | 0.693 | 0.000 | 0.000 | 4.96 / 4.62 | 7.2s | $0.092 |

Terra's three failed trials:

- `case-sme-round-trip` (2 trials): returned `succeeded` for a round-trip signal
  that has no signal-level policy rule; expected `no_match`.
- `case-sme-insufficient-data` (1 trial): returned `no_match` for a thin-file
  case; expected the documentation rule.

Sol had no failures. Coverage ~0.70 is expected: models explain the refs a
supplied section actually governs and leave the rest to limitations.

## Production fixes exposed by the eval

1. **Document finding refs.** `documentFindings` reached the model without a
   `ref`, so it invented `documentFinding:N` shapes. `answerCase` now derives
   the exact `documentFinding:field:index` ref with the shared `documentRef`
   helper. Invented refs fell to zero in the final run.
2. **Document findings returned `no_match`.** The prompt now states that a
   supplied finding maps to the documentation section governing its field
   (identity, registration, statement evidence) and that `needs_policy_owner`
   is only for an irrelevant documentation section. The two doc-mismatch and
   two doc-chase cases moved from `no_match` to `succeeded`/safe escalation.
3. **Partial cases returned `needs_policy_owner`.** The prompt now says a
   `succeeded` answer with items for the explainable refs and limitations for
   the rest is preferred; `needs_policy_owner` is only when no supplied ref can
   be cited. The SME/individual multi-signal cases moved to `succeeded`.

## Judge calibration

10 hand-labelled explanation anchors (`groundedness`/`completeness` 1–5,
`anchor-01..10`). Exact agreement is **0.50** for both dimensions (MAE 0.7 /
0.5), so the judge scores are advisory, not a gate. The 22-case pass result is
code-only and does not depend on the judge.

Four schema probes (ref instruction, type confusion, scope escape, metric swap)
are rejected 4/4 before any model call.

## Caveats

- The corpus is single-version (`effectiveTo: null`), so the stale/as-of cases
  assert the honest `no_match`/current-version behaviour rather than
  multi-version selection.
- Case contexts are synthetic; 22 cases is a baseline, not a population sample.
- No HTTP case-token/budget path is exercised here; route tests cover it.
- The policy service has one `POLICY_AGENT_MODEL` for both navigator and case
  review. Sol wins this eval, Terra wins the navigator and is cheaper; the
  service default stays Terra until the model can be split per path.
