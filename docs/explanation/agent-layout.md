# Agent layout and runtime

Every AI agent follows one directory convention, borrowed from Vercel's
eve ("an agent is a directory"), and one shared runtime package,
`@credit/agent-kit`. We copy the convention only: agents still run on our
own stack (OpenRouter through the OpenAI SDK, `@openai/agents`, Temporal),
not on eve.

Agents are advisory. Nothing in this layout lets model output reach a
score, decision, term, price, or booking. See [architecture.md](architecture.md).

## Directory convention

Each agent lives in the service that owns its data:

```
apps/<owning-service>/src/agents/<agent-name>/
  agent.ts          # defineAgent({...}) manifest + the runner factory
  instructions.md   # static system prompt (byte-exact; not formatted)
  tools/<tool>.ts   # one model-callable tool per file (omit if none)
  validator.ts      # the output validator; always this file name
  index.ts          # the agent's public surface; import from here
  *.ts              # other agent-private modules (types, prompt builders)
```

Rules:

- **Placement:** an agent stays in the service whose database it reads.
  Never move an agent into another service to "centralise" agents.
- **`agent.ts`:** exports `definition = defineAgent({...})` with the model
  env var and pinned default, flags, versions, tool names and execution
  mode (`temporal` or `request`).
- **Prompts:** static prompt text lives in `instructions.md`, loaded with
  `loadInstructions(import.meta.url)`. Dynamic parts use `{{name}}`
  placeholders filled by `renderInstructions`, or are composed in code.
- **Prompt changes:** moving a prompt into a file must keep the assembled
  string byte-identical. If the text changes, bump the prompt version.
  `instructions.md` files are excluded from oxfmt for this reason.
- **Evals:** they stay in `apps/<app>/eval/` (see [docs/eval](../eval/index.md))
  and import from the agent's `index.ts`.

## Inventory

| Agent                                   | Directory                                        | Execution               |
| --------------------------------------- | ------------------------------------------------ | ----------------------- |
| External case brief                     | `apps/research/src/agents/case-brief/`           | Temporal (research)     |
| Context analyst                         | `apps/research/src/agents/context-analyst/`      | Temporal (research)     |
| Case assistant                          | `apps/research/src/agents/case-assistant/`       | Request                 |
| Case policy review (client)             | `apps/research/src/agents/policy-review/`        | Temporal (research)     |
| Policy navigator / case-review answerer | `apps/policy/src/agents/policy-answerer/`        | Request                 |
| Credit memo writer                      | `apps/applications/src/agents/memo-writer/`      | Request                 |
| Policy-exception drafter                | `apps/applications/src/agents/policy-exception/` | Request                 |
| Document integrity                      | `apps/applications/src/agents/integrity/`        | Temporal (applications) |

## Model-call retries

Every OpenRouter call goes through `createOpenRouterClient` (OpenAI SDK
and `@openai/agents`) or `createRetryingFetch` (raw fetch). Both share
`DEFAULT_RETRY_POLICY`.

- **Attempts:** 3 in total, with backoff of 1s then 2s (4s cap) and ±20%
  jitter.
- **`Retry-After`:** honoured up to 10s. A longer hint stops retrying.
- **Retried:** HTTP 408, 409, 429 and 5xx; network errors; per-attempt
  timeouts.
- **Never retried:**
  - other 4xx responses (auth, bad request);
  - a caller abort (the run deadline);
  - any failure after a response was returned. Schema and validator
    failures go through each agent's own repair path, not a retry.
- **Budgets:** a retry is skipped when its backoff would cross the
  caller's deadline (`deadlineAt`) or when `canRetry()` returns false,
  for example when the cost budget is exhausted.
- **Logging:** `onRetry` receives metadata only (attempt, status, delay).
  Bodies are never read.

The SDK's own retry loop is disabled (`maxRetries: 0`) so that only this
policy applies.

## Durable runs on Temporal

Background agent runs (research runs and document integrity) execute as
Temporal workflows instead of in-process fire-and-forget jobs.

- **Worker process:** each owning service runs a separate Node
  `agent-worker` process on its own task queue (`research-agents`,
  `applications-agents`), with activities that touch only that service's
  database. The API process only starts workflows, using the Bun-safe
  `@credit/agent-kit/temporal/client`. The pipeline worker (`apps/worker`)
  never runs an agent.
- **Workflow:** the generic `agentRunWorkflow` runs one `executeAgentRun`
  activity, which heartbeats every 10s with a 60s heartbeat timeout.
- **Crash retries:** Temporal retries the whole run up to 3 times on a
  crash, a lost heartbeat or an unexpected throw. Attempt n > 1 rotates
  the run token first, so a zombie attempt's token-guarded writes fail.
- **Business failures** (validation, model unavailable after call-level
  retries, budget) are finalized on the run row. The activity then
  returns normally and is not retried.
- **Cleanup:** after the last attempt fails, or on cancel, `failAgentRun`
  marks a still-active run failed. This replaces the hand-rolled reapers
  and boot recovery. The run tables remain the read model the UI polls.
- **Idempotent start:** the workflow id is `<kind>:<runId>:<token>`, so
  re-issuing a start is a no-op. The API commits the row and then starts
  the workflow, so a crash in between can leave a row that was committed
  but never started. A 15s sweep in each agent worker re-issues starts
  for rows older than 10s that never heartbeated. It fails rows still
  queued past their lease plus 5 minutes, so the UI always reaches a
  terminal state even when Temporal is unreachable.
- **Research retries** (`rotateRunForRetry`) rotate `run_token`, reset the
  row to `queued`, and clear the dead attempt's evidence, findings and
  context/policy stage state before rerunning. Context retries rotate
  `context_stage_token`.
- **Integrity retries** (`claimIntegrityRunById`) re-lease the row with a
  fresh `lease_token` and still respect `max_attempts`.

Run kinds: `research.run` and `research.context-retry` run on the
`research-agents` queue, and `integrity.run` on `applications-agents`.

Local dev: `pnpm dev` also starts each service's `dev:agent-worker`
script. The compose overlay runs them as the `research-agent-worker` and
`applications-agent-worker` services. Without a running agent worker,
runs stay `queued` until the sweep fails them.
