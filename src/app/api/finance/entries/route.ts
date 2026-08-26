import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  createEntry,
  financeEntryCreateSchema,
  listEntriesPage,
  parseFinanceQuery,
  resolveFinanceRange,
} from "@/server/services/finance-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/finance/entries — the ledger for a period, optionally filtered. */
export function GET(request: Request) {
  return handle(async () => {
    await requirePermission("finance.view");

    const query = parseFinanceQuery(request);
    const range = await resolveFinanceRange(query);

    // `truncated` is returned rather than swallowed: the client sums this array
    // for its own totals, so it has to know when the array is not the whole
    // period.
    return listEntriesPage({
      range,
      kind: query.kind,
      channelId: query.channelId,
      categoryId: query.categoryId,
    });
  });
}

/** POST /api/finance/entries — record revenue or an expense. */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    // Writing money is a separate capability from reading it: a Channel
    // Director may be given `finance.view` to see how their channel is doing
    // without also being able to book entries against it.
    await requirePermission("finance.manage");

    const parsed = financeEntryCreateSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That financial entry is not valid.",
      );
    }

    // The Request goes to the service so the audit record can carry request
    // context; the service decides what is worth recording, not this handler.
    return { entry: await createEntry(parsed.data, request) };
  });
}
