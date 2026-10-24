# External case brief — eval (2026-10-24)

Command:

```powershell
pnpm --filter @credit/research eval:brief -- --trials=3
```

Model: `deepseek/deepseek-v4.1-flash-1017` (temperature 0.1, 3000 output
tokens, 12 turns, 8 model tool calls). Fixture: frozen Tavily pages for three
entities (2–4 documents each), injected per case so a search cannot leak
another case's pages. The eval runs the real agent and the production
`validateAndBuild` pipeline (schema, quote snapshots, source tiers, entity
match, support judge, language repair).

## Results

| Metric                     | Result                                  |
| -------------------------- | --------------------------------------- |
| Cases / trials             | 3 / 9                                   |
| Trial pass                 | 9/9 (1.000)                             |
| Cases passing all 3        | 3/3 (1.000)                             |
| Citation validity          | 1.00 on every trial                     |
| Finding support            | 1.00 on every trial                     |
| Unsupported claims         | 0                                       |
| PII leaks                  | 0                                       |
| Forbidden / protected hits | 0                                       |
| Official source linked     | 8/9 trials (one clean brief was empty)  |
| Registry finding           | 8/9 trials (reported, not gated)        |
| Independent sources        | 2 (Acme), 1 (Bright), 1 (Meridian)      |
| Mean / p95 latency         | 9.5 s / 21.5 s                          |
| Cost                       | $0.2387 (projected ceiling, not billed) |

Case outcomes:

- **Acme (adverse):** 2 supported findings; adverse media with a linked
  official court record plus a registry finding; 2 independent sources.
- **Bright (clean):** 1 registry finding in two trials and a valid empty
  brief in one; no adverse finding invented.
- **Meridian (name collision):** registry finding only; the Batam judgment is
  recorded as a contradiction/unknown, not as an adverse finding.

Registry and support rates are reported quality metrics, not pass gates: the
prompt allows an empty brief that records what was checked, and the validator
already discards unsupported findings before persistence. Pass requires the
validated outcome to have the expected adverse signal, no false adverse
finding, the collision recorded, and valid citations.

Wilson 95% for 3/3 cases: 0.438–1.000. This is a three-case demo suite; the
interval is wide and the result should be read as “the pipeline works on these
scenarios”, not as a general precision estimate.

## What changed because of the eval

| Change                                                                                                                                                           | Why                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Mandatory server-side preflight for `adverse_media` and `registry`                                                                                               | The model sometimes returned a valid empty brief with zero tool calls, so clean/ambiguous entities had no evidence at all.                |
| Preflight consumes the `AGENT_MAX_FETCHES` budget and checks the run signal                                                                                      | Keep the per-run fetch cap honest and stop a slow preflight from eating the whole deadline.                                               |
| Retry only when no evidence was fetched                                                                                                                          | The old `toolCalls === 0` condition retried a perfectly good preflight-only brief and doubled cost.                                       |
| Raw preflight block with a random nonce, not JSON-escaped text                                                                                                   | Escaped `&`/`<` broke verbatim quote copying; the nonce prevents delimiter injection.                                                     |
| Prompt v6: preflight is authoritative; one contiguous quote per page; no name-only adverse findings; no findings that merely say “could not identify”; JSON only | Removed duplicate-localId drops, wrong-entity adverse findings, and Markdown output; empty briefs remain valid when they record unknowns. |
| `locateQuote` in `buildSnapshot`, canonical quote stored                                                                                                         | The same hard-wrap bug as policy citations: a model quote with spaces failed exact `indexOf` against a newline-wrapped page.              |
| Surrogate-pair boundary clamp                                                                                                                                    | Prevent a 20 KB snapshot window from splitting a UTF-16 pair.                                                                             |
| `AGENT_MAX_OUTPUT_TOKENS` 2000 → 3000                                                                                                                            | The collision brief’s longer unknowns/contradictions truncated the JSON.                                                                  |
| Eval uses linked evidence for registry/source-quality checks                                                                                                     | An unlinked official row could make a case look sourced when no finding cited it.                                                         |
| Eval gates adverse findings on validated `f.confidence` and requires no adverse finding on clean/collision cases                                                 | Entity-match confidence is not finding confidence; low-confidence false positives were slipping through.                                  |
| Eval grades the validated outcome, not registry/support completeness                                                                                             | The prompt allows an empty brief that records what was checked, and the validator already discards unsupported findings.                  |
| Summary judge is advisory only                                                                                                                                   | The judge flagged 6/9 faithful summaries as overreach; it has no human calibration and is not in `pass`.                                  |

## Caveats

- Three synthetic cases, no held-out split. Prompt and settings were tuned on
  these same cases; this is an in-sample sanity result, not generalisation.
- The frozen Tavily fixture is deliberately narrow. It does not exercise live
  web drift, stale/as-of rejection, or review-platform capping.
- The summary judge produced 6/9 `overreach` verdicts on summaries that read
  as faithful; it is reported for visibility, not gated.
- Cost uses the repo’s conservative `projectCostUsd` ceiling, not billed
  OpenRouter spend.
- The agent still requires `TAVILY_API_KEY` to be set because the tool wrapper
  checks it before calling the injected fake client.
