import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { deleteNote, updateNote, updateNoteSchema } from "@/server/services/research-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export function PATCH(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // `research.write` is the capability to author notes at all. *Which* note
    // this person may rewrite is a question about the row, not the role, so it
    // is answered where the row is — `updateNote` matches on the author, or on
    // an admin holding `users.manage`, and 404s otherwise. That is also what
    // settles the visibility half: a colleague who can now READ a shared note
    // still does not match, so they cannot un-share or re-share somebody
    // else's writing.
    await requirePermission("research.write");

    const { id } = await context.params;
    const parsed = updateNoteSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(parsed.error.issues[0]?.message ?? "That note is not valid.");
    }
    return { note: await updateNote(id, parsed.data) };
  });
}

export function DELETE(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Same split as PATCH: the permission says "may write research", the
    // service decides whose note this is. There is no narrower "delete"
    // capability to hold out for.
    await requirePermission("research.write");

    const { id } = await context.params;
    await deleteNote(id);
    return { ok: true };
  });
}
