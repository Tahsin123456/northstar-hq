import { redirect } from "next/navigation";

import { actorCan } from "@/server/auth/dal";

/**
 * The ledger half of Finance: overview, entries, settings.
 *
 * A route group rather than a folder, so these three keep the URLs they have
 * always had — `/finance`, `/finance/entries`, `/finance/settings` — while
 * sharing a gate their sibling `payroll` does not. That is the whole reason it
 * exists. The section layout above admits anyone holding `finance.view` OR
 * `payroll.view`, because payroll is grantable on its own; this one holds the
 * line that a payroll-only viewer never reads the company's revenue.
 *
 * The same server-side check the section layout used to make for the whole
 * segment, unchanged in effect for anybody who held `finance.view` before the
 * move. The API routes behind these screens each call
 * `requirePermission("finance.view")` regardless — this only avoids walking
 * somebody into a shell whose every request would 403.
 */
export const dynamic = "force-dynamic";

export default async function FinanceLedgerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // `actorCan` never throws: an unauthenticated visitor has already been sent
  // to /login above, so `false` here means "signed in, wrong permission".
  if (!(await actorCan("finance.view"))) {
    // Not the dashboard: somebody who landed here with only `payroll.view` came
    // to Finance for a reason and has a tab in it they can use.
    if (await actorCan("payroll.view")) redirect("/finance/payroll");
    redirect("/");
  }

  return children;
}
