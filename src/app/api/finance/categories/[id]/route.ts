import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  archiveCategory,
  financeCategoryUpdateSchema,
  renameCategory,
} from "@/server/services/finance-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PATCH /api/finance/categories/:id — rename and/or archive.
 *
 * The two operations are applied separately, and each writes its own audit
 * entry, because they are genuinely different events: "Marketing was renamed to
 * Growth" and "Growth was archived" both need to be findable in the log, and
 * collapsing them into one record would lose whichever the reader was looking
 * for.
 */
export function PATCH(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("finance.manage");

    const { id } = await context.params;
    const parsed = financeCategoryUpdateSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That update is not valid.",
      );
    }

    const { name, isArchived } = parsed.data;

    // Rename first when both arrive: archiving is the state the caller wants
    // the category left in, so it goes last and its result is the response.
    if (isArchived !== undefined) {
      if (name !== undefined) await renameCategory(id, name, request);
      return { category: await archiveCategory(id, isArchived, request) };
    }

    if (name === undefined) {
      throw errors.invalidInput("Nothing to change — send a name or an archived flag.");
    }
    return { category: await renameCategory(id, name, request) };
  });
}
