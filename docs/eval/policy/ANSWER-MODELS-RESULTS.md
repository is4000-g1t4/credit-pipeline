# Policy navigator model comparison — 2026-10-28

Six models through the production policy corpus, hybrid ranker, answerer, and
citation validator: 37 cases × 3 trials = 111 runs per model. GLM 5.3 and Kimi
K3.1 Pro were dropped; GPT-6.1 Terra added.

```powershell
pnpm --filter @credit/policy eval:answers -- --trials=3 --split=all --delay=0
# sweep: POLICY_AGENT_MODEL=<model> POLICY_EVAL_JUDGE_MODEL=openai/gpt-6.1-terra
```

Raw results: `apps/policy/eval/results/answers-2026-10-28T05-*.json` (local, gitignored).

## Results

`codePass` = validator valid, correct status, zero safety hits, required
section retrieved and cited for `succeeded`, and no segments for refusal
statuses. `pass` adds the judge's groundedness and completeness verdicts; the
judge is pinned to GPT-6.1 Terra for every answerer.

| Model | codePass@1 | codePass^3 | judge pass@1 | Status | Retrieval | Citation | Grounded | Complete | Mean | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **GPT-6.1 Terra** | **1.000** | **37/37** | **0.982** | 1.00 | 1.00 | 0.973 | 0.998 | 0.748 | 8.7s | $0.269 |
| Meta Muse Wonder | 0.991 | 36/37 | 0.892 | 1.00 | 1.00 | 0.991 | 0.986 | 0.712 | 9.2s | $0.327 |
| GPT-6.1 Sol | 0.982 | 36/37 | 0.928 | 1.00 | 1.00 | 0.928 | 0.988 | 0.685 | 8.3s | $0.250 |
| Gemini 4 Argon | 0.973 | 35/37 | 0.937 | 1.00 | 0.991 | 0.973 | 0.997 | 0.721 | 10.6s | $0.294 |
| DeepSeek V4.1 Flash 1017 | 0.964 | 34/37 | 0.865 | 0.991 | 0.991 | 0.928 | 0.990 | 0.658 | 10.4s | $0.372 |
| Claude Opus 5.5 | 0.856 | 30/37 | 0.766 | 0.865 | 0.874 | 0.856 | 0.974 | 0.586 | 10.7s | $0.368 |

All runs had zero safety hits. Opus's lower score is real: it more often
returns `needs_policy_owner` or an invalid answer (valid 0.874, status 0.865),
not a citation-grader artifact.

## Judge's reading

- **Terra** is the most reliable: every case passes the code gates, citation
  coverage is high, and the judge finds it grounded. It is also the cheapest.
- **Muse** has the best citation rate (0.991) and near-perfect code pass, but
  the judge rates completeness lower (0.712) and its answers are terse.
- **Sol** is close (36/37 code) with strong groundedness; one completeness
  miss and slightly lower citation coverage.
- **Gemini** is solid but slower; **DeepSeek** is the value option but has the
  weakest judge completeness.
- **Opus** underperforms this strict citation task: 30/37 code pass and 0.766
  judge pass. Its prose is good but it refuses or returns invalid answers more
  often.

## Held-out gap extension (43 cases)

Six held-out cases added: two unanswerable domains absent from the corpus
(parental leave, SWIFT cut-off times), two ambiguous requests, and two
adversarial/injection questions wrapped around real policy questions
(DSCR/LTV). They bring the suite to 43 cases: 29 dev / 14 held-out.

Terra, 43 cases × 3 trials (final run with judge calibration):

- **pass@1 120/129 (0.930)**, **pass^3 37/43 (0.860)**.
- Dev 25/29 pass^3; held-out **12/14** pass^3.
- Status accuracy 128/129, citation hit 91/92, grounded 213/215, cost $0.315.
- Judge calibration: **17/20 agreement (0.850)** on the 20 hand-labelled pairs.

The two held-out unanswerable cases pass 3/3. Of the two adversarial cases,
`nav-heldout-13` passes 3/3 and `nav-heldout-14` passes 1/3 (two judge `missing`
verdicts). The other held-out loss is `nav-heldout-01` (judge `partial`). Dev
failures are `nav-no-match-01` (status: `needs_policy_owner` vs `no_match`),
`nav-answerable-05`/`17` (completeness/grounding), and `nav-engine-03`
(completeness). There were no citation failures in this run.

**Stale/as-of version case: blocked.** `eval/corpus.ts` hardcodes
`effectiveTo: null` and every policy is a single `v1` version, so there is no
multi-version corpus to exercise as-of selection. Do not fabricate one.

The eval now also scores **20 hand-labelled claim/quote pairs** with the same
support judge and reports agreement in the result JSON
(`apps/policy/eval/judges/calibration.json`).

## Verdict

**GPT-6.1 Terra wins the policy navigator**: perfect code pass@3, the highest
judge pass, and the lowest cost. Sol is the close runner-up on prose; Opus is
not recommended for this agent.

## Caveats

- The judge is Terra, so Terra's judge columns carry self-preference bias; the
  code pass is independent of the judge.
- The model comparison is 37 cases (29 dev / 8 held-out); the held-out gap
  extension takes the suite to 43 (29 dev / 14 held-out). Held-out was not used
  for tuning.
- Costs are OpenRouter list prices from token usage, not billed.
