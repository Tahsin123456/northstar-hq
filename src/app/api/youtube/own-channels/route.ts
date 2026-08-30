import { z } from "zod";
import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { recordAudit } from "@/server/audit/audit-service";
import { listOwnChannels, trackOwnChannel } from "@/server/services/youtube-oauth-service";
import { toRefreshResultDTO } from "@/server/services/channel-service";
import { syncChannel } from "@/server/services/channel-sync";
import { buildChannelSyncOptions } from "@/server/services/sync-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Adding pulls the channel's history immediately, and a large back catalogue
 * takes tens of seconds to walk — the same headroom the single-channel refresh
 * route allows, and for the same reason.
 */
export const maxDuration = 120;

/**
 * GET /api/youtube/own-channels
 *
 * The channels the connected Google accounts actually own, each with what the
 * tracker already knows about it.
 *
 * THIS IS THE POINT OF CONNECTING. The owner asked — twice now — that after
 * connecting, their own channels be discoverable and addable without anybody
 * pasting a channel id. Pasting one asks a person to re-type a fact Google has
 * already told us, and a single mistyped character files a stranger's channel as
 * "own", which is the flag deciding whose work the studio reports as its own.
 *
 * `youtube.manage` rather than `analytics.view`: this spends a connected
 * account's grant on a live Data API call and names the Google accounts behind
 * each channel, which is administrative information about credentials rather
 * than analytics anybody with a login should read.
 */
export function GET() {
  return handle(async () => {
    const actor = await requirePermission("youtube.manage");
    // Scoped to the caller's own workspace from the session — never a parameter.
    return { channels: await listOwnChannels(actor.organizationId) };
  });
}

/**
 * The body, and the reason it is this small.
 *
 * A connection and a channel id, and nothing describing the channel. Everything
 * else — title, handle, avatar, subscriber count — is read from Google with the
 * connection's own token inside `trackOwnChannel`, because a client that could
 * supply those could name a channel the account does not own and have it filed
 * as one of Northstar's. The id is not trusted either: it is matched against the
 * channels the connection reports owning, and refused otherwise.
 */
const addOwnChannelSchema = z.object({
  connectionId: z.string().min(1).max(64),
  youtubeChannelId: z.string().min(1).max(64),
});

/**
 * POST /api/youtube/own-channels — track one of the connected account's own
 * channels, and pull its history straight away.
 *
 * TWO PERMISSIONS, DELIBERATELY. This spends a connected account's grant
 * (`youtube.manage`) and it writes a row into the tracker everybody reads
 * (`channels.manage`). Requiring only the first would let somebody who may
 * manage credentials add channels they may not otherwise add; requiring only
 * the second would let somebody who may add channels reach into a Google grant
 * that is not theirs to spend. They are separate capabilities and this endpoint
 * genuinely exercises both.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    const actor = await requirePermission("youtube.manage");
    await requirePermission("channels.manage");

    const parsed = addOwnChannelSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput("That is not a channel this connection can add.");
    }

    const tracked = await trackOwnChannel({
      organizationId: actor.organizationId,
      userId: actor.userId,
      connectionId: parsed.data.connectionId,
      youtubeChannelId: parsed.data.youtubeChannelId,
    });

    /**
     * Sync immediately, as `addChannel` does.
     *
     * A channel that appears in the tracker with no numbers reads as broken even
     * though it is only unsynced — and this one has a further reason: the whole
     * promise of connecting is that these figures come from the account's own
     * authorisation, and `buildChannelSyncOptions` resolves exactly that
     * credential, so the very first read already goes through the connection
     * rather than the shared key.
     */
    const sync = await syncChannel(
      tracked.channelId,
      await buildChannelSyncOptions(actor.organizationId, tracked.channelId, "initial"),
    );

    await recordAudit(
      {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorLabel: actor.name ?? actor.email,
        request,
      },
      {
        action: "channel.added",
        summary:
          `${actor.name ?? actor.email ?? "An admin"} added ${tracked.title} from a connected ` +
          "Google account as one of Northstar's channels",
        targetType: "channel",
        targetId: tracked.channelId,
        targetLabel: tracked.title,
        metadata: {
          youtubeChannelId: parsed.data.youtubeChannelId,
          connectionId: parsed.data.connectionId,
          created: tracked.created,
          restored: tracked.restored,
          // Worth recording on its own: nothing was added, a channel already in
          // the tracker as a competitor was corrected to "own" — which changes
          // which figures the studio reports as its own work.
          reclassified: tracked.reclassified,
          // What the first read actually went through, so the log can answer
          // "were these numbers ever the public ones?" later.
          dataSource: sync.dataSource,
        },
      },
    );

    return { ...tracked, sync: toRefreshResultDTO(sync) };
  });
}
