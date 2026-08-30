"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Coins, ListChecks, ShieldCheck } from "lucide-react";
import {
  IMPORTED_FIELD_GROUPS,
  IMPORT_COVERAGE_SUMMARY,
  UNAVAILABLE_FIELDS,
} from "@/lib/youtube/import-coverage";

/**
 * The three facts somebody deserves BEFORE they grant access to their channel.
 *
 * All three appear at the moment the grant happens rather than in a help page,
 * because that is the only moment any of them is worth anything. They are also,
 * individually, the three things people get wrong about this integration:
 *
 *   • That it might post to their channel. It cannot. `OAUTH_SCOPES` in
 *     `youtube-oauth-service.ts` asks for `youtube.readonly` and two `readonly`
 *     Analytics scopes; no write scope is requested, so the permission to change
 *     anything does not exist.
 *   • That revenue arrives automatically with the connection. It does not. The
 *     monetary Analytics scope is a separate tick on Google's consent screen and
 *     can be refused on its own — which is why a whole state exists for it.
 *   • That the money figures are final. They are not. YouTube adjusts them at
 *     month end, and a ledger presenting an estimate as settled cash is how
 *     somebody reconciles against a bank statement and concludes the books are
 *     broken.
 *
 * ONE COPY, TWO PLACES. This used to live only inside the admin page's connect
 * panel. Now that the same offer appears on the channels screen and the
 * dashboard's empty state, a second hand-written copy of these three paragraphs
 * would be a second thing to keep true — and the one most likely to go stale is
 * the read-only promise, which is the one nobody can afford to have wrong.
 */
export function ConnectScopeFacts() {
  return (
    <ul className="flex flex-col gap-2">
      <Fact icon={<ShieldCheck className="text-success" />}>
        Northstar HQ requests <strong className="text-foreground">read-only</strong> access and{" "}
        <strong className="text-foreground">can never modify a channel</strong>. It can read your
        channels, videos, their statistics and the revenue YouTube estimates for them; it cannot
        upload, edit, comment, delete or change anything. No write permission is ever requested, so
        the ability to do so does not exist.
      </Fact>

      <Fact icon={<Coins className="text-subtle-foreground" />}>
        Revenue needs a{" "}
        <strong className="text-foreground">separate YouTube Analytics permission</strong> — a
        distinct tick on Google&rsquo;s consent screen. Leave every permission ticked to import
        earnings. Declining it still connects the account and still syncs channels and videos; only
        the money is left out.
      </Fact>

      <Fact icon={<AlertTriangle className="text-warning" />}>
        Every figure YouTube reports is an <strong className="text-foreground">estimate</strong>,
        and YouTube revises it — usually at month end, sometimes weeks later. Imported amounts are
        marked as estimates in{" "}
        <Link href="/finance" className="text-accent underline-offset-2 hover:underline">
          Finance
        </Link>{" "}
        and must not be treated as settled cash.
      </Fact>

      {/*
        THE FOURTH FACT, and the one people are most surprised by afterwards.
        "Connect your channel" reads as "get your YouTube Studio numbers", and
        Studio's headline metrics — watch time, average view duration,
        impressions, click-through rate — come from a different API that this app
        does not query. Saying so before the grant costs a sentence; discovering
        it afterwards costs somebody's confidence in every other figure on the
        screen. The list is folded away because it is long and only some people
        want it, and stated in full because the alternative was inventing
        plausible substitutes, which nobody could check against Studio.
      */}
      <Fact icon={<ListChecks className="text-subtle-foreground" />}>
        {IMPORT_COVERAGE_SUMMARY}
        <details className="mt-1.5 rounded-md border border-border bg-surface-sunken px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-medium text-foreground">
            Exactly what is and is not imported
          </summary>

          <p className="mt-2 text-[11px] font-medium uppercase tracking-wider text-subtle-foreground">
            Imported
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {IMPORTED_FIELD_GROUPS.map((group) => (
              <li key={group.label} className="text-[11px] leading-relaxed">
                <strong className="text-foreground">{group.label}:</strong> {group.fields}
              </li>
            ))}
          </ul>

          <p className="mt-3 text-[11px] font-medium uppercase tracking-wider text-subtle-foreground">
            Not available through this connection
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {UNAVAILABLE_FIELDS.map((field) => (
              <li key={field.label} className="text-[11px] leading-relaxed">
                <strong className="text-foreground">{field.label}:</strong> {field.reason}
              </li>
            ))}
          </ul>
        </details>
      </Fact>
    </ul>
  );
}

function Fact({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0 text-[12px] leading-relaxed text-muted-foreground">{children}</span>
    </li>
  );
}
