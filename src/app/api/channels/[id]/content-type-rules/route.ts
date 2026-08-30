import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { getTrackedChannel } from "@/server/services/channel-service";
import { applyContentTypeToChannel } from "@/server/services/content-type-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const applyRuleSchema = z.object({
  contentTypeId: z.string().min(1),
});

/**
 * POST /api/channels/:id/content-type-rules
 *
 * "Apply to this channel" — one tag, covering the channel's whole back
 * catalogue and everything it publishes next.
 *
 * THIS REPLACES `PUT /api/channels/:id/content-types`, and the shape of the
 * request is the substance of the change rather than a rename. The old endpoint
 * took the channel's COMPLETE tag set, which made every call a statement about
 * every tag — including the ones the caller had not thought about, and including
 * the removals that statement implied. There is no whole-set write here and
 * there should not be: a rule is a claim about a stretch of time, and "these are
 * now the tags" cannot say when any of them started or stopped being true.
 *
 * POST rather than PUT because this CREATES something addressable — a rule, with
 * an id the client uses to close or re-open it. Idempotent all the same: applying
 * a tag a rule already covers writes nothing and returns the rule that was
 * already there, so a double-click is one rule.
 *
 * `:id` IS THE CHANNEL ID, matching `/api/channels/:id/niches` and
 * `ChannelDTO.id`. The `TrackedChannel` the rule hangs off is resolved from it
 * inside the service, scoped to the caller's organization — a tracking id in a
 * URL would be a second addressing scheme for the same object.
 *
 * The rule AND the updated channel come back: the rule so the caller can render
 * what it just made, the channel so it re-renders from what the server stored
 * rather than from what it hoped it wrote.
 */
export function POST(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    /*
     * APPLYING a tag is research.write, not niches.manage.
     *
     * Deciding the vocabulary and using it are different acts. Creating,
     * renaming and retiring content types shapes how the whole team describes
     * its work, and that stays with the heads and the admin (niches.manage).
     * Saying that this channel makes Rankings is the same kind of contribution
     * as writing a note or saving a Short — which is exactly what research.write
     * governs — and an editor who cannot characterise the channels they work on
     * would leave the library to be classified by the two people least likely to
     * have watched it.
     *
     * The reach is bigger than a per-Short tag and the permission is the same,
     * deliberately: the act is reversible in one click from three places, and
     * gating it higher would push people back to tagging four hundred Shorts by
     * hand, which is neither safer nor undoable.
     */
    await requirePermission("research.write");

    const { id } = await context.params;
    const parsed = applyRuleSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput("Provide the content type to apply to this channel.");
    }

    const rule = await applyContentTypeToChannel(id, parsed.data.contentTypeId, request);
    return { rule, channel: await getTrackedChannel(id) };
  });
}
