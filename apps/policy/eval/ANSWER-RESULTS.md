# Policy navigator — answer eval

## 2026-10-27 re-run (POL-CR-009 decision-engine standard)

The corpus gained `POL-CR-009-decision-engine-standard.md` (9.0–9.4), so the
corpus is now 9 policies / 40 sections and the dataset 37 cases (29 dev,
8 held-out; four new dev cases, `nav-engine-01..04`). Commands:

```powershell
pnpm --filter @credit/policy eval:answers -- --split=dev --trials=1
pnpm --filter @credit/policy eval:answers -- --split=heldout --trials=1
```

| Split    | Cases |    Trial pass | Status |  Citation hit | Grounded |      Mean / p95 |    Cost |
| -------- | ----: | ------------: | -----: | ------------: | -------: | --------------: | ------: |
| Dev      |    29 | 23/29 (0.793) |  29/29 | 20/22 (0.909) |    38/38 | 10.6 s / 25.6 s | $0.1020 |
| Held-out |     8 |   8/8 (1.000) |    8/8 |   6/6 (1.000) |    12/12 | 12.8 s / 29.7 s | $0.0267 |

This is a single-trial re-run to check corpus regression, not a pass^3
quality claim. The four engine-standard cases: `nav-engine-01` (score band)
and `nav-engine-04` (DSCR 1.20x) pass; `nav-engine-02` (revenue S$60k vs the
S$200k POL-CR-003 gate) and `nav-engine-03` (TDSR 52% vs the 55% exception
cap) are status-correct and section-complete but the judge rates one answer
partial (completeness) and one misses the 5.2 citation. The pre-existing
dev failures remain `nav-answerable-07` (citation), `08`/`14`/`18`
(completeness). Status accuracy, retrieval, grounding, and safety are clean.

Command:

```powershell
pnpm --filter @credit/policy test
pnpm --filter @credit/policy eval:answers -- --trials=3 --split=heldout --delay=1500
pnpm --filter @credit/policy eval:answers -- --trials=3 --split=dev --delay=1500
```

The split runs are deliberate: the old held-out set was reclassified to dev
after tuning, a fresh held-out set (6 answerable + 2 new gate cases) was
frozen, and it was run once after the final prompt/validator change. The full
suite is `pnpm --filter @credit/policy eval:answers -- --trials=3 --delay=1500`
(the delay avoids OpenRouter burst limits).

Model: `deepseek/deepseek-v4.1-flash-1017` (temperature 0, 6000 output
tokens, 60 s timeout). Embeddings: `voyageai/voyage-4-large` (1024 dims).
Corpus: 8 policies, 35 sections. Dataset: 33 cases (25 dev, 8 held-out).
The section below is the historical 2026-10-24 run; the 2026-10-27 re-run
above supersedes its corpus/dataset counts.
Each trial runs the production markdown parser, retrieval ranker, answerer,
and `validateNavigatorAnswer`; the eval bypasses HTTP auth, ACL, and budget
reservations (recorded in the result metadata).

## Results

| Split    | Cases | Trials |    Trial pass | Cases passing all 3 | Status correct | Citation hit | Grounded segments |     Mean / p95 |    Cost |
| -------- | ----: | -----: | ------------: | ------------------: | -------------: | -----------: | ----------------: | -------------: | ------: |
| Held-out |     8 |     24 | 24/24 (1.000) |         8/8 (1.000) |          24/24 |        18/18 |             34/34 | 7.4 s / 19.5 s | $0.0656 |
| Dev      |    25 |     75 | 70/75 (0.933) |       22/25 (0.880) |          75/75 |        54/54 |             89/91 | 9.4 s / 23.9 s | $0.2437 |
| Combined |    33 |     99 | 94/99 (0.949) |       30/33 (0.909) |          99/99 |        72/72 |           123/125 |              — | $0.3093 |

Wilson 95% for cases passing all three: held-out 0.676–1.000, dev
0.700–0.958. Cost is the answerer's OpenRouter `total_cost` plus the judge
usage; it is not a full TCO (embedding and infrastructure are excluded).

