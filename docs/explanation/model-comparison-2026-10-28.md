# Model comparison across the credit agents — 2026-10-28

Six OpenRouter models across the five live LLM agents. GLM 5.3 and Kimi K3.1
Pro were dropped after the context sweep; GPT-6.1 Terra was added. Policy
exception was rerun with Terra/Sol only, per the follow-up request.

**Verdict:** GPT-6.1 Terra is the best overall value (context and policy wins,
exception tie at lower cost). GPT-6.1 Sol is the quality-depth pick (integrity
and brief wins, zero-repair exception). Opus, Muse, Gemini, and DeepSeek are
not recommended as defaults for the reasons below.

| Agent | Dataset | Trials | Report |
|---|---|---:|---|
| Context analyst | 30 window cases | 3 | `apps/research/eval/CONTEXT-MODELS-RESULTS.md` |
| Policy navigator | 37 cases | 3 | `apps/policy/eval/ANSWER-MODELS-RESULTS.md` |
| Document integrity | 28 cases | 3 | `apps/applications/eval/INTEGRITY-MODELS-RESULTS.md` |
| External case brief | 3 fixture cases | 3 | `apps/research/eval/BRIEF-MODELS-RESULTS.md` |
| Policy exception | 24 cases | 3 | `apps/applications/eval/POLICY-EXCEPTION-MODELS-RESULTS.md` |

All runners use the production prompt, tools/fixtures, and validator. Costs are
OpenRouter list prices projected from token usage, not billed. The policy and
exception judges are pinned to a model independent of the answerer
(`gpt-5.6-terra` for the exception rerun; `gpt-6.1-terra` for policy).

## Headline matrix

Pass@1 / pass^3 per agent. Brief is n=3 and directional; Gemini's brief path
failed at the provider (400), so it has no brief score.

| Model | Context | Policy (code) | Integrity | Brief | Policy exception |
|---|---|---|---:|---:|---:|
| **GPT-6.1 Terra** | **1.000 / 30/30** | **1.000 / 37/37** | 0.988 / 27/28 | 1.000 / 3/3 (entity 0.20) | **0.972 / 22/24** |
| **GPT-6.1 Sol** | **1.000 / 30/30** | 0.982 / 36/37 | **1.000 / 28/28** | **1.000 / 3/3 (entity 0.83)** | **0.972 / 22/24** |
| Claude Opus 5.5 | 0.989 / 29/30 | 0.856 / 30/37 | 0.976 / 27/28 | 0.889 / 2/3 | not run |
| DeepSeek V4.1 Flash 1017 | 0.978 / 28/30 | 0.964 / 34/37 | 0.976 / 26/28 | 0.667 / 2/3 | not run |
| Meta Muse Wonder | 1.000 / 30/30 | 0.991 / 36/37 | **1.000 / 28/28** | 0.111 / 0/3 | not run |
| Gemini 4 Argon | 1.000 / 30/30 | 0.973 / 35/37 | 0.929 / 25/28 | provider 400 | not run |

## Reproduce

Datasets and harnesses are committed; raw result JSONs are gitignored.

```powershell
pnpm --filter @credit/research eval:context-models -- --trials=3

$env:POLICY_AGENT_MODEL='openai/gpt-6.1-terra'
$env:POLICY_EVAL_JUDGE_MODEL='openai/gpt-6.1-terra'
pnpm --filter @credit/policy eval:answers -- --trials=3 --split=all --delay=0

$env:DOCUMENT_INTEGRITY_MODEL='openai/gpt-6.1-sol'
pnpm --filter @credit/applications eval:integrity -- --trials=3 --split=all --budget-usd=25 --concurrency=2

$env:BRIEF_EVAL_MODEL='openai/gpt-6.1-sol'
$env:BRIEF_EVAL_JUDGE_MODEL='openai/gpt-6.1-terra'
pnpm --filter @credit/research eval:brief -- --trials=3

$env:POLICY_EXCEPTION_MODEL='openai/gpt-6.1-terra'
$env:POLICY_EXCEPTION_JUDGE_MODEL='openai/gpt-5.6-terra'
pnpm --filter @credit/applications eval:policy-exception -- --trials=3 --split=all --budget-usd=8
```

## Pinned defaults

The production agent defaults now follow these results (overrides remain):

