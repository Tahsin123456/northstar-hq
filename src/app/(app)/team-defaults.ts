import {
  DEFAULT_PERIOD_PRESET,
  DEFAULT_THRESHOLD,
  PERIOD_PRESETS,
} from "@/lib/analytics/constants";
import type { PeriodPresetId } from "@/lib/analytics/types";

/**
 * Team defaults for the period and threshold controls.
 *
 * These come from OrganizationSettings rather than the individual, because a
 * hit rate that means different things to two colleagues is not a metric.
 *
 * Extracted from the authenticated layout because TWO layouts seed a
 * `FiltersProvider` now — the app shell's Shorts provider and the /longform
 * segment's Long Form one — and the defaults have to be the same numbers in
 * both, or the two products would open on different periods for no reason
 * anybody chose.
 */
export async function loadTeamDefaults(): Promise<{
  threshold: number;
  periodPreset: PeriodPresetId;
}> {
  try {
    const { getCurrentOrgSettings } = await import("@/server/services/user-service");
    const settings = await getCurrentOrgSettings();
    return {
      threshold: settings.defaultThreshold,
      periodPreset: periodPresetForDays(settings.defaultPeriodDays),
    };
  } catch {
    // Only reached if the settings row cannot be read at all. The built-in
    // defaults keep the app renderable; they are never silently substituted for
    // an authorisation failure, because the actor check has already run in the
    // layout that calls this.
    return { threshold: DEFAULT_THRESHOLD, periodPreset: DEFAULT_PERIOD_PRESET };
  }
}

function periodPresetForDays(days: number): PeriodPresetId {
  const match = PERIOD_PRESETS.find((preset) => preset.days === days);
  return match ? match.id : DEFAULT_PERIOD_PRESET;
}
