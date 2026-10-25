# Document integrity (E2 / EN-04/EN-05)

Deterministic document fingerprinting plus a bounded AI extraction/consistency
pass, with reviewer-owned fraud review for flagged cases. Audience: developers
extending the integrity pipeline or enabling the triage agent. Outcome: you
know what is deterministic, what the model may do, and where a human decides.

Related: [API](../reference/api.md#document-integrity-e2--en-04en-05) (route
contract and error codes),
[configuration](../reference/configuration.md) (`DOCUMENT_INTEGRITY_*`,
`FRAUD_REVIEW_ENABLED`),
[data and events](../reference/data-and-events.md) (artifact storage and audit).

Non-negotiables:

- Hashing, fingerprinting, duplicate lookup, provenance, and the deterministic
  cross-check (`apps/applications/src/documents/crosscheck.ts`) are
  authoritative. The model may not invent a tamper, provenance, or duplication
  signal.
- The model never decides, approves, declines, scores, or changes a case. Flag
  resolution is reviewer-only and never touches application status, score,
  terms, or decision.
- Every AI claim cites an exact page/offset quote or an existing deterministic
  signal. Unsupported claims are dropped or fail closed.
- One validation/repair attempt on invalid output, then fail closed. Agent
  failure leaves the deterministic flag `open` and never blocks the case.
- Traces, logs, and audits are metadata only: tool names, source refs, counts,
  usage, versions. Never page text, PII, or chain-of-thought.

## Boundary: deterministic vs AI

| Layer                              | Owns                                                                           | Never                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Fingerprint (`fingerprint.ts`)     | sha/size/MIME/pages, known-software tokens, edit codes, `unknown` fallback     | Text, names, inference                                      |
| Signals (`signals.ts`)             | Severity + `shouldFlag` threshold                                              | Proof (every signal is "signal, not proof")                 |
| Validators (`validators.ts`)       | Exact quote offsets, format/date/amount rules, deterministic pair confirmation | Model prose (explanations are server-composed from quotes)  |
| Agent (`agent.ts`, `agent-sdk.ts`) | Candidate extraction + consistency proposals + triage brief draft              | New ids, values, parties, amounts; confirmed-fraud language |
| Officer/reviewer                   | Confirm candidates, escalate mismatches, resolve reviews                       | — (only human resolves)                                     |

## EN-04 fingerprint and provenance

`buildFingerprint` (`integrity/fingerprint.ts`, version
`document-fingerprint-v1`) runs on upload into `document_fingerprints`. Fields:

`sha256`, `sizeBytes`, `mimeType`, `pageCount`, `ocrConfidence`,
`producer`, `creator`, `metadataCreatedAt`, `metadataModifiedAt`,
`metadataSource` (`pdf` | `image` | `unknown`),
`editSignal` (`detected` | `not_detected` | `unknown`),
`editCodes[]`, `fingerprintVersion`.

Rules:

- Only PDF `Producer`/`Creator` are read, and only a known product token is
  kept (`Adobe Acrobat`, `Microsoft Word`, `pdf-lib`, `Adobe Photoshop`, …).
  Anything else — a filename, person, path, or registration number — collapses
  to `unknown`. Author, Title, Subject, Keywords, and page text are never
  copied.
- `unknown` is never inferred. When no usable metadata exists,
  `metadataSource` is `unknown`, `editSignal` is `unknown`, and `editCodes`
  carries `metadata_unknown`.
- `editSignal: detected` comes only from observed markers:
  `incremental_update`, `editor_producer`, `recompression_editor` (image
  editors on scan-expected kinds only: `bank_statement`,
  `business_registration`, `id`), `metadata_date_inversion`. An Office-produced
  PDF is common and becomes a flag only when severity crosses the configured
  bar.
- No raw document text in the fingerprint store. Missing rows for legacy or
  reused files are backfilled as all-`unknown` by `ensureFingerprints`.

## Signal taxonomy and severity

`buildIntegritySignals` emits `{ code, severity, documentFileId | null,
summary, sourceRef, count? }`. Summaries are fixed non-PII strings. Severities:

