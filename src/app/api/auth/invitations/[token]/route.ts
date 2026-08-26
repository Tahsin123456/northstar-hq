import { handle } from "@/server/http";
import { previewInvitation } from "@/server/services/auth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/invitations/[token] — what this invitation is for.
 *
 * Anonymous by design: the token IS the credential, and the acceptance page has
 * to show who it was issued to before asking for a password. It reveals only
 * the invited address, the intended role and the workspace name, all of which
 * whoever holds the link already knows.
 *
 * An invalid, expired, revoked or already-used token yields the same
 * "no longer valid" message, so this cannot be used to probe which tokens exist.
 */
/**
 * The params shape is declared locally rather than using Next 16's generated
 * `RouteContext<"/api/...">` helper, matching every other dynamic route in this
 * app. The generated helper only resolves after route typegen has run, so a
 * newly added route fails `tsc` until the next build — a local alias with the
 * same `Promise`-wrapped shape type-checks from the moment the file is saved.
 */
type Context = { params: Promise<{ token: string }> };

export function GET(_request: Request, context: Context) {
  return handle(async () => {
    const { token } = await context.params;
    return { invitation: await previewInvitation(token) };
  });
}
