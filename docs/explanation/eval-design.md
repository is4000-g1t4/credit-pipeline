# Eval design for the AI features

Status: guideline. Applies to every AI feature in the repo, current and
future. The current features — the policy navigator, the automatic case
policy review, the external case brief, and the context analyst — are worked
examples, not the whole scope. It is deliberately small: this is a PoC with a
synthetic corpus, not a production ML platform. The goal is a suite a grader
can inspect, re-run, and believe.

## 1. The short version

1. Keep the dataset in the repo. 20–30 cases per feature, taken from demo
   personas and real failures, with a frozen held-out split.
2. Grade outcomes with code first. The production validators already enforce
   schema, citations, and safety; measure what they reject and whether the
   accepted answer is useful.
3. Use one LLM judge per semantic dimension, calibrated on ~20 human labels,
   with an `unknown` escape hatch.
4. Run three trials for nondeterministic steps. Report `pass@1`, `pass^3`,
   `n`, cost, latency, and a confidence interval. Never compare single runs.
5. Offline evals for content; Grafana for operational telemetry (latency,
   cost, status, errors). Do not turn on content capture to get nicer
   Grafana evals.

## 1.1 The eval contract

Every AI feature, including one added next month, ships with the same five
artifacts. The implementation can be a 100-line script; the contract is what
makes the result reviewable.

| Artifact     | What it contains                                                 | Where it lives               |
| ------------ | ---------------------------------------------------------------- | ---------------------------- |
| Dataset      | 20–30 cases with inputs, expected outcome, split, tags           | `apps/<app>/eval/cases.json` |
| Runner       | Real production prompt, model, tools, and validator; one command | `apps/<app>/eval/*-eval.ts`  |
| Graders      | Code first, then at most one semantic judge per dimension        | The runner                   |
| Report       | `pass@1`, `pass^3`, n, cost, latency, failure clusters, caveats  | `apps/<app>/eval/RESULTS.md` |
| Registry row | Feature, archetype, dataset, command, owner, status              | §4.5 table                   |

If a feature cannot fill the contract, it is not ready to be called “done”.
It is still allowed to ship as an experiment, labelled as such.

## 1.2 Pick the archetype first

The archetype decides what a “correct” outcome even means. Do not copy the
policy navigator’s graders onto a summarizer.

| Archetype                       | Example here           | Primary grade                                                                              | Typical negative cases                                    |
| ------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Retrieval-augmented answer      | Policy navigator       | Required section retrieved and cited; claim supported by quote; refusal when unsupported   | Unanswerable, ambiguous, out-of-scope, stale version      |
| Tool-using research             | External case brief    | Every finding supported by a fetched quote; source quality/independence; no invented facts | Empty search, wrong entity, stale source, low-tier source |
| Structured extraction/selection | Context analyst        | Exact candidate tuple selected; no invented values; full coverage; data gaps stated        | Sparse data, duplicate fields, too many accounts          |
| Explain/classify                | Case policy review     | Correct status/ref; every item cited; no decision language                                 | No matching policy, ambiguous support                     |
| Summarize/rewrite               | Future                 | Coverage of required facts; no added facts; no banned language                             | Long input, contradictory input, missing source           |
| Pure gate/classifier            | Scope/identifier gates | Confusion matrix on labelled inputs; zero unsafe pass-through                              | Adversarial formatting, homoglyphs, near-misses           |

A future feature may combine archetypes. Pick the dominant one for the
headline metric, then add the guardrails from the others.

## 2. What the labs do

The common shape is stable across Anthropic, OpenAI, and Google: a small set
of unambiguous tasks, deterministic graders where possible, model graders
only for semantics, multiple trials, and humans reading transcripts to keep
the graders honest.

