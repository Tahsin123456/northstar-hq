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
export * from "./hit-rate";
export * from "./filters";
export * from "./distribution";
export * from "./channel-metrics";
export * from "./series";
export * from "./outliers";
export * from "./market";
export * from "./market-share";
export * from "./trends";
