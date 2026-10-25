# Memo-agent eval

Status: passing. Scripted mechanics (no model, no network), so `pass@1 =
pass^3` by construction; the value is the failure-mode coverage and the
safety gate.

Command: `pnpm --filter @credit/applications eval:memo-agent`

Dataset: 8 code-defined cases in `apps/applications/eval/memo-agent-eval.ts`
(synthetic application/evidence fixtures, scripted fake `MemoModel`). The
runner uses the production loop (`runMemoAgent`) and the production shared
validator (`validateGeneratedText`).

| Metric             | Result                      |
| ------------------ | --------------------------- |
| n                  | 8                           |
| trials             | 3                           |
| `pass@1`           | 1.00                        |
| `pass^3`           | 1.00                        |
| accepted (valid)   | 4                           |
| tool use rate      | 1.00                        |
| source-type cover  | 1.00                        |
| gap retrievals     | 2                           |
| repair rate        | 0.50                        |
| citation coverage  | 1.00                        |
| unsupported claims | 2 (caught, never persisted) |
| safety pass        | 1.00                        |
| cost / latency     | $0 / scripted               |

Failure-mode coverage: `accept` (4: happy tool use, gap-driven second
retrieval across 3 tool steps, one repair then valid, decision-language
first draft repaired to valid), `NO_TOOL_USE` (1: valid draft with no tool
calls, twice), `INVALID_OUTPUT` (2: still-invalid after the single repair;
exact-quote mismatch persisting through repair), `TOOL_CALL_LIMIT` (1:
3-call batch against a cap of 2).

Caveats:

- This is a mechanics/harness eval, not a prose-quality eval. The model is
  scripted; wording quality, real retrieval judgment, and officer edit rate
  need the live model and human review.
- Cases are synthetic and code-defined. Grow the set from real failures.
- The loop never persists (no DB in the harness); route-level fail-closed
  persistence is covered by `test/integration/assist-agent.test.ts`.
- Results JSON: `apps/applications/eval/results/` (one file per run).