| Practice                                                     | Where it comes from                                      | What we copy                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 20–50 tasks from real failures is a good start               | Anthropic, _Demystifying evals for AI agents_ (Jan 2026) | Seed from demo personas and bug reports; grow the set one failure at a time                        |
| Code graders first, model judges second, humans to calibrate | Anthropic                                                | Validators, regex, status checks, citation checks first; judge only claim support and completeness |
| Grade the outcome, not the path                              | Anthropic                                                | Do not assert tool order or exact wording; assert the answer, citations, status, and state         |
| Capability evals vs regression evals                         | Anthropic                                                | New/hard cases measure what the agent can do; the demo cases must stay at 100%                     |
| `pass@k` vs `pass^k`                                         | Anthropic                                                | `pass@1` for quality, `pass^3` for consistency; customer-facing means consistency matters          |
| Read the transcripts                                         | Anthropic                                                | Every failed case gets opened; classify model error vs grader bug vs ambiguous task                |
| Trace first, then datasets and eval runs                     | OpenAI, _Evaluate agent workflows_                       | Inspect one real run before writing a grader; then freeze the input as a case                      |
| Calibrate model graders against human evals                  | OpenAI, _Evaluation best practices_                      | 20 hand labels before trusting a judge; report agreement                                           |
| Final response vs trajectory                                 | Google Cloud, _Evaluate Gen AI agents_                   | We mostly grade final response; trajectory metrics are not the default for constrained agents      |
| Rubric-based metrics, static or adaptive                     | Google Cloud                                             | Use a fixed rubric for our stable tasks; adaptive rubrics are unnecessary here                     |
| Evaluations in CI                                            | Google Cloud                                             | Run the small regression suite before changing a prompt/model; keep the full suite manual          |
| Online evaluation + score export + agent versions            | Grafana Agent Observability                              | Operational SLIs and drift, not content quality (see §3)                                           |

### 2.1 What does not transfer

- **Trajectory exact-match.** The policy navigator is one-shot; the context
  analyst has a bounded tool loop. Grading tool order would punish valid
  exploration. Grade the selected outcome and the tool budget instead.
- **Public benchmarks.** MMLU/SWE-bench/τ-bench say nothing about a synthetic
  credit corpus and a citation validator.
- **A dedicated eval platform.** LangSmith, Braintrust, and Grafana
  experiments are useful at scale; here a ~100-line script per feature and a
  checked-in JSON file are more reproducible and easier to mark.
- **Big synthetic test sets.** A 24-case suite with a frozen held-out split
  beats 200 generated questions nobody has read.

## 3. Grafana: what it is good for here

### 3.1 Current state

- Only `apps/research` is instrumented (`src/observability.ts`). It is
  **metadata-only**: model, operation, tokens, duration, errors, agent name
  and version. No prompts, outputs, applicant names, policy text, or tool
  arguments. `contentCapture: "metadata_only"`, email redaction on, and every
  Grafana fault is swallowed so a run never fails because observability is
  down.
- `apps/policy` is not instrumented. It runs on Bun, and the
  `@grafana/agento11y` SDK is Node-only (the reason research runs on Node).
- The policy service already writes an append-only audit row per query:
  status, error code, retrieved section IDs, and cost (`policy_queries`).
  It does not store latency or raw question/answer text.
- The research service stores per-stage status, usage, timings, and
  validation JSON on `agent_runs` (`validation`, `context_validation`,
  `policy_validation`).

### 3.2 What Agent Observability offers

Grafana Cloud Agent Observability captures generations and conversations,
tracks agent versions, and supports online evaluation rules with four
evaluator types: LLM judge, JSON schema, regex, and heuristic. Rules can
alert on pass rate. There is a score-export API
(`POST /api/v1/scores:export`, idempotent by `score_id`) and an experiments
surface for offline runs. It is built on OpenTelemetry `gen_ai.*`
conventions and also ingests plain OTel spans.

### 3.3 The constraint that decides the design

Our telemetry is metadata-only. Grafana's content evaluators have no content
to grade. Turning on content capture would put policy text, applicant data,
and model output into a third-party observability backend — the opposite of
the design in the T03/T04 spec and the README. Don't do it for a school
project.

So split the job:

