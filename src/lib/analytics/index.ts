/**
 * Analytics engine — public surface.
 *
 * Pure, isomorphic and dependency-free. The server imports it to compute
 * metrics for exports and API responses; the browser imports the *same* code
 * to recompute everything the instant a period or threshold changes, which is
 * why those controls never trigger a network request.
 */

export * from "./types";
export * from "./constants";
export * from "./stats";
// The definition of a hit — a bar AND a clock — lives in `hit-rate` and only
// there. It briefly had a module of its own beside this one, which is two
// homes for a rule the whole business runs on and therefore two versions of it
// the first time somebody edits one. Every consumer that decides whether
// something is a hit calls `evaluateHit` rather than comparing view counts.
export * from "./hit-rate";
export * from "./filters";
export * from "./distribution";
export * from "./channel-metrics";
export * from "./content-type-performance";
export * from "./series";
export * from "./outliers";
export * from "./market";
export * from "./market-share";
export * from "./trends";
