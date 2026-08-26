import { handle } from "@/server/http";
import { getActor, toActorDTO } from "@/server/auth/dal";
import { needsSetup } from "@/server/services/auth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me — who is signed in, and what may they do.
 *
 * Returns 200 with a null user rather than 401 when nobody is signed in. The
 * client uses this to decide whether to render the app at all, and a 401 here
 * would be indistinguishable from a session that expired mid-use, which the UI
 * needs to treat differently.
 *
 * The payload is a DTO, never the user row: there is no field on it for a
 * password hash, a session id or another member's details, so none can leak
 * through a component spreading it into props.
 */
export function GET() {
  return handle(async () => {
    const actor = await getActor();
    if (!actor) {
      return { user: null, needsSetup: await needsSetup() };
    }
    return { user: toActorDTO(actor), needsSetup: false };
  });
}