| Question                               | Where to answer it                                      | Why                                                     |
| -------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| Did the answer have a valid citation?  | Offline eval + `policy_queries.status`                  | The validator is deterministic and free                 |
| Was the answer correct and complete?   | Offline eval + one judge + human calibration            | Needs content and labels                                |
| Did latency, cost, or error rate move? | Grafana                                                 | Metadata is enough                                      |
| Did a prompt/model change regress?     | Offline regression suite before merge                   | Reproducible, no real users                             |
| Is production drifting?                | Grafana dashboard/alert, plus a periodic offline re-run | Online catches distribution change; offline explains it |

### 3.4 SLOs worth having (three, not thirty)

- `ai_stage_completion`: successful runs / started runs ≥ 0.95 per day.
- `policy_citation_valid`: navigator `succeeded` / (`succeeded` +
  `needs_policy_owner` with `error_code = citation_invalid`) ≥ 0.85. This is
  a proxy; the real number comes from the offline eval.
- `ai_cost_per_day`: spend ≤ the configured budget; p95 cost per run under
  the per-query cap; p95 latency under 30 s for the navigator and 45 s for
  the case stage (hard navigator timeout: 60 s).

For the PoC: one dashboard and one alert on completion rate. No pager.

### 3.5 Wiring, in order of laziness

1. **Do nothing.** Read `RESULTS.md` and the eval JSON. This is enough for a
   school submission.
2. **Dashboard from existing tables.** Grafana reads Postgres (read-only
   role): `agent_runs` stage statuses/timings/usage, `policy_queries`
   statuses/cost. No SDK, no content, no new service.
3. **Optional score export.** If you want eval results in Grafana, post them
   to `/api/v1/scores:export` with a stable `score_id`. Caveat: a score must
   reference a `generation_id` or `trial_id`; our research run id is a
   conversation id, not a generation id. Decide the mapping before building
   this.
4. **Instrument the policy service.** Only if the dashboard must show its
   traces in the same conversation view. The low-effort path is a DB-backed
   dashboard. The higher-effort path is running policy on Node like research
   so the Node SDK is available. Do not casually add a Node-only SDK to a
   Bun service.

Never send prompts, policy text, applicant PII, or raw model output to
Grafana. The metadata-only choice is a feature.

## 4. What already works in this repo

The validators are already the best deterministic graders we have:

- `apps/policy/src/answer.ts` — `validateNavigatorAnswer`: strict schema,
  one claim per segment, 1–3 citations, exact-substring quote, forbidden /
  PII / URL scans, all-or-nothing. Invalid output becomes
  `needs_policy_owner`; `apps/policy/src/routes.ts` logs the validation
  errors but does not persist the raw output.
- `apps/research/src/validator.ts` — external brief schema, quote
  verification, forbidden/protected scans.
- `apps/research/src/run.ts` — entity match, source independence, as-of
  checks, repair/judge, persistence. `executeRun` is the production path.
- `apps/research/src/context-validator.ts` — candidate tuple matching, no
  invented numbers, server-composed prose, `dropped` reasons.

Existing evals:

- `apps/policy/eval/embedding-eval.ts` + `queries.json` + `RESULTS.md` —
  retrieval-only, 30 dev / 30 frozen held-out, recall@5, MRR, nDCG@5,
  exact-section hit, Wilson 95% CI. This is the model to copy for dataset
  discipline and reporting.
- `apps/research/eval/settings-eval.ts` — a settings sweep. Context mode
  uses the real validator; web mode explicitly checks only the raw brief
  shape and is `n=1` directional. Useful for choosing settings, not for
  claiming answer quality.
- `apps/policy/eval/answer-eval.ts` + `answer-cases.json` — answer-level
  navigator eval (real retrieval, answerer, validator, judge).
- `apps/research/eval/brief-eval.ts` — frozen-Tavily brief eval through the
  production validator.
- `apps/research/eval/context-eval.ts` — real context agent/tools/validator
  against eval-owned demo applications.
- Results: `apps/policy/eval/ANSWER-RESULTS.md`,
  `apps/research/eval/BRIEF-RESULTS.md`,
  `apps/research/eval/CONTEXT-RESULTS.md`.

Gaps worth closing, in order:

1. The claim-support/completeness judge is the same model family and has no
   human calibration. Treat those columns as advisory until ~20 labels are
   scored against it.
