import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { getActor } from "@/server/auth/dal";
import { needsSetup } from "@/server/services/auth-service";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // A deployment with no administrator cannot be signed into; send the first
  // person to setup rather than to a form that can never succeed.
  if (await needsSetup()) redirect("/setup");
  if (await getActor()) redirect("/");

  return <LoginForm />;
}
