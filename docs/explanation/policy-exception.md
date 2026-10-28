# Policy exception navigator (EN-06, EN-07, E3)

Case-grounded explanation of engine rule failures, the deterministic
exception/approval path, and a draft `policy_exception_memo`. Audience:
developers extending the navigator or adding a rule. Outcome: you know what
is deterministic, what the model may write, and what must fail closed.

Related: [eval design](../eval/eval-design.md#45-feature-registry) (registry row and
results), the implementation plan
(historical plan path, not in repo:
`.scratch/plans/en06-en07-e3-policy-exception-navigator.md`).

## What is deterministic

- `packages/core/src/policy-registry.ts` — 19 product-scoped rules, the
  rule-to-policy mapping (`ruleSectionRefs`), and the exception taxonomy
  (`allowed` / `prohibited` / `not_applicable` / `structural_remedy` /
  `mapping_unavailable`). Versioned (`POLICY_REGISTRY_VERSION`) and hashed.
- `explainPolicyRules` (`packages/core/src/policy.ts`) — every evaluated
  check with observed value, threshold, reason code, and score band. Pinned
  to `POLICY_VERSION`; decided cases use `decision.snapshot`, pending cases
  the latest evaluation.
- `buildCaseRuleContextFromRows`
  (`apps/applications/src/assist/policy-rules.ts`) — pure row-to-context
  mapping. Missing evaluation/score throws `RULE_CONTEXT_UNAVAILABLE`;
  wrong engine version throws `UNSUPPORTED_POLICY_VERSION`. A persisted
  reason code with no registry entry is surfaced as an `UNMAPPED:` rule in
  `mapping_unavailable`, never silently dropped or explained.
- `resolveExceptionPath` — approver (standard authority, one level above for
  `allowed`, committee on multi-rule), dual sign-off, mitigants, and the
  12-month regularisation ceiling. Prohibited and mapping-unavailable states
  carry no approver and no mitigants.
- `composePolicyMemoContent` — the memo `rules` block and plan months are
  server-composed; the model writes prose only.

## What the model may write

`runPolicyExceptionAgent` (deterministic tool prefetch, one grounded model
draft, one repair, then typed failure) produces cited prose for `explain` /
`followup` and memo sections for `memo`. The prefetch calls the allowlisted
rule and policy tools; a provider that does not reliably honor tool calls
therefore still gets the exact rule facts and canonical section bodies. Every
segment carries an exact quote from a case section; every claim cites case
evidence. Missing required rule/exception citations are filled from the
pre-resolved catalog with a safe canonical sentence _after_ validation, so
the added prose cannot bypass the guards. The policy-exception EN-03 profile
bans action language (`approve`/`decline`/`reject`/`recommend`/`decision`)
but allows descriptors (`score`, `limit`, `rate`). Numeric, approver, and
mitigant mentions are checked against the deterministic path and the case
policy catalog.

Fail-closed typed outcomes: `MAPPING_UNAVAILABLE` (no fabricated path),
`POLICY_SOURCE_UNAVAILABLE` (policy service down), `POLICY_EXCEPTION_INVALID`
(validation fails after repair). Cross-case, identifier, and out-of-scope
follow-ups refuse without a model call.

## Enable and evaluate

Flag `ASSIST_POLICY_EXCEPTION_ENABLED` (default off; off is opaque 404).
Config: `POLICY_EXCEPTION_*` (`MODEL`, `PROMPT_VERSION`, `AGENT_VERSION`,
`VALIDATOR_VERSION`, `MAX_STEPS`, `MAX_TOOL_CALLS`, `TIMEOUT_MS`,
`MAX_COST_USD`, `MAX_OUTPUT_TOKENS`).

Eval: `pnpm --filter @credit/applications eval:policy-exception --
--split=dev --trials=3` (then `--split=heldout` once). 24 cases
(17 dev / 7 held-out; 9 explain, 8 memo, 7 follow-up), fixture policy
client, code-first graders, one calibrated claim-support judge,
`eval/POLICY-EXCEPTION-RESULTS.md`.

Open items: staff/PEP/connected flags are absent (minimum approver plus a
mandatory verification item); third-party names in officer questions are
only scrubbed for known case values; retention is anchored at creation,
not facility closure. The `apps/policy` answer eval needs 9.x/conflict
cases re-run after corpus changes — same command family, separate suite:

```powershell
pnpm --filter @credit/policy eval:answers -- --split=dev --trials=1
```
