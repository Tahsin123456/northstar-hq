import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  exchangeRateUpsertSchema,
  listExchangeRates,
  upsertExchangeRates,
} from "@/server/services/finance-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/finance/rates
 *
 * Behind `finance.view` rather than open to everyone: the set of currencies a
 * company converts, and at what rates, is commercial information in its own
 * right — and this is also how the entry form learns which foreign currencies
 * it may offer at all.
 */
export function GET() {
  return handle(async () => {
    await requirePermission("finance.view");

    return { rates: await listExchangeRates() };
  });
}

/**
 * PUT /api/finance/rates — set one rate or the whole table.
 *
 * Changing a rate deliberately does NOT touch a single existing entry. Every
 * entry stored the rate it was converted at, so historical totals stay exactly
 * as they were reported; the new rate applies from the next entry onwards.
 */
export function PUT(request: Request) {
  return handleMutation(request, async () => {
    // A rate decides what every future foreign-currency entry is worth in the
    // reporting currency, so setting one is a finance write, not a setting.
    await requirePermission("finance.manage");

    const parsed = exchangeRateUpsertSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That exchange rate is not valid.",
      );
    }

    return { rates: await upsertExchangeRates(parsed.data, request) };
  });
}
