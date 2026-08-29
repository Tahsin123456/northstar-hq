import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  assignContentTypeSchema,
  assignContentTypeToVideos,
} from "@/server/services/content-type-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/content-types/assign — file many Shorts under one content type.
 *
 * A static segment sitting alongside `/api/content-types/[id]`, which Next
 * resolves in favour of the literal path, so "assign" can never be read as an
 * id. Worth knowing before anyone adds a second verb here: the day a content
 * type is legitimately called "assign" its slug still is not its id, so the two
 * do not actually collide.
 *
 * The response reports what changed rather than just succeeding — `assigned`
 * versus `alreadyAssigned` is what lets the UI say "38 filed, 12 already were"
 * instead of implying it wrote 50 rows. Re-running the same request is a no-op
 * by design; see the idempotency note on the service.
 *
 * ANY TAG ON ANY SELECTION. There is no niche rule left to trip over here — a
 * selection may span every channel in the tracker and still take one tag. What
 * the service does still refuse, all-or-nothing, is a run containing a Short
 * the caller cannot see: writing the ones that happen to be valid would report
 * success for a request that was partly a probe of another team's data.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    // Classifying Shorts is taxonomy work on shared data — the same permission
    // that created the type, since being able to invent a label but not apply
    // it would be a strange half-capability.
    /*
     * APPLYING a tag is research.write, not niches.manage.
     *
     * Deciding the vocabulary and using it are different acts. Creating,
     * renaming and retiring content types shapes how the whole team describes
     * its work, and that stays with the heads and the admin (niches.manage).
     * Filing a Short under a label the team already agreed on is the same kind
     * of contribution as writing a note or saving a Short — which is exactly
     * what research.write governs — and an editor who cannot label the Shorts
     * they work on would leave the library to be classified by the two people
     * least likely to have watched them.
     */
    await requirePermission("research.write");

    const parsed = assignContentTypeSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That bulk assignment is not valid.",
      );
    }

    return assignContentTypeToVideos(parsed.data, request);
  });
}
