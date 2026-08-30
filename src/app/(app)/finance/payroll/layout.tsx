import { redirect } from "next/navigation";

import { actorCan } from "@/server/auth/dal";

/**
 * Payroll, inside Finance but not gated by it.
 *
 * The screens moved here from `/admin/payroll`; the permission did not move
 * with them and must not. `payroll.view` is separate from `finance.view`
 * because the two leak differently — company revenue is commercially
 * sensitive, an individual's salary is personal — and somebody trusted with one
 * is not thereby trusted with the other. So an accountant with finance access
 * still cannot open this, and somebody granted payroll alone still can.
 *
 * It covers `/finance/payroll` and `/finance/payroll/history` in one check,
 * which is what the Admin section layout was doing for these pages before.
 * `/api/admin/payroll*` calls `requirePermission("payroll.view")` for the data
 * either way — this is the affordance, not the boundary.
 */
export const dynamic = "force-dynamic";

export default async function PayrollLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await actorCan("payroll.view"))) {
    // Somebody with finance access but no payroll access has somewhere useful
    // to be one tab away; anybody else goes to the dashboard.
    if (await actorCan("finance.view")) redirect("/finance");
    redirect("/");
  }

  return children;
}
