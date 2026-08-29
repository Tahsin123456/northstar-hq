import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  createNote,
  createNoteSchema,
  listNotes,
  noteTargetSchema,
} from "@/server/services/research-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/notes?targetType=channel&targetId=... */
export function GET(request: Request) {
  return handle(async () => {
    // Notes annotate the analytics they hang off, so reading them is part of
    // reading the numbers. Which notes come back is a separate question and is
    // settled in the service: they are personal, so this is the caller's own.
    await requirePermission("analytics.view");

    // `noteTargetSchema`, not `noteKindSchema`: this endpoint answers "what has
    // been written about *this thing*", and a general note is attached to no
    // thing. Those are read from the log, `/api/notes/all`.
    const url = new URL(request.url);
    const parsed = noteTargetSchema.safeParse(url.searchParams.get("targetType"));
    const targetId = url.searchParams.get("targetId");
    if (!parsed.success || !targetId) {
      throw errors.invalidInput("Specify a targetType and targetId.");
    }
    return { notes: await listNotes(parsed.data, targetId) };
  });
}

/** POST /api/notes */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    // Authoring is a separate capability from reading. The note lands in the
    // author's own notebook, stamped with their id — which is what every read
    // of it afterwards filters on.
    await requirePermission("research.write");

    const parsed = createNoteSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(parsed.error.issues[0]?.message ?? "That note is not valid.");
    }
    return { note: await createNote(parsed.data) };
  });
}