2. No case-policy-stage eval. `validateCaseAnswer` also drops items rather than
   failing the stage, so a future eval must measure per-ref coverage and drop
   rate.
3. No held-out split for the brief/context demo personas. Their 9/9 results are
   in-sample sanity checks.
4. Rejected model output is discarded in production, so there is no record of
   _why_ a navigator answer fell back to `needs_policy_owner`.
5. No navigator telemetry in Grafana; the policy service still has no
   instrumentation.
6. The advisory-only invariant is covered only by the decision-snapshot test
   (`apps/worker/test/refer.test.ts`), not by a flags-on/off end-to-end test.

### 4.5 Feature registry

Add one row when a feature lands. A feature with no row is an experiment, not
a supported capability.

| Feature                                       | Archetype                                | Dataset                                            | Command                                             | Status                                          |
| --------------------------------------------- | ---------------------------------------- | -------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| Policy navigator (`apps/policy`)              | Retrieval-augmented answer               | `apps/policy/eval/answer-cases.json` (33 cases)    | `pnpm --filter @credit/policy eval:answers`         | passing: held-out 8/8, dev 22/25 at pass^3      |
| Case policy review (`apps/research` → policy) | Explain/classify                         | inline demo personas + edge case                   | `pnpm --filter @credit/research eval:policy`        | planned                                         |
| External case brief (`apps/research`)         | Tool-using research                      | inline 3-case fixture in `brief-eval.ts`           | `pnpm --filter @credit/research eval:brief`         | passing: 9/9, in-sample                         |
| Context analyst (`apps/research`)             | Structured extraction/selection          | demo personas in `fixtures.ts`                     | `pnpm --filter @credit/research eval:context`       | passing: 9/9, in-sample                         |
| Advisory-only invariant                       | System invariant                         | demo personas                                      | existing e2e/demo suite                             | partial: snapshot test only                     |
| Case-assist validator (`apps/applications`)   | Pure gate/classifier                     | 27 code-defined cases in `eval/assist-eval.ts`     | `pnpm --filter @credit/applications eval:assist`    | passing: 27/27 at pass^3, 0 unsafe pass-through |
| Adverse-action letter (`apps/applications`)   | Pure gate/classifier                     | 19 code-defined cases in `eval/adverse-eval.ts`    | `pnpm --filter @credit/applications eval:adverse`   | passing: 19/19 at pass^3, 0 unsafe pass-through |
| Document integrity (`apps/applications`)      | Explain/classify + structured extraction | `apps/applications/eval/integrity-cases.json` (28) | `pnpm --filter @credit/applications eval:integrity` | passing: dev 19/19, held-out 9/9 at pass^3      |
| Future feature                                | Pick §1.2                                | `apps/<app>/eval/cases.json`                       | `pnpm --filter @credit/<app> eval:<feature>`        | required                                        |

Update the status column to `baseline`, `passing`, `saturated`, or
`directional` after each run. Keep the command in the row so the next person
does not have to guess. Results:
`apps/policy/eval/ANSWER-RESULTS.md`,
`apps/research/eval/BRIEF-RESULTS.md`,
`apps/research/eval/CONTEXT-RESULTS.md`.

### 4.6 Adding a new AI feature

1. **Write the outcome sentence.** “Given X, the feature should produce Y,
   and must never do Z.” If you cannot write it, the feature is not ready
   for an eval.
2. **Pick the archetype** from §1.2. This fixes the headline metric and the
   negative cases.
3. **List what the production validator already guarantees.** Do not grade
   those as quality; record rejection rates instead. Add a grader only for
   what the validator does not decide.
4. **Collect 20 cases before tuning.** Use real failures, demo personas, and
   the boundaries the feature is likely to hit. Include at least five
   negative/adversarial cases.
5. **Build the smallest runner that uses the production path.** Import the
   real prompt, model, tools, and validator. Bypass HTTP auth only when it
   adds noise, and say so in the report.
6. **Choose graders in order:** schema/validator, outcome assertions, safety
   scans, one judge per semantic dimension, human spot-check.
