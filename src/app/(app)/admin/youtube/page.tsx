"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
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
        description="Google accounts that have authorised Northstar HQ to read your channel data. Each connection is what lets your own channels be synced with their real figures rather than only the public ones."
        actions={
          google?.configured ? <ConnectButton label="Connect YouTube account" /> : null
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
          {/*
            Said on the screen where somebody is about to grant access, because
            that is the only moment the sentence is worth anything. It is also
            simply true: OAUTH_SCOPES in youtube-oauth-service.ts asks for
            youtube.readonly and nothing that can write.
          */}
          <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-sunken px-4 py-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Northstar HQ requests <strong className="text-foreground">read-only</strong>{" "}
              access. It can see your channels, videos and their statistics; it cannot
              upload, edit, comment, or delete anything on a connected channel — no write
              scope is ever requested, so the permission to do so does not exist.
            </p>
          </div>

          {connections.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Youtube />}
                title="No Google accounts connected"
                description="Connect the account that owns your channels. Northstar HQ will then read their figures directly instead of relying on what YouTube shows the public."
                action={<ConnectButton label="Connect YouTube account" size="md" />}
              />
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {connections.map((connection) => (
                <ConnectionCard key={connection.id} connection={connection} />
              ))}
            </div>
          )}
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
}: {
  label: string;
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
  icon?: React.ReactNode;
}) {
  return (
    <Button asChild variant={variant} size={size}>
      <a href={YOUTUBE_CONNECT_PATH}>
        {icon ?? <Plug />}
        {label}
      </a>
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

          <div className="flex shrink-0 items-center gap-2">
            {!healthy ? (
              <ConnectButton
                label="Reconnect"
                variant="secondary"
                icon={<RefreshCw />}
              />
            ) : null}
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
          <li>
            Under <em>APIs &amp; Services → Library</em>, enable{" "}
            <strong className="text-foreground">YouTube Data API v3</strong> for the same
            project.
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
