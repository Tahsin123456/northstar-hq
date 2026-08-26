import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { previewChannel } from "@/server/services/channel-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resolveSchema = z.object({
  input: z.string().trim().min(1).max(300),
});

/**
 * POST /api/channels/resolve
 *
 * Look up a channel without tracking it, so the add dialog can show a real
 * preview — avatar, name, handle, subscribers — before the user commits.
 * Costs 1–2 quota units and writes nothing.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    // Writes nothing, but still spends the org's shared quota on every call, so
    // it is gated as the channel edit it is a step of — and gated *first*, above
    // parsing, so an unpermitted caller cannot reach the YouTube API at all.
    await requirePermission("channels.manage");

    const body = await readJson(request);
    const parsed = resolveSchema.safeParse(body);
    if (!parsed.success) {
      throw errors.invalidInput(
        "Enter a YouTube channel URL, an @handle, or a channel ID beginning with UC.",
      );
    }
    return previewChannel(parsed.data.input);
  });
}