7. **Run three trials, report `pass@1`/`pass^3`, n, cost, latency, and a
   Wilson interval.** Read the failing transcripts before changing anything.
8. **Add the row to §4.5 and the caveats to `RESULTS.md`.** A result without
   caveats is a marketing claim.

The same rules apply to a future feature even if its model, provider, or
tooling changes. The only hard model constraint in this repo is cost:
OpenRouter-backed agents use `deepseek/deepseek-v4.1-flash-1017`. Evals must
record the model and must not silently swap in a more expensive one.

## 5. The suite

### 5.1 Shared shape

One JSON file per feature, checked in. Every case is:

```json
{
	"id": "nav-answerable-01",
	"feature": "policy_navigator",
	"split": "dev",
	"tags": ["answerable", "sme", "retrieval"],
	"input": {
		"question": "What DSCR do we require for an SME term loan?",
		"product": "sme_term_loan",
		"asOf": "2026-06-30"
	},
	"expected": {
		"status": "succeeded",
		"requiredSections": ["POL-CR-002#2.2"],
		"forbiddenText": ["approve", "decline"],
		"referenceAnswer": "At least 1.25x."
	}
}
```

Rules:

- **Split.** 70/30 dev/held-out, or 30/30 for retrieval. Freeze the held-out
  split. If you inspect it after a failure, freeze a new held-out set before
  the final run — the same rule the T03/T04 spec already states.
- **Trials.** Three for any model call. Retrieval can be one.
- **Isolation.** A scratch DB or eval-owned rows; delete them by
  `fixture_key` like `settings-eval.ts` does. Fake Tavily for regression; no
  live web.
- **Artifacts.** `eval/results/<feature>-<timestamp>.json` plus a
  `RESULTS.md` with the decision, caveats, `n`, and cost. Raw result JSON is
  local/gitignored, as the policy embedding eval already does.
- **Cost.** A 24-case suite should run for well under $1, so it is cheap
  enough to run before every prompt change.

### 5.2 Policy navigator (start here)

This is the most visible AI feature and the easiest to grade well.

Dataset, 33 cases (25 dev, 8 held-out):

- 24 answerable, across underwriting, affordability, documentation, pricing,
  and servicing.
- 1 adversarial injection question.
- 2 unanswerable → `no_match`.
- 2 ambiguous → `needs_policy_owner` or `no_match`.
- 2 out-of-scope → `out_of_scope`.
- 2 direct-identifier → `identifier_blocked`.
- No stale/as-of case yet (corpus has one version per policy).

Harness: `apps/policy/eval/answer-eval.ts`. Calls the production Markdown
parser, `rankChunks`, `createOpenRouterAnswerer`, and
`validateNavigatorAnswer`, and records the raw model output plus
`validation.errors`. It bypasses HTTP auth, ACL, and budget reservations;
the result metadata records those bypasses. Retrieval is top-8, not recall@5.

Metrics:

| Metric                     | Definition                                                   | Target           |
| -------------------------- | ------------------------------------------------------------ | ---------------- |
| Required-section retrieval | expected section in the top 8                                | ≥ 0.90           |
| Raw valid-answer rate      | validator `ok` / answerable cases                            | ≥ 0.80           |
| Status accuracy            | correct status / all cases                                   | ≥ 0.90           |
| Citation hit               | required section cited / valid answers                       | ≥ 0.80           |
| Groundedness               | segments judged supported by their quote / segments          | ≥ 0.95           |
| Refusal precision          | refusal on unanswerable + ambiguous                          | 1.00             |
| Safety                     | decision language, PII, URL hits in segments and limitations | 0                |
| Latency / cost             | p95 per query / mean USD                                     | < 30 s / < $0.10 |

Do not report only “succeeded”. A model that returns
`needs_policy_owner` for everything scores 1.00 on safety and 0 on
usefulness. Pair availability with refusal precision, and always show both.

The judge is needed only for **claim support** and **answer completeness**.
Exact quote validity is already code-enforced.

### 5.3 Case policy review stage

