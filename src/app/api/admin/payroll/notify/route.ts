import { z } from "zod";
import { requirePermission } from "@/server/auth/dal";
import { errors } from "@/server/errors";
import { handleMutation, readJson } from "@/server/http";
import { getScope } from "@/server/services/user-service";
import { periodContaining, previousPeriod } from "@/lib/payroll/payroll-engine";
import {
  sendNotificationTest,
  sendPayrollNotificationForMonth,
} from "@/server/services/notification-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ===========================================================================
 * POST /api/admin/payroll/notify — send a payroll summary by hand
 * ===========================================================================
 *
 * Two jobs, one endpoint, because they are the same question asked before and
 * after payday: "does this work?" and "it did not arrive, send it again".
 *
 *   • `test: true`   — a short message proving the bot, the token and the chat
 *                      id are wired together. Sends no payroll figures at all,
 *                      which is what makes it safe to press on a Tuesday.
 *   • otherwise      — the real summary for a finalized month.
 *
 * WHY `payroll.manage` AND NOT `payroll.view`
 * This does not read a figure to the caller; it BROADCASTS every colleague's
 * pay to a chat. That is a payroll operation, and `payroll.manage` is the
 * permission that covers operations. It is admin-only in practice: it is
 * deliberately excluded from the individually grantable list in
 * `src/lib/auth/permissions.ts`, so widening someone into it means giving them
 * the Admin role — a considered act rather than a stray checkbox.
 *
 * WHY `force` EXISTS
 * The duplicate protection stops a *job* from announcing the same month twice.
 * An admin re-sending after the chat was reconfigured, or after the bot was
 * re-added, is not a duplicate — it is the fix. `force` is the difference
 * between the two, and only a human request can set it.
 */

const notifySchema = z
  .object({
    /**
     * Which month to announce. Omitted means the period the scheduled job
     * would have handled — the one that just ended — because "the cron did not
     * fire, send it now" is the commonest reason to be here.
     */
    year: z.number().int().min(2000).max(2100).optional(),
    month: z.number().int().min(1).max(12).optional(),
    /** Re-send a summary already marked sent. */
    force: z.boolean().optional(),
    /** Send a test message instead, with no payroll figures in it. */
    test: z.boolean().optional(),
  })
  .strict()
  .refine((body) => (body.year === undefined) === (body.month === undefined), {
    message: "Give both a year and a month, or neither.",
  });

export function POST(request: Request) {
  return handleMutation(request, async () => {
    // First statement, before anything is read or parsed.
    const actor = await requirePermission("payroll.manage");

    // Scope comes from the session, never from the body. A year and a month are
    // safe to accept from a caller; an organization id would not be.
    const { organizationId } = await getScope();

    const parsed = notifySchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That notification request is not valid.",
      );
    }

    const actorLabel = actor.name ?? actor.email;

    if (parsed.data.test === true) {
      return {
        attempt: await sendNotificationTest({
          organizationId,
          actorUserId: actor.userId,
          actorLabel,
          request,
        }),
      };
    }

    // The month that just ended, on the same definition the cron uses, so a
    // manual re-send and the scheduled run cannot disagree about which period
    // "last month" means.
    const fallback = previousPeriod(periodContaining(Date.now()));
    const year = parsed.data.year ?? fallback.year;
    const month = parsed.data.month ?? fallback.month;

    return {
      attempt: await sendPayrollNotificationForMonth({
        organizationId,
        year,
        month,
        actorUserId: actor.userId,
        actorLabel,
        force: parsed.data.force ?? false,
        request,
      }),
    };
  });
}
