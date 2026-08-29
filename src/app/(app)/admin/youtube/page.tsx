"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Coins,
  Copy,
  ExternalLink,
  Lock,
  Plug,
  RefreshCw,
  ShieldCheck,
  X,
  Youtube,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/components/providers/session-provider";
import { useNow } from "@/hooks/use-now";
import {
  useDisconnectYouTube,
  useSyncYouTubeRevenue,
  useYouTubeConnections,
  YOUTUBE_CONNECT_PATH,
} from "@/hooks/use-youtube-connections";
import type { GoogleOAuthStatusDTO, YouTubeConnectionDTO } from "@/lib/dto";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Connected Google accounts.
 *
 * Two entirely different screens live here, and which one renders is decided by
 * `google.configured` from /api/youtube/connections — the same response that
 * carries the list, so the wrong one is never shown first. Unconfigured means a
 * setup card naming the variables; configured means the list and a connect
 * button. There is deliberately no third state where a button is rendered that
 * would fail on click.
 *
 * The connect flow leaves the SPA. /api/youtube/connect answers with a 302 to
 * Google's consent screen, so it is reached by navigating — an <a href> below,
 * never a fetch — and Google returns the browser here with the result in the
 * query string.
 */
export default function YouTubeAdminPage() {
  const { can } = useSession();

  // An affordance, not the boundary: every one of these routes calls
  // requirePermission("youtube.manage") server-side. Gating here only spares
  // somebody a 403 they could do nothing about — and keeps the request from
  // being sent at all, which is why the screen lives in a child component.
  if (!can("youtube.manage")) {
    return (
      <PageContainer>
        <Card>
          <EmptyState
            icon={<Lock />}
            title="You don't have access to YouTube connections"
            description="Connecting and disconnecting Google accounts needs the “Manage YouTube connections” permission. An administrator can grant it."
          />
        </Card>
      </PageContainer>
    );
  }

  return <YouTubeAdminScreen />;
}

function YouTubeAdminScreen() {
  const { data, isLoading, error, refetch } = useYouTubeConnections();

  const google = data?.google;
  const connections = data?.connections ?? [];

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="YouTube accounts"
        description="Google accounts that have authorised Northstar HQ to read your channel data and its estimated revenue. Each connection is what lets your own channels be synced with their real figures rather than only the public ones."
        actions={
          // Only offered when there is something to sync. A button that can
          // only report "no connections" is a button that teaches nothing. The
          // connect button is deliberately NOT duplicated up here — it lives in
          // the panel below, at full size, beside the sentences describing what
          // pressing it grants.
          google?.configured && connections.length > 0 ? (
            <SyncRevenueButton label="Sync all revenue" />
          ) : null
        }
      />

      {/* useSearchParams needs a Suspense boundary; there is nothing meaningful
          to show in place of a one-off message, so the fallback is empty. */}
      <React.Suspense fallback={null}>
        <OAuthOutcome />
      </React.Suspense>

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-2/3 rounded" />
          <Skeleton className="h-[132px] w-full rounded-lg" />
        </div>
      ) : google && !google.configured ? (
        <SetupCard google={google} />
      ) : (
        <>
          <ConnectPanel hasConnections={connections.length > 0} />

          {connections.length > 0 ? (
            <div className="flex flex-col gap-3">
              {connections.map((connection) => (
                <ConnectionCard key={connection.id} connection={connection} />
              ))}
            </div>
          ) : null}
        </>
      )}
    </PageContainer>
  );
}

/**
 * The connect action, as an anchor rather than a button with a click handler.
 *
 * /api/youtube/connect is a 302 to accounts.google.com. `fetch` would follow
 * that redirect inside the request instead of in the address bar, so the person
 * would never see the consent screen. An <a> makes the mechanism — a real
 * navigation out of the app — impossible to mistake, and brings middle-click
 * and keyboard behaviour along for free.
 */
function ConnectButton({
  label,
  variant = "primary",
  size = "sm",
  icon,
  className,
}: {
  label: string;
  variant?: "primary" | "secondary";
  size?: "sm" | "md" | "lg";
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <a href={YOUTUBE_CONNECT_PATH}>
        {icon ?? <Plug />}
        {label}
      </a>
    </Button>
  );
}

