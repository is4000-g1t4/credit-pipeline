# Policy-exception navigator model comparison — 2026-10-28

Terra vs Sol only, per the follow-up request. 24 cases × 3 trials = 72 agent
trials per model through the production orchestrator, validators, and prompt.
The earlier six-model sweep was invalidated by the OpenRouter key limit during
the memo/followup cases; this is the authoritative rerun.

```powershell
$env:POLICY_EXCEPTION_MODEL='openai/gpt-6.1-terra'
$env:POLICY_EXCEPTION_JUDGE_MODEL='openai/gpt-5.6-terra'
pnpm --filter @credit/applications eval:policy-exception -- --trials=3 --split=all --budget-usd=8
```

Raw results: `eval/results/policy-exception-2026-10-28T07-59-37-553Z.json`
(Terra), `...T08-00-54-653Z.json` (Sol) — local, gitignored. The 24-case
comparison judge is **GPT-5.6 Terra**, independent of both answerers. The
29-case hard-case extension at `...T14-19-02-864Z.json` uses GPT-6.1 Terra
(the answerer's family), so treat its judge column as self-preferenced. The
held-out manifest was re-frozen after the invalid run.

## Results

| Model | pass@1 | pass^3 | Explain | Memo | Follow-up | Structural | Semantic | Mapping | Fidelity | Tool coverage | Repair | Safety | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| GPT-6.1 Terra | 0.972 | 22/24 (0.917) | 25/27 | 24/24 | 21/21 | 1.000 | 0.963 | 1.000 | 1.000 | 1.000 | 0.037 | 0 | $0.388 |
| GPT-6.1 Sol | 0.972 | 22/24 (0.917) | 26/27 | 24/24 | 20/21 | 1.000 | 0.963 | 1.000 | 1.000 | 1.000 | 0.000 | 0 | $0.542 |

Both models are structurally perfect and have identical semantic pass rates.
They fail different cases:

- **Terra:** `pe-explain-01` and `pe-explain-02` each lose one trial to the
  judge's `unknown` verdict.
- **Sol:** `pe-explain-05` and `pe-followup-05` each lose one trial to
  `unknown`. Sol needed no repair; Terra repaired 3.7% of trials.

## Judge's reading

Both produce complete, cited exception memos and explain/follow-up answers.
Terra is 28% cheaper and handles every memo case perfectly; Sol has the cleaner
repair record and one more correct explain trial, at a higher cost. This is a
quality tie broken by cost (Terra) or repair rate (Sol).

## Hard-case held-out extension (28 valid cases)

The 29-case run included `pe-explain-10` (no failed rules), which production
short-circuits to `no_match` before the model. It was removed after review as a
route-invalid case; the no-failed-rules path belongs in route tests, not a
model-quality eval. The numbers below are the 28 valid cases.

Four held-out cases added after the Terra/Sol comparison:

- `pe-explain-11` — two prohibited rules in one case; each must be reported
  separately with no approver or mitigant.
- `pe-followup-08/09` — prior officer/navigator thread resolved by the current
  question (the harness now accepts `input.turns` and prefixes the thread).
- `pe-memo-09` — individual applicant memo (the prior memo cases were SME).

Terra, 28 valid cases × 3 trials, live judge (GPT-6.1 Terra, same family as the answerer):

- **pass@1 27/28 (0.964), pass^3 27/28 (0.964)**, structural 1.000, semantic 1.000,
  mapping 1.000, fidelity 0.978, citation coverage 1.000, 0 safety failures,
  $0.458 total, 12.1s mean / 21.7s p95.
- Judge calibration 18/20 (0.90).
- The only failing case is `pe-explain-11` on all three trials:
  `fidelityFailures: ["mitigant-without-path"]`. The answer is structurally
  valid and the judge passes it; the eval's stricter check flags mitigant
  language on a prohibited rule. This is a genuine residual behavior gap (or a
  strictness artifact in the negative-statement detector), left unfixed because
  the case is held-out and the harness correctly refuses a second live held-out
  run after tuning.

Budget/timeout case: not added. The global budget path is covered by the
harness and route tests; forcing a per-case budget breach needs a model to
overspend unpredictably, so it would not be a stable case.

Raw: `eval/results/policy-exception-2026-10-28T14-19-02-864Z.json`. The Sol
column in the comparison remains the 24-case run; Sol was not rerun on the new
held-out cases to avoid consuming the split twice.

## Verdict

**Tie on quality; GPT-6.1 Terra wins on cost.** For the policy-exception agent,
either model is defensible: Terra is the value pick ($0.388 vs $0.542), Sol is
the zero-repair pick. There is no pass@1 or pass^3 difference.

## Caveats

- The comparison is 24 cases; the held-out extension takes the suite to 28
  valid cases (one route-invalid no-failed-rules case was removed after
  review). Sol was not rerun on the four new held-out cases.
- The multi-turn cases prepend prior turns to the model prompt; the
  deterministic follow-up gate still evaluates only the current question, so
  they test thread resolution, not gate bypass.
- The judge is GPT-5.6 Terra for the 24-case comparison; the 29-case extension
  uses GPT-6.1 Terra, so its judge column is self-preferenced.
- The earlier six-model run was discarded because the OpenRouter key limit
  produced 403s on memo/followup trials; do not use those files.
- The held-out manifest was regenerated for this rerun; the dataset was not
  tuned on it.
- Costs are OpenRouter list prices from token usage, not billed.
