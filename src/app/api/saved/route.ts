import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  listSavedShorts,
  saveShort,
  saveShortSchema,
  savedShortsQuerySchema,
} from "@/server/services/research-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handle(async () => {
    // Saved Shorts carry the same competitor data as the boards they came
    // from, so reading them is analytics readership. Whose shortlist comes
    // back is decided in the service: your own, or — for an admin with
    // `users.manage` — the team's, every row naming who saved it.
    await requirePermission("analytics.view");

    // Who saved it and when, pushed into the query. The filters cannot widen
    // the answer — they are ANDed with the ownership filter — so this endpoint
    // is the same read for everybody, just narrower for whoever asks.
    const url = new URL(request.url);
    const parsed = savedShortsQuerySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "Those filters are not valid.",
      );
    }

    return { saved: await listSavedShorts(parsed.data) };
  });
}

/** POST /api/saved — bookmark a Short, capturing its current view count. */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    // Bookmarking adds a row to the caller's own board, so it is a write. A
    // colleague having already saved this Short is not a conflict: the key
    // carries the owner, so both saves exist side by side.
    await requirePermission("research.write");

    const parsed = saveShortSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput("Provide the video to save.");
    }
    return { saved: await saveShort(parsed.data) };
  });
}
