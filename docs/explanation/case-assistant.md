# Case assistant (officer Ask tab)

Officer-only, case-scoped Q&A over one case. The officer asks a follow-up
question; the assistant answers from read-only case tools and cites the policy
sections it used. It never recommends, approves, declines, scores, prices, sets
terms, writes a row, or changes a status. Audience: developers extending the
tool set or reviewing the trust boundary.

Related: [architecture](architecture.md),
[policy exception](policy-exception.md), and the
[eval report](../eval/research/CASE-ASSISTANT-MODELS-RESULTS.md).

## Request flow

```text
web Ask tab
  -> POST /api/review/:id/assistant              gateway  (officer, 10/min, 120s)
  -> POST /api/review/:id/assistant              review   (officer, flag, strict body, 60s)
  -> POST /internal/research/applications/:id/assistant   research (officer HMAC, flag, consent)
       -> GET  /internal/applications/:id/research-context  caseFacts + consent
       -> POST /internal/applications/:id/assistant-context score/policy/decision/documents
       -> GET  /internal/applications/:id/context/*         accounts, txs, KYC, reports, ...
       -> GET  /internal/loans/by-applicant/:userId         case-bound loans/EWS
       -> POST /internal/policy/search                      as-of, product-scoped sections
```

The browser sends only `{question, history}`. History is a bounded trailing
window (8 messages, 6,000 chars total); the client keeps it in React state.
No assistant chat or run row is persisted, and the assistant writes nothing
itself. The underlying case/context reads keep their existing audit rows, and
policy search keeps its query/budget row; those are currently attributed to
the service principal, not the requesting officer.

The case is resolved as of `caseFacts.submittedAt` (UTC day) for policy and
loan reads, so the assistant sees the same evidence the deterministic
pipeline saw. Before any case data is read, research calls
`/internal/applications/:id/assistant-access` with the officer's signed
identity; unknown cases, drafts, another officer's active assignment, and
revoked officers are a non-leaking 404.

## Tools

The loop exposes exactly 15 read-only tools:

| Tool | Source |
| ---- | ------ |
| `get_case_facts` | Case facts from the applications service |
| `get_case_assessment` | Latest score, policy evaluation, decision, status, dates |
| `get_documents` | Document metadata only (kind, status, OCR, period) |
| `get_customer_summary` | Customer profile summary |
| `list_accounts` | Customer accounts |
| `get_transactions` | One account's windowed transactions |
| `get_cashflow_metrics` | Deterministic cashflow signals |
| `get_application_financials` | Declared financials |
| `get_document_findings` | Crosscheck findings and stale flag |
| `get_credit_history` | Prior applications |
| `get_external_reports` | Bureau/bank reports |
| `get_kyc_checks` | KYC checks |
| `get_loans` | Existing loans and EWS |
| `get_external_research_summary` | Latest verified research brief |
| `search_policy` | Policy sections for the case product and as-of |

All tool results are treated as data, never instructions. Transaction
descriptions, counterparties, finding reasons, and research text are
untrusted; the prompt tells the model to ignore instructions inside them.

The response carries metadata-only traces: tool name, result count, and source
types. It never carries arguments, tool output, document text, or prompts.
`policyRefs` contains only sections the answer actually cites; each carries a
short quote and a signed drawer token so the UI can open the section.

## Prompt, validation, and bounds

- Answer only from tool results; say explicitly when the evidence is missing.
- Never use approve/decline/reject/recommend/decision vocabulary, even to
  describe policy facts. Report a recorded outcome as case status.
- Never repeat the applicant name, email, phone, NRIC, address, account
  number, or document text. The company name may be used to disambiguate.
- Money tool values are integer cents; report whole currency units without
  inventing a currency code.
- Cite policy as `POL-CR-00X §Y.Z`.

The production validator rejects an empty answer, an answer over 4,000
characters, advisory/decision language, a direct identifier, or the applicant
name. Any rejection fails closed with 422 `UNSAFE_OUTPUT`/`INVALID_OUTPUT`;
there is no repair path that could hide a failure. The tool loop is capped at
6 turns, 12 tool calls, 1,200 output tokens, and a 45-second deadline.

