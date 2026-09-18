import { z } from "zod";
import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { addChannel, listTrackedChannels } from "@/server/services/channel-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * A ceiling of its own, rather than the platform's 300-second default.
 *
 * This route ran for the full 300 and was killed, on the one request a person
 * waits in front of. The work inside it is now bounded — see `addChannel`'s
 * classification budget — and this is the backstop: matching the manual
 * refresh route, which caps the same `syncChannel` work at 120 seconds and
 * always did.
 */
export const maxDuration = 120;

const addChannelSchema = z.object({
  input: z
    .string()
    .trim()
    .min(1, "Enter a YouTube channel URL, @handle or channel ID.")
    .max(300, "That input is too long to be a channel reference."),
  /** Defaults to "competitor" — most channels added to a tracker are research. */
  ownershipType: z.enum(["own", "competitor"]).optional(),
  nicheIds: z.array(z.string().min(1)).max(20).optional(),
  /**
   * Which roster an UNFILED channel lands on. Absent means Shorts, so every
   * request the Shorts side has ever sent keeps its exact meaning.
   *
   * Narrow to the two formats rather than a free string: it is written to a
   * column the dataset query reads, and a third value would put a channel on
   * neither roster.
   */
  format: z.enum(["shorts", "longform"]).optional(),
});

/** GET /api/channels — the tracked channel list (metadata only, no videos). */
export function GET(request: Request) {
  return handle(async () => {
    // The tracker list is analytics: whoever may read the dashboard may read
    // which channels feed it.
    await requirePermission("analytics.view");

    const url = new URL(request.url);
    const includeRemoved = url.searchParams.get("includeRemoved") === "true";
    const channels = await listTrackedChannels({ includeRemoved });
    return { channels };
  });
}

/** POST /api/channels — resolve, track and immediately sync a channel. */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    // Tracking a channel spends the org's shared YouTube quota and adds to what
    // everyone sees — an operational change, not a personal one.
    await requirePermission("channels.manage");

    const body = await readJson(request);
    const parsed = addChannelSchema.safeParse(body);
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "Invalid request.",
      );
    }
    return addChannel(parsed.data.input, {
      ownershipType: parsed.data.ownershipType,
      nicheIds: parsed.data.nicheIds,
      format: parsed.data.format,
    });
  });
}