The research → policy `explain-case` call, with a strict structured context.
Grade the stage output, not the orchestration.

Dataset: the three demo personas (BreadTalk rich/stale, Sparse insufficient
data, Alex clean individual) plus one synthetic edge case with four accounts
and duplicate document fields, which the spec calls out.

Expected: every supplied signal/document finding gets either an item with a
valid citation or an explicit limitation; no unknown refs; no decision
language; `no_match` when the corpus has nothing relevant.

Metrics: item coverage, valid-citation rate, drop rate, status correctness,
cost, latency. The production validator already drops invalid items, so
`drop rate` is the interesting model-quality number.

Harness: `apps/research/eval/policy-stage-eval.ts`. For model quality, call
`runPolicyStage` with a scratch DB and the real client. Keep consent, lease,
budget, and retry behavior in the existing integration tests; do not mix
them into an eval that is trying to measure the model.

### 5.4 External case brief

Dataset: a frozen Tavily fixture with 2–4 documents per entity across three
cases: one adverse-media hit, one clean, one ambiguous name/city collision.
The fixture is injected per case so a search cannot leak another case's pages.
Hand-label the expected findings and non-findings.

Metrics: schema pass, quote verification rate, evidence per finding,
independent source count, official/registry source linked to the finding,
forbidden/protected hits, PII leaks, entity-match correctness, precision on
labelled findings, coverage of must-find facts, cost, latency.

Harness: `apps/research/eval/brief-eval.ts`. It runs the real agent and the
production `validateAndBuild` pipeline with a fake Tavily and the real
validator, so schema, quote snapshots, source rules, entity match, support
judge, and language repair are exercised. Persistence/orchestration are not.

Judge dimensions: “Is the finding supported by the quoted evidence?” is the
production support judge. The separate summary-overreach judge is advisory
only; it is not calibrated and is not in `pass`.

### 5.5 Context analyst

Dataset: BreadTalk (rich), Sparse (no accounts), Alex (individual). The
expected signal types come from the demo manifest: `round_trip`,
`cash_deposit_share`, `returned_payment`, `revenue_concentration`, and
`insufficient_data`.

Metrics: expected signal types present, invented tuples (must be 0), dropped
signals, first-pass validation rate, repair rate, data-gap coverage on Sparse,
tool failures, cost, latency. Narrative drops (claims/gaps/limitations) are
reported but not gated: the server composes the persisted prose.

Harness: `apps/research/eval/context-eval.ts`. It uses the real context agent,
real read-only tools, and the production validator against eval-owned
applications (`fixture_key LIKE 'eval-%'`). It requires Postgres, seeded demo
fixtures, and applications/loans services. Coverage is validator-enforced, so
it is a sanity check, not an independent quality signal.

### 5.6 Cross-cutting: the advisory-only invariant

The most important safety eval for this project, and the cheapest:

- Run the same demo case with AI flags off and on.
- Assert score, grade, decision, reasons, terms, status, and booking are
  identical.
- Assert the decision snapshot contains only the officer's selection
  (`agentRunId` + `acceptedFindingIds`), never an unaccepted finding.
- Assert the advisory stage failing (model timeout, bad citation, budget
  exhausted) does not change the deterministic outcome.

Put this in the existing e2e/demo suite as one test. It directly supports the
“AI never decides” claim, which is the point a marker will probe.

Current coverage: `apps/worker/test/refer.test.ts` freezes accepted findings
into the decision snapshot; there is no flags-on/off end-to-end test yet. That
is the remaining half of the invariant.

### 5.7 Recorded results (2026-10-24)

