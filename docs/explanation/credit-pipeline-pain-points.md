# Credit pipeline pain points and feature options

Status: research note. Audience: product/engineering for this PoC. Purpose:
identify the bottlenecks that matter to banks and credit officers, then choose
features that fit the existing pipeline instead of rebuilding what is already
here.

Evidence quality: regulator/DFI sources are treated as primary. Vendor
whitepapers and vendor case studies are labelled **vendor estimate**; they are
directionally useful but not independent research. This is desk research, not
bank interviews: use it to choose a demo narrative and a feature bet, not as a
market-sizing exercise.

## 1. Executive summary

The recurring bottlenecks are not “the score is not smart enough”. They are:

1. **Getting complete, current, trustworthy documents.** Collection and
   verification are manual, repetitive, and relationship-damaging.
2. **Turning documents into analysis.** Financial spreading and memo writing
   consume hours per case and vary by analyst.
3. **Fragmented systems and re-keying.** Data lives across core banking, LOS,
   bureau, document, and policy systems.
4. **Applying policy and exceptions consistently.** Officers need the rule,
   the exception path, the approver, and the audit trail.
5. **Explaining and monitoring.** Adverse-action reasons must be specific;
   portfolio deterioration is often caught at the annual review, not before.

For this PoC, the highest-value additions are **credit-memo drafting**,
**adverse-action reason explanations**, and **case triage**. They reuse the
existing score, reasons, documents, research brief, context analyst, policy
navigator, and review queue. Financial spreading and covenant monitoring are
higher-value but larger; document-integrity signals and policy-change impact
are good later additions.

## 2. What banks face in the pipeline

| Bottleneck                            | What it looks like                                                                                            | Evidence                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document collection and verification  | Repeated requests, missing items, stale statements, re-keying the same data, slow onboarding                  | Finastra’s commercial-lending infographic: 33% say gathering documents is the biggest obstacle; 27 days, $6,000, and 7 emails to onboard a client; two-thirds re-enter data; 65% struggle to track missing items (**vendor estimate**).                                                                                                                              |
| Manual financial spreading            | Analysts copy figures from long PDFs into spreadsheets, compute ratios, and reconcile add-backs               | FIS: spreading a document often exceeding 50 pages is manual, resource-intensive, and error-prone (**vendor estimate**). Industry guides put spreading at 2–6 hours per deal (**vendor estimate**).                                                                                                                                                                  |
| Credit memo drafting                  | Synthesizing spread, ratios, collateral, risk, and policy into a committee-ready narrative                    | Moody’s: a single credit memo can take hours to nearly three working days; teams chase documents across 12+ platforms (**vendor estimate**). Other vendor guides cite 2–4 hours for a straightforward memo (**vendor estimate**).                                                                                                                                    |
| Fragmented data and systems           | Same borrower data in LOS, core, bureau, documents, and policy tools; no single case view                     | KPMG 2025 Banking Survey: data privacy/risk 93%, data quality 89%, legacy/integration 81% as top AI/data challenges. IIF 2025: 79% of firms cite data quality as a top AI challenge; 100% of G-SIB respondents do.                                                                                                                                                   |
| Policy and regulatory complexity      | Rules change; officers must find the current version, apply exceptions, and evidence the decision             | Wolters Kluwer survey: 64% see regulatory change as a high concern; 60% cite compliance requirements; 50% cite updating policies/procedures.                                                                                                                                                                                                                         |
| Exception management                  | Exceptions are common, but support quality and routing vary                                                   | OCC 2016 survey: 98% of commercial banks track underwriting exceptions; approved commercial exceptions were 22%, and examiners said support had weakened.                                                                                                                                                                                                            |
| Explainability and adverse action     | Complex models can make it hard to state specific reasons; regulators still require them                      | CFPB Circular 2022-03: ECOA/Reg B require specific, accurate principal reasons even for complex algorithms; black-box reasons are not enough. Reg B commentary: more than four reasons is generally not required. BIS 2025: explainability and data quality are model-risk issues.                                                                                   |
| Lagging portfolio monitoring          | Annual reviews and periodic covenant checks catch deterioration late; manual covenant tracking is error-prone | Moody’s: annual reviews/periodic covenant checks are no longer adequate for a fast cycle; early-warning signals sit across borrower, market, and payment data (**vendor estimate**).                                                                                                                                                                                 |
| SME / thin-file gap                   | Many viable SMEs lack the documents or data that traditional underwriting expects                             | IFC: formal MSME finance gap was $5.2T in the 2017 study and $5.7T in the 2024 factsheet; 40% of MSMEs need financing. IFC’s SME banking survey: credit risk was one of the two biggest challenges, cited by half of surveyed SME banks. FDIC 2024: three in four banks approve a typical small business loan within 10 business days; the long tail is much slower. |
| Document fraud and synthetic identity | Forged statements, altered figures, synthetic IDs, deepfake identity media                                    | FinCEN 2024 alert: GenAI is used to fabricate documents and deepfake video for synthetic identities; loan fraud is listed. Entrust 2025: deepfakes are 40% of biometric fraud; lending is a top-3 targeted sector (**vendor/industry estimate**).                                                                                                                    |
| Alert fatigue in adjacent controls    | AML/sanctions and EWS queues generate mostly false positives                                                  | Industry estimates put AML false positives at 90–95%; one vendor case study reports a 31% reduction and 1,817 hours saved per quarter (**vendor estimate**). Treat as directional.                                                                                                                                                                                   |