| Code                                       | Severity                                              | Scope    |
| ------------------------------------------ | ----------------------------------------------------- | -------- |
| `duplicate_hash_cross_application`         | high                                                  | case     |
| `duplicate_hash_same_applicant_other_case` | medium                                                | case     |
| `duplicate_hash_same_application`          | medium                                                | case     |
| `crosscheck_mismatch`                      | high when cross-check confidence is high, else medium | document |
| `crosscheck_confusable`                    | medium                                                | document |
| `text_layer_risk`                          | medium                                                | document |
| `ocr_low_confidence`                       | low (also below the 0.7 confidence bound)             | document |
| `ocr_unsupported`                          | medium                                                | document |
| `incremental_update`                       | medium                                                | document |
| `editor_producer`                          | medium                                                | document |
| `recompression_editor`                     | medium                                                | document |
| `metadata_date_inversion`                  | medium                                                | document |
| `metadata_unknown`                         | low, never flags                                      | document |
| `consistency_candidate`                    | medium, never flags                                   | case     |

Flagging: `shouldFlag(signals, DOCUMENT_INTEGRITY_FLAG_SEVERITY)` takes the
max severity over flaggable signals (`metadata_unknown` and
`consistency_candidate` excluded) and flags when it meets the threshold
(default `high`, so only high signals flag out of the box).

## Flag and fraud-review lifecycle

One `fraud_reviews` row is both the case-level flag and the review item; the
partial unique index keeps a single active (`open`/`needs_info`) item per
case. Statuses: `open` → `cleared` | `confirmed` | `needs_info` (which can
resolve again). Creation takes the per-application advisory lock; a repeat
evaluation merges signal codes/document refs and keeps the higher severity.

- `evaluateIntegrity` runs best-effort after an officer/service document
  mutation (applicant uploads never create items) and via
  `POST .../integrity/evaluate`. Both feature flags
  (`DOCUMENT_INTEGRITY_ENABLED`, `FRAUD_REVIEW_ENABLED`) are required.
- Manual flags (`POST .../integrity/flags`, reason codes
  `document_integrity` | `duplicate_document` | `metadata_inconsistency` |
  `other`) and consistency escalations (only a `confirmed` + `mismatch`
  finding, else 409 `NOT_CONFIRMED_MISMATCH`) create a review and queue triage.
- Resolution is reviewer-only (`fraud_reviewer_grants`, granted/revoked via
  service-only internal routes), optimistic-concurrency guarded
  (`expectedVersion`, 409 `VERSION_CONFLICT`), note required (10–2000 chars).
  It never mutates the application. `POST .../resolve` returns
  `decisionPath: /officer/review/<applicationId>` for navigation only.
- Queue: reviewers see all items (`?status=active|all`); an assigned officer
  sees granted cases only. Item DTO: `id`, `applicationId`,
  `applicationReference`, `status`, `severity`, `reasonCode`,
  `briefAvailable`, `briefStale`, `createdAt`, `updatedAt`, `version`.
- Item read: reviewers get the full DTO (note, assignee, signal codes,
  document refs, brief content, run/model versions, resolution). An assigned
  officer gets a minimal DTO (summary + `briefAvailable`/`briefStale`) and
  never the brief. Everyone else gets a non-leaking 404.
- `GET .../resolution-draft` returns a server-composed draft note (signals +
  brief summary, first 5 citations) that the reviewer edits; there is no
  auto-resolution.

## AI extraction and consistency pass

`POST .../integrity/analyses` starts an async `document_analysis` run
(`202` new, `200` replay on identical `inputHash`; `429 RETRY_LIMIT` past
`DOCUMENT_INTEGRITY_MAX_RUNS_PER_HASH`, default 3 per hash per 24h; `503
INTEGRITY_AGENT_UNAVAILABLE` when the agent is off or keyless). The worker
leases one row (`FOR UPDATE SKIP LOCKED`, `max_attempts` 2) and finalizes
under the lease token.

Allowlisted tools (analysis): `list_documents`, `search_pages`, `get_page`,
`list_signals`. Triage adds `list_customer_evidence`, `get_customer_page`,
`get_duplicate_context`. Pure dispatcher (`tools.ts`): unknown or
non-allowlisted tools return an error payload, never throw; excerpts capped
(300 chars), pages 8,000 chars, 20 refs per call. Analysis never registers
customer tools. Document text is untrusted data, never instructions
(temperature 0, no SDK tracing).

