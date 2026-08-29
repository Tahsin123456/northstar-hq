/**
 * A tiny interpreter for the subset of Prisma `where` the research service
 * builds — applied for real against fixture rows.
 *
 * WHY THIS EXISTS RATHER THAN AN ASSERTION ON THE `where` OBJECT
 * The claim under test is "that row does not come back". Asserting on the shape
 * of a `where` would pass just as happily for a filter naming the wrong column,
 * the wrong relation, or the right relation with the organization dropped out of
 * it — every one of which is a leak that renders green. So the fakes apply the
 * filter and the tests read the rows, which is the same thing the database will
 * do in production.
 *
 * It understands exactly what the service emits and nothing more:
 *   • `AND` / `OR` / `NOT`, nested;
 *   • scalar equality, including `null` as a real condition (an orphaned row);
 *   • `{ in }`, `{ not }`, and date ranges `{ gte, lte }`;
 *   • to-one relations (`channel: { … }`) by recursing into the nested row;
 *   • to-many relations (`trackedBy: { some: { … } }`) by testing the array.
 *
 * Anything else is a filter this code does not write yet, and it throws rather
 * than guessing — a silent "no" would fail the test for the wrong reason, and a
 * silent "yes" would hide the very leak these files exist to catch.
 */

export type WhereRow = Record<string, unknown>;

function toList(condition: unknown): unknown[] {
  return Array.isArray(condition) ? condition : [condition];
}

export function matchesWhere(row: unknown, where: unknown): boolean {
  if (where === undefined || where === null) return true;
  if (typeof where !== "object") return false;
  // A relation filter against a row that is not there — a note whose `channel`
  // is null, say. Prisma answers "no", and so does this.
  if (row === null || row === undefined || typeof row !== "object") return false;

  const candidate = row as WhereRow;

  for (const [key, condition] of Object.entries(where as Record<string, unknown>)) {
    // `undefined` is "no condition", which is exactly how an admin's empty
    // author filter has to behave: spreading `{}` leaves the key unset and
    // every row matches.
    if (condition === undefined) continue;

    if (key === "AND") {
      if (!toList(condition).every((clause) => matchesWhere(candidate, clause))) return false;
      continue;
    }
    if (key === "OR") {
      if (!toList(condition).some((clause) => matchesWhere(candidate, clause))) return false;
      continue;
    }
    if (key === "NOT") {
      if (toList(condition).some((clause) => matchesWhere(candidate, clause))) return false;
      continue;
    }

    if (!matchesField(candidate[key], condition)) return false;
  }

  return true;
}

function matchesField(value: unknown, condition: unknown): boolean {
  // Scalar equality. `null` is a condition, not an absence.
  if (condition === null || typeof condition !== "object") return value === condition;

  const filter = condition as Record<string, unknown>;

  if (Array.isArray(value)) {
    if ("some" in filter) {
      return value.some((entry) => matchesWhere(entry, filter.some));
    }
    if ("every" in filter) {
      return value.every((entry) => matchesWhere(entry, filter.every));
    }
    if ("none" in filter) {
      return !value.some((entry) => matchesWhere(entry, filter.none));
    }
    throw new Error(
      `prisma-where: a to-many relation needs some/every/none, got ${JSON.stringify(filter)}`,
    );
  }

  if ("in" in filter) {
    return Array.isArray(filter.in) && filter.in.includes(value);
  }
  if ("notIn" in filter) {
    return Array.isArray(filter.notIn) && !filter.notIn.includes(value);
  }
  if ("not" in filter) {
    return !matchesField(value, filter.not);
  }

  if ("gte" in filter || "lte" in filter || "gt" in filter || "lt" in filter) {
    const actual = toMillis(value);
    if (actual === null) return false;
    if ("gte" in filter && actual < requireMillis(filter.gte)) return false;
    if ("gt" in filter && actual <= requireMillis(filter.gt)) return false;
    if ("lte" in filter && actual > requireMillis(filter.lte)) return false;
    if ("lt" in filter && actual >= requireMillis(filter.lt)) return false;
    return true;
  }

  // Everything left is a to-one relation: the nested object is itself a where.
  return matchesWhere(value, filter);
}

function toMillis(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return null;
}

function requireMillis(value: unknown): number {
  const millis = toMillis(value);
  if (millis === null) {
    throw new Error(`prisma-where: not a comparable value: ${JSON.stringify(value)}`);
  }
  return millis;
}
