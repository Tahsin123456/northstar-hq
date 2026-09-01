import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { FiltersProvider } from "@/components/providers/filters-provider";
import { FiltersUrlSync } from "@/components/providers/filters-url-sync";
import { SessionProvider } from "@/components/providers/session-provider";
import { getActor, toActorDTO } from "@/server/auth/dal";
import { needsSetup } from "@/server/services/auth-service";
import { loadTeamDefaults } from "./team-defaults";

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

// The period/threshold team defaults moved to `./team-defaults` so the
// /longform segment's own provider can seed the identical numbers.

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
