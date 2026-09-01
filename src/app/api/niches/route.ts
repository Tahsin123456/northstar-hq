import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { resolveAllowedFormats } from "@/server/auth/format-scope";
import {
  createNiche,
  createNicheSchema,
  listNiches,
} from "@/server/services/niche-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/niches — all niches with their active channel counts. */
export function GET() {
  return handle(async () => {
    // Niches are how the dashboard is sliced, and the counts are channel data:
    // reading them is reading analytics, not administering them.
    const actor = await requirePermission("analytics.view");

    // Every format this role's side of the operation covers — both for an
    // admin, whose assignment checklist spans the whole team, one for
    // everybody else. This is a scope, not a preference, so there is no
    // parameter to send and nothing for `requireFormat` to validate.
    return { niches: await listNiches({ formats: resolveAllowedFormats(actor.role) }) };
  });
}

/**
 * POST /api/niches — create a niche.
 *
 * Two permissions, checked in two places. `niches.manage` is the floor to
 * create one at all and is asserted here, before anything is read. A
 * `hitThreshold` in the body is a second, narrower act — it defines what a hit
 * means for everybody's charts — and needs `settings.manage`; that check lives
 * in `createNiche` itself so it holds for every caller, not just this route.
 *
 * An employee who sends one anyway is refused with a 403 rather than having the
 * field quietly dropped. Stripping it would create the niche and let them
 * believe they had configured a number that does not exist.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    // A niche is shared taxonomy — everyone's charts regroup around it — so
    // creating one is an operational act, not part of the research baseline.
    await requirePermission("niches.manage");

    const parsed = createNicheSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That niche name is not valid.",
      );
    }
    return { niche: await createNiche(parsed.data) };
  });
}