Two cross-cutting constraints sit over the table. First, **model risk and
governance**: BIS and the ECB both flag explainability, data quality, and
third-party oversight as reasons AI credit use cases stall. Second,
**adoption capability**: McKinsey’s survey of 44 financial institutions found
67% cite a shortage of gen-AI capabilities and 50% struggle to define use cases
and the value at stake, even though 52% make gen-AI adoption a priority. The
lesson for this PoC is to ship narrow, auditable features with a clear
before/after metric, not a generic “AI credit platform”.

## 3. What credit officers face

| Pain point                                    | Why it hurts                                                                                                                     | Evidence                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Chasing documents and re-keying               | Officers become account managers for missing PDFs instead of credit analysts; repeated requests damage the customer relationship | Finastra: repeated requests and manual re-entry; 65% struggle to track missing items (**vendor estimate**).                 |
| Manual spreading and ratio work               | Hours per statement, inconsistent add-backs, transcription errors, no source trace                                               | FIS and vendor guides; 2–6 hours per deal (**vendor estimate**).                                                            |
| Writing the memo                              | 2–4 hours for a simple memo and up to days for complex/multi-entity credits; quality varies by author                            | Moody’s, Uptiq, GLIB (**vendor estimates**).                                                                                |
| Finding the current policy and exception path | Officers must know the version, the exception rule, the approver, and the mitigants; policy change is constant                   | Wolters Kluwer: regulatory change and policy updates are top compliance pain points. OCC: exception support quality varies. |
| Switching between systems                     | A single case can require a dozen platforms and screens                                                                          | Moody’s: teams chasing documents across 12+ platforms (**vendor estimate**).                                                |
| Explaining declines                           | Specific reasons must be defensible and consistent; generic score bands are not enough                                           | CFPB Circular 2022-03 and Reg B.                                                                                            |
| Triage and queue pressure                     | Cases arrive in bulk; high-risk, high-value, or stale-document cases are not always first                                        | FDIC: approval times vary widely by loan complexity and bank size.                                                          |
| Monitoring after booking                      | Covenant checks and annual reviews are periodic; early warning is often manual                                                   | Moody’s and industry EWS guides (**vendor estimates**).                                                                     |
| Alert fatigue                                 | Low-value alerts consume attention and hide the real signal                                                                      | AML/EWS industry estimates: 90–95% false positives; hours per alert.                                                        |

## 4. What this repo already covers

Do not rebuild these:

| Existing capability                                                       | Where                                                                                             | Remaining gap                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Document requirements, freshness, reuse, applicant checklist              | `apps/applications/src/customer/requirements.ts`, `apps/web/src/components/RequirementsPanel.tsx` | More document kinds, applicant communication, fraud/integrity signals |
| Document extraction, cross-check, mismatch findings, draft chase requests | `apps/applications/src/documents/`, `apps/web/src/components/`                                    | Draft-only; no auto-send (intentional). Deeper integrity checks       |
| Policy navigator with exact citations                                     | `apps/policy`                                                                                     | Case-specific exception path and approver routing                     |
| Automatic case policy review                                              | research → policy stage                                                                           | Coverage/drop-rate eval; exception mapping                            |
| External adverse-media brief                                              | `apps/research`                                                                                   | More source categories, stale-source handling                         |
| Internal context analyst                                                  | `apps/research`                                                                                   | Covenant/EWS integration                                              |
| Advisory-only decision guardrails + evals                                 | worker/review, `docs/explanation/eval-design.md`                                                  | Flags-on/off invariant e2e                                            |

