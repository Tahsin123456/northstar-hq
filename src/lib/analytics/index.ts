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
// How a hit rate should be READ, kept beside the rule that produces it. One
// predicate for "is this zero a measurement or an absence?", so no two screens
// can answer it differently about the same object — which they did, in the
// same card group, for months.
export * from "./hit-display";
export * from "./filters";
export * from "./distribution";
export * from "./channel-metrics";
export * from "./content-type-performance";
export * from "./series";
export * from "./outliers";
export * from "./market";
// Who is IN the comparison, kept beside the maths that compares them. One
// definition of "counts toward how we are doing" — `isStudioChannel` — read
// here as well as by the portfolio summary and the report.
export * from "./market-scope";
export * from "./market-share";
export * from "./trends";
