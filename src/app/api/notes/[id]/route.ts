import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { deleteNote, updateNote, updateNoteSchema } from "@/server/services/research-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export function PATCH(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Notes belong to the organization, so editing one is the same authorship
    // capability as writing it — not ownership of this particular row.
    await requirePermission("research.write");

    const { id } = await context.params;
    const parsed = updateNoteSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(parsed.error.issues[0]?.message ?? "That note is not valid.");
    }
    return { note: await updateNote(id, parsed.data.body) };
  });
}

export function DELETE(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Removing a note from the shared board is a research write; there is no
    // narrower "delete" capability to hold out for.
    await requirePermission("research.write");

    const { id } = await context.params;
    await deleteNote(id);
    return { ok: true };
  });
}
