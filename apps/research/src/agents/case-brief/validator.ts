// The case-brief output validator (§6.4): the model-output schema plus the
// blocking validation pipeline (schema → PII/decision-language gates →
// language repair → evidence verification → support judging → confidence).
// Split across two sibling modules; this file is the agent's single entry.
export * from "./brief-schema.js";
export * from "./brief-validation.js";
