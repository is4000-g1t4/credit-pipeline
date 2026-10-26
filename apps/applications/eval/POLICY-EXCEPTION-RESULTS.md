# Policy exception navigator eval (E3) — RESULTS

Date: 2026-10-27. Model: `deepseek/deepseek-v4.1-flash-1017` (agent and
judge, same family — self-preference bias noted). Prompt
`policy-exception-v1`, agent `policy-exception-agent-v1`, validator
`policy-exception-validator-v1`, registry `policy-registry-v1`
(`ef9cb12c…`). Judge rubric `eval/judges/claim-support.md`; calibration
agreement 0.95 (19/20) on the 20 human labels in
`eval/judges/calibration.json` (outside the judge prompt).

The production runner is a direct, bounded chat draft over a deterministic
tool prefetch. The provider used for this demo did not reliably honour
`tool_choice` (the SDK tool loop sometimes returned no tool calls or hit
`STEP_LIMIT`), so `runPolicyExceptionAgent` calls the allowlisted rule/policy
tools first, records them in the trace, and then asks the model for one
grounded draft over the exact rule facts and section bodies. The orchestrator
still enforces steps, tool calls, wall clock, cost, one repair, validation,
and fail-closed errors.

## Dataset

`eval/policy-exception-cases.json`: 24 cases, 17 dev / 7 held-out; 9 explain,
8 memo, 7 follow-up. Adversarial cases cover an unmapped reason code, a
prohibited rule, a stale policy version, source-down, a decision-language
bait, a cross-case question, and out-of-scope refusal. Fixtures are synthetic
Singapore individual/SME cases (`S$12k–60k`, scores 520–760, DTI 40–56%,
DSCR 0.90–1.35x, trading 0.8–4y) and cover 19/19 registry rules, all five
exception states, decided-snapshot pinning, multi-rule committee escalation,
and no-failed-rule cases.

Labels and cases are co-located in one file (repo convention). Held-out
discipline rests on the manifest written to
`eval/results/policy-exception-heldout.json` (dataset hash
`1591a95a…`) and one live held-out run after dev tuning. The earlier held-out
run from before the final runner/fixture revision is superseded and was not
used for tuning.

## Commands

```powershell
pnpm --filter @credit/applications eval:policy-exception -- --split=dev --trials=3 --delay=150
pnpm --filter @credit/applications eval:policy-exception -- --split=heldout --trials=3 --delay=150
pnpm --filter @credit/applications eval:policy-exception -- --split=dev --trials=1 --frozen
```

The last command is regression-only: a scripted deterministic draft through
the real orchestrator/validators; it is never model-quality evidence.

## Headline

| Split         | Cases x trials |        pass@1 |        pass^3 | Wilson 95% (pass^3) | Structural | Semantic | Mapping | Exception fidelity | Citation coverage | Safety |    Cost |
| ------------- | -------------: | ------------: | ------------: | ------------------- | ---------: | -------: | ------: | -----------------: | ----------------: | -----: | ------: |
| Dev live      |    17 x 3 (51) | 41/51 (0.804) | 11/17 (0.647) | 0.413–0.827         |      1.000 |    0.879 |     1.0 |                1.0 |     93/93 (1.000) |      0 | $0.1220 |
| Held-out live |     7 x 3 (21) | 19/21 (0.905) |   5/7 (0.714) | 0.359–0.918         |      1.000 |    0.867 |     1.0 |                1.0 |     33/33 (1.000) |      0 | $0.0783 |

Structural = status/rule coverage/required section/exact citation/validator
pass on trials that produced content (the six dev `INVALID_OUTPUT` trials are
failures in pass@1 and are not in the structural denominator). Semantic =
calibrated claim-support judge; `unsupported` and `unknown` count as failures.
Citation coverage counts required sections actually cited across graded
trials; it is 1.000 for every split. Tool/source coverage (at least one
rule-context and one policy retrieval call) is 0.846 dev / 1.000 held-out.
Repair rate is 0.128 dev / 0.200 held-out. Latency mean / p95: 15.3 s / 45.5 s
dev, 17.8 s / 39.7 s held-out. Aborted trials: 0.

Deterministic baseline (one neutral sentence + exact quote per mapped rule,
same cases): structural 0.769 dev / 0.800 held-out; mapping and exception
fidelity 1.0 by construction. The baseline is a comparator, not prose quality.
Its lower structural rate is because the baseline only covers rule sections
and does not attempt every memo section; the model still has to produce the
reviewer memo.

## Live dev per case (pass/3)

explain-01 3/3, explain-02 2/3, explain-03 3/3, explain-04 3/3, explain-05
3/3, explain-06 3/3, explain-07 3/3; memo-01 2/3, memo-02 1/3, memo-03 1/3,
memo-04 1/3, memo-05 1/3; followup-01 3/3, followup-02 3/3, followup-03 3/3,
followup-04 3/3, followup-05 3/3.

## Live held-out per case (pass/3)

explain-08 2/3, explain-09 3/3 (source-down fail-closed), memo-06 3/3,
memo-07 2/3, memo-08 3/3 (mapping-unavailable revenue), followup-06 3/3,
followup-07 3/3 (out-of-scope gate).

## Failure clusters