The document-collection pain is therefore **partly solved**. The remaining
high-value work is not another checklist; it is document intelligence, memo
synthesis, exception routing, and monitoring.

## 5. Feature options

Priority is for this PoC, not a production bank roadmap. “Effort” is relative
to the current repo: S = days, M = 1–2 weeks, L = multi-week.

### P0 — Credit memo draft copilot

**Pain:** memo writing takes hours to days and varies by analyst; the
information is already scattered across the case.

**What it does:** builds a structured draft from the existing case facts,
score/reasons, document findings, context signals, external brief, and policy
review. Sections: request, borrower/entity, financial summary, strengths,
risks, policy compliance, open items, questions for the officer. Every factual
claim links to its source; missing sections say “not available”. The officer
edits and approves; the approved version is immutable and audited.

**Why it fits:** no new data source. It consumes outputs the app already
produces. It is the most visible “agentic” feature after the navigator.

**Guardrails:** no recommendation/decision; citation validator; “missing
evidence” section; officer approval; version diff; no PII in logs/Grafana.

**Minimal data:** `memo_drafts` (application_id, run_id, version, sections
jsonb, citations jsonb, status draft/approved, edited_by, approved_by).

**Demo:** Tomás referral → draft memo with stale-document open items, policy
citations, context signals, and the adverse-media brief; officer edits and
approves.

**Measure:** time to first draft, officer edit rate, citation coverage,
unsupported claims (must be 0), memo approval time.

### P0 — Adverse-action reason explainer

**Pain:** declines need specific, accurate principal reasons; generic score
bands and black-box outputs are not defensible.

**What it does:** maps the deterministic score/reason codes to 3–4 principal
reasons in plain language, with an internal policy citation and an
applicant-facing letter draft. The mapping is deterministic first; an LLM may
rewrite within a constrained template, but it cannot invent a new reason.
Officer approves; the letter is versioned and audited.

**Why it fits:** the score engine already emits reason codes and the policy
corpus already has citations. Low AI risk, high regulatory relevance.

**Guardrails:** no reason not present in the deterministic output; max four
principal reasons; no protected attributes; human approval; template
validation; audit.

**Minimal data:** no new table required for v1; store the generated letter and
approval in the decision audit or a `decision_letters` table.

**Demo:** Sam decline → “bureau score below threshold”, “existing debt
obligations”, “income/affordability shortfall” with specific values and policy
references.

**Measure:** specificity, zero unsupported reasons, officer edit rate, letter
turnaround.

### P1 — Case triage and queue prioritization

**Pain:** officers work a queue; high-risk, high-value, stale, or
policy-exception cases are not always first.

**What it does:** ranks the review queue using deterministic factors: score
band, amount, product, policy exceptions, missing/stale documents, external
adverse findings, context signals, and age against SLA. Shows why each case is
ranked; officer can override.

**Why it fits:** review queue, score/reasons, document requirements, and
research aggregate already exist. Small, deterministic, easy to explain.

**Guardrails:** no auto-decision; factor-level explanation; override audit;
avoid protected attributes.

**Demo:** Tomás (SME, above auto limit, stale documents, adverse media) rises
above a simple individual case; the queue shows the reasons.

**Measure:** time-to-decision, SLA breaches, officer acceptance of ordering.

### P1 — Exception path assistant

**Pain:** when a case fails a rule, the officer needs the exception route, the
approver, the required mitigants, and a defensible memo.

**What it does:** maps failed rules to the exception policy: prohibited vs
allowed, required approver level, required mitigants (pricing uplift, limit
reduction, collateral, tenor), and a draft exception memo with citations. It
never recommends approval.

**Why it fits:** policy engine, policy corpus, navigator, and review routing
already exist.

**Guardrails:** deterministic rule mapping first; citations; no approval
language; committee routing; audit.

**Demo:** Tomás amount above auto limit → exception path, approver, mitigants,
and a draft exception memo.

**Measure:** routing accuracy, memo completeness, exception support quality.

### P1 — Covenant and early-warning monitor

**Pain:** monitoring is periodic and manual; deterioration is caught late.

**What it does:** covenant register per loan (DSCR, TDSR, current ratio,
revenue decline, overdue count), recompute from financials/transactions,
track headroom trends, and raise EWS alerts with evidence. Officer
acknowledges; portfolio view shows concentrations.

**Why it fits:** loans, portfolio, Kafka, and the existing monitoring demo are
already present.

**Guardrails:** deterministic calculations; human review; alert dedupe and
severity; no automatic limit changes.

**Demo:** Tomás loan → DSCR drifts 1.45x → 1.32x → 1.28x against a 1.25x
covenant; an alert fires before breach; officer acknowledges.

