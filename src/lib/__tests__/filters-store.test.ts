import { beforeEach, describe, expect, it } from "vitest";

/**
 * The suite runs on the `node` environment, so the handful of browser APIs the
 * store reads are stubbed here rather than pulling in a full DOM. Only what the
 * store actually touches is implemented: storage, `location.search` and
 * `history.replaceState`.
 */
const storage = new Map<string, string>();
const location = { pathname: "/", search: "" };

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
    },
    location,
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        const [pathname, search = ""] = url.split("?");
        location.pathname = pathname;
        location.search = search ? `?${search}` : "";
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

const {
  clearThresholdOverride,
  getFiltersSnapshot,
  invalidateFiltersFromUrl,
  setNicheFilter,
  setPeriodPreset,
  setThreshold,
} = await import("@/lib/filters-store");

/**
 * Threshold overrides are scoped to a niche.
 *
 * The failure this pins down is subtle and was found by hand: with an override
 * active in one niche, selecting another niche kept the override, so the app
 * silently stopped honouring the newly selected niche's own threshold. The
 * numbers stayed internally consistent, which is exactly why it survived a
 * casual look — the header showed a hit bar the selected niche had not asked
 * for.
 */

const GTA = "niche_gta";
const RDR = "niche_rdr";

function setUrl(url: string): void {
  window.history.replaceState(null, "", url);
  invalidateFiltersFromUrl();
}

beforeEach(() => {
  storage.clear();
  setUrl("/");
});

describe("threshold override scoping", () => {
  it("keeps an override while only the period changes", () => {
    setNicheFilter(RDR);
    setThreshold(2_000_000);
    setPeriodPreset("30d");

    expect(getFiltersSnapshot().thresholdOverride).toBe(2_000_000);
    expect(getFiltersSnapshot().niche).toBe(RDR);
  });

  it("drops the override when the niche changes", () => {
    setNicheFilter(RDR);
    setThreshold(2_000_000);
    setNicheFilter(GTA);

    // Null means "follow the new niche's default", which is the whole point of
    // configuring a per-niche threshold.
    expect(getFiltersSnapshot().thresholdOverride).toBeNull();
    expect(getFiltersSnapshot().niche).toBe(GTA);
  });

  it("keeps the override when the same niche is re-selected", () => {
    setNicheFilter(RDR);
    setThreshold(2_000_000);
    setNicheFilter(RDR);

    expect(getFiltersSnapshot().thresholdOverride).toBe(2_000_000);
  });

  it("drops a stored override when a link lands on a different niche", () => {
    setNicheFilter(RDR);
    setThreshold(2_000_000);

    // A `?niche=` deep link carries no threshold, so the stored one must not be
    // resurrected against a niche it was never chosen for.
    setUrl(`/?niche=${GTA}`);

    expect(getFiltersSnapshot().niche).toBe(GTA);
    expect(getFiltersSnapshot().thresholdOverride).toBeNull();
  });

  it("honours an explicit threshold in a shared link", () => {
    setNicheFilter(RDR);

    // The sender deliberately chose this bar; the link should reproduce it.
    setUrl(`/?niche=${GTA}&threshold=2000000`);

    expect(getFiltersSnapshot().niche).toBe(GTA);
    expect(getFiltersSnapshot().thresholdOverride).toBe(2_000_000);
  });

  it("keeps a stored override when the link names the same niche", () => {
    setNicheFilter(RDR);
    setThreshold(2_000_000);

    setUrl(`/?niche=${RDR}&period=30d`);

    expect(getFiltersSnapshot().thresholdOverride).toBe(2_000_000);
  });

  it("clears the override on request without touching the niche", () => {
    setNicheFilter(RDR);
    setThreshold(2_000_000);
    clearThresholdOverride();

    expect(getFiltersSnapshot().thresholdOverride).toBeNull();
    expect(getFiltersSnapshot().niche).toBe(RDR);
  });
});
