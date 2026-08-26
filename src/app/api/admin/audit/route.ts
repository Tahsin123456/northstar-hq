import { handle } from "@/server/http";
import { actorCan, requirePermission } from "@/server/auth/dal";
import { listAuditEvents } from "@/server/audit/audit-service";
import { getCurrentOrgId } from "@/server/services/user-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Guards against a query string turning into a pathological `skip`/`take`. */
function readInt(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Filters are free text on their way into a `where`, so they are bounded here.
 * Prisma parameterises the value, so length is the only thing worth capping —
 * an unbounded string would just be a slower scan for no result.
 */
function readFilter(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 64) : undefined;
}

/**
 * GET /api/admin/audit — the audit trail, newest first.
 *
 * `audit.view` rather than `users.manage`: reading the log is its own
 * capability, and the separation is what lets somebody investigate an incident
 * without also being handed the ability to change who has access.
 *
 * TWO PERMISSIONS, BECAUSE THE LOG CARRIES TWO KINDS OF THING. `audit.view`
 * gets the entries. The amounts an `employee.pay_updated` entry carries in its
 * metadata are payroll data that happens to live in the audit table, and they
 * need `payroll.view` as well — because `audit.view` is grantable on its own,
 * so without this second check granting somebody the log to investigate an
 * incident would hand them every salary change in the company as a side effect.
 *
 * The flag is resolved from the SESSION, here, and there is deliberately no
 * query parameter for it: a flag the caller can set is a flag the caller can
 * grant themselves.
 *
 * The organization comes from the session and is passed explicitly, so there is
 * no code path here that could list another workspace's events.
 */
export function GET(request: Request) {
  return handle(async () => {
    await requirePermission("audit.view");

    const includeSensitiveMetadata = await actorCan("payroll.view");
    const organizationId = await getCurrentOrgId();
    const params = new URL(request.url).searchParams;

    // `limit` and `offset` are clamped inside listAuditEvents, so a nonsense
    // value degrades to a sane page rather than a 400 the UI has to handle.
    return listAuditEvents({
      organizationId,
      includeSensitiveMetadata,
      limit: readInt(params.get("limit")),
      offset: readInt(params.get("offset")),
      action: readFilter(params.get("action")),
      actionPrefix: readFilter(params.get("actionPrefix")),
      actorUserId: readFilter(params.get("actorUserId")),
    });
  });
}
