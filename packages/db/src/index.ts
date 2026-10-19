// @credit/db root — client + password helpers only. Table definitions live
// behind per-service subpaths so no service can import another domain's
// tables: `@credit/db/auth`, `/applications`, `/loans`, `/portfolio`
// (plus `/shared` for the outbox/audit shape every writer DB carries).
export * from "./client.js";
export * from "./password.js";
