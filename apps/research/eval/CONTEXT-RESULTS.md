# Context analyst — eval (2026-10-24)

Command:

```powershell
pnpm --filter @credit/research eval:context -- --trials=3
```

Prerequisites: Postgres up, `pnpm db:init && pnpm db:migrate && pnpm db:seed &&
pnpm demo:seed`, and the applications/loans services running
(`pnpm dev:services`). The eval uses the real context agent, the real read-only
tool loop, and the production `validateContextOutput` (including repair).

Model: `deepseek/deepseek-v4.1-flash-1017` (temperature 0.1, 6000 output
tokens, 16 turns, 16 model tool calls, 6-month history window).

## Results

| Metric                    | Result                                  |
| ------------------------- | --------------------------------------- |
| Cases / trials            | 3 / 9                                   |
| Trial pass                | 9/9 (1.000)                             |
| Cases passing all 3       | 3/3 (1.000)                             |
| First-pass validation     | 9/9 (no repair)                         |
| Signal coverage           | 1.00 on every trial                     |
| Dropped signals           | 0                                       |
| Dropped narrative entries | 29 total (claims/gaps/limitations)      |
| Tool failures             | 0                                       |
| Model budget exceeded     | 0                                       |
| Mean / p95 latency        | 10.7 s / 23.5 s                         |
| Cost                      | $0.7546 (projected ceiling, not billed) |

Per persona:

- **BreadTalk (rich):** 4/4 signals, types `round_trip`,
  `cash_deposit_share`, `declared_vs_observed_cashflow`, `returned_payment`;
  data gaps/limitations present.
- **Sparse (no accounts):** 1/1 `insufficient_data`; data gaps recorded.
- **Alex (individual):** 1/1 `revenue_concentration`.

Wilson 95% for 3/3 cases: 0.438–1.000. Coverage is enforced by the validator,
so it is a sanity check, not an independent quality signal. The meaningful
numbers are first-pass validation, dropped signals, expected signal types, and
data-gap presence.

## What changed because of the eval

| Change                                                                                                                                              | Why                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Context prompt v5: “Return only the structured JSON object; no Markdown, headings, or prose”                                                        | BreadTalk returned a Markdown brief and the SDK rejected the output type.                                        |
| Expected signal types from the demo manifest (`round_trip`, `cash_deposit_share`, `returned_payment`, `revenue_concentration`, `insufficient_data`) | `validation.ok` only proves schema/coverage; it does not prove the right candidates were selected.               |
| Require `candidates > 0` and `toolFailures === 0`                                                                                                   | A zero-candidate run (tool/service failure) previously passed as a valid “no data” case.                         |
| Narrative drops (claims/gaps/limitations) are reported, not gated                                                                                   | The server composes persisted claims from validated signals; a dropped model narrative cannot reach the officer. |
| Eval-owned application rows only (`fixture_key LIKE 'eval-%'`)                                                                                      | The old reuse query could adopt a live demo application.                                                         |
| Cleanup in a nested `finally` so `sql.end()` always runs                                                                                            | An error during delete could leak the DB connection.                                                             |
| Strict expected types + min signal counts                                                                                                           | Prevents a single generic signal from passing the rich case.                                                     |

No production context prompt change was needed beyond the JSON-only rule; the
signal selection and data-gap behavior were already correct on the demo
fixtures.

## Caveats

- Three demo personas, no held-out persona. This is an in-sample demo result.
- The validator requires one signal per deterministic candidate and exactly
  matches tuples, so coverage is guaranteed when `ok` is true. The eval cannot
  tell “selected the right candidates” beyond the expected-type check.
- The eval calls the runner directly, not `runContextStage`; it does not
  exercise the production consent probe, lease/heartbeat, cost cap, or
  stop-gap persistence. Those are covered by integration tests.
- Requires running applications/loans services and seeded demo data; the
  results are not reproducible from a bare checkout.
- Cost uses `projectCostUsd` ceilings, not billed OpenRouter spend.
