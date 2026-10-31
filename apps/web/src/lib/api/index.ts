// API barrel: every module re-exported under its original name, so
// existing `../lib/api` importers need zero changes. `getMemoArtifact` and
// `updateContextConsent` were intentionally removed (zero callers).
export * from "./assistant";
export * from "./client";
export * from "./core";
export * from "./demo";
export * from "./documents";
export * from "./format";
export * from "./fraud";
export * from "./intake";
export * from "./integrity";
export * from "./memo";
export * from "./policy";
export * from "./policyException";
export * from "./research";
export * from "./sse";
