import { handleMutation } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { markPeriodPaid, parsePeriodParams } from "@/server/services/payroll-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PeriodRouteContext = { params: Promise<{ year: string; month: string }> };

/**
 * POST /api/admin/payroll/periods/:year/:month/pay — record that a finalized
 * period has been paid out.
 *
 * Marks every still-pending record in the period, and the period itself, as
 * paid. It does not move any money — this system has no banking integration and
 * should not pretend otherwise. It records that a transfer happened elsewhere,
 * which is what makes "who has been paid and who has not" answerable.
 *
 * Refuses an open period: a payment is a claim about a specific set of figures,
 * and an unfrozen period's figures are still moving.
 *
 * No body. Marking individual people paid — the batched case — is a PATCH on
 * the record instead.
 */
export function POST(request: Request, context: PeriodRouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("payroll.manage");

    const params = await context.params;
    const { year, month } = parsePeriodParams(params.year, params.month);

    return { period: await markPeriodPaid(year, month, request) };
  });
}