Bounds: `DOCUMENT_INTEGRITY_MAX_STEPS` (24), `DOCUMENT_INTEGRITY_MAX_TOOL_CALLS`
(32), `DOCUMENT_INTEGRITY_TIMEOUT_MS` (90s), `DOCUMENT_INTEGRITY_MAX_COST_USD`
(0.25), `DOCUMENT_INTEGRITY_MAX_OUTPUT_TOKENS` (4000). At least one tool call
is required (`NO_TOOL_USE` otherwise). One repair attempt with codes/paths
only; persistent failure throws `INVALID_OUTPUT` and persists nothing.

Validation (`validators.ts`):

- Candidates: quote must be an exact code-point excerpt of the cited page
  (`quote_not_found` → rejected); value must appear in its quote; per-field
  rules (document-type label presence, plausible dates, registration/account
  formats, amount parse). Fields with no deterministic rule stay `candidate`;
  only validated fields render as checked. Officer confirm/reject
  (`PATCH .../candidates/:id`) re-verifies offsets against live page text —
  a retry-OCR rewrite returns 409 `CANDIDATE_STALE`.
- Consistency: both quotes re-verified, then confirmed by the existing
  cross-check comparators (names, registration incl. confusable, label- and
  currency-aware amounts, periods, dates). Anything not comparable stays
  `candidate` and renders as `needs_chase`; only `confirmed` + `mismatch`
  renders as `mismatch` and is escalable. Explanations are server-composed
  from the exact quotes.

Candidate fields (10): `document_type`, `issuer`, `document_date`,
`statement_period_start`, `statement_period_end`, `registration_number`,
`account_number`, `account_holder_name`, `material_amount`, `other`.
Consistency fields (7): `company_name`, `registration_number`,
`account_holder_name`, `statement_period`, `material_amount`,
`document_date`, `other`.

## Triage brief

Triage runs only for an active (`open`/`needs_info`) review at a pinned
`reviewVersion`, with `DOCUMENT_INTEGRITY_TRIAGE_ENABLED` plus both feature
flags, the agent flag, and a runner. Same-customer evidence requires
`contextAnalysisConsent`; without it (or under legal hold/retention expiry)
the source is a typed gap (`access_denied`, `retention_expired`, `missing`,
`unavailable`), never an inference.