**Measure:** early-detection lead time, false-positive rate, acknowledgement
time.

### P2 — Financial spreading workbench

**Pain:** spreading is hours of manual transcription with inconsistent
add-backs and no source trace.

**What it does:** parses statements into canonical line items with page/offset
citations, computes ratios, shows source-to-figure trace, and lets the analyst
correct a line with an audit trail. Start with a narrow synthetic statement
format; use LLM extraction only with confidence and human confirmation.

**Why it fits:** document text extraction and OCR already exist.

**Guardrails:** every figure source-linked; no silent overwrite; analyst
approval; reconciliation checks; versioned spreads.

**Demo:** BreadTalk financial statements → spread → DSCR/current ratio; one
analyst correction with audit.

**Measure:** spreading time, correction rate, ratio accuracy.

### P2 — Document integrity signals

**Pain:** forged statements, altered figures, synthetic identities, and
duplicate applications.

**What it does:** deterministic integrity panel: PDF metadata/producer, edit
history, image recompression, duplicate file hash across applications,
inconsistent dates/names/amounts, OCR confidence, page count. Routes to fraud
review; never auto-declines.

**Why it fits:** document pipeline and cross-check already exist.

**Guardrails:** signals only; human fraud review; no deepfake claims; privacy
and retention rules.

**Demo:** upload a statement with a metadata mismatch and a duplicate hash from
another application; the panel flags both for review.

**Measure:** signal precision, fraud-review time, false-positive rate.

### P2 — Policy change impact

**Pain:** policy changes are frequent; banks need to know which rules, cases,
and exceptions are affected.

**What it does:** diffs policy versions, maps changed sections to engine rules
and open cases/loans, and lists affected exceptions or decisions with owner
tasks.

**Why it fits:** versioned policies, approvals, and the policy engine already
exist.

**Guardrails:** read-only impact report; owner approval; no automatic
re-decision.

**Demo:** DSCR threshold changes v1 → v2; show affected SME applications and
loans.

**Measure:** impact-analysis time, missed changes.

### Small addition — data-quality preflight

Before scoring, run deterministic checks for missing/inconsistent fields,
stale bureau/bank data, and impossible values. Show a “data confidence” panel
and block scoring only for critical gaps. This addresses the data-quality
challenge without a new platform.

## 6. Priority and sequencing

| Order | Feature                         | Effort | Risk   | Demo value | Why now                                                    |
| ----: | ------------------------------- | ------ | ------ | ---------- | ---------------------------------------------------------- |
|     1 | Adverse-action reason explainer | S/M    | Low    | High       | Deterministic, regulatory, uses existing reasons/policy    |
|     2 | Case triage                     | S      | Low    | Medium     | Small, visible operational win                             |
|     3 | Credit memo draft copilot       | M      | Medium | High       | Reuses every existing AI output; biggest officer time sink |
|     4 | Exception path assistant        | M      | Medium | High       | Extends policy navigator into the actual decision workflow |
|     5 | Covenant/EWS monitor            | M/L    | Medium | Medium     | Extends loans/portfolio into post-booking monitoring       |
|     6 | Financial spreading workbench   | L      | High   | High       | Biggest build; only if there is time                       |
|     7 | Document integrity signals      | M      | Medium | Medium     | Strong differentiator; needs careful claims                |
|     8 | Policy change impact            | M      | Low    | Low        | Useful for banks, less visible in a demo                   |

If you build only one: **credit memo draft**. If two: **memo + adverse-action
reasons**. If three: **+ case triage**.

### Demo story for the top three

1. **Sam declines** → adverse-action reason explainer shows three specific,
   policy-cited reasons and an applicant letter draft; officer approves.
2. **Tomás refers** → triage puts the SME case first because of amount,
   stale documents, and adverse media; memo draft assembles the case; exception
   path assistant shows the approver and mitigants.
3. **Tomás books** → covenant monitor tracks DSCR headroom and raises an EWS
   alert before a breach.

This is one coherent story: explain the decision, prioritize the work, draft
the analysis, route the exception, then monitor the loan.

## 7. What not to build

- **Autonomous approve/decline.** The current advisory-only design is the
  right story; do not cross it.
- **A generic “chat with the case”** without citations and scope. The existing
  navigator and context analyst are stronger because they are constrained.
- **Deepfake detection from scratch.** Use deterministic document-integrity
  signals and route to human review; do not claim biometric detection.
- **Real-time core-banking/LOS integration.** Out of scope for a PoC; use the
  existing service boundaries and fixtures.
