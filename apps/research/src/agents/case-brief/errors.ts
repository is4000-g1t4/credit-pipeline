// Run-level failure classes of the case-brief agent. A leaf module so the
// validator and the runner can both use them without an import cycle.
export class ModelUnavailableError extends Error {}
export class AgentTimeoutError extends Error {}