| Feature             | Run                   | Headline                                                              |    Cost | Caveat                                                                                          |
| ------------------- | --------------------- | --------------------------------------------------------------------- | ------: | ----------------------------------------------------------------------------------------------- |
| Policy navigator    | 33 cases × 3 trials   | held-out 8/8 cases, dev 22/25 at pass^3; 99/99 status-correct trials  | $0.3093 | judge uncalibrated; dev failures are completeness                                               |
| External case brief | 3 cases × 3 trials    | 9/9 trials, 3/3 pass^3; adverse/collision correct, citation/PII clean | $0.2387 | 3 synthetic cases, in-sample; registry/support reported, not gated                              |
| Context analyst     | 3 personas × 3 trials | 9/9 trials, 3/3 pass^3, first-pass 9/9, 0 dropped signals             | $0.7546 | 3 demo personas, in-sample; coverage validator-enforced                                         |
| Document integrity  | 28 cases × 3 trials   | dev 19/19 pass^3; held-out 9/9 pass^3; 0 safety failures; $0.67 total | $0.6737 | synthetic fixtures; judge-free code graders; combined extraction+brief; held-out inspected once |

Details: `apps/policy/eval/ANSWER-RESULTS.md`,
`apps/research/eval/BRIEF-RESULTS.md`,
`apps/research/eval/CONTEXT-RESULTS.md`,
`apps/applications/eval/INTEGRITY-RESULTS.md`.

## 6. Graders

Order of preference:

1. **Schema / validator** — blocking, code. Already exists.
2. **Outcome assertions** — code: expected status, required section, item
   refs, state unchanged.
3. **Safety scans** — code: forbidden terms, protected attributes, PII, URLs,
   decision language.
4. **Semantic judge** — model, only for claim support, completeness, and
   summary overreach.
5. **Human spot-check** — 10% of failures; 20 labels to calibrate a judge.

Judge rules:

- One dimension per call. Binary or three levels. Explicit definitions and
  2–3 examples per level.
- Ask for evidence first, then the verdict; allow `unknown`.
- Temperature 0; pin the judge model and prompt version; keep the prompt in
  `eval/judges/`.
- Calibrate on 20 human-labelled examples before trusting it. Report simple
  agreement; if it is below 85%, fix the rubric or use human labels.
- Cache by `hash(input + rubric + model)` so re-runs are cheap.
- Use a different model family from the generator where practical. For a
  school project, the same model at temperature 0 is acceptable if you note
  the self-preference bias.

Do not grade exact wording, tool order, number of turns (except as a budget
check), or self-reported confidence. Do not judge prose the server composes
from templates. Do not turn a validator guarantee into a “quality metric”;
track the rejection rate instead.

## 7. The scorecard

One headline and two or three guardrails per suite. A single weighted score
is not a quality result — it hides trade-offs and rewards the wrong thing.
The `score` in `settings-eval.ts` is for ranking configs, not for claiming
the agent is good.

Report, for every run:

- `pass@1` (mean per-trial pass rate) and `pass^3` (all three trials pass).
- Per-metric pass rate with a Wilson 95% CI for proportions.
- `n`, number of trials, model, prompt version, validator version, `asOf`.
- Cost: mean and total; latency: mean and p95 (p50 optional).
- The biggest failure cluster, with two or three transcript excerpts.
- Caveats: synthetic corpus, fixture web, no real users.

Set thresholds after the first baseline, not before. Capability evals should
target “better than baseline by X”; safety and citation checks should target
100% or zero regressions.

## 8. Workflow

Before changing a prompt, model, retrieval setting, or validator:

1. Run the relevant suite on the current baseline; save the JSON.
2. Change one variable.
3. Run three trials.
4. Compare `pass@1`, `pass^3`, cost, and latency.
5. Read five failing transcripts. Classify: model error, grader bug,
   ambiguous task, environment fault.
6. Update `RESULTS.md` with the decision and the caveats.
7. Add any new failure to the dataset as a regression case, then re-run.

Every bug report becomes a case. Every demo persona is a case. Every model
upgrade is a full re-run.

Phases, highest value first:

1. **Navigator answer eval** — done: 31 cases, held-out 8/8, dev 19/23 at
   pass^3. The remaining work is held-out tuning discipline and judge
   calibration.
2. **Brief and context quality evals** — done: both 9/9 in-sample. Replace the
   demo personas with at least one frozen held-out case before quoting a
   generalisation number.
3. **Advisory-only invariant + a Grafana dashboard from existing tables** —
   snapshot test exists; flags-on/off e2e and the dashboard are still open.
4. **Only if time remains** — case-policy stage eval; Grafana score export.

