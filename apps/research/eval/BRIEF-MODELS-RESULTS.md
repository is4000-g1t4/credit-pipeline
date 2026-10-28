# External case-brief model comparison — 2026-10-28

Six models through the production case-brief agent, frozen Tavily fixture, and
production `validateAndBuild` pipeline. The model comparison used 3 cases × 3
trials = 54 runs; tuning later added two negative fixtures for 5 cases. The
suite remains directional (in-sample, not 30 cases). GLM 5.3 and Kimi K3.1 Pro
were dropped; GPT-6.1 Terra added.

```powershell
pnpm --filter @credit/research eval:brief -- --trials=3
# per-model sweep: BRIEF_EVAL_MODEL=<model> BRIEF_EVAL_JUDGE_MODEL=openai/gpt-6.1-terra
```

Raw results: `eval/results/brief-2026-10-28T05-*.json` (local, gitignored).

## Results

`pass` is code-only: expected adverse/registry/collision outcome, zero
forbidden/protected/PII, no injection leak, and citation validity. The support
judge is pinned to GPT-6.1 Terra for every answerer; `entity` is the model's
own entity-match confidence (a quality signal, not a pass gate).

| Model | pass@1 | pass^3 | Support | Citation | Official | Indep. | Entity | Safety | Mean | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| GPT-6.1 Sol | **1.000** | **3/3** | 1.00 | 1.00 | 1.00 | 1.33 | **0.83** | clean | 18.2s | $0.177 |
| GPT-6.1 Terra | **1.000** | **3/3** | 1.00 | 1.00 | 1.00 | 1.33 | 0.20 | clean | 15.3s | $0.190 |
| Claude Opus 5.5 | 0.889 | 2/3 | 0.94 | 1.00 | 1.00 | 1.22 | 0.78 | 1 raw forbidden hit | 25.8s | $0.358 |
| DeepSeek V4.1 Flash 1017 | 0.667 | 2/3 | 1.00 | 1.00 | 0.67 | 1.00 | 0.67 | 1 raw forbidden hit | 10.4s | $0.198 |
| Meta Muse Wonder | 0.111 | 0/3 | 0.11 | 0.78 | 0.11 | 0.11 | 0.11 | clean | 21.4s | $0.225 |
| Gemini 4 Argon | 0.000 | 0/3 | — | — | — | — | — | n/a | 5.3s | $0.000 |

Gemini failed all 9 trials with `400 Provider returned error` before any
output; it is a provider/schema incompatibility, not a measured quality zero.
Exclude it from the ranking.

## Judge's reading

- **GPT-6.1 Sol (best):** finds the adverse/registry facts, cites the official
  source, keeps the collision/name-only limitations explicit, and links the
  registration number from the source URL. Entity confidence 0.83 is the best
  in the suite.
- **GPT-6.1 Terra:** passes every code gate and is slightly cheaper/faster,
  but entity confidence is 0.20: it treats the filing as name-only and does
  not use the registration number present in the URL/record. For a brief whose
  job is entity disambiguation, that is a real quality gap.
- **Opus:** 8/9, with a strong entity score (0.78), but one raw forbidden hit
  and higher cost. Second-best transcripts.
- **DeepSeek:** 6/9; misses the official-source requirement in one case and
  has one forbidden hit. Good cost/latency, not as reliable.
- **Muse:** 1/9. It writes findings but often emits no `evidence` array, so
  the validator drops every finding; one clean trial only.
- **Gemini:** cannot run the brief path (400).

## Tuning follow-up (2026-10-28)

A brief-preflight ablation was worse (entity 0.72 vs 0.83, cost $0.27 vs
$0.18), so the mandatory server-side adverse/registry preflight stays. Prompt
`v7` added the registration-number rule; on the same 3 cases × 3 trials Sol
kept 9/9 pass and entity match rose from 0.833 to **1.000**. See
`apps/research/eval/TUNING-2026-10-28.md`.

## Hard-case extension (5 cases)

Added two negative/edge fixtures: `empty-no-hit` (no documents at all) and
`adverseonly` (adverse finding, no registry filing). Sol, preflight on, prompt
`v7`, 3 trials:

- **15/15 pass**, **5/5 pass^3**, $0.346 total, 17.9s mean.
- `empty-no-hit`: 0 findings, no invented facts, clean citation/safety.
- `adverseonly`: 1 adverse finding, bootstrap registry left absent.

This is still a small suite (5, not 20–30), but it adds the first real
negative case. Raw: `brief-2026-10-28T12-43-00-996Z.json`.

## Verdict

**GPT-6.1 Sol wins the case brief**: perfect pass@3, best entity grounding,
clean safety, and lower cost than Opus. Terra is the cheap tie on the code
gates but its weak entity matching makes it the wrong default for this agent.

## Caveats

- 3 hand-built fixture entities, in-sample; not a 30-case generalization
  claim. The prior `BRIEF-RESULTS.md` uses the same fixture.
- The support judge is pinned to Terra, so Terra's own runs have
  self-preference bias; the code pass does not depend on the judge.
- Raw results are gitignored; costs are projected list prices.
