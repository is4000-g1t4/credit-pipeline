# Docs

Start here. Each section names one audience and the page that serves it.

## First run

- [Getting started](getting-started.md) — how-to. Run the stack and verify the demo from a clean checkout.

## Demo

- [Getting started](getting-started.md#4-run-the-four-scenarios) — how-to. Canonical scenarios, headless checks, and recovery.

## Developer

- [Architecture](explanation/architecture.md) — explanation. Components, request flow, trust boundary, and failure domains.
- [Lifecycle](explanation/lifecycle.md) — explanation. Status machines, expiry, the booking saga, and alert behavior.
- [Eval design](explanation/eval-design.md) - guideline. Lab practices, a small suite per AI feature, and the Grafana split.
- [Adverse action](explanation/adverse-action.md) - explanation. EN-08 taxonomy, jurisdiction profiles, fair-lending gates, and letter provenance.
- [Policy exception](explanation/policy-exception.md) - explanation. EN-06/EN-07 case-policy review, exception path, and memo provenance.
- [Document integrity](explanation/document-integrity.md) — explanation. Fingerprint/provenance, signals, combined extraction/consistency/brief pass, and fraud review.
- [Agent and app observability](explanation/agent-observability.md) — explanation. Grafana Agent Observability wiring, agent and service names, evals, and gcx verification.
- [Agentic memo](explanation/agentic-memo.md) - explanation. Bounded tool loop, allowlisted evidence tools, validation/repair, trace, replay, and writer modes.
- [Credit pipeline pain points](explanation/credit-pipeline-pain-points.md) — research. Bank and credit-officer bottlenecks, current coverage, and feature options.
- [Extend the pipeline](how-to/extend-the-pipeline.md) — how-to. Recipes for routes, events, migrations, policy, and demo checks.

## Operator

- [Troubleshooting](operations/troubleshooting.md) — how-to. Symptom tables, health checks, and safe recovery.
- [Configuration](reference/configuration.md) — reference. Variables, defaults, precedence, and container overrides.

## API caller

- [Public and internal API](reference/api.md) — reference. Auth, applications, review, loans, demo, dashboard, health, internal contracts, errors.
- [Data and events](reference/data-and-events.md) — reference. Database ownership, topics, payloads, outbox, consumer.

## Command lookup

- [Root README](../README.md) — how-to and reference. Quickstart, commands, ports, and version notes.
