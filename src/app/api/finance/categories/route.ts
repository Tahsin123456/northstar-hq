import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  createCategory,
  financeCategoryCreateSchema,
  listCategories,
} from "@/server/services/finance-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/finance/categories
 *
 * Archived categories are included. They are how historical entries keep their
 * label, so the client needs them to render the table even though it will not
 * offer them on the entry form.
 */
export function GET() {
  return handle(async () => {
    // A category list is the shape of the company's spending — "Legal",
    // "Contractor payouts" — so it sits behind the finance wall rather than
    // being ordinary taxonomy like niches.
    await requirePermission("finance.view");

    return { categories: await listCategories() };
  });
}

/** POST /api/finance/categories — add a revenue or expense category. */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    await requirePermission("finance.manage");

    const parsed = financeCategoryCreateSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That category is not valid.",
      );
    }

    return { category: await createCategory(parsed.data, request) };
  });
}
