import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupForm } from "@/components/auth/setup-form";
import { needsSetup } from "@/server/services/auth-service";

export const metadata: Metadata = { title: "First-run setup" };
export const dynamic = "force-dynamic";

/**
 * One-time claim of the administrator account.
 *
 * The window is checked here AND again inside the transaction that creates the
 * account, so it closes the instant an admin exists. Once it has, this page
 * redirects to sign-in and there is no way to reopen it from outside.
 */
export default async function SetupPage() {
  if (!(await needsSetup())) redirect("/login");
  return <SetupForm />;
}
