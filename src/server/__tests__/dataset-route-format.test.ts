import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * THE FORMAT BOUNDARY, TESTED AT THE BOUNDARY
 * =========================================================================
 *
 * Deploy C's central claim is that /api/dataset IS the format boundary: a
 * longs-role user loses the Shorts product because THIS handler refuses
 * `?format=shorts`, not because any page hides a link. So the tests run the
 * actual route handler — `requireFormat` wired into `GET`, with the real
 * role table underneath — and pin the three behaviours everything else
 * depends on:
 *
 *   • an admin with NO parameter gets shorts — the existing-clients-unchanged
 *     guarantee, which also catches the `searchParams.get() === null` trap:
 *     pass the null through raw and every parameterless client 403s;
 *   • a longs-role actor requesting `format=shorts` is FORBIDDEN (403), and
 *     `buildDataset` is never reached;
 *   • a longs-role actor with no parameter gets their own side (longform) —
 *     the one deliberate behaviour change for those roles.
 *
 * `requirePermission` and `buildDataset` are stubs; `requireFormat` and the
 * role table it reads are the real ones, so a role whose `contentScope`
 * leaks in permissions.ts changes these answers rather than being papered
 * over.
 */

const mocks = vi.hoisted(() => ({
  role: "admin" as string,
  buildDataset: vi.fn(),
  getExcludedVideos: vi.fn(),
  getHistoricalViews: vi.fn(),
}));

vi.mock("@/server/auth/dal", () => ({
  requirePermission: async () => ({
    userId: "user_1",
    organizationId: "org_1",
    role: mocks.role,
    permissions: new Set(["analytics.view"]),
  }),
}));

vi.mock("@/server/services/dataset-service", () => ({
  buildDataset: mocks.buildDataset,
  getExcludedVideos: mocks.getExcludedVideos,
}));

vi.mock("@/server/services/history-service", () => ({
  getHistoricalViews: mocks.getHistoricalViews,
}));

const { GET } = await import("@/app/api/dataset/route");
const { GET: GET_EXCLUDED } = await import("@/app/api/channels/[id]/excluded/route");
const { GET: GET_HISTORY } = await import("@/app/api/history/views-as-of/route");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildDataset.mockResolvedValue({ channels: [], niches: [] });
  mocks.getExcludedVideos.mockResolvedValue([]);
  mocks.getHistoricalViews.mockResolvedValue({ videos: [] });
});

describe("GET /api/dataset format enforcement", () => {
  it("defaults an admin with no parameter to shorts — existing clients unchanged", async () => {
    mocks.role = "admin";
    const response = await GET(new Request("http://localhost/api/dataset"));

    expect(response.status).toBe(200);
    expect(mocks.buildDataset).toHaveBeenCalledTimes(1);
    expect(mocks.buildDataset.mock.calls[0][0]).toMatchObject({ format: "shorts" });
  });

  it("refuses a longs-role actor asking for the Shorts product with 403, before any read", async () => {
    mocks.role = "head_of_longs";
    const response = await GET(
      new Request("http://localhost/api/dataset?format=shorts"),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    // The refusal must land before the dataset is assembled: a 403 whose
    // work was already done is a boundary in name only.
    expect(mocks.buildDataset).not.toHaveBeenCalled();
  });

  it("defaults a longs-role actor with no parameter to longform — their side of the operation", async () => {
    mocks.role = "head_of_longs";
    const response = await GET(new Request("http://localhost/api/dataset"));

    expect(response.status).toBe(200);
    expect(mocks.buildDataset.mock.calls[0][0]).toMatchObject({ format: "longform" });
  });

  it("hands an admin the Long Form dataset when they ask for it", async () => {
    mocks.role = "admin";
    const response = await GET(
      new Request("http://localhost/api/dataset?format=longform"),
    );

    expect(response.status).toBe(200);
    expect(mocks.buildDataset.mock.calls[0][0]).toMatchObject({ format: "longform" });
  });

  it("refuses a shorts-role actor asking for the Long Form product", async () => {
    mocks.role = "head_of_shorts";
    const response = await GET(
      new Request("http://localhost/api/dataset?format=longform"),
    );

    expect(response.status).toBe(403);
    expect(mocks.buildDataset).not.toHaveBeenCalled();
  });

  it("refuses a garbage format value rather than guessing", async () => {
    mocks.role = "admin";
    const response = await GET(
      new Request("http://localhost/api/dataset?format=widescreen"),
    );

    expect(response.status).toBe(403);
    expect(mocks.buildDataset).not.toHaveBeenCalled();
  });
});

describe("GET /api/channels/[id]/excluded format enforcement", () => {
  const context = { params: Promise.resolve({ id: "chan_1" }) };

  it("defaults to shorts and threads the format into the service", async () => {
    mocks.role = "admin";
    const response = await GET_EXCLUDED(
      new Request("http://localhost/api/channels/chan_1/excluded"),
      context,
    );

    expect(response.status).toBe(200);
    expect(mocks.getExcludedVideos).toHaveBeenCalledTimes(1);
    expect(mocks.getExcludedVideos.mock.calls[0][1]).toMatchObject({ format: "shorts" });
  });

  it("refuses the cross-format read with 403, same as the dataset", async () => {
    mocks.role = "head_of_longs";
    const response = await GET_EXCLUDED(
      new Request("http://localhost/api/channels/chan_1/excluded?format=shorts"),
      context,
    );

    expect(response.status).toBe(403);
    expect(mocks.getExcludedVideos).not.toHaveBeenCalled();
  });
});

describe("GET /api/history/views-as-of format enforcement", () => {
  /*
   * The reconstruction is per-video SHORTS data — org-wide titles-and-views
   * of the product the dataset route 403s a longs role. The pay-rate-DTO
   * lesson again: a UI that merely withholds the control while the API still
   * serves the figures is a boundary in name only.
   */
  const url = "http://localhost/api/history/views-as-of?asOfMs=1756600000000&windowDays=30";

  it("refuses a longs-role actor before any snapshot is read", async () => {
    mocks.role = "head_of_longs";
    const response = await GET_HISTORY(new Request(url));

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(mocks.getHistoricalViews).not.toHaveBeenCalled();
  });

  it("keeps serving admins and shorts roles exactly as before", async () => {
    mocks.role = "admin";
    expect((await GET_HISTORY(new Request(url))).status).toBe(200);

    mocks.role = "head_of_shorts";
    expect((await GET_HISTORY(new Request(url))).status).toBe(200);
    expect(mocks.getHistoricalViews).toHaveBeenCalledTimes(2);
  });
});