The brief is a `document_integrity_brief` draft artifact: `title`, `summary`,
`candidateContradictions[]`, `alternativeExplanations[]`
(every claim ≥1 citation), `missingEvidence[]` (typed open-item codes),
`questionsForReviewer[]` (must be interrogative, end with `?`),
`suggestedPriority`. Citation kinds: `document` / `customer_document` (exact
page quote), `signal` (deterministic code), `duplicate_document` (match id,
no applicant data). The shared validator (`packages/core/src/generated-text.ts`)
additionally rejects `DEFINITIVE_FRAUD_LANGUAGE` ("confirmed fraud", "the
document is fake" — "possible tampering" and reviewer questions are allowed),
`CROSS_CUSTOMER_REFERENCE` (other-application refs/names), decision language,
and PII/direct identifiers. The applicant-facing fair-lending deny list is not
applied to this internal brief because it contains common words such as
"single"; PII and cross-customer checks remain active.

Async/lease flow: enqueue on flag create/evaluate/escalate → worker claims →
`executeTriage` re-checks review active + version, runs the agent, and commits
brief + run + review link in one fenced transaction (review still active at
same version; worker still owns the lease). A reviewer resolving mid-run
cancels the run (`REVIEW_CLOSED`); a stale worker cannot write after a
re-claim. Evidence change marks the brief stale (`briefStaleAt`, hidden from
the reviewer) and re-queues; identical input hashes replay. The panel exposes
at most one draft brief; superseded drafts are marked `superseded`.

Flow:

```text
upload/mutation ──► fingerprint + deterministic signals ──► severity ≥ threshold?
        │                                                              │ yes
        │ best-effort, officer/service only                    fraud_reviews (open)
        │                                                              │ enqueue
        ▼                                                              ▼
panel (officer) ◄── analysis run (lease, validate, persist)    triage run (lease,
candidates + consistency (stale-aware)                           version fence, brief)
                                                                       │ reviewer resolves
                                                                       ▼ cleared|confirmed|needs_info
```

## Duplicate lookup

Two surfaces, deliberately split (`duplicates.ts`):

- Officer panel: per-document `duplicateCount` (same-application only) plus
  `crossApplicationRestricted` (boolean — no cross-case refs). Same-case
  count only.
- Reviewer-only `POST /api/fraud-review/duplicates/lookup`: `{ sha256,
  applicationId? }` → `{ sha256Prefix, count, counts?, rows[] }` where rows
  carry `applicationReference`, `documentFileId`, `kind`, `uploadedAt`, and
  `explanationNote`. With `applicationId`, `counts` breaks down
  `sameApplication` / `sameApplicantOther` / `crossApplicant`.
- False-positive path: reviewer-only `POST .../duplicates/explain`
  (`note` 5–500 chars) upserts one explanation per hash+case.
- Every lookup is audited with the hash prefix only.

## Retention, legal hold, consent

- `DOCUMENT_INTEGRITY_RETENTION_DAYS` (default 365) stamps
  `fraud_reviews.retentionUntil` and duplicate-explanation retention.
  Retention redacts note + resolution note only for `cleared`/`confirmed`
  reviews; `open`/`needs_info` are never redacted; an active legal hold on
  the case blocks redaction. Explanations redact to `"redacted"`.
- Documents: blob purge and `retention_until` expiry (consent withdrawal sets
  `retention_until=now()`) remove files from the panel, the snapshot, and the
  reviewer surface. Legal holds block deletion.
- `requireIntegrityCaseAccess`: officer + active case grant + case not draft
  - `documentProcessingConsent`, else 403 `CONSENT_REQUIRED` / non-leaking
  404. Applicants get 403 before any existence check.

## Privacy and audit

All integrity/fraud responses send `Cache-Control: no-store`. Audit payloads
carry ids, codes, counts, versions, and hashes — never page text, quotes, or
PII. Events: `integrity.flag_opened/flag_updated`,
`integrity.analysis_requested/analysis_succeeded`,
`integrity.candidate_confirmed/candidate_rejected`,
`integrity.evaluate_requested/evaluate_failed`,
`integrity.triage_queued/triage_succeeded/triage_failed`,
`integrity.brief_stale`, `fraud_review.viewed/assigned/resolved`,
`fraud_review.reviewer_granted/revoked`, `fraud.duplicate_lookup`,
`fraud.duplicate_explained`, `artifact.created/superseded`,
`fraud_review.retention_applied`.

## Flags and config

`DOCUMENT_INTEGRITY_ENABLED` (panel + analyses), `FRAUD_REVIEW_ENABLED`
(review + triage + flags), `DOCUMENT_INTEGRITY_AGENT_ENABLED` (model pass),
`DOCUMENT_INTEGRITY_TRIAGE_ENABLED` (brief) — all default `false`. Off means
routes 404. The agent additionally needs `OPENROUTER_API_KEY` (shared with
the memo writer). Model/provenance defaults: `DOCUMENT_INTEGRITY_MODEL`
(`deepseek/deepseek-v4.1-flash-1017`), `DOCUMENT_INTEGRITY_PROMPT_VERSION`
(`integrity-analysis-v1`), `DOCUMENT_INTEGRITY_AGENT_VERSION`
(`integrity-agent-v1`), `DOCUMENT_INTEGRITY_TRIAGE_PROMPT_VERSION`
(`integrity-triage-v1`). System actor for service-created items:
`DOCUMENT_INTEGRITY_SYSTEM_USER_ID`. See
[configuration](../reference/configuration.md).

## Known limits

- No deepfake/image-forensics detection: `editSignal` is PDF metadata only.
- No auto-decline, no status/score/terms change, no auto-resolution.
- Registration numbers get format validation only
  (`checksum_not_available` — no registry checksum).
- Ambiguous consistency pairs stay `needs_chase` forever; only deterministic
  confirmation renders `mismatch`.
- Panel reads the latest succeeded analysis only and the newest 20 files;
  the snapshot caps at 20 documents, 20 pages each, ~2 MB total text.
- Triage needs all four flags plus a key; without them the flag stays `open`
  with deterministic signals and no brief.
