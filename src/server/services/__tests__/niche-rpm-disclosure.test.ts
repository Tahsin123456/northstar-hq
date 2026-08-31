import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may read what a niche is WORTH.
 *
 * The same trap the per-hit rate fell into, one step worse. `GET /api/niches`
 * and `GET /api/dataset` are both gated on `analytics.view` — held by every
 * employee role — and both ship the whole niche catalogue. So any field added
 * to `NicheDTO` is published to the entire team unless it is deliberately
 * withheld.
 *
 * What would be published here is not a configured constant. Where Northstar
 * operates a monetized channel in a niche, the rate shown is that channel's
 * reported revenue divided by the views it gained, and both numbers travel with
 * it — so anybody holding the DTO can multiply back to what the channel earned.
 * That is company revenue, which is why the gate is `finance.view` rather than
 * the `settings.manage` the hit payment uses, and why this needs a test of its
 * own: a disclosure whose only visible consumer is one card is one nobody
 * notices coming back.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 19).toString("base64");

const ORG_ID = "org_northstar";

const mocks = vi.hoisted(() => ({
  nicheFindMany: vi.fn(),
  trackedFindMany: vi.fn(),
  memberNicheFindMany: vi.fn(),
  can: vi.fn<(permission: string) => Promise<boolean>>(),
  /** The role `requireActor` reports. Drives the niche-scope narrowing. */
  role: "admin" as string,
}));

vi.mock("@/server/db", () => ({
  prisma: {
    niche: { findMany: mocks.nicheFindMany },
    trackedChannel: { findMany: mocks.trackedFindMany },
    // The real niche-scope module is used rather than stubbed, because the
    // narrowing it applies is one of the things this file asserts.
    memberNiche: { findMany: mocks.memberNicheFindMany },
  },
}));

vi.mock("@/server/auth/dal", () => ({
  actorCan: mocks.can,
  /*
   * `role` is part of the actor for a reason, not filler.
   *
   * The resolver narrows on the caller's VISIBLE niches as well as on
   * `finance.view`, and `resolveVisibleNicheIds` fails CLOSED on a role it does
   * not recognise — an actor with no role is treated as the least privileged,
   * niche-scoped one and is answered for no niches at all. An admin is not
   * niche-scoped, so the whole taxonomy resolves, which is what the disclosure
   * cases below are about. The scoping itself has its own test.
   */
  requireActor: async () => ({
    userId: "user_1",
    organizationId: ORG_ID,
    role: mocks.role,
  }),
}));

vi.mock("../user-service", () => ({
  getCurrentOrgId: async () => ORG_ID,
  getScope: async () => ({ organizationId: ORG_ID, userId: "user_1" }),
  /*
   * A DELIBERATELY NON-DEFAULT ENGAGED SHARE — 40%, not the 50% default.
   *
   * A mock carrying the default would pass whether the service read the column
   * or not, because `normalizeEngagedViewShare` answers 50% for an absent
   * value. 40% is only reachable by actually reading the row, which is what
   * makes the delivery assertion below mean something.
   */
  getCurrentOrgSettings: async () => ({
    baseCurrency: "USD",
    defaultPeriodDays: 30,
    engagedViewShareBasisPoints: 4_000,
  }),
  getOrgSettings: async () => ({
    baseCurrency: "USD",
    defaultPeriodDays: 30,
    engagedViewShareBasisPoints: 4_000,
  }),
}));

vi.mock("@/server/audit/audit-service", () => ({ recordAudit: vi.fn() }));

const { listNiches } = await import("../niche-service");

/** One niche priced by hand at $0.03–$0.06 per 1,000 views. */
function nicheRow() {
  return {
    id: "niche_gta",
    organizationId: ORG_ID,
    name: "GTA",
    slug: "gta",
    colorIndex: 0,
    kind: "production",
    hitThreshold: 1_000_000,
    hitWindowHours: 168,
    hitPaymentMinor: 500,
    rpmLowMinorPerMillion: 3_000,
    rpmHighMinorPerMillion: 6_000,
    rpmCurrency: "USD",
    sortOrder: 0,
    createdById: null,
    createdBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    _count: { channels: 1 },
  };
}