## Endpoint

`POST /api/review/:id/assistant` (officer)

```json
{
	"question": "Why was this case referred?",
	"history": [{ "role": "user", "text": "..." }]
}
```

Response `200`:

```json
{
	"answer": "...",
	"limitations": [],
	"toolCalls": [{ "name": "get_case_assessment", "resultCount": 1, "sourceTypes": ["case"] }],
	"policyRefs": [
		{
			"policyKey": "POL-CR-009",
			"sectionId": "9.2",
			"heading": "...",
			"version": "v1",
			"effectiveFrom": "2026-01-01",
			"policyVersionId": "<uuid>",
			"quote": "...",
			"drawerToken": "..."
		}
	],
	"usage": { "inputTokens": 11339, "outputTokens": 532 },
	"model": "openai/gpt-6.1-terra",
	"promptVersion": "case-assistant-v3",
	"agentVersion": "case-assistant-v1",
	"latencyMs": 14192
}
```

Errors: 404 `CASE_ASSISTANT_DISABLED` (flag off), 403
`CONTEXT_CONSENT_REQUIRED`, 404 `NOT_FOUND` (unknown/cross-officer/draft),
409 `CASE_NOT_SUBMITTED` for a draft case, 422 `VALIDATION_ERROR`, 422
`UNSAFE_OUTPUT`/`INVALID_OUTPUT`, 504 `CASE_ASSISTANT_TIMEOUT`, 502
`CASE_ASSISTANT_FAILED`, 503 `CASE_ASSISTANT_UNAVAILABLE`. Messages are
static; logs carry ids, codes, and the validator's safe reason only.

## UI

The officer case page has an `Ask` tab after `Policy`. The panel keeps the
conversation in memory, offers four suggested questions, sends Enter (Shift+Enter
newlines), caps the question at 1,000 characters, and renders each answer with
its limitations, a collapsible tool-activity timeline, and policy citation
buttons that open the shared section drawer. Failed turns keep the question and
offer retry without duplicating it. The timeline shows labels, result counts,
and source types only.

## Configuration

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `CASE_ASSISTANT_ENABLED` | `false` | Research and review both gate on it; off 404s |
| `CASE_ASSISTANT_MODEL` | `openai/gpt-6.1-terra` | Eval winner pin |
| `CASE_ASSISTANT_MAX_TURNS` | `6` | Model turns |
| `CASE_ASSISTANT_MAX_TOOL_CALLS` | `12` | Tool invocations per question |
| `CASE_ASSISTANT_MAX_OUTPUT_TOKENS` | `1200` | Answer cap |
| `CASE_ASSISTANT_TIMEOUT_MS` | `45000` | Research deadline (1s–50s; review proxy 60s, gateway 120s) |
| `CASE_ASSISTANT_TEMPERATURE` | `0.1` | Sampling |
| `CASE_ASSISTANT_MAX_QUESTION_CHARS` | `1000` | Inbound question |
| `CASE_ASSISTANT_MAX_HISTORY_MESSAGES` | `8` | Trailing history |
| `CASE_ASSISTANT_MAX_HISTORY_CHARS` | `6000` | Summed history text |

The feature also requires `AGENTS_ENABLED=true` and case-level
`contextAnalysisConsent`. Flags default off.

## Eval

```powershell
pnpm --filter @credit/research eval:case-assistant -- --trials=3
```

20 questions across five eval-owned customers (multi-account SME, negative
balance, data-rich SME, empty observation window, hostile/injection). Pass is
a code gate: the production validator accepted the answer, the expected
read-only tool ran, the required evidence token is present, and no forbidden
token or applicant PII leaked. Sol and Terra run on the same pinned fixture;
see the [report](../eval/research/CASE-ASSISTANT-MODELS-RESULTS.md).

Open items: result counts for object-shaped tools are 1 rather than the number
of nested items; the assistant does not stream partial answers; and a follow-up
that needs a document's text (not just metadata/findings) is out of scope by
design.