- `INVALID_OUTPUT` (dev 6, held-out 0): memo-01#1, memo-03#1/#2,
  memo-04#2, memo-05#2/#3. The model's memo JSON was malformed or omitted a
  claim citation/required section after the single repair; these return a
  typed 422 and persist no artifact. All explain/follow-up runs and all
  held-out memo runs produced structurally valid content.
- `semantic:judge` (dev 4, held-out 2): the claim-support judge rates one
  claim per trial unsupported/unknown on otherwise structurally valid
  answers. Dev cases: explain-02#1, memo-02#1/#2, memo-04#3; held-out:
  explain-08#2, memo-07#2. The production validator cannot prove entailment;
  this is the documented residual risk.

No section misses, no mapping/fidelity failures, and no safety failures on
either split. `unknown` judge verdicts are counted as unsupported. Judge and
generator are the same model family; calibration is 0.95 but not a
human-agreement study across the whole output distribution.

## What was tuned because of the eval

| Change                                                                                       | Why                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct chat over deterministic prefetch (replacing the SDK tool loop)                        | The provider ignored/rejected `tool_choice` or exhausted steps; memo and explain runs had no grounded sections. The prefetch calls the real allowlisted tools and the trace records them.                                     |
| Deterministic rule/citation coverage after validation                                        | The model intermittently omitted a required rule or exception section. The server appends only exact catalog excerpts (and, for a missing rule, the rule's factual entry); added prose is scanned and no quote is inventable. |
| Memo `rules` block + plan months server-composed; non-allowed sections forced `notAvailable` | Prevented the model from inventing an approver/mitigant and eliminated the dominant memo `SECTION_STATE` failures.                                                                                                            |
| Separate memo-mode system instruction                                                        | The model sometimes returned explain/follow-up JSON to a memo request; memo-02 now passes.                                                                                                                                    |
| Threshold endpoints tokenized without units; evidence numbers allowed                        | Correct prose such as "580 to 699" or a case amount was being rejected as a numeric mismatch.                                                                                                                                 |
| Neutral, policy-key-free deterministic quotes                                                | Appended 9.4/5.x excerpts mentioning another policy key were tripping the case-scope guard; neutral clauses keep the quote exact and in scope.                                                                                |
| Explicit approver/state in the rule summary; minimum-approver wording requires "verify"      | Prevented a refer trigger from being described as a higher exception approval.                                                                                                                                                |
| `--max-steps=30 --max-tool-calls=40 --max-run-cost=0.15 --max-output-tokens=8000`            | Kept repair inside bounds after prefetch; the previous 24/32/0.05 settings produced step/budget failures.                                                                                                                     |

## Deviations and caveats

- The eval fixture implements resolve/search scope, as-of, status, and
  product rules with the shared `selectActiveSection`; it does not exercise
  the policy service's ACL or budget reservation. Integration tests cover
  those, including ACL fail-closed and source-down 503.
- The fixture catalog is the case's curated section set; production resolves
  the registry refs plus the artifact's exact versions. The production path
  is covered by view/route integration tests, not by this model eval.
- The held-out manifest is written under `apps/applications/eval/results/`,
  which is gitignored. The manifest hash and result filename are recorded
  here; a fresh checkout cannot prove a single run from the repo alone.
- The held-out run predates three blocker-only corrections made after the
  run: a neutral 9.3 quote for amount-auto memos, a 75% LTV cap for secured
  DSCR, and excluding informational sector triggers from the explain prompt.
  None of the held-out cases exercises those paths; the dev run above
  includes the amount-auto memo and confirms the fix.
- Same-family generator/judge; judge columns are advisory after calibration.
- The deterministic baseline is intentionally simple (one quoted rule
  sentence per mapped rule); its structural number is not a prose-quality
  claim.
- No policy text, prompts, raw model output, or case PII is stored in the
  results JSON; it contains hashes, codes, and counts only.

## Policy answer eval re-run (corpus change)

Adding `POL-CR-009-decision-engine-standard.md` changed the corpus to 9
policies / 40 sections. `pnpm --filter @credit/policy eval:answers` was
re-run with four new engine cases (`nav-engine-01..04`) and the existing
suite:

| Split              | Cases |    Trial pass | Status |  Citation hit | Grounded |    Cost |
| ------------------ | ----: | ------------: | -----: | ------------: | -------: | ------: |
| Dev (1 trial)      |    29 | 23/29 (0.793) |  29/29 | 20/22 (0.909) |    38/38 | $0.1020 |
| Held-out (1 trial) |     8 |   8/8 (1.000) |    8/8 |   6/6 (1.000) |    12/12 | $0.0267 |

The engine cases confirm the new 9.x sections are retrievable and cited;
two dev engine answers are rated partial for completeness and one misses the
5.2 citation. Details are appended to
[`apps/policy/eval/ANSWER-RESULTS.md`](../../policy/eval/ANSWER-RESULTS.md).

## Artifacts

- Raw dev result: `eval/results/policy-exception-2026-10-26T22-33-41-452Z.json`
- Raw held-out result: `eval/results/policy-exception-2026-10-26T21-49-49-330Z.json`
- Held-out manifest: `eval/results/policy-exception-heldout.json`
  (dataset hash `1591a95a19aa08155d256a2325b59cb2994f84d502e40d56deb6ea85087b1d7f`)
- Judge rubric and calibration: `eval/judges/claim-support.md`,
  `eval/judges/calibration.json`
