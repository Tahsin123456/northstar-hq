import { redirect } from "next/navigation";

import { getActor } from "@/server/auth/dal";
import { FinanceNav } from "./finance-nav";

/**
 * The Finance area.
 *
 * WHY THE GATE IS HERE AND NOT IN THE PAGE
 * `SidebarNav` already hides the Finance link from anyone who holds none of the
 * capabilities below, but that is an affordance, not a boundary — a bookmark, a
 * pasted link or a typed URL all bypass it. This layout is the server-side
 * check that actually holds for the render, and it wraps every page in the
 * segment at once, so a Finance page added later cannot be shipped ungated by
 * forgetting a line. The API routes hold the line for the data independently:
 * each one calls `requirePermission` of its own.
 *
 * ADMISSION IS "HOLDS ANY CAPABILITY THIS SECTION EXPOSES", NOT `finance.view`
 * Payroll moved in here, and it is NOT finance: `payroll.view` is individually
 * grantable, so somebody can hold it with no finance access at all. Gating the
 * whole segment on `finance.view` would have taken payroll away from exactly
 * that person — a permission change smuggled in by a file move, which this
 * round is explicitly not doing. The narrower gates live one level down:
 * `(ledger)/layout.tsx` requires `finance.view` for the ledger screens, and
 * `payroll/layout.tsx` requires `payroll.view` for payroll. Somebody with only
 * one of the two reaches only their own half, exactly as before the move.
 *
 * A redirect rather than `notFound()`. Someone without the permission is a
 * colleague who followed a link, not an attacker probing for routes — and the
 * sidebar has already told them the area exists. Sending them somewhere they
 * can actually use beats a dead end.
 */
export const dynamic = "force-dynamic";

/**
 * Every capability that unlocks something under /finance.
 *
 * Derived-from rather than hardcoded in the same spirit as the admin section:
 * a tab added here without its permission on this list is a grant that leads
 * nowhere, and one removed from the list is a page nobody can open.
 */
const FINANCE_SECTION_PERMISSIONS = ["finance.view", "payroll.view"] as const;

export default async function FinanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // `getActor` is memoised per request by React's `cache()`, so this costs
  // nothing beyond the lookup `(app)/layout.tsx` already made. It is repeated
  // rather than inherited because a layout may not assume an ancestor ran.
  const actor = await getActor();

  if (!actor) redirect("/login");

  const mayEnter = FINANCE_SECTION_PERMISSIONS.some((permission) =>
    actor.permissions.has(permission),
  );

  // Signed in, wrong permissions: the dashboard is the right landing.
  if (!mayEnter) redirect("/");

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <FinanceNav />
      {children}
    </div>
  );
}
