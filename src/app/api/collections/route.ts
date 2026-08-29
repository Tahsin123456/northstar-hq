import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  createCollection,
  createCollectionSchema,
  listCollections,
} from "@/server/services/research-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => {
    // Collections are how a research board is organised; listing them is
    // reading, not curating. They are personal, like the saves they hold, so
    // the service returns the caller's folders.
    await requirePermission("analytics.view");

    return { collections: await listCollections() };
  });
}

export function POST(request: Request) {
  return handleMutation(request, async () => {
    // A new folder is a change to the caller's own research board.
    await requirePermission("research.write");

    const parsed = createCollectionSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That collection name is not valid.",
      );
    }
    return { collection: await createCollection(parsed.data.name) };
  });
}