/** Grants exactly the listed permissions and refuses everything else. */
function granting(...permissions: readonly string[]) {
  mocks.can.mockImplementation(async (permission) => permissions.includes(permission));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "admin";
  mocks.memberNicheFindMany.mockResolvedValue([]);
  mocks.nicheFindMany.mockResolvedValue([nicheRow()]);
  // No channels Northstar owns, so nothing can be derived and the hand-entered
  // range is what a permitted reader sees. That is also the real state of this
  // deployment for every niche today.
  mocks.trackedFindMany.mockResolvedValue([]);
});

describe("niche economics on the catalogue", () => {
  it("is withheld entirely from somebody without finance access", async () => {
    granting("analytics.view", "settings.manage", "niches.manage");

    const [niche] = await listNiches();

    // `null`, not an object saying "unpriced". A reader who may not see this
    // gets no shape to inspect at all — the strip does not render for them, and
    // there is nothing on the wire to reconstruct a rate from.
    expect(niche.rpm).toBeNull();
    // Everything else about the niche is still theirs. Withholding the price
    // does not withhold the taxonomy an editor works inside.
    expect(niche.hitThreshold).toBe(1_000_000);
    expect(niche.name).toBe("GTA");
  });

  it("reaches somebody with finance access, carrying the entered range", async () => {
    granting("analytics.view", "finance.view");

    const [niche] = await listNiches();

    expect(niche.rpm).not.toBeNull();
    expect(niche.rpm?.source).toBe("manual");
    if (niche.rpm?.source !== "manual") return;
    expect(niche.rpm.range).toEqual({
      lowMinorPerMillion: 3_000,
      highMinorPerMillion: 6_000,
      currency: "USD",
    });
  });

  /**
   * =========================================================================
   * THE ENGAGED-VIEW SHARE TRAVELS WITH THE RATE, OR THE MONEY DOUBLES
   * =========================================================================
   *
   * The money is projected in the BROWSER. The share that scales it lives on
   * `OrganizationSettings`, whose DTO is read behind `settings.manage` and
   * lists its fields one by one — so a `finance.view` reader has no payload
   * that could carry it. That is the delivery gap, and this is the fix being
   * asserted: the value rides on the RPM resolution, which is already gated on
   * exactly the right permission, so the rate, its currency, its basis and the
   * share that scales it arrive as one object.
   *
   * IF THIS FIELD STOPPED ARRIVING, nothing would throw. The client would fall
   * back to the 50% default and every hand-entered money figure in an
   * organization that had chosen a different share would be silently wrong —
   * by exactly the ratio between the two. That is why the mock above is 40%
   * rather than the default: this assertion has to be able to fail.
   */
  it("delivers the organization's engaged-view share on the resolution itself", async () => {
    granting("analytics.view", "finance.view");

    const [niche] = await listNiches();

    expect(niche.rpm?.engagedViewShareBasisPoints).toBe(4_000);
  });

  /**
   * The gate is `finance.view`, not `settings.manage`.
   *
   * Asserted because the obvious wrong implementation is to reuse the
   * permission that already guards the hit payment on this same DTO — which
   * would pass a naive "is it withheld from an employee?" test while making the
   * only way to show a Head of Shorts what a niche is worth also hand them the
   * organization's sync cadence, lookback and base currency.
   */
  it("is bound to finance access and not to system settings", async () => {
    granting("settings.manage");
    const [withSettings] = await listNiches();
    expect(withSettings.rpm).toBeNull();

    granting("finance.view");
    const [withFinance] = await listNiches();
    expect(withFinance.rpm).not.toBeNull();

    expect(mocks.can).toHaveBeenCalledWith("finance.view");
  });

  /**
   * A withheld reader costs nothing to serve.
   *
   * The resolver has to read own channels, revenue days, snapshots and exchange
   * rates to answer this question. Doing that work and then discarding it would
   * put four extra queries on the one read every signed-in person makes, on
   * every page load, for a figure they are not allowed to see.
   */
  it("does not touch the tracker for a reader who may not see the answer", async () => {
    granting("analytics.view");

    await listNiches();

    expect(mocks.trackedFindMany).not.toHaveBeenCalled();
  });

  /**
   * An unpriced niche says so rather than reporting a rate of nothing.
   *
   * This is the state every niche on this deployment is in, so it is the state
   * most likely to be rendered — and the one where a `?? 0` somewhere upstream
   * would silently turn "nobody has said" into "this niche pays nothing".
   */
  it("reports an unpriced niche as unpriced, with a reason, and never as zero", async () => {
    granting("finance.view");
    mocks.nicheFindMany.mockResolvedValue([
      {
        ...nicheRow(),
        rpmLowMinorPerMillion: null,
        rpmHighMinorPerMillion: null,
        rpmCurrency: null,
      },
    ]);

    const [niche] = await listNiches();

    expect(niche.rpm?.source).toBe("none");
    if (niche.rpm?.source !== "none") return;
    expect(niche.rpm.reason).toBe("no_own_channel");
    // Nothing on the object is a number that could be mistaken for a rate.
    expect(JSON.stringify(niche.rpm)).not.toContain("rpmMinorPerMillion");
  });
});

