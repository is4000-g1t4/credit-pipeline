# EN-03 generated-text validator eval

Status: passing. Deterministic (no model, no network), so `pass@1 = pass^3`
by construction; the value is the failure-mode coverage and the safety gate.

Command: `pnpm --filter @credit/applications eval:assist`

Dataset: 27 code-defined cases in `apps/applications/eval/assist-eval.ts`
(mutations of a valid memo, one policy memo, one adverse letter). The runner
uses the production validator (`validateGeneratedText`) and the production
deterministic memo builder (`buildCreditMemo`).

| Metric             | Result             |
| ------------------ | ------------------ |
| n                  | 27                 |
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
code): `SCHEMA_INVALID` (2), `UNSUPPORTED_CLAIM` (1), `CITATION_MALFORMED`
(1), `CITATION_MISSING` (3), `CITATION_UNAVAILABLE` (1),
`CITATION_QUOTE_MISMATCH` (1), `DECISION_LANGUAGE` (7: approve, decline,
recommend, score, rate, limit, terms), `PII_DETECTED` (4: email, phone,
NRIC, known case name),
`PROTECTED_ATTRIBUTE` (4: age, gender, race, marital status).

Caveats:

- This is a validator/gate eval, not a memo-quality eval. Memo prose quality
  and officer edit rate need the real feature and an LLM judge (later
  `US-MEMO-*` work).
- Cases are synthetic and code-defined. Grow the set from real failures.
- The decision-language scan is intentionally blunt; a future feature that
  must quote a banned word in generated prose needs an explicit exemption,
  not a weaker regex.
- Results JSON: `apps/applications/eval/results/` (one file per run).
