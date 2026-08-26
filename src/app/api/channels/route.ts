import { z } from "zod";
import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { addChannel, listTrackedChannels } from "@/server/services/channel-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const addChannelSchema = z.object({
  input: z
    .string()
    .trim()
    .min(1, "Enter a YouTube channel URL, @handle or channel ID.")
    .max(300, "That input is too long to be a channel reference."),
  /** Defaults to "competitor" — most channels added to a tracker are research. */
  ownershipType: z.enum(["own", "competitor"]).optional(),
  nicheIds: z.array(z.string().min(1)).max(20).optional(),
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
    });
  });
}
