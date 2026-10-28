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
(Terra), `...T08-00-54-653Z.json` (Sol) — local, gitignored. The judge is
**GPT-5.6 Terra**, independent of both answerers. The held-out manifest was
re-frozen after the invalid run.

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

## Verdict

**Tie on quality; GPT-6.1 Terra wins on cost.** For the policy-exception agent,
either model is defensible: Terra is the value pick ($0.388 vs $0.542), Sol is
the zero-repair pick. There is no pass@1 or pass^3 difference.

## Caveats

- The judge is GPT-5.6 Terra, independent of both answerers; its `unknown`
  verdicts count as failures.
- The earlier six-model run was discarded because the OpenRouter key limit
  produced 403s on memo/followup trials; do not use those files.
- The held-out manifest was regenerated for this rerun; the dataset was not
  tuned on it.
- Costs are OpenRouter list prices from token usage, not billed.
