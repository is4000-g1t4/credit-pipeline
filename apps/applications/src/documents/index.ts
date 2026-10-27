// T01 document modules (SPEC-t01-t02, D1a): crypto, storage, scanner, OCR,
// pipeline, service, access. D1b seams — claim/grant/revoke
// (access.ts), retention/legal-hold sweep, crosscheck/chase — build on
// DocumentService, sweepDocumentOrphans, and resolveDocumentAccess.
// Routes live in ./routes.js (imported directly by the app factory).
export * from "./access.js";
export * from "./crosscheck.js";
export * from "./crypto.js";
export * from "./ocr.js";
export * from "./pipeline.js";
export * from "./retention.js";
export * from "./scanner.js";
export * from "./service.js";
export * from "./storage.js";
