# Adverse action (EN-08 / E4)

Deterministic adverse-action letters for declined cases. Audience: developers
extending the letter pipeline or adding a jurisdiction. Outcome: you know how
a decline becomes a letter, what can fail, and what a new jurisdiction needs.

Related: [API](../reference/api.md#adverse-action-en-08--e4) (route contract),
[configuration](../reference/configuration.md) (`ASSIST_ADVERSE_*`),
[data and events](../reference/data-and-events.md#generated-artifacts-en-010203-en-08)
(artifact storage and audit).

## Pipeline

Declined decision → decision reason codes → EN-08 taxonomy → 3-4 principal
reasons → letter. Only `POST /api/assist/cases/:id/adverse-action` runs it;
the generic artifact-create route rejects `adverse_action_letter` with
`DEDICATED_ROUTE_REQUIRED` so the taxonomy cannot be bypassed.

1. The case must be `declined` with a declined decision row; otherwise 409
   `CASE_NOT_DECLINED`.
2. The configured jurisdiction resolves to a code-defined profile (`SG` /
   `US`); otherwise 409 `JURISDICTION_UNSUPPORTED`.
3. Decision reason codes map through the total EN-08 taxonomy
   (`packages/core/src/adverse-action.ts`): every policy, check, officer, and
   score-factor code has a category, specificity, and applicant-safe template.
   Negative score factors frozen in `decision.snapshot.factors` are also
   decision evidence, so an officer decline with one generic officer code can
   still use the snapshot's specific factors. Unmapped codes fail closed with
   `NEEDS_OFFICER_INPUT` — nothing is invented.
4. Deterministic selection picks at most `maxReasons` (4), keeping specific
   reasons first and at most one generic reason as support. Minimum 3, at most
   one generic, at least one specific; violations fail closed with
   `NEEDS_OFFICER_INPUT`. Reasons beyond the cap are returned as
   `droppedReasonCodes` and recorded in the audit metadata.
5. Each reason cites decision-reason evidence (`score_reason`,
   `kind: decision_reason` / `decision_factor`, `scoreId = decision.id`) and
   the shared validator re-checks citations, decision language, PII, internal
   risk/model/policy references, and fair lending before the draft persists.
   A check-only decline with only one or two check reasons still returns
   `NEEDS_OFFICER_INPUT`; that is the intended fail-closed path when the
   decision simply does not contain three specific reasons.

There is no model prompt in v1: `ASSIST_MODEL=deterministic` and
`ASSIST_ADVERSE_PROMPT_VERSION=adverse-letter-v1` are provenance only.

## Jurisdiction profiles

| Jurisdiction | Version      | Title                    | Decision wording | Legal review                                    |
| ------------ | ------------ | ------------------------ | ---------------- | ----------------------------------------------- |
| `SG`         | `sg-feat-v2` | Notice of credit outcome | `not_successful` | `LEGAL-SG-ADV-2026-09` (SG FEAT-aligned)        |
| `US`         | `us-ecoa-v2` | Adverse action notice    | `declined`       | `LEGAL-US-ADV-2026-09` (US ECOA / Regulation B) |

The legal-review references above are the recorded review identifiers for this
demo; production enablement of a new jurisdiction must link the signed legal
sign-off. Reason templates are jurisdiction-neutral and reviewed once; the
profile controls the title, decision wording, required disclosures, and reason
count.

Every profile carries its required disclosures, an approved legal-review
entry, a wording hash, and a change log linking each version to its review.
Changing title, decision wording, or notices without bumping the version
changes the hash and fails profile validation, so a stored `profileVersion`
always identifies the approved wording. `ASSIST_ADVERSE_JURISDICTION` (default
`SG`) selects the profile; `ASSIST_ADVERSE_CONTACT_PATH` supplies the
applicant contact path and has no default — an empty value fails closed with
422 `DISCLOSURE_UNAVAILABLE`.

## Adding a jurisdiction

1. Extend the `AdverseJurisdictionProfile["code"]` union and
   `ADVERSE_JURISDICTION_PROFILES` with the new profile: version, title,
   decision wording, 3-4 reason bounds, disclosures, legal-review reference,
   and change-log entry. Compute the wording hash with
   `adverseProfileWordingHash` and copy the literal into both the profile and
   its matching change-log entry; it includes the taxonomy version, title,
   decision wording, reason count, and disclosures.
2. Extend `resolveAdverseJurisdictionProfile` (or replace the two hardcoded
   branches with a keyed lookup) so the new code resolves.
3. Add the legal-review entry (reference, scope, date) — the profile must
   validate via `validateAdverseJurisdictionProfile`.
4. Add tests covering selection, profile validation, and the new wording.
5. Select it via `ASSIST_ADVERSE_JURISDICTION`.

## Fair lending and human control

- The deny-list / proxy scan runs on inputs (reason codes + labels) and on
  generated text, and on edits/approvals via the shared validator
  (`PROTECTED_ATTRIBUTE`, `FAIR_LENDING_PROXY`). The deny-list version is
  recorded in the audit. Structured identity/contact fields are exempt from
  the fair-lending scan (a company called "Single Origin Coffee" is not a
  reason), but reason prose, titles, and notices are scanned.
- On generation, an input hit returns `FAIR_LENDING_BLOCKED` and writes
  `artifact.generate_blocked` (metadata only); on edit/approve a generated-text
  hit returns `GENERATED_TEXT_INVALID` with `PROTECTED_ATTRIBUTE` /
  `FAIR_LENDING_PROXY` and writes `artifact.edit_blocked` /
  `artifact.approve_blocked`.
- Edit/approve re-binds the letter to the case decision: `decisionId`, every
  reason code, each reason's approved taxonomy text, each citation
  (`score_reason:<decisionId>:<code>`), the profile title, and the configured
  contact path must match. Drift returns 422 `ADVERSE_DECISION_MISMATCH` and is
  audited. The profile's required notices must match exactly; drift returns
  `ADVERSE_PROFILE_INVALID`. v1 deliberately locks applicant-facing reason
  text to the reviewed templates; an officer can edit non-reason fields (open
  items) but not rewrite a reason into an untraceable statement.
- Letters are drafts until an officer approves them through the existing
  artifact routes; approval re-validates citations, decision binding, and the
  jurisdiction profile. Approved letters are immutable — edits create a new
  version. There is no auto-send.
- Audit and logs carry metadata only (`decisionId`, `reasonCodes`,
  `droppedReasonCodes`, `jurisdiction`, `profileVersion`, `profileWordingHash`,
  `legalReviewRef`, `policyVersion`, `scorecardVersion`, `taxonomyVersion`,
  `citationRefs`, `fairLendingScan`, `fairLendingDenyListVersion`). No letter
  text, prompt, or applicant PII goes to logs.
