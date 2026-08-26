import { beforeAll, describe, expect, it } from "vitest";

/**
 * Niche scoping: the decision, not the query.
 *
 * `getVisibleNicheIds()` is two things bolted together — one indexed read of
 * MemberNiche, and one rule about what the rows mean. The read is Prisma's
 * problem. The rule is where a mistake is silent and total: get it wrong in one
 * direction and an editor sees the whole company's channels, get it wrong in
 * the other and a Head's dashboard empties out. So the rule is a pure function,
 * and this file exercises every branch of it without a database.
 *
 * The case that matters most is the empty one. "No assignments" must mean "no
 * channels", never "no restriction" — an unassigned editor is the exact state
 * the system passes through every time somebody is hired, and it must fail
 * closed.
 */

// `niche-scope` reaches the DAL, which reads SESSION_SECRET through auth-env at
// import time. Set it before the dynamic import below, as the credential tests
// do — nothing here touches a session, but the module graph still has to load.
process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

type NicheScopeModule = typeof import("@/server/auth/niche-scope");

let nicheScope: NicheScopeModule;

beforeAll(async () => {
  nicheScope = await import("@/server/auth/niche-scope");
});

/** Roles whose job is comparing across the whole operation. */
const UNSCOPED_ROLES = ["admin", "head_of_shorts", "head_of_longs"] as const;

/** Roles that see only what they are assigned to. */
const SCOPED_ROLES = [
  "short_form_editor",
  "long_form_editor",
  "short_form_clip_producer",
] as const;

describe("resolveVisibleNicheIds", () => {
  it("returns null — see everything — for roles that are not niche-scoped", () => {
    for (const role of UNSCOPED_ROLES) {
      expect(nicheScope.resolveVisibleNicheIds(role, [])).toBeNull();
      expect(nicheScope.resolveVisibleNicheIds(role, ["gta"])).toBeNull();
    }
  });

  it("ignores stray assignments on an unscoped role", () => {
    // Somebody promoted from editor to Head keeps their old MemberNiche rows.
    // Those rows must not narrow them: the role decides, the assignments only
    // supply the list when the role asks for one.
    expect(nicheScope.resolveVisibleNicheIds("head_of_shorts", ["gta", "minecraft"])).toBeNull();
  });

  it("returns exactly the assigned niches for a niche-scoped role", () => {
    for (const role of SCOPED_ROLES) {
      expect(nicheScope.resolveVisibleNicheIds(role, ["gta", "asmr"])).toEqual(["asmr", "gta"]);
    }
  });

  it("fails closed: a niche-scoped member with no assignments sees nothing", () => {
    for (const role of SCOPED_ROLES) {
      const visible = nicheScope.resolveVisibleNicheIds(role, []);
      // An empty array, emphatically not null. The two are different answers —
      // "nothing" and "everything" — and collapsing them is the bug this
      // assertion exists to prevent.
      expect(visible).toEqual([]);
      expect(visible).not.toBeNull();
    }
  });

  it("deduplicates and orders the result", () => {
    // Stable output: it feeds an `in` clause and a memoised value, and the same
    // membership must not produce a differently shaped query per request.
    expect(nicheScope.resolveVisibleNicheIds("short_form_editor", ["b", "a", "b"])).toEqual([
      "a",
      "b",
    ]);
  });

  it("treats a retired role as the current role it maps to", () => {
    // `channel_director` resolves to short_form_editor, which is niche-scoped —
    // so an account still carrying the old string is scoped, not exempt.
    expect(nicheScope.resolveVisibleNicheIds("channel_director", ["gta"])).toEqual(["gta"]);
  });

  it("fails closed on an unrecognised role string", () => {
    // A typo, a downgrade, a hand-edited row: `roleDefinition` falls back to the
    // least-privileged role, which is niche-scoped. The worst case is somebody
    // seeing too little and saying so.
    expect(nicheScope.resolveVisibleNicheIds("wat", [])).toEqual([]);
    expect(nicheScope.resolveVisibleNicheIds("wat", ["gta"])).toEqual(["gta"]);
  });
});

describe("trackedChannelNicheFilter", () => {
  it("adds nothing to the query when the caller sees everything", () => {
    // An empty fragment, so spreading it into a `where` leaves the surrounding
    // organization filter exactly as it was.
    expect(nicheScope.trackedChannelNicheFilter(null)).toEqual({});
  });

  it("matches no rows when the caller has no assignments", () => {
    const filter = nicheScope.trackedChannelNicheFilter([]);
    // `id: { in: [] }` is Prisma's "matches nothing". The assertion is on the
    // shape rather than on a database result because the point is that the
    // fail-closed branch is reached at all.
    expect(filter).toEqual({ id: { in: [] } });
  });

  it("narrows to the assigned niches", () => {
    expect(nicheScope.trackedChannelNicheFilter(["gta", "asmr"])).toEqual({
      niches: { some: { nicheId: { in: ["gta", "asmr"] } } },
    });
  });
});
