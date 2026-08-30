import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { getTrackedChannel } from "@/server/services/channel-service";
import { setChannelContentTypeRuleWindow } from "@/server/services/content-type-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; ruleId: string }> };

const windowSchema = z.object({
  /**
   * Epoch milliseconds, or `null` to re-open.
   *
   * A NUMBER RATHER THAN AN ISO STRING, matching every other date on this wire.
   * The rule is evaluated against `publishedAt`, which is epoch milliseconds on
   * both sides; accepting a string here would put one parse between the date a
   * person picked and the comparison it ends up in.
   *
   * The lower bound is only that it is a real instant. "After the rule starts"
   * is the constraint that matters and it is enforced in the service, where the
   * rule's own `effectiveFrom` is in scope and the refusal can name the date to
   * beat.
   */
  effectiveUntil: z.number().int().finite().nullable(),
});

/**
 * PATCH /api/channels/:id/content-type-rules/:ruleId
 *
 * THE MANUAL LEVER, BOTH DIRECTIONS: close a rule at a date, or re-open one with
 * `effectiveUntil: null`.
 *
 * ONE ENDPOINT FOR BOTH, because they are one edit to one column and splitting
 * them would make the undo a different-shaped request from the do. It is also
 * what makes "reopening must be one action" literally true — the toast that
 * announces a self-retirement sends exactly this, with `null`.
 *
 * PATCH rather than PUT: the body names the window and nothing else, and the
 * streak columns the service resets alongside it are consequences of the edit
 * rather than fields a caller may set. A client must never be able to write
 * `consecutiveOverrides` — that is evidence, not state.
 *
 * `:id` is the CHANNEL id and `:ruleId` the rule's. Both are checked: a rule id
 * belonging to another team's channel 404s exactly as a made-up one does, so the
 * endpoint never confirms that somebody else's rule exists.
 */
export function PATCH(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Same permission as applying one, and for the same reason: this is using
    // the vocabulary, not deciding it. Closing a rule is the correction half of
    // the same judgement that opened it, and a person who may make the claim
    // must be able to take it back.
    await requirePermission("research.write");

    const { id, ruleId } = await context.params;
    const parsed = windowSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        "Provide the date this rule stops applying, or null to re-open it.",
      );
    }

    const rule = await setChannelContentTypeRuleWindow(
      id,
      ruleId,
      parsed.data.effectiveUntil,
      request,
    );
    return { rule, channel: await getTrackedChannel(id) };
  });
}
