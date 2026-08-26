import type { Metadata } from "next";
import Link from "next/link";
import { AcceptInviteForm } from "@/components/auth/accept-invite-form";
import { AuthCard } from "@/components/auth/auth-form";
import { Button } from "@/components/ui/button";
import { previewInvitation } from "@/server/services/auth-service";
import { roleDefinition } from "@/lib/auth/permissions";

export const metadata: Metadata = { title: "Accept your invitation" };
export const dynamic = "force-dynamic";

/**
 * The invitation acceptance screen.
 *
 * Two states live under this route, and only the first is rendered here: the
 * form that sets a password, and the "waiting for approval" screen that
 * replaces it once the account exists. The second one is inside the client
 * component on purpose — it is the outcome of a POST, so a server-rendered page
 * could only reach it by redirecting somewhere, and there is nowhere to
 * redirect to: the person still has no session and every app route would send
 * them to /login.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Resolved on the server so the page renders the invitee's details without a
  // client round trip. Any invalid, expired, revoked or already-used token
  // produces the identical message below, so this cannot be used to probe which
  // tokens exist.
  let invitation;
  try {
    invitation = await previewInvitation(token);
  } catch {
    return (
      <AuthCard
        title="This invitation is no longer valid"
        description="It may have expired, already been used, or been revoked. Ask an admin to send you a new one."
      >
        <Button asChild variant="ghost" className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AcceptInviteForm
      token={token}
      email={invitation.email}
      suggestedName={invitation.name}
      roleLabel={roleDefinition(invitation.role).label}
      organizationName={invitation.organizationName}
    />
  );
}
