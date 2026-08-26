import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  listSavedShorts,
  saveShort,
  saveShortSchema,
} from "@/server/services/research-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => {
    // Saved Shorts carry the same competitor data as the boards they came
    // from, so reading them is analytics readership.
    await requirePermission("analytics.view");

    return { saved: await listSavedShorts() };
  });
}

/** POST /api/saved — bookmark a Short, capturing its current view count. */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    // Bookmarking adds a row to the organization's board, so it is a write.
    await requirePermission("research.write");

    const parsed = saveShortSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput("Provide the video to save.");
    }
    return { saved: await saveShort(parsed.data) };
  });
}