/**
 * The connect action, and the three facts somebody deserves before taking it.
 *
 * All three are on the screen where the grant happens, not in a help page,
 * because that is the only moment any of them is worth anything.
 *
 * They are also, individually, the three things people get wrong about this
 * integration. That it might post to their channel — it cannot; OAUTH_SCOPES in
 * youtube-oauth-service.ts asks for `youtube.readonly` and two `readonly`
 * Analytics scopes, and no write scope is requested, so the permission to
 * change anything does not exist. That revenue arrives automatically with the
 * connection — it does not; the monetary Analytics scope is a separate tick on
 * Google's consent screen and can be refused on its own, which is why half the
 * connection card below is about whether it was granted. And that the money
 * figures are final — they are not; YouTube adjusts them at month end, and a
 * ledger that presents an estimate as settled cash is how somebody reconciles
 * against a bank statement and concludes the books are broken.
 *
 * This panel stays on screen after the first connection. Connecting a second
 * account is the normal case for a studio with several channels, and the person
 * doing it is entitled to read the same three sentences.
 */
function ConnectPanel({ hasConnections }: { hasConnections: boolean }) {
  return (
    <Card className="flex flex-col gap-5 p-5 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
      <div className="flex min-w-0 flex-col gap-3">
        <div>
          <h2 className="text-[15px] font-medium text-foreground">
            {hasConnections
              ? "Connect another YouTube channel"
              : "No YouTube channel is connected yet"}
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            {hasConnections
              ? "Each Google account you connect adds the channels it owns, read with their own private figures rather than the ones YouTube shows the public."
              : "Connect the Google account that owns your channels. Until then, every figure in the app is the public one anybody can see, and there is no revenue to import."}
          </p>
        </div>

        <ul className="flex flex-col gap-2">
          <PanelPoint icon={<ShieldCheck className="text-success" />}>
            Northstar HQ requests <strong className="text-foreground">read-only</strong>{" "}
            access and <strong className="text-foreground">can never modify a channel</strong>
            . It can read your channels, videos, their statistics and the revenue YouTube
            estimates for them; it cannot upload, edit, comment, delete or change anything.
            No write permission is ever requested, so the ability to do so does not exist.
          </PanelPoint>

          <PanelPoint icon={<Coins className="text-subtle-foreground" />}>
            Revenue needs a{" "}
            <strong className="text-foreground">separate YouTube Analytics permission</strong>{" "}
            — a distinct tick on Google&rsquo;s consent screen. Leave every permission
            ticked to import earnings. Declining it still connects the account and still
            syncs channels and videos; only the money is left out.
          </PanelPoint>

          <PanelPoint icon={<AlertTriangle className="text-warning" />}>
            Every figure YouTube reports is an{" "}
            <strong className="text-foreground">estimate</strong>, and YouTube revises it —
            usually at month end, sometimes weeks later. Imported amounts are marked as
            estimates in{" "}
            <Link
              href="/finance/entries"
              className="text-accent underline-offset-2 hover:underline"
            >
              Finance &rarr; Entries
            </Link>{" "}
            and must not be treated as settled cash.
          </PanelPoint>
        </ul>
      </div>

      <ConnectButton
        label="Connect YouTube Channel"
        size="lg"
        icon={<Youtube />}
        className="shrink-0 self-start lg:self-center"
      />
    </Card>
  );
}

function PanelPoint({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0 text-[12px] leading-relaxed text-muted-foreground">
        {children}
      </span>
    </li>
  );
}

/**
 * "Sync revenue now" — the same work the scheduler does, on demand.
 *
 * The two moments it exists for are right after connecting an account and right
 * after fixing an exchange rate a previous run complained about. In both, the
 * alternative is waiting hours to learn whether the fix worked, which is the
 * difference between a setup that feels finished and one that feels broken.
 *
 * The result is reported in detail rather than as "done", because a revenue run
 * has several honest outcomes that are not success and are not errors either: a
 * channel outside the Partner Programme, a connection that predates the revenue
 * permission, a month that has not moved. Saying "synced" over any of those
 * would be the screen's own small lie.
 *
 * `connectionId` narrows the run to one account. Every card has its own
 * instance, so `isPending` — and the spinner it drives — belongs to the button
 * that was actually pressed rather than to all of them at once. The wording of
 * the outcome differs too: a run over one connection that reported nothing can
 * say "this channel", where the sweep can only send the reader to look through
 * the cards below.
 */
