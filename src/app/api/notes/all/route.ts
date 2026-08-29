import { handle } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { listAllNotes, noteLogQuerySchema } from "@/server/services/research-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/notes/all — the notes the caller may read, with their channel /
 * niche / Short context, filtered and ordered by the query string.
 *
 * The filters are parsed here and applied in the QUERY, never in the browser.
 * That is not a performance preference: the log is the widest note read in the
 * app, and "everything, then hide some of it on screen" is exactly the shape of
 * the bug the ownership round removed.
 */
export function GET(request: Request) {
  return handle(async () => {
    // `analytics.view` gates the *screen*: the log is read alongside the boards
    // the notes were written on. It does not decide the rows — that is
    // `noteScope()` in the service: your own notes, the ones colleagues shared
    // into your scope, or, for an admin with `users.manage`, the team's, each
    // one attributed.
    await requirePermission("analytics.view");

    // Every parameter is optional, so an unadorned GET still means "the whole
    // log". Unknown parameters are ignored by the object parse rather than
    // rejected, which keeps an old bookmarked URL working after a filter is
    // renamed.
    const url = new URL(request.url);
    const parsed = noteLogQuerySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "Those note filters are not valid.",
      );
    }

    return { notes: await listAllNotes(parsed.data) };
  });
}
