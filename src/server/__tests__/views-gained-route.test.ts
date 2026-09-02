import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/niches/views-gained — the boundary, tested at the boundary.
 *
 * Same technique as `dataset-route-format.test.ts`: the service is a stub,
 * `requireFormat` and the role table it reads are real, so a role whose
 * `contentScope` drifts in permissions.ts changes these answers rather than
 * being papered over.
 */

const mocks = vi.hoisted(() => ({
  role: "admin" as string,
  permitted: true,
  getNicheViewsGained: vi.fn(),
}));

vi.mock("@/server/auth/dal", async (importOriginal) => {
  // The real errors module shapes the refusal; only the actor is stubbed.
  const { errors } = await import("@/server/errors");
  void importOriginal;
  return {
    requirePermission: async (permission: string) => {
      if (!mocks.permitted) throw errors.forbidden("view analytics");
      if (permission !== "analytics.view") {
        throw new Error(`unexpected permission asked for: ${permission}`);
      }
      return {
        userId: "user_1",
        organizationId: "org_1",
        role: mocks.role,
        permissions: new Set([permission]),
      };
    },
  };
});

vi.mock("@/server/services/niche-views-gained-service", () => ({
  getNicheViewsGained: mocks.getNicheViewsGained,
}));

const { GET } = await import("@/app/api/niches/views-gained/route");

const DAY_MS = 86_400_000;
const START_MS = Date.UTC(2026, 7, 1);
const END_MS = Date.UTC(2026, 7, 31);

function url(params: Record<string, string>) {
  const search = new URLSearchParams(params);
  return `http://localhost/api/niches/views-gained?${search.toString()}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "admin";
  mocks.permitted = true;
  mocks.getNicheViewsGained.mockResolvedValue({
    requestedStartMs: START_MS,
    endMs: END_MS,
    measuredFromMs: START_MS,
    earliestSnapshotMs: START_MS,
    niches: [],
  });
});

describe("GET /api/niches/views-gained", () => {
  it("requires analytics.view, before any measurement", async () => {
    mocks.permitted = false;
    const response = await GET(
      new Request(url({ format: "shorts", startMs: String(START_MS), endMs: String(END_MS) })),
    );

    expect(response.status).toBe(403);
    expect(mocks.getNicheViewsGained).not.toHaveBeenCalled();
  });

  it("serves the requested format and threads the validated window through", async () => {
    const response = await GET(
      new Request(url({ format: "shorts", startMs: String(START_MS), endMs: String(END_MS) })),
    );

    expect(response.status).toBe(200);
    expect(mocks.getNicheViewsGained).toHaveBeenCalledWith({
      format: "shorts",
      startMs: START_MS,
      endMs: END_MS,
    });
  });

  it("refuses a longs-role actor asking for the Shorts figures with 403", async () => {
    mocks.role = "head_of_longs";
    const response = await GET(
      new Request(url({ format: "shorts", startMs: String(START_MS), endMs: String(END_MS) })),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(mocks.getNicheViewsGained).not.toHaveBeenCalled();
  });

  it("refuses a shorts-role actor asking for the Long Form figures", async () => {
    mocks.role = "head_of_shorts";
    const response = await GET(
      new Request(url({ format: "longform", startMs: String(START_MS), endMs: String(END_MS) })),
    );

    expect(response.status).toBe(403);
    expect(mocks.getNicheViewsGained).not.toHaveBeenCalled();
  });

  it("defaults a caller who names no format to their role's own side", async () => {
    mocks.role = "head_of_longs";
    const response = await GET(
      new Request(url({ startMs: String(START_MS), endMs: String(END_MS) })),
    );

    expect(response.status).toBe(200);
    expect(mocks.getNicheViewsGained.mock.calls[0][0]).toMatchObject({ format: "longform" });
  });

  it.each([
    ["a missing start", { format: "shorts", endMs: String(END_MS) }],
    ["a non-numeric end", { format: "shorts", startMs: String(START_MS), endMs: "soon" }],
    [
      "an inverted window",
      { format: "shorts", startMs: String(END_MS), endMs: String(START_MS) },
    ],
    [
      "an empty window",
      { format: "shorts", startMs: String(START_MS), endMs: String(START_MS) },
    ],
    [
      "a span over ten years",
      {
        format: "shorts",
        startMs: String(START_MS),
        endMs: String(START_MS + 3651 * DAY_MS),
      },
    ],
  ])("refuses %s as invalid input", async (_case, params) => {
    const response = await GET(new Request(url(params)));

    expect(response.status).toBe(400);
    expect(mocks.getNicheViewsGained).not.toHaveBeenCalled();
  });
});
