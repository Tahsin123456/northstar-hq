import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATASET_KEY } from "@/hooks/use-dataset";

/**
 * ==========================================================================
 * CHANGING A SCOPE FILTER MUST NEVER CAUSE A FETCH
 * ==========================================================================
 *
 * The whole app is derived in the browser from one `["dataset"]` payload:
 * period, threshold, niche, ownership and content type are pure transforms over
 * arrays already in memory. That is a deliberate design property, not an
 * optimisation — a filter that refetched would make the fastest controls in the
 * product the slowest, and would let a stale response land after a newer one
 * and quietly undo it.
 *
 * The property is easy to break by accident and impossible to notice: adding a
 * filter to a `queryKey` looks like the obvious way to make a list respond to
 * it, and the result still works. It is just slow, racy, and no longer the
 * thing the design promised.
 *
 * SO IT IS PINNED STRUCTURALLY RATHER THAN BY CONVENTION. This test reads the
 * source and fails if any scope filter ever appears inside a `queryKey`. A
 * behavioural test cannot cover it — the bug is not a wrong value, it is a
 * request that should not have happened.
 */

const SRC = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The filters that must stay out of every cache key.
 *
 * `period` and `range` are deliberately ABSENT from this list even though they
 * are scope filters too: `use-finance.ts` legitimately keys on a date range,
 * because the finance ledger is server-aggregated and is not part of the
 * dataset payload at all. The five below are all derived from the dataset in
 * the browser, so there is no honest reason for any of them to key a query.
 */
const FORBIDDEN_IN_KEYS = [
  "contentType",
  "niche",
  "ownership",
  "threshold",
  "ownFirst",
] as const;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      found.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Every `queryKey:` line in the app, with its file and line number.
 *
 * Line-based on purpose. A key is written on one line in this codebase, and a
 * parser here would be a second thing to maintain — while the failure mode this
 * guards against (someone appends a filter to a key) is exactly the kind of
 * edit that stays on one line.
 */
function queryKeyLines(): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      if (!text.includes("queryKey")) return;
      // Invalidation and cache writes name a key to *target* it; they are not
      // declaring what a fetch depends on, and a filter appearing in one of
      // those is a normal, correct thing.
      if (/invalidateQueries|setQueryData|removeQueries|cancelQueries|getQueryData/.test(text)) {
        return;
      }
      hits.push({ file: path.relative(SRC, file), line: index + 1, text: text.trim() });
    });
  }
  return hits;
}

describe("scope filters never enter a React Query key", () => {
  it("finds the query keys it is supposed to be checking", () => {
    // A guard on the guard: if the scan silently matched nothing — a moved
    // directory, a renamed API — this test would pass forever while checking
    // absolutely nothing.
    expect(queryKeyLines().length).toBeGreaterThan(10);
  });

  it.each(FORBIDDEN_IN_KEYS)("no queryKey mentions %s", (filter) => {
    const offenders = queryKeyLines().filter((hit) => hit.text.includes(filter));
    expect(
      offenders.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`),
    ).toEqual([]);
  });

  it("the dataset key is a constant with nothing filter-shaped in it", () => {
    // The one payload every scope filter is a transform over. If this ever
    // grows a segment, every filter above becomes a refetch at once.
    expect(DATASET_KEY).toEqual(["dataset"]);
  });
});
