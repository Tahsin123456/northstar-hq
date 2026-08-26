import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { FiltersProvider } from "@/components/providers/filters-provider";
import { FiltersUrlSync } from "@/components/providers/filters-url-sync";
import { SessionProvider } from "@/components/providers/session-provider";
import { getActor, toActorDTO } from "@/server/auth/dal";
import { needsSetup } from "@/server/services/auth-service";
import {
  DEFAULT_PERIOD_PRESET,
  DEFAULT_THRESHOLD,
  PERIOD_PRESETS,
} from "@/lib/analytics/constants";
import type { PeriodPresetId } from "@/lib/analytics/types";

/**
 * The authenticated half of the application.
 *
 * Everything inside this group requires a session, and the check happens HERE
 * on the server rather than in a client component. `src/proxy.ts` already
 * redirects a cookie-less browser, but it cannot see whether the session was
 * revoked or the account deactivated — so this is the gate that actually holds
 * for page renders, and the API's own DAL is the gate that holds for data.
 *
 * Reading the actor here also means the shell can render the person's name and
 * role, and hide navigation they have no permission for, without a round trip
 * on first paint.
 */
export const dynamic = "force-dynamic";

/**
 * Team defaults for the period and threshold controls.
 *
 * These now come from OrganizationSettings rather than the individual, because
 * a hit rate that means different things to two colleagues is not a metric.
 */
async function loadTeamDefaults(): Promise<{
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
    // an authorisation failure, because the actor check above has already run.
    return { threshold: DEFAULT_THRESHOLD, periodPreset: DEFAULT_PERIOD_PRESET };
  }
}

function periodPresetForDays(days: number): PeriodPresetId {
  const match = PERIOD_PRESETS.find((preset) => preset.days === days);
  return match ? match.id : DEFAULT_PERIOD_PRESET;
}

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const actor = await getActor();

  if (!actor) {
    // A fresh deployment has nobody to sign in as yet; send them to claim the
    // first admin account rather than to a login form that cannot succeed.
    if (await needsSetup()) redirect("/setup");
    redirect("/login");
  }

  const defaults = await loadTeamDefaults();

  return (
    <SessionProvider user={toActorDTO(actor)}>
      <FiltersProvider
        defaultThreshold={defaults.threshold}
        defaultPeriod={{ preset: defaults.periodPreset }}
      >
        <FiltersUrlSync />
        <AppShell>{children}</AppShell>
      </FiltersProvider>
    </SessionProvider>
  );
}
