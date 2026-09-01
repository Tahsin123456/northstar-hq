import { LongformFiltersProvider } from "@/components/providers/longform-filters-provider";
import { loadTeamDefaults } from "../team-defaults";

/**
 * The Long Form segment.
 *
 * Everything under /longform runs inside its own filters provider over the
 * Long Form store and the Long Form dataset — see
 * `LongformFiltersProvider` for how it shadows the app shell's Shorts
 * provider. Authentication is the parent layout's job and has already run by
 * the time this renders.
 *
 * THERE IS DELIBERATELY NO `longs.view` PAGE GUARD HERE. The API is the
 * boundary: a shorts-role user who types /longform gets the ErrorState these
 * pages already render, because `/api/dataset?format=longform` refuses them —
 * exactly the mirror of what a longs-role user meets on a Shorts page. A
 * render-side redirect would be a second, weaker copy of that rule.
 */
export const dynamic = "force-dynamic";

export default async function LongformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The same team defaults the Shorts provider seeds, from the same loader:
  // the two products must open on the same period or the difference would
  // read as data.
  const defaults = await loadTeamDefaults();

  return (
    <LongformFiltersProvider
      defaultThreshold={defaults.threshold}
      defaultPeriod={{ preset: defaults.periodPreset }}
    >
      {children}
    </LongformFiltersProvider>
  );
}
