import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  createContentType,
  createContentTypeSchema,
  listContentTypes,
} from "@/server/services/content-type-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/content-types?search=…&includeInactive=true
 *
 * The catalogue with its usage counts — ONE FLAT ORG-WIDE LIST, because that is
 * what a content type is again: a tag the whole operation shares, attached to
 * channels and Shorts. The `?nicheId=` narrowing this used to accept described
 * a per-niche vocabulary that no longer exists, and it is gone rather than
 * quietly ignored: a parameter that silently stops filtering is worse than one
 * that was never there.
 *
 * `search` is a case-insensitive substring match on the name, applied by the
 * server rather than in the browser — the counts come with the rows, so a
 * client-side filter would show a match count that disagreed with the catalogue
 * behind it. Archived types are omitted unless asked for: a picker wants the
 * live vocabulary, the management screen wants all of it.
 */
export function GET(request: Request) {
  return handle(async () => {
    // Content types are how the Shorts table is sliced, and the counts are
    // video data: reading them is reading analytics, not administering the
    // taxonomy.
    await requirePermission("analytics.view");

    const params = new URL(request.url).searchParams;

    return {
      contentTypes: await listContentTypes({
        // `?? undefined` rather than the raw `null`: an absent parameter means
        // "no search", and passing null through would read as a filter on
        // nothing.
        search: params.get("search") ?? undefined,
        includeInactive: params.get("includeInactive") === "true",
      }),
    };
  });
}

/** POST /api/content-types — create one. */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    // The same class of taxonomy editing as a niche, and deliberately the same
    // permission: everyone's charts regroup around a content type the moment it
    // exists, and inventing a permission nobody currently holds would mean
    // shipping a feature no role can reach.
    await requirePermission("niches.manage");

    const parsed = createContentTypeSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That content type is not valid.",
      );
    }

    return { contentType: await createContentType(parsed.data, request) };
  });
}