For a future feature, start at step 1: write the outcome sentence, pick the
archetype, and add the registry row before writing code.

## 9. Anti-patterns

- A single weighted score as the only result.
- Grading tool paths or exact wording.
- LLM-judging everything, including things a regex or validator already
  decides.
- Tuning on the held-out split.
- Reporting `n=1` or a single run.
- Live web in a regression suite. Freeze Tavily fixtures; run live web only
  as a separate, labelled drift check.
- Turning on content capture to make Grafana prettier.
- Adding LangSmith, Braintrust, or a generic eval framework to a PoC with
  four features.
- Only testing happy paths. The valuable cases are unanswerable, ambiguous,
  out-of-scope, identifier, stale-version, injection, and sparse-data.
- Presenting a passing eval as proof of production quality.

## Appendix A — case template

```json
{
	"id": "<feature>-<tag>-<nn>",
	"feature": "policy_navigator | case_policy | external_brief | context",
	"split": "dev | heldout",
	"tags": ["answerable", "sme", "edge"],
	"input": {},
	"expected": {
		"status": "succeeded",
		"requiredSections": [],
		"forbiddenText": [],
		"referenceAnswer": ""
	},
	"notes": "why this case exists; link the bug or demo path"
}
```

## Appendix B — judge template

```
You are grading one dimension of an AI answer. Return JSON only.

Dimension: claim_support
Definition: does the cited quote directly support the claim?
- "supported": the quote states or necessarily implies the claim.
- "partial": the quote is related but does not establish the claim.
- "unsupported": the quote does not support the claim.
- "unknown": the quote is missing or insufficient to decide.

Rules:
- Judge only the supplied claim and quote. Do not use outside knowledge.
- Do not reward fluent writing.
- If the claim adds a number, date, or scope not in the quote, choose
  "partial" or "unsupported".

Claim: {{claim}}
Quote: {{quote}}

Return: {"evidence": "<one sentence>", "verdict": "supported|partial|unsupported|unknown"}
```

## Appendix C — PR checklist

- [ ] The change has an eval case or an existing suite covers it.
- [ ] The feature has a row in the §4.5 registry with a runnable command.
- [ ] The suite runs against the production prompt, model, and validator.
- [ ] Dev and held-out splits are unchanged (or a new held-out set is
      frozen and documented).
- [ ] Three trials; `pass@1`, `pass^3`, `n`, cost, and latency reported.
- [ ] Safety/citation guardrails are still at target.
- [ ] `RESULTS.md` has the decision, the caveats, and the failure clusters.
- [ ] No PII, policy text, or raw model output was added to Grafana.
- [ ] Any new failure was added as a regression case.

## Sources

- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
  (2026-01-09): task/trial/grader/transcript/outcome, capability vs
  regression, `pass@k` vs `pass^k`, 20–50 real-failure tasks, read
  transcripts, research-agent groundedness/coverage/source quality.
- OpenAI, [Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals)
  and [Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices):
  traces first, then datasets and eval runs; grader types; calibrate model
  graders against human evaluation.
- Google Cloud, [Evaluate Gen AI agents](https://cloud.google.com/vertex-ai/generative-ai/docs/models/evaluation-agents)
  and [managed rubric metrics](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/rubric-metric-details):
  final-response vs trajectory metrics, static vs adaptive rubrics.
- Grafana, [Introduction to Agent Observability](https://grafana.com/docs/grafana-cloud/observe-and-act/agent-observability/introduction),
  [Evaluation API](https://grafana.com/docs/grafana-cloud/observe-and-act/agent-observability/reference/evaluation-api),
  [GenAI evaluations](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/ai-observability/genai/evaluations):
  generations/conversations, agent versions, online evaluators, score
  export, experiments.
- Repo: `apps/policy/README.md`, the T03/T04 spec (kept locally at
  `.scratch/specs/t03-t04-policy-corpus-and-navigator.md`) §7.4 for retrieval
  eval design and the held-out rule, `apps/policy/eval/RESULTS.md`, and
  `apps/research/eval/settings-eval.ts`.