/**
 * =========================================================================
 * TWO NARROWINGS, NOT ONE
 * =========================================================================
 *
 * `finance.view` answers "may this person see money at all". It does not answer
 * "which niches are theirs" — and it is individually grantable, which is the
 * entire argument for gating the read on it rather than on `settings.manage`.
 * So a niche-scoped editor granted `finance.view` is a combination somebody can
 * assemble, and without this narrowing they would receive, for every niche in
 * the organization, the names of Northstar's own channels in it, their
 * monetization state, and — the day snapshots exist — the revenue a derived
 * rate was divided out of.
 *
 * `listNiches` returns the whole taxonomy on purpose: an editor still needs the
 * labels to filter by. So the narrowing is applied to the ECONOMICS hanging off
 * those rows, and it is applied IN THE QUERY as well, because a filter applied
 * afterwards has already loaded the rows.
 */
describe("niche scope on top of finance access", () => {
  /** A niche-scoped role, assigned to one of the organization's two niches. */
  function signInAsScopedEditor(assignedNicheIds: readonly string[]): void {
    mocks.role = "short_form_editor";
    mocks.memberNicheFindMany.mockResolvedValue(
      assignedNicheIds.map((nicheId) => ({ nicheId })),
    );
  }

  beforeEach(() => {
    mocks.nicheFindMany.mockResolvedValue([
      nicheRow(),
      { ...nicheRow(), id: "niche_football", name: "Football", slug: "football" },
    ]);
  });

  it("answers only for the niches a scoped member is assigned to", async () => {
    granting("analytics.view", "finance.view");
    signInAsScopedEditor(["niche_gta"]);

    const niches = await listNiches();

    // Both labels are still theirs — they filter by them every day.
    expect(niches.map((niche) => niche.id)).toEqual(["niche_gta", "niche_football"]);
    // The economics are not. `null` is this DTO's single meaning of "withheld",
    // so the unassigned niche is indistinguishable from one seen by somebody
    // without finance access at all — no shape to inspect, no rate to infer.
    expect(niches[0].rpm).not.toBeNull();
    expect(niches[1].rpm).toBeNull();
  });

  /**
   * IN THE QUERY, NOT AFTER IT.
   *
   * Every other tracked-channel read in the app carries both narrowings in the
   * `where` clause — `dataset-service` states the rule outright — because
   * filtering afterwards means the rows were already loaded and the next caller
   * inherits nothing.
   */
  it("narrows the tracker read itself, not the answer afterwards", async () => {
    granting("analytics.view", "finance.view");
    signInAsScopedEditor(["niche_gta"]);

    await listNiches();

    expect(mocks.trackedFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.trackedFindMany.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG_ID,
      isActive: true,
      ownershipType: "own",
      niches: { some: { nicheId: { in: ["niche_gta"] } } },
    });
  });

  /**
   * FAIL CLOSED. A scoped member with no assignments sees no economics at all —
   * not everything. This is the shape of the classic bug: the moment an
   * assignment is deleted, the least privileged account becomes the most.
   */
  it("gives a scoped member with no assignments nothing", async () => {
    granting("analytics.view", "finance.view");
    signInAsScopedEditor([]);

    const niches = await listNiches();

    expect(niches).toHaveLength(2);
    expect(niches.every((niche) => niche.rpm === null)).toBe(true);
  });

  it("leaves a Head, who is not niche-scoped, seeing the whole taxonomy", async () => {
    granting("analytics.view", "finance.view");
    mocks.role = "head_of_shorts";

    const niches = await listNiches();

    expect(niches.every((niche) => niche.rpm !== null)).toBe(true);
    // No niche clause at all — a Head must keep seeing channels filed under no
    // niche, which an `in` list of every niche id would silently exclude.
    expect(mocks.trackedFindMany.mock.calls[0][0].where).not.toHaveProperty("niches");
  });
});
