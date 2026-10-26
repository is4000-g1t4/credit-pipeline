# Agent and app observability

Grafana Agent Observability captures every LLM generation and tool execution
from the credit agents. OTel traces and metrics carry the app-level view
(`service.name`, latency, token and cost metrics). Instrumentation is
metadata-only and best-effort: a missing endpoint, token, or network never
fails a run or decision, and prompts, document text, PII, and tool arguments
never leave the process.

## What is instrumented

| Surface                  | Agent name                 | App service (`service.name`) |
| ------------------------ | -------------------------- | ---------------------------- |
| Agentic credit memo      | `credit-memo-writer`       | `credit-applications`        |
| Document integrity       | `document-integrity-agent` | `credit-applications`        |
| Policy navigator / case  | `policy-navigator`         | `credit-policy`              |
| Policy embeddings        | `policy-embedder`          | `credit-policy`              |
| Research case brief      | `case-brief`               | `credit-research`            |
| Research context analyst | `context-analyst`          | `credit-research`            |

Tool executions are recorded as separate metadata-only tool spans. Direct
model calls that bypass a runner (policy answerer, research judge/repair) are
recorded as generations under the same conversation id. Conversations use the
run id (memo/integrity), the policy query id, or the eval case/trial id.

## Configuration

The shared client reads the SDK-canonical variables from `.env`:

```dotenv
AGENTO11Y_ENDPOINT=https://agento11y-prod-....grafana.net
AGENTO11Y_PROTOCOL=http
AGENTO11Y_AUTH_MODE=basic
AGENTO11Y_AUTH_TENANT_ID=<stack-id>
AGENTO11Y_AUTH_TOKEN=glc_...
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-....grafana.net/otlp
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64>
```

`OTEL_SERVICE_NAME` is set per app if the deployment does not set it;
`OTEL_SDK_DISABLED=true` makes every path a no-op (tests use this).

## Evals

Real-model evals pass a stable conversation id and flush before exit:

```bash
pnpm --filter @credit/applications eval:integrity -- --split=all --trials=1
pnpm --filter @credit/applications eval:memo-agent -- --live
pnpm --filter @credit/policy eval:answers -- --trials=1 --split=all
pnpm --filter @credit/research eval:brief -- --trials=1
pnpm --filter @credit/research eval:context -- --trials=1
```

`--live` on the memo eval runs one real `credit-memo-writer` turn; the default
memo suite is scripted and does not call a model. The settings sweep is a
tuning tool, not a one-run eval.

## Verify with gcx

```bash
gcx agento11y agents list
gcx agento11y conversations search --filters 'agent = "document-integrity-agent"' --page-size 5
gcx agento11y conversations get <conversation-id>
gcx agento11y generations list-scores <generation-id>
```

Generation ingest proves `AGENTO11Y_*` and `setResult` are wired. It does not
prove OTel. Use the `trace_id` from a generation:

```bash
gcx traces get -d grafanacloud-traces <trace-id> --llm -o json
gcx metrics query -d grafanacloud-prom \
  'max by (gen_ai_agent_name) (agento11y_generation_cost_usd_total)'
```

The trace's `serviceName` must be the app in the table above, with
`gen_ai.agent.name`, `gen_ai.request.model`, and token usage on the span.
