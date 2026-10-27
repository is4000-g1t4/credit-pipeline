// Barrel (SPEC §6): the client was split into ./api/* by domain; this file
// re-exports everything under its original name so existing `../lib/api`
// importers need zero changes.
export * from "./api/index";
