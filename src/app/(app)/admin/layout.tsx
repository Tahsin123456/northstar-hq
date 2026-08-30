import { redirect } from "next/navigation";

import { AdminTabs } from "@/components/admin/admin-tabs";
import { getActor } from "@/server/auth/dal";

/**
 * The administration section.
 *
 * WHY THE CHECK IS HERE AND NOT IN THE PAGES
 * Every admin API route already calls `requirePermission`, so the data is safe
 * whatever renders. What that does not do is stop a Creative Director who typed
 * /admin from being shown a shell full of forbidden panels and error states —
 * which reads as a broken product rather than as a boundary. This layout wraps
 * every route in the section, so one check covers Overview, Users, the audit
 * log and YouTube, and no future page under /admin can be added without it.
 *
 * A redirect rather than a 404 or an empty page: the person is signed in and
 * this is simply not their area, so the honest response is to put them
 * somewhere they can work.
 *
 * EITHER CAPABILITY IS ENOUGH TO BELONG HERE
 * `users.manage` and `audit.view` are deliberately separate — the separation is
 * what lets somebody investigate an incident without also being handed the
 * ability to change who has access — and each unlocks a real tab. The sub-nav
 * and the Overview page then show only the panels the viewer's own permissions
 * cover, so holding one does not imply seeing the other's data.
 */
export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // `getActor` is memoised per request by React's `cache()`, so this costs
  // nothing beyond the lookup `(app)/layout.tsx` already made. It is repeated
  // rather than inherited because a layout may not assume an ancestor ran.
  const actor = await getActor();

  if (!actor) redirect("/login");

  /**
   * Admission is "holds any capability this section exposes", derived from the
   * tab list rather than hardcoded.
   *
   * Listing only `users.manage` and `audit.view` made `youtube.manage` a grant
   * that led nowhere: an admin could tick it for a Head of Shorts, and that
   * person would still be redirected away from the only page it unlocks. A
   * permission the product offers but cannot be used is worse than one it does
   * not offer at all.
   */
  const ADMIN_SECTION_PERMISSIONS = [
    "users.manage",
    "audit.view",
    "youtube.manage",
    // `payroll.view` is NOT on this list any more, and its absence is the whole
    // point: Payroll moved to /finance/payroll. Somebody granted payroll and
    // nothing else has no tab in this section, so admitting them here would land
    // them on an Overview with nothing on it. Their door is in Finance, and the
    // sidebar sends them there.
    //
    // `settings.manage` unlocks the Niches tab, where hit rate thresholds are
    // configured. Same rule, same reason: it is individually grantable, so an
    // admin can hand somebody the ability to set thresholds without making them
    // an administrator — and that person has to be able to reach the one screen
    // it unlocks.
    "settings.manage",
  ] as const;

  const mayAdminister = ADMIN_SECTION_PERMISSIONS.some((permission) =>
    actor.permissions.has(permission),
  );

  if (!mayAdminister) redirect("/");

  return (
    <div className="flex min-w-0 flex-col">
      <div className="border-b border-border">
        {/* Matches PageContainer's gutters so the tabs line up with the page
            heading directly beneath them. */}
        <div className="mx-auto w-full max-w-[1400px] px-4 sm:px-6 lg:px-8">
          <AdminTabs />
        </div>
      </div>

      {children}
    </div>
  );
}
