import { redirect } from "next/navigation";

import { actorCan } from "@/server/auth/dal";
import { FinanceNav } from "./finance-nav";

/**
 * The Finance area.
 *
 * WHY THE GATE IS HERE AND NOT IN THE PAGE
 * `SidebarNav` already hides the Finance link from anyone without
 * `finance.view`, but that is an affordance, not a boundary — a bookmark, a
 * pasted link or a typed URL all bypass it. This layout is the server-side
 * check that actually holds for the render, and it wraps every page in the
 * segment at once, so a Finance page added later cannot be shipped ungated by
 * forgetting a line. The API routes hold the line for the data independently:
 * each one calls `requirePermission("finance.view")` of its own.
 *
 * A redirect rather than `notFound()`. Someone without the permission is a
 * colleague who followed a link, not an attacker probing for routes — and the
 * sidebar has already told them the area exists. Sending them somewhere they
 * can actually use beats a dead end.
 */
export const dynamic = "force-dynamic";

export default async function FinanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // `actorCan` never throws: an unauthenticated visitor has already been sent
  // to /login by the (app) layout above, so `false` here means "signed in,
  // wrong permission" and the dashboard is the right landing.
  if (!(await actorCan("finance.view"))) redirect("/");

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <FinanceNav />
      {children}
    </div>
  );
}