- **Model training/fine-tuning.** Deterministic rules + constrained LLM calls
  are cheaper and easier to defend.
- **Auto-sending chase messages.** Keep drafts human-approved; the current
  draft-only design is deliberate.
- **A new eval platform.** Use the existing eval guideline and harnesses.

## 8. Sources

Primary / regulator / DFI:

- FDIC, [Small Business Lending Survey 2024, Section 3](https://www.fdic.gov/publications/small-business-lending-survey-2024-section-3-loan-underwriting-and-approval).
- IFC, [MSME Finance](https://www.ifc.org/en/what-we-do/sector-expertise/financial-institutions/msme-finance) and [MSME Finance Gap](https://www.ifc.org/content/dam/ifc/doclink/2018/msme-finance-gap-report.pdf).
- IFC, [Banking on SMEs](https://www.ifc.org/content/dam/ifc/doc/mgrt/ifc-on-banking-smes-publication-june-2019.pdf).
- CFPB, [Circular 2022-03: adverse action notices and complex algorithms](https://www.consumerfinance.gov/compliance/circulars/circular-2022-03-adverse-action-notification-requirements-in-connection-with-credit-decisions-based-on-complex-algorithms).
- eCFR, [12 CFR 1002.9](https://www.ecfr.gov/current/title-12/chapter-X/part-1002/subpart-A/section-1002.9).
- BIS, [Managing explanations: AI explainability](https://www.bis.org/publications/fsi-paper-24-managing-explanations-how-regulators-can-address-ai-explainability.pdf).
- Federal Reserve, [AI explainability in banking](https://www.federalreserve.gov/SECRS/2021/July/20210708/OP-1743/OP-1743_063021_138218_378216776070_1.pdf).
- KPMG, [2025 Banking Survey: Technology](https://kpmg.com/kpmg-us/content/dam/kpmg/pdf/2025/kpmg-banking-survey-2025.pdf).
- McKinsey, [Banking on gen AI in the credit business](https://www.mckinsey.com/capabilities/risk-and-resilience/our-insights/banking-on-gen-ai-in-the-credit-business-the-route-to-value-creation).
- ECB Banking Supervision, [AI in credit scoring and fraud detection](https://www.bankingsupervision.europa.eu/press/supervisory-newsletters/newsletter/2025/html/ssm.nl251120_1.cs.html).
- FinCEN, [Deepfake and synthetic identity alert](https://www.fincen.gov/system/files/shared/FinCEN-Alert-DeepFakes-Alert508FINAL.pdf).
- Wolters Kluwer, [Risk and compliance pain points survey](https://www.wolterskluwer.com/en/news/survey-reveals-persisting-pain-points-in-banks-risk-management-and-regulatory-compliance-efforts).
- OCC, [2016 Survey of Credit Underwriting Practices](https://www.occ.gov/publications-and-resources/publications/survey-of-credit-underwriting-practices/files/pub-survey-cred-under-2016.pdf).

Vendor / industry estimates (directional only):

- Finastra, [Commercial lending document collection infographic](https://www.finastra.com/sites/default/files/file/2022-04/resource-aio-infographic-competing-online-lenders-commercial-lending-market-share.pdf).
- FIS, [Automated financial spreading](<https://www.fisglobal.com/-/media/fisglobal/files/pdf/white-paper/3689984_creative_white-paper_7091_fis-automated-financial-spreading-(1).pdf>).
- Moody’s, [Turning information into better lending decisions](https://www.moodys.com/web/en/us/site-assets/moodys-credit-memo-white-paper-8Sep2026.pdf).
- Uptiq, [Commercial loan credit memo](https://www.uptiq.ai/glossary/what-is-commercial-loan-credit-memo).
- GLIB, [Financial spreading guide](https://glib.ai/blog/what-is-financial-spreading).
- Entrust, [2025 Identity Fraud Report](https://www.entrust.com/sites/default/files/documentation/reports/2025-identity-fraud-report.pdf).
- NICE Actimize, [AML false-positive case study](https://resources.niceactimize.com/wp-content/uploads/2025/09/aml_case_study_bank_reduces_false_positives_31_percent.pdf).
- Flagright, [False positives in transaction monitoring](https://www.flagright.com/post/understanding-false-positives-in-transaction-monitoring).
- CreditBenchmark, [Credit risk monitoring](https://www.creditbenchmark.com/knowledge-base/credit-risk-monitoring).
- Aloan, [Covenant monitoring](https://aloan.ai/guides/covenant-monitoring-best-practices).