Run note: an earlier all-case 3-trial run was discarded after a transient
OpenRouter outage produced a cascade of `fetch failed` rows. The production
answerer now retries network/429/5xx failures with backoff, and the final
split runs above are clean.

### What still failed on dev

| Case                                   | Failure                  | Read                                                                                                                                                  |
| -------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav-answerable-02` (DSCR)             | 2/3 trials grounded 0.67 | The answer adds the 1.15x secured floor as a second segment; the judge sometimes rates that paraphrase partial. The primary 1.25x claim is supported. |
| `nav-answerable-04` (freelance income) | 1/3 complete = partial   | The answer omits the under-24-month 50% recognition nuance.                                                                                           |
| `nav-answerable-18` (restructure)      | 2/3 complete = partial   | Complex multi-part answer; the judge wants every permitted relief spelled out.                                                                        |

These are completeness/claim-support strictness issues. Status, retrieval,
citations, and safety were clean in every trial. The judge is the same model
family, uncalibrated against human labels, so the grounded/completeness
numbers are directional and stricter than the deterministic citation gate.

## What changed because of the eval

| Change                                                                                                                                              | Why                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findQuote` whitespace normalization + canonical quote storage                                                                                      | Hard-wrapped policy Markdown made the model's space-normalized quotes fail `indexOf`; valid citations were rejected. The stored quote is now the exact source slice. |
| Reject normalized matches that cross blank lines or list/table markers                                                                              | Whitespace normalization must not stitch separate bullets into one quote.                                                                                            |
| PII scan on the canonical quote                                                                                                                     | A doubled space could hide a phone number from the single-space regex.                                                                                               |
| Safety filter on `limitations` (PII/URL/decision language)                                                                                          | Limitations are rendered to officers; production previously returned them unchecked. Eval and validator now share helpers.                                           |
| `isSingleClaim` strips `i.e.`, `e.g.`, `viz.`, `etc.`                                                                                               | “i.e. relief …” was counted as two sentences and rejected.                                                                                                           |
| Increase `limitations` max from 300 to 600 chars                                                                                                    | A correct `needs_policy_owner` conflict explanation exceeded 300 chars and failed the whole answer.                                                                  |
| Prompt v2: citations refer to the model-built array; copy complete operative clauses; one quote per segment; refuse vague questions; no extra rules | Removed the invalid-citation and over-answer failures seen in the first baseline.                                                                                    |
| `POLICY_AGENT_TIMEOUT_MS` 30 s → 60 s; gateway upstream 60 s → 75 s                                                                                 | Complex answers took 45–50 s; the 30 s deadline produced avoidable `failed` runs.                                                                                    |
| OpenRouter POST retries 2 → 4 with exponential backoff, including network errors                                                                    | A transient OpenRouter outage cascaded into `fetch failed` for a whole trial run.                                                                                    |
| Use production `readPolicyDir` in the eval corpus loader                                                                                            | Removes parser drift and validates anchors/frontmatter exactly like the importer.                                                                                    |
| As-of/jurisdiction/status filters in the eval                                                                                                       | The in-memory corpus now mirrors the production retrieval filters.                                                                                                   |
| Fresh held-out set (6 answerable + 2 gates)                                                                                                         | The first held-out set had been inspected during prompt tuning; it is now `dev`.                                                                                     |
| Strict pass: validator must be valid, all required sections cited, completeness = complete                                                          | Prevents a malformed output from being scored as a correct refusal and prevents partial answers from passing silently.                                               |

## Caveats

- Synthetic corpus, one version per policy; no retired/future-effective version
  is exercised. The eval bypasses ACL and budget gates (metadata records this).
- 31 cases is enough for a PoC, not for a production claim. The dev failures
  are reported rather than hidden.
- The claim-support/completeness judge is self-graded by the same model family
  and has no human agreement study; treat those columns as advisory.
- The held-out result is the one to quote for generalisation. The dev result is
  the tuning set.