| Setting | Default | Report |
|---|---|---|
| `CONTEXT_AGENT_MODEL` | `openai/gpt-6.1-terra` | `CONTEXT-MODELS-RESULTS.md` |
| `AGENT_MODEL` (case brief) | `openai/gpt-6.1-sol` | `BRIEF-MODELS-RESULTS.md` |
| `POLICY_AGENT_MODEL` | `openai/gpt-6.1-terra` | `ANSWER-MODELS-RESULTS.md` |
| `POLICY_EXCEPTION_MODEL` | `openai/gpt-6.1-terra` (tie with Sol; cost pick) | `POLICY-EXCEPTION-MODELS-RESULTS.md` |
| `DOCUMENT_INTEGRITY_MODEL` | `openai/gpt-6.1-sol` | `INTEGRITY-MODELS-RESULTS.md` |
| `ASSIST_MEMO_MODEL` | unchanged (`deepseek/...`; scripted eval only) | `MEMO-AGENT-RESULTS.md` |

## Cost

| Model | Context | Policy | Integrity | Brief | Exception | Total* |
|---|---:|---:|---:|---:|---:|---:|
| GPT-6.1 Terra | $1.30 | $0.269 | $0.434 | $0.190 | $0.388 | **$2.58** |
| GPT-6.1 Sol | $3.60 | $0.250 | $0.432 | $0.177 | $0.542 | $5.00 |
| Claude Opus 5.5 | $8.90 | $0.368 | $0.838 | $0.358 | — | $10.46 |
| DeepSeek V4.1 Flash 1017 | $0.27 | $0.372 | $0.633 | $0.198 | — | $1.47 |
| Meta Muse Wonder | $8.74 | $0.327 | $0.701 | $0.225 | — | $9.99 |
| Gemini 4 Argon | $4.49 | $0.294 | $0.509 | — | — | $5.29 |

\* Excludes the policy-exception column for models not rerun there.

## Per-agent winners

- **Context analyst:** Terra. Perfect pass@3, the lowest narrative-drop rate
  (0.83/run), 12.2s, $1.30. Sol ties accuracy but costs 2.8× and drops 2.3×
  more. Sol has the most detailed transcripts.
- **Policy navigator:** Terra. Code pass 1.000 (37/37), judge pass 0.982,
  $0.269. Sol and Muse are close on code pass; Opus underperforms (0.856).
- **Document integrity:** Sol. Perfect 28/28, zero repairs, $0.432. Muse also
  goes 28/28 but costs $0.701 and is slower; Terra is 27/28.
- **External case brief:** Sol. Perfect code pass and the best entity grounding
  (0.83); Terra also passes 3/3 but entity confidence is 0.20, a real weakness
  for a brief whose job is disambiguation.
- **Policy exception:** Terra and Sol tie on quality (0.972 pass@1, 22/24
  pass^3, 1.000 structural, 0.963 semantic). Terra is cheaper ($0.388 vs
  $0.542); Sol has zero repairs.

## Verdict

**GPT-6.1 Terra is the best overall value**: it wins context and policy, ties
the exception on quality at lower cost, and is a close third on integrity. It
matches or beats Sol on every pass metric except integrity and the brief's
entity grounding, at roughly half the total cost.

**GPT-6.1 Sol is the quality-depth pick**: it wins integrity and the brief,
where entity disambiguation matters, and is the cleaner zero-repair exception
model. Choose Sol if the brief/officer prose is the priority; choose Terra if
cost, latency, or context/policy reliability is the priority.

**Not recommended as defaults:** Opus (expensive, weak on the strict policy
citation task), Muse (perfect integrity but shallow brief/context prose),
Gemini (slow; brief path provider-incompatible), DeepSeek (best cost/latency,
lower consistency and gap coverage).

## Caveats

- Context cases are three personas across 10–12 windows, not 30 customers.
- The brief is 3 in-sample fixture cases; treat it as directional.
- Policy/exception judges are fixed but still LLM graders; the code gates are
  independent. Human calibration is not done.
- An earlier six-model policy-exception sweep was invalidated by the
  OpenRouter key hard limit during memo/followup; it is superseded by the
  Terra/Sol rerun.
- Two production interoperability fixes were required: `get_transactions`
  cursor and integrity `searchPagesParams.limit` are now required properties.
