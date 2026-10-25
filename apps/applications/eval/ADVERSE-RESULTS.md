# EN-08 adverse-action letter eval

Status: passing. Deterministic (no model, no network), so `pass@1 = pass^3`
by construction; the value is the failure-mode coverage and the safety gate.

Command: `pnpm --filter @credit/applications eval:adverse`

Dataset: 19 code-defined cases in `apps/applications/eval/adverse-eval.ts`
(synthetic application/decision/score/evidence fixtures, no DB). The runner
uses the production builder (`buildAdverseActionLetter`) and the production
shared validator (`validateGeneratedText`).

| Metric             | Result             |
| ------------------ | ------------------ |
| n                  | 19                 |
| trials             | 3                  |
| `pass@1`           | 1.00               |
| `pass^3`           | 1.00               |
| accepted (valid)   | 3                  |
| safety pass        | 1.00               |
| false positives    | 0                  |
| false negatives    | 0                  |
| unsupported claims | 0                  |
| citation coverage  | 1.00               |
| cost / latency     | $0 / deterministic |

Failure-mode coverage (every unsafe case is rejected with the expected typed
code): `accept` (3: SG 3-reason letter, US 4-reason letter with ECOA
notices, valid SG letter through the shared validator),
`NEEDS_OFFICER_INPUT/insufficient_reasons` (1: two reasons),
`NEEDS_OFFICER_INPUT/unmapped_code` (1),
`NEEDS_OFFICER_INPUT/insufficient_specificity` (1: generic-only reasons),
`NEEDS_OFFICER_INPUT/missingCitationCodes` (1),
`NEEDS_OFFICER_INPUT` (1: missing applicant name), `NOT_DECLINED` (1:
approved decision), `FAIR_LENDING_BLOCKED` (2: protected attribute and proxy
in a decision reason label), `PROTECTED_ATTRIBUTE` (1: tainted letter through
the shared validator), `FAIR_LENDING_PROXY` (1: tainted letter through the
shared validator), `INTERNAL_REFERENCE` (1: model/scorecard/risk-grade prose
through the shared validator), and five `ADVERSE_DECISION_MISMATCH` binding
cases (`DECISION_ID_MISMATCH`, `REASON_CODE_NOT_IN_DECISION`,
`REASON_TEXT_MISMATCH`, `CITATION_NOT_DECISION_REASON`,
`CONTACT_PATH_MISMATCH`).

Caveats:

- This is a deterministic taxonomy/gate eval, not a prose-quality eval.
  Letter wording comes from fixed templates; readability and officer edit
  rate need the real feature and human review.
- Cases are synthetic and code-defined. Grow the set from real failures.
- The fair-lending deny-list is deliberately blunt: a false positive blocks
  the letter for human review rather than letting a protected attribute or
  proxy reach an applicant.
- Results JSON: `apps/applications/eval/results/` (one file per run).