function SyncRevenueButton({
  connectionId = null,
  label = "Sync revenue now",
}: {
  connectionId?: string | null;
  label?: string;
}) {
  const sync = useSyncYouTubeRevenue();
  const single = connectionId !== null;

  return (
    <Button
      variant="secondary"
      size="sm"
      loading={sync.isPending}
      onClick={() =>
        sync.mutate(connectionId, {
          onSuccess: (summary) => {
            const written = summary.entriesCreated + summary.entriesRevised;

            if (summary.errors.length > 0) {
              toast.warning("Revenue synced, with problems", {
                // The first error in full: these messages are written to name
                // the next action, and truncating one to a count would throw
                // away the only part that helps.
                description: summary.errors[0]?.message,
                duration: 12_000,
              });
              return;
            }

            if (written === 0) {
              toast.success("Revenue is up to date", {
                description:
                  summary.connectionsSynced > 0
                    ? "YouTube reported no change since the last sync."
                    : single
                      ? "YouTube reported no revenue for this connection. Its revenue status now says why."
                      : "No connected channel reported any revenue. Check each connection below for why.",
              });
              return;
            }

            toast.success("Revenue synced", {
              description:
                `${summary.entriesCreated} monthly entr${summary.entriesCreated === 1 ? "y" : "ies"} added, ` +
                `${summary.entriesRevised} revised. Estimates — YouTube adjusts them at month end.`,
            });
          },
          onError: (error) =>
            toast.error("Could not sync revenue", {
              description: error instanceof Error ? error.message : undefined,
            }),
        })
      }
    >
      <RefreshCw />
      {label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// One connection
// ---------------------------------------------------------------------------

/** Mirrors REQUIRED_SCOPE in youtube-oauth-service.ts, which is not exported. */
const REQUIRED_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  [REQUIRED_SCOPE]: "Read channels, videos and statistics",
  "https://www.googleapis.com/auth/yt-analytics.readonly":
    "Read this channel's own analytics reports",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly":
    "Read this channel's estimated revenue",
  openid: "Confirm which Google account this is",
  email: "Read the account's email address",
  "https://www.googleapis.com/auth/userinfo.email": "Read the account's email address",
  profile: "Read the account's basic profile",
};

function ConnectionCard({ connection }: { connection: YouTubeConnectionDTO }) {
  const now = useNow();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const scopes = connection.scope.split(" ").filter(Boolean);
  const hasReadScope = scopes.includes(REQUIRED_SCOPE);
  const healthy = connection.status === "connected";

  const label =
    connection.channelTitle ?? connection.googleAccountEmail ?? "Unidentified connection";

  return (
    <>
      <Card className="flex flex-col">
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-raised text-subtle-foreground">
              <Youtube className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-[14px] font-medium text-foreground">
                  {connection.channelTitle ?? "No channel on this account"}
                </span>
                <StatusBadge status={connection.status} />
              </div>
              <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                {connection.googleAccountEmail ?? "Google account email not returned"}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {!healthy ? (
              <ConnectButton
                label="Reconnect"
                variant="secondary"
                icon={<RefreshCw />}
              />
            ) : null}
            {/* Offered on every connection, including the ones whose revenue
                state is currently unhappy. Pressing it there is not futile: the
                run rewrites the status either way, so it is also the way to
                confirm that a reconnection or a fixed exchange rate took. */}
            <SyncRevenueButton connectionId={connection.id} />
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
              Disconnect
            </Button>
          </div>
        </div>

        {/*
          A downgraded grant is the failure mode worth surfacing loudly: the
          person unticked a box on the consent screen, everything looks
          connected, and the next sync fails with an opaque 403.
        */}
        {!hasReadScope ? (
          <div className="mx-4 mt-3 flex items-start gap-2.5 rounded-lg border border-warning/25 bg-warning-subtle px-3 py-2.5">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Read access to YouTube data was not granted, so this account cannot be synced.
              Reconnect and leave every permission ticked on Google&rsquo;s consent screen.
            </p>
          </div>
        ) : null}

        {connection.lastError ? (
          <div className="mx-4 mt-3 flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger-subtle px-3 py-2.5">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" />
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {connection.lastError}
            </p>
          </div>
        ) : null}

        <RevenueNotice connection={connection} />

        <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-border px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Channel">
            {connection.youtubeChannelId ? (
              <a
                href={`https://www.youtube.com/channel/${connection.youtubeChannelId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline"
              >
                <span className="truncate">{connection.channelTitle ?? "Open on YouTube"}</span>
                <ExternalLink className="size-3 shrink-0" />
              </a>
            ) : (
              // Never invented: an account can authorise access and own no
              // channel at all, which is a real state rather than missing data.
              <span className="text-subtle-foreground">This account owns no channel</span>
            )}
          </Field>

          <Field label="Last sync">
            {connection.lastSyncAt === null ? (
              <span className="text-subtle-foreground">Never synced</span>
            ) : (
              <span title={formatDateTime(connection.lastSyncAt)}>
                {formatRelativeTime(connection.lastSyncAt, now === 0 ? undefined : now)}
              </span>
            )}
          </Field>

          <Field label="Connected by">
            {connection.connectedByName ?? (
              <span className="text-subtle-foreground">Account no longer in the team</span>
            )}
          </Field>

          <Field label="Connected on">{formatDateTime(connection.createdAt)}</Field>

          <Field label="Revenue">
            <RevenueStatusBadge connection={connection} />
          </Field>

          <Field label="Last revenue sync">
            {connection.lastRevenueSyncAt === null ? (
              // Not "never synced": a connection that has never been ASKED for
              // revenue and one that was asked and answered nothing are
              // different facts, and the badge beside this says which.
              <span className="text-subtle-foreground">Not read yet</span>
            ) : (
              <span title={formatDateTime(connection.lastRevenueSyncAt)}>
                {formatRelativeTime(connection.lastRevenueSyncAt, now === 0 ? undefined : now)}
              </span>
            )}
          </Field>

          <Field label="Next sync">
            <NextSyncValue nextSyncAt={connection.nextSyncAt} now={now} />
          </Field>

          <Field label="Monetisation">
            {connection.monetizationStatus === "monetized" ? (
              "In the YouTube Partner Programme"
            ) : connection.monetizationStatus === "not_monetized" ? (
              /*
                The refusal is the evidence, so the refusal is what this says.
                It used to read "Not in the Partner Programme", which is one
                READING of a 403 and not the only one: Google answers a monetary
                report with the same status and the same reason code whether the
                channel is outside the programme or the connected account no
                longer owns it, and the body names neither. Nothing in the
                response separates the two, so nothing here pretends to — the
                notice above this table states both readings and names the fix
                for each. This line states what was observed and stops.
              */
              <span title="YouTube refused to produce a revenue report for this channel even though this connection has permission to read one. That is its answer both for a channel outside the Partner Programme and for a channel this Google account no longer owns; the refusal does not say which. See the note above.">
                Revenue report refused
              </span>
            ) : (
              // Never guessed at, and a window of zeros does not change that: a
              // channel earning fractions of a cent reports the same as one that
              // cannot earn at all. Until something establishes it, there is
              // nothing here worth asserting either way.
              <span className="text-subtle-foreground">Not known yet</span>
            )}
          </Field>
        </dl>

        <div className="border-t border-border px-4 py-3">
          <div className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
            Permissions granted
          </div>
          <ul className="mt-2 flex flex-col gap-1.5">
            {scopes.length === 0 ? (
              <li className="text-[12px] text-subtle-foreground">
                Google returned no scope list for this connection.
              </li>
            ) : (
              scopes.map((scope) => (
                <li key={scope} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                  <span className="min-w-0 text-[12px] text-muted-foreground">
                    {SCOPE_LABELS[scope] ?? (
                      // Unknown scope: show exactly what Google granted rather
                      // than a friendly guess at what it means.
                      <span className="break-all font-mono text-[11px]">{scope}</span>
                    )}
                  </span>
                </li>
              ))
            )}
          </ul>
        </div>
      </Card>

      <DisconnectDialog
        connection={connection}
        label={label}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
      />
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "connected") {
    return (
      <Badge variant="hit" size="sm" className="tracking-wider">
        Connected
      </Badge>
    );
  }
  if (status === "needs_reauth") {
    return (
      <Badge variant="near" size="sm" className="tracking-wider">
        Needs re-auth
      </Badge>
    );
  }
  if (status === "revoked") {
    return (
      <Badge variant="danger" size="sm" className="tracking-wider">
        Revoked
      </Badge>
    );
  }
  // An unrecognised status is shown as it is rather than mapped to a
  // reassuring one — this column exists to be trusted.
  return (
    <Badge variant="neutral" size="sm" className="tracking-wider">
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

/**
 * The revenue column, as six distinguishable states rather than a tick or a
 * cross.
 *
 * "Not read yet", "we were never given permission to ask", "we asked and
 * YouTube refused to answer", "we asked and every day came back zero", "we
 * asked and it failed" and "working" are six different situations with six
 * different next actions. Collapsing any of them into "no revenue" would put a
 * figure of zero in somebody's head that the data never supported.
 *
 * "Refused a report" and "Reported no revenue" are close together in wording on
 * purpose, because the states are close together in fact and the difference is
 * the whole point: one is what YouTube refused to say, the other is what it
 * said. Neither says why. The refusal badge used to read "No revenue to
 * report", which is a third thing again — a claim that the money does not
 * exist, from a response that only ever said we could not have it.
 */
function RevenueStatusBadge({ connection }: { connection: YouTubeConnectionDTO }) {
  if (!connection.revenueScopeGranted) {
    return (
      <Badge variant="near" size="sm" className="tracking-wider">
        Reconnect to enable
      </Badge>
    );
  }

  switch (connection.revenueSyncStatus) {
    case "ok":
      return (
        <Badge variant="hit" size="sm" className="tracking-wider">
          Syncing
        </Badge>
      );
    case "not_monetized":
      return (
        <Badge variant="neutral" size="sm" className="tracking-wider">
          Refused a report
        </Badge>
      );
    case "reported_zero":
      return (
        <Badge variant="neutral" size="sm" className="tracking-wider">
          Reported no revenue
        </Badge>
      );
    case "error":
      return (
        <Badge variant="danger" size="sm" className="tracking-wider">
          Failed
        </Badge>
      );
    case "no_scope":
      return (
        <Badge variant="near" size="sm" className="tracking-wider">
          Reconnect to enable
        </Badge>
      );
    default:
      return (
        <Badge variant="neutral" size="sm" className="tracking-wider">
          Not read yet
        </Badge>
      );
  }
}

/**
 * When the scheduler will look again.
 *
 * A time in the past is shown as "due on the next run" rather than as "2 hours
 * ago", which would read as though something had already happened. The
 * scheduler wakes on its own cadence, so a passed due time means waiting, not
 * failing.
 */
function NextSyncValue({ nextSyncAt, now }: { nextSyncAt: number | null; now: number }) {
  if (nextSyncAt === null) {
    return (
      <span className="text-subtle-foreground">
        After the first sync of this connection
      </span>
    );
  }
  if (now !== 0 && nextSyncAt <= now) {
    return <span>Due on the next run</span>;
  }
  return (
    <span title={formatDateTime(nextSyncAt)}>
      {formatRelativeTime(nextSyncAt, now === 0 ? undefined : now)}
    </span>
  );
}

interface RevenueNoticeContent {
  readonly tone: "warning" | "danger" | "info";
  readonly icon: "alert" | "coins" | "clock";
  readonly body: React.ReactNode;
  /** True when the fix is a fresh consent, so the banner offers the button. */
  readonly offerReconnect: boolean;
}

/**
 * What to DO about this connection's revenue state.
 *
 * EVERY state gets a sentence, including the working one, and every sentence
 * names the next step — even when that step is "nothing, and here is where the
 * money will show up". This function used to return null for a healthy
 * connection, which sounds like restraint and is not: a screen that speaks only
 * when something is broken leaves "it is working" and "nobody has told you yet"
 * looking identical, and the person reading it has no way to tell whether the
 * setup they just finished actually finished.
 *
 * The states are genuinely distinct and each one has a different next action:
 * the permission was never granted (reconnect), YouTube refused a report at all
 * (wait, nothing to fix), YouTube answered with nothing but zeros (wait, and
 * here is why that probably is), the last read failed (act on the error),
 * nothing has been read yet (press sync or wait for the scheduler), and it is
 * working (go and look at the ledger). Collapsing any pair of these into one
 * message throws away the only thing this screen knows that the reader does
 * not.
 */
function revenueNoticeFor(connection: YouTubeConnectionDTO): RevenueNoticeContent {
  if (!connection.revenueScopeGranted) {
    return {
      tone: "warning",
      icon: "alert",
      body:
        "This connection cannot read revenue. Either it was authorised before Northstar HQ asked " +
        "for that permission, or the separate YouTube Analytics permission was unticked on " +
        "Google's consent screen. Reconnect the account and leave every permission ticked to " +
        "enable revenue — channel and video syncing is unaffected either way.",
      offerReconnect: true,
    };
  }

  if (connection.revenueSyncStatus === "not_monetized") {
    return {
      tone: "info",
      icon: "coins",
      // The service composes this sentence and hedges it, because the refusal
      // has two readings and Google's response does not choose between them.
      // The fallback below is for a row written before that message existed and
      // therefore has to hedge in the same terms — a fallback that named only
      // the Partner Programme would quietly reintroduce the claim the message
      // above was rewritten to stop making.
      body:
        connection.revenueSyncError ??
        "YouTube refused to produce a revenue report for this channel even though this connection " +
          "has permission to read one. That is its answer for a channel outside the YouTube " +
          "Partner Programme — and also for a channel the Google account behind this connection " +
          "no longer owns; the refusal does not say which. If the channel IS monetised, reconnect " +
          "using the account that owns it. Otherwise nothing needs fixing, and figures will start " +
          "appearing on their own once the channel is in the programme.",
      offerReconnect: false,
    };
  }

  /**
   * What was OBSERVED, then the likeliest reason for it, in that order and in
   * different voices.
   *
   * This branch used to be folded into the one above, which stated "this
   * channel is not in the YouTube Partner Programme" as a finding. It was not
   * one. A window of zeros is a report YouTube sent; the Partner Programme is
   * our reading of that report, and a small channel earning fractions of a cent
   * a day sends exactly the same zeros. The service composes the sentence
   * because it is the half of this that knows which days were read and whether
   * this channel has ever reported revenue before; the fallback below is for a
   * row written before that message existed.
   */
  if (connection.revenueSyncStatus === "reported_zero") {
    return {
      tone: "info",
      icon: "coins",
      body:
        connection.revenueSyncError ??
        "YouTube reported no revenue for this channel over the period it was last read for. The " +
          "likeliest explanation is that the channel is not in the YouTube Partner Programme, " +
          "though a channel earning fractions of a cent a day reports the same zeros. Nothing " +
          "needs fixing either way — figures appear on their own once there are any.",
      offerReconnect: false,
    };
  }

  if (connection.revenueSyncStatus === "error") {
    return {
      tone: "danger",
      icon: "alert",
      body:
        connection.revenueSyncError ??
        "Revenue could not be read on the last run, and no reason was recorded. Press “Sync " +
          "revenue now” to try again and capture the error.",
      offerReconnect: false,
    };
  }

  // "ok" with a message means the run succeeded but something in it is worth
  // mentioning — a month that could not be converted, for instance. Reported as
  // a warning rather than folded into the success sentence, because the run
  // genuinely did both things.
  if (connection.revenueSyncStatus === "ok" && connection.revenueSyncError) {
    return {
      tone: "warning",
      icon: "alert",
      body: connection.revenueSyncError,
      offerReconnect: false,
    };
  }

  if (connection.revenueSyncStatus === "ok") {
    return {
      tone: "info",
      icon: "coins",
      body: (
        <>
          Revenue is importing for this channel. It arrives as one entry per month in{" "}
          <Link
            href="/finance/entries"
            className="text-accent underline-offset-2 hover:underline"
          >
            Finance &rarr; Entries
          </Link>
          , marked <strong className="text-foreground">Est</strong> because YouTube revises
          these figures at month end. Nothing here needs doing.
        </>
      ),
      offerReconnect: false,
    };
  }

  // Scope granted, no verdict yet: the permission is in place and the first
  // read simply has not happened. Distinct from every failure above, and the
  // one state where the sync button is the actual answer.
  return {
    tone: "info",
    icon: "clock",
    body: "The revenue permission is granted, but no figures have been read yet. Press “Sync revenue now” to read them immediately, or leave it — the scheduler will do it on its next run, shown below.",
    offerReconnect: false,
  };
}

const NOTICE_ICONS = {
  alert: AlertTriangle,
  coins: Coins,
  clock: Clock,
} as const;

function RevenueNotice({ connection }: { connection: YouTubeConnectionDTO }) {
  const notice = revenueNoticeFor(connection);
  const Icon = NOTICE_ICONS[notice.icon];

  return (
    <div
      className={cn(
        "mx-4 mt-3 flex items-start gap-2.5 rounded-lg border px-3 py-2.5",
        notice.tone === "warning" && "border-warning/25 bg-warning-subtle",
        notice.tone === "danger" && "border-danger/25 bg-danger-subtle",
        notice.tone === "info" && "border-border bg-surface-sunken",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          notice.tone === "warning" && "text-warning",
          notice.tone === "danger" && "text-danger",
          notice.tone === "info" && "text-subtle-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] leading-relaxed text-muted-foreground">{notice.body}</p>
        {notice.offerReconnect ? (
          <div className="mt-2">
            <ConnectButton label="Reconnect to enable revenue" variant="secondary" icon={<RefreshCw />} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
        {label}
      </dt>
      <dd className="mt-1 truncate text-[12px] text-muted-foreground">{children}</dd>
    </div>
  );
}

function DisconnectDialog({
  connection,
  label,
  open,
  onOpenChange,
}: {
  connection: YouTubeConnectionDTO;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const disconnect = useDisconnectYouTube();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect {label}?</DialogTitle>
          <DialogDescription>
            Access is withdrawn at Google as well as here.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-2.5">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Northstar HQ revokes the authorisation in{" "}
            {connection.googleAccountEmail ?? "this Google account"} and then deletes its
            stored tokens. The grant will no longer appear in that account&rsquo;s Google
            security settings, and syncing this channel&rsquo;s private figures stops
            immediately.
          </p>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Nothing is removed from your tracker. The channel, its Shorts and every figure
            already collected stay exactly as they are — this is about credentials, not
            about your research. Connecting the account again restores the sync.
          </p>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={disconnect.isPending}
            onClick={() =>
              disconnect.mutate(connection.id, {
                onSuccess: ({ revokedAtGoogle }) => {
                  onOpenChange(false);
                  // The one thing about a disconnection that can silently go
                  // wrong. The local tokens are gone either way, but reporting
                  // a clean revocation that did not happen would leave a live
                  // grant nobody knows to remove.
                  if (revokedAtGoogle) {
                    toast.success(`Disconnected ${label}`, {
                      description: "The authorisation was revoked at Google.",
                    });
                  } else {
                    toast.warning(`Disconnected ${label} locally`, {
                      description:
                        "Google did not confirm the revocation. Remove Northstar HQ from the account's third-party access at myaccount.google.com/permissions.",
                    });
                  }
                },
                onError: (error) =>
                  toast.error("Could not disconnect that account", {
                    description: error instanceof Error ? error.message : undefined,
                  }),
              })
            }
          >
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Not configured
// ---------------------------------------------------------------------------

const ENV_DESCRIPTIONS: Readonly<Record<string, string>> = {
  GOOGLE_CLIENT_ID: "The OAuth 2.0 client ID from the Google Cloud console.",
  GOOGLE_CLIENT_SECRET: "The client secret issued alongside that ID. Server-side only.",
  APP_ENCRYPTION_KEY:
    "Encrypts the stored refresh token. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
  APP_URL:
    "The app's own origin. The redirect URI is derived from it, never from the request, so it cannot be spoofed.",
};

/**
 * What to set, and where to register it.
 *
 * A connect button is deliberately absent: it would 302 straight back here with
 * `error=not_configured`, which teaches nobody anything. Naming the exact
 * variables and the exact redirect URI is the whole content of this screen
 * until they are set.
 */
function SetupCard({ google }: { google: GoogleOAuthStatusDTO }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Google OAuth is not configured</CardTitle>
        <CardDescription>
          Connecting a Google account is optional, so the app runs without these — but the
          connect flow cannot start until they are set in{" "}
          <code className="rounded bg-surface-hover px-1 py-0.5 text-[11px]">.env.local</code>{" "}
          and the server is restarted.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
            Still to set
          </div>
          {google.missing.map((name) => (
            <div
              key={name}
              className="rounded-lg border border-warning/25 bg-warning-subtle px-3 py-2.5"
            >
              <code className="text-[12px] font-medium text-foreground">{name}</code>
              {ENV_DESCRIPTIONS[name] ? (
                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                  {ENV_DESCRIPTIONS[name]}
                </p>
              ) : null}
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
            Authorised redirect URI
          </div>
          {google.redirectUri ? (
            <>
              <CopyableValue value={google.redirectUri} />
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                Register this exactly, byte for byte, under{" "}
                <em>APIs &amp; Services → Credentials → your OAuth client → Authorised
                redirect URIs</em>. Google rejects the sign-in if it differs by so much as a
                trailing slash.
              </p>
            </>
          ) : (
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              The redirect URI cannot be derived until{" "}
              <code className="rounded bg-surface-hover px-1 py-0.5 text-[11px]">APP_URL</code>{" "}
              is set. Set it first, then this page will show the exact value to register.
            </p>
          )}
        </div>

        <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-[12px] leading-relaxed text-muted-foreground">
          <li>
            Open{" "}
            <a
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline-offset-2 hover:underline"
            >
              Google Cloud Console → Credentials
            </a>{" "}
            and create an <strong className="text-foreground">OAuth client ID</strong> of
            type <em>Web application</em>.
          </li>
          {/*
            TWO APIs, not one.
            Revenue does not come from the Data API — it comes from the YouTube
            Analytics API, which is a separate entry in the Library and is off by
            default. Enabling only the first one produces a connection that reads
            channel data perfectly and then fails every revenue report with a 403,
            which is an hour of debugging nobody should have to do.
          */}
          <li>
            Under <em>APIs &amp; Services → Library</em>, enable{" "}
            <strong className="text-foreground">YouTube Data API v3</strong> for the same
            project.
          </li>
          <li>
            In the same Library, also enable{" "}
            <strong className="text-foreground">YouTube Analytics API</strong>. This is a
            separate API and revenue reporting will not work without it — channel data
            would sync normally while every revenue figure failed.
          </li>
          <li>Add the redirect URI above to that client.</li>
          <li>
            Copy the client ID and secret into{" "}
            <code className="rounded bg-surface-hover px-1 py-0.5 text-[11px]">.env.local</code>
            , then restart the server.
          </li>
        </ol>
      </CardContent>
    </Card>
  );
}

function CopyableValue({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-2">
      <code className="min-w-0 flex-1 break-all text-[12px] text-foreground">{value}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy redirect URI"
        className="shrink-0"
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => toast.success("Redirect URI copied"))
            .catch(() =>
              toast.error("Could not copy", {
                description: "Select the value and copy it by hand.",
              }),
            );
        }}
      >
        <Copy />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The result of a consent flow
// ---------------------------------------------------------------------------

interface Outcome {
  readonly tone: "success" | "warning" | "danger";
  readonly title: string;
  readonly body: string;
}

/**
 * The result Google's callback left in the query string, shown once and then
 * tidied away.
 *
 * The message is read from `useSearchParams` and latched into state on the
 * first render, rather than pulled out of `window.location` in an effect. Two
 * reasons: the server and the client see the same parameters, so the markup
 * matches on hydration; and the effect is then free to do the one thing an
 * effect should — push a change to an external system, here the address bar.
 *
 * Latching matters because that clean-up removes the very parameters the
 * message was derived from. Re-deriving on the next render would make the
 * banner vanish the instant it appeared.
 *
 * `replaceState` rather than `push` so Back leaves the admin area instead of
 * replaying a message about something that already happened, and so a reload or
 * a shared link does not resurrect it. Nothing is invalidated on success: the
 * callback is a server redirect, so this page arrived on a fresh document load
 * with an empty query cache.
 */
function OAuthOutcome() {
  const searchParams = useSearchParams();
  const [outcome] = React.useState(() => readOutcome(searchParams));

  React.useEffect(() => {
    if (!outcome) return;
    window.history.replaceState(null, "", window.location.pathname);
  }, [outcome]);

  return outcome ? <OutcomeBanner outcome={outcome} /> : null;
}

/** Structural so it accepts both `URLSearchParams` and Next's readonly wrapper. */
function readOutcome(params: Pick<URLSearchParams, "get">): Outcome | null {
  if (params.get("connected") === "1") {
    // "Connected, but this account owns no channel" is a real outcome that
    // would otherwise look like a silent failure.
    return params.get("linked") === "1"
      ? {
          tone: "success",
          title: "Google account connected",
          body: "The channel it owns is now tracked as one of yours, and will sync with its own figures from the next run.",
        }
      : {
          tone: "warning",
          title: "Google account connected, but no channel was found",
          body: "This account does not own a YouTube channel, so nothing was added to the tracker. Connect the account that owns the channel instead.",
        };
  }

  const error = params.get("error");
  if (!error) return null;

  switch (error) {
    case "denied":
      return {
        tone: "warning",
        title: "Access was not granted",
        body: "Consent was declined on Google's screen, so nothing was connected and nothing changed.",
      };
    case "invalid_state":
      return {
        tone: "danger",
        title: "That sign-in could not be verified",
        body: "The request did not match the one this browser started, so it was discarded without being used. Start again from this page.",
      };
    case "missing_code":
      return {
        tone: "danger",
        title: "Google did not return an authorisation code",
        body: "Nothing was connected. Try again, and if it repeats, check the OAuth client's redirect URI.",
      };
    case "not_configured":
      return {
        tone: "danger",
        title: "Google OAuth is not configured on this deployment",
        body: "The connect flow cannot start until the environment variables below are set and the server is restarted.",
      };
    default:
      return {
        tone: "danger",
        title: "Could not connect that account",
        // The callback only ever forwards this app's own error text; Google's
        // error_description is deliberately kept out of anything user-facing.
        body:
          params.get("message") ??
          "The connection failed partway through. Nothing was saved — try again.",
      };
  }
}

function OutcomeBanner({ outcome }: { outcome: Outcome }) {
  const [dismissed, setDismissed] = React.useState(false);
  if (dismissed) return null;

  const Icon = outcome.tone === "success" ? CheckCircle2 : AlertTriangle;

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-4 py-3",
        outcome.tone === "success" && "border-success/25 bg-success-subtle",
        outcome.tone === "warning" && "border-warning/25 bg-warning-subtle",
        outcome.tone === "danger" && "border-danger/25 bg-danger-subtle",
      )}
      role="status"
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          outcome.tone === "success" && "text-success",
          outcome.tone === "warning" && "text-warning",
          outcome.tone === "danger" && "text-danger",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{outcome.title}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
          {outcome.body}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        className="-mr-1 -mt-1 shrink-0"
        onClick={() => setDismissed(true)}
      >
        <X />
      </Button>
    </div>
  );
}
