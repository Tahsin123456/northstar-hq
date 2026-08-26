import { handle } from "@/server/http";
import { actorCan, requirePermission } from "@/server/auth/dal";
import { listEmployees } from "@/server/services/employee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/employees
 *
 * The Employees table: everyone in the caller's organization, with their role,
 * status, assigned niches and employment dates.
 *
 * TWO PERMISSIONS, TWO DIFFERENT JOBS
 * `users.manage` is what gets you the list at all — it is a person-by-person
 * account of who works here, which is the same class of information the Users
 * screen already shows. `payroll.view` is what adds the pay columns, and it is
 * resolved HERE, from the session, and passed down as a boolean.
 *
 * That split is the whole point. A caller cannot ask for the pay columns: there
 * is no query parameter, no header and no body to ask with. Without
 * `payroll.view` the service never selects `salaryMinor` from the database, and
 * the `pay` key is absent from every row rather than present and null — so the
 * response cannot leak a figure, or the existence of one, by its shape.
 */
export function GET() {
  return handle(async () => {
    await requirePermission("users.manage");

    // `actorCan` never throws: this is a widening, not a gate. The gate above
    // has already run.
    const includePay = await actorCan("payroll.view");

    return { employees: await listEmployees({ includePay }) };
  });
}
