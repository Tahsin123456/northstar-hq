import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  finalizePeriod,
  finalizePeriodSchema,
  parsePeriodParams,
} from "@/server/services/payroll-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PeriodRouteContext = { params: Promise<{ year: string; month: string }> };

/**
 * POST /api/admin/payroll/periods/:year/:month/finalize — freeze a month.
 *
 * `payroll.manage`, not `payroll.view`: reading what the team is owed and
 * committing to it are different acts, and only the second one produces a
 * financial document.
 *
 * Safe to call twice. An already-finalized period comes back unchanged rather
 * than being recalculated, which is what protects any adjustment made since —
 * see `finalizePeriod`.
 *
 * Body: `{ force?: boolean }`. Without it, a period that has not ended yet is
 * refused: freezing a month while its Shorts are still gaining views records a
 * figure that was never the right one.
 */
export function POST(request: Request, context: PeriodRouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("payroll.manage");

    const params = await context.params;
    const { year, month } = parsePeriodParams(params.year, params.month);

    const parsed = finalizePeriodSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That finalize request is not valid.",
      );
    }

    // The Request goes to the service so the audit entry can carry request
    // context; the service decides what is worth recording, not this handler.
    return { period: await finalizePeriod(year, month, parsed.data, request) };
  });
}
