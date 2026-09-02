"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Database,
  KeyRound,
  Lock,
  Moon,
  Palette,
  RefreshCw,
  ShieldCheck,
  Sun,
  UserRound,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useSession } from "@/components/providers/session-provider";
import { useTheme } from "@/components/providers/theme-provider";
import { api } from "@/lib/api-client";
import type { MyProfileDTO, OrganizationSettingsDTO, PersonalSettingsDTO } from "@/lib/dto";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { DATASET_KEY } from "@/hooks/use-dataset";
import { VIEWS_GAINED_KEY } from "@/hooks/use-views-gained";
import { THRESHOLD_PRESETS } from "@/lib/analytics/constants";
import {
  ENGAGED_VIEWS_GLOSS,
  ENGAGED_VIEW_SHARE_IMPLAUSIBLE_ABOVE_BASIS_POINTS,
  ENGAGED_VIEW_SHARE_IMPLAUSIBLE_BELOW_BASIS_POINTS,
  MAX_ENGAGED_VIEW_SHARE_BASIS_POINTS,
  MIN_ENGAGED_VIEW_SHARE_BASIS_POINTS,
  formatEngagedViewShare,
  normalizeEngagedViewShare,
} from "@/lib/analytics/niche-rpm";
import { formatCompactNumber, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Settings.
 *
 * Split along the line that actually matters: WHOSE setting is it.
 *
 *   • Your account — name, email, password. Personal state. Everyone gets it,
 *     and nobody but the account holder can change it.
 *   • Organization — analysis defaults, the collection window, the YouTube
 *     configuration, the currency. One row for the whole team, so changing any
 *     of it changes what a colleague sees. `settings.manage` only.
 *
 * The gate below hides the organization cards from an employee, which is an
 * affordance and NOT the control. The control is in the service: both the read
 * and the write of OrganizationSettings call `requirePermission` before they
 * touch the row, so an employee who calls /api/settings/organization directly
 * gets the same 403 the sidebar is quietly saving them from discovering.
 *
 * The environment group stays read-only for everyone who can see it at all:
 * secrets belong in `.env.local`, never in a form that would persist them to a
 * database or echo them back over the wire.
 */
export default function SettingsPage() {
  const session = useSession();
  const canManageOrganization = session.can("settings.manage");

  const profile = useQuery({ queryKey: PROFILE_KEY, queryFn: api.getMyProfile });

  const personal = useQuery({ queryKey: SETTINGS_KEY, queryFn: api.getSettings });

  const organization = useQuery({
    queryKey: ORG_SETTINGS_KEY,
    queryFn: api.getOrganizationSettings,
    // Not merely "do not render it": do not REQUEST it. Firing a call that is
    // guaranteed to 403 would fill an employee's console with authorization
    // failures for a page they opened legitimately.
    enabled: canManageOrganization,
  });

  if (profile.error) {
    return (
      <PageContainer>
        <Card>
          <ErrorState error={profile.error} onRetry={() => profile.refetch()} />
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex max-w-3xl flex-col gap-5">
      <PageHeader
        title="Settings"
        description={
          canManageOrganization
            ? "Your account, and the defaults and collection behaviour for the whole organization."
            : "Your account and your personal preferences."
        }
      />

      {profile.isLoading || !profile.data ? (
        <Skeleton className="h-64 w-full rounded-lg" />
      ) : (
        <AccountCard profile={profile.data.profile} />
      )}

      <AppearanceCard />

      {canManageOrganization ? (
        <OrganizationSection query={organization} />
      ) : (
        <TeamDefaultsNotice settings={personal.data?.settings} />
      )}
    </PageContainer>
  );
}

const PROFILE_KEY = ["profile"] as const;
const SETTINGS_KEY = ["settings"] as const;
const ORG_SETTINGS_KEY = ["settings", "organization"] as const;

// ---------------------------------------------------------------------------
// PERSONAL
// ---------------------------------------------------------------------------

/**
 * Your name, your email, your password.
 *
 * Two forms rather than one, because the server refuses a request that carries
 * both a password change and a profile change — the two writes are not atomic,
 * and a half-applied submit is worse than a second button. Splitting them here
 * means the UI cannot construct the request the API rejects.
 */
function AccountCard({ profile }: { profile: MyProfileDTO }) {
  const queryClient = useQueryClient();

  const [name, setName] = React.useState(profile.name ?? "");
  const [email, setEmail] = React.useState(profile.email ?? "");
  const [detailsPassword, setDetailsPassword] = React.useState("");

  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");

  const emailChanging = email.trim().toLowerCase() !== (profile.email ?? "").toLowerCase();
  const detailsDirty = name.trim() !== (profile.name ?? "") || emailChanging;

  const saveDetails = useMutation({
    mutationFn: () =>
      api.updateMyProfile({
        name: name.trim(),
        email: email.trim(),
        // Only sent when it is actually needed. The server asks for it on an
        // email change and nothing else, so sending it unconditionally would
        // train people to type their password to rename themselves.
        ...(emailChanging ? { currentPassword: detailsPassword } : {}),
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(PROFILE_KEY, { profile: result.profile });
      setDetailsPassword("");
      toast.success(result.emailChanged ? "Email address updated" : "Profile updated");
    },
    onError: (error) =>
      toast.error("Could not save your details", {
        description: error instanceof Error ? error.message : undefined,
      }),
  });

  const savePassword = useMutation({
    mutationFn: () => api.updateMyProfile({ currentPassword, newPassword }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      toast.success("Password changed", {
        description: "Every other device has been signed out.",
      });
    },
    onError: (error) =>
      toast.error("Could not change your password", {
        description: error instanceof Error ? error.message : undefined,
      }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserRound className="size-4 text-subtle-foreground" />
          Your account
        </CardTitle>
        <CardDescription>
          Yours alone. Nobody else can change these, and no administrator can
          set your password — they can only send you a reset link.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            saveDetails.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                id="profile-name"
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="profile-email">Email address</Label>
              <Input
                id="profile-email"
                type="email"
                value={email}
                maxLength={320}
                onChange={(event) => setEmail(event.target.value)}
              />
              <FieldHint>This is what you sign in with.</FieldHint>
            </div>
          </div>

          {emailChanging ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="profile-confirm">Current password</Label>
              <Input
                id="profile-confirm"
                type="password"
                autoComplete="current-password"
                value={detailsPassword}
                onChange={(event) => setDetailsPassword(event.target.value)}
              />
              <FieldHint>
                Required to move the address you sign in with — it is also where
                password-reset links are sent.
              </FieldHint>
            </div>
          ) : null}

          <div>
            <Button
              type="submit"
              size="sm"
              disabled={
                !detailsDirty ||
                saveDetails.isPending ||
                (emailChanging && detailsPassword.length === 0)
              }
            >
              Save details
            </Button>
          </div>
        </form>

        <form
          className="flex flex-col gap-4 border-t border-border pt-5"
          onSubmit={(event) => {
            event.preventDefault();
            savePassword.mutate();
          }}
        >
          <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
            <Lock className="size-4 text-subtle-foreground" />
            Change password
          </span>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="password-current">Current password</Label>
              <Input
                id="password-current"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password-new">New password</Label>
              <Input
                id="password-new"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <FieldHint>At least {MIN_PASSWORD_LENGTH} characters.</FieldHint>
            </div>
          </div>

          <div>
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={
                savePassword.isPending ||
                currentPassword.length === 0 ||
                newPassword.length < MIN_PASSWORD_LENGTH
              }
            >
              Change password
            </Button>
          </div>
          <FieldHint>Changing it signs out every other device.</FieldHint>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Light or dark.
 *
 * The only preference on this page that is not stored on the server, and that
 * is deliberate rather than an omission: the theme class is applied by a
 * blocking script before first paint, from `localStorage`, so that the app
 * never flashes the wrong palette on load. A value that has to come back from
 * an API cannot be read before the first paint, so persisting it server-side
 * would either reintroduce the flash or leave two sources of truth that
 * disagree for the first second of every page load.
 *
 * The same control is in the sidebar, and it has to be — this is a preference
 * people flip when the room's lighting changes, not something they navigate to
 * Settings for. It is repeated here because Settings is where somebody looks
 * for it, and both call the same `useTheme`, so they cannot drift.
 *
 * NOT SHOWN HERE: the stored `defaultSortKey` / `defaultSortDirection` pair.
 * The service accepts them and `api.updateSettings` can send them, but nothing
 * in the app reads them back yet — no table seeds its sort from either. A
 * control that saves a value no screen consumes is worse than no control: it
 * reports success and changes nothing. It belongs here the moment a table
 * honours it.
 */
function AppearanceCard() {
  // `ready` is false during SSR and the first hydration pass, when the stored
  // theme is not yet known. Rendering a selected state before then would be a
  // hydration mismatch against markup that always assumes dark.
  const { theme, setTheme, ready } = useTheme();

  const options = [
    { value: "dark" as const, label: "Dark", icon: Moon },
    { value: "light" as const, label: "Light", icon: Sun },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette className="size-4 text-subtle-foreground" />
          Appearance
        </CardTitle>
        <CardDescription>
          How this app looks on this device. It changes nothing anybody else
          sees.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {/*
          Toggle buttons with `aria-pressed`, not a `radiogroup`. The radio
          pattern promises one tab stop and arrow-key movement between options;
          these are two ordinary buttons and each is its own tab stop, so
          claiming the role would describe behaviour that is not there.
        */}
        <div
          role="group"
          aria-label="Theme"
          className="inline-flex gap-1 rounded-lg border border-border bg-surface-sunken p-1"
        >
          {options.map((option) => {
            const selected = ready && theme === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => setTheme(option.value)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
                  selected
                    ? "bg-surface-raised text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.16)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <option.icon className="size-3.5" />
                {option.label}
              </button>
            );
          })}
        </div>

        <FieldHint className="mt-2">
          Saved in this browser, so a different computer starts on dark again.
        </FieldHint>
      </CardContent>
    </Card>
  );
}

/**
 * What an employee sees where the organization cards would be.
 *
 * The two defaults are shown because they are already theirs to see — every
 * chart is drawn with them, and the app hands both to the browser to seed the
 * filters. Showing them read-only, with who owns them, is more useful than an
 * empty page and more honest than a disabled form.
 */
function TeamDefaultsNotice({ settings }: { settings: PersonalSettingsDTO | undefined }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization defaults</CardTitle>
        <CardDescription>
          Set once for the whole team by an administrator, so a hit rate means
          the same thing to everyone looking at it.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {settings ? (
          <>
            <ReadOnlyRow
              label="Default hit threshold"
              value={`${formatNumber(settings.defaultThreshold)} views`}
            />
            <ReadOnlyRow
              label="Default period"
              value={`${settings.defaultPeriodDays} days`}
            />
          </>
        ) : (
          <Skeleton className="h-20 w-full rounded-lg" />
        )}
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          A niche can set its own threshold, which overrides this one for its
          channels. Ask an administrator if either number is wrong for your work.
        </p>
      </CardContent>
    </Card>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-sunken px-3.5 py-3">
      <span className="text-[13px] text-foreground">{label}</span>
      <span className="tnum text-[13px] font-medium text-foreground">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ORGANIZATION — `settings.manage` only
// ---------------------------------------------------------------------------

type OrganizationPatch = Partial<Omit<OrganizationSettingsDTO, "baseCurrency">>;

function OrganizationSection({
  query,
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.getOrganizationSettings>>>>;
}) {
  const queryClient = useQueryClient();

  const update = useMutation({
    mutationFn: (patch: OrganizationPatch) => api.updateOrganizationSettings(patch),
    onSuccess: ({ organization }) => {
      queryClient.setQueryData(ORG_SETTINGS_KEY, (prev: typeof query.data) =>
        prev ? { ...prev, organization } : prev,
      );
      // The two analysis defaults also travel in the personal payload, and the
      // lookback changes how much history the dataset returns.
      queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
      queryClient.invalidateQueries({ queryKey: DATASET_KEY });
      // The engaged-view share on every niche's RPM resolution travels in the
      // dataset, but the gains it multiplies are this payload's — refetch both
      // so a changed assumption cannot price yesterday's deltas.
      queryClient.invalidateQueries({ queryKey: VIEWS_GAINED_KEY });
      toast.success("Settings saved");
    },
    onError: (error) =>
      toast.error("Could not save settings", {
        description: error instanceof Error ? error.message : undefined,
      }),
  });

  if (query.error) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      </Card>
    );
  }

  if (query.isLoading || !query.data) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  const { organization, config } = query.data;

  return (
    <>
      <ConfigurationCard config={config} companyName={organization.companyName} />
      <DefaultsCard
        settings={organization}
        onChange={(patch) => update.mutate(patch)}
        saving={update.isPending}
      />
      <EngagedViewsCard
        settings={organization}
        onChange={(patch) => update.mutate(patch)}
        saving={update.isPending}
      />
      <RefreshCard
        settings={organization}
        onChange={(patch) => update.mutate(patch)}
        saving={update.isPending}
      />
      <ShortsDetectionCard
        settings={organization}
        probeEnabledInEnv={config.probeEnabledInEnv}
        onChange={(patch) => update.mutate(patch)}
      />
    </>
  );
}

function ConfigurationCard({
  config,
  companyName,
}: {
  config: { hasApiKey: boolean; databaseProvider: string; lookbackDays: number };
  companyName: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Server configuration</CardTitle>
        <CardDescription>
          Read from environment variables at startup. Change these in{" "}
          <code className="rounded bg-surface-hover px-1 py-0.5 text-[11px]">.env.local</code>{" "}
          and restart the server.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <StatusRow
          icon={<KeyRound />}
          label="YouTube Data API v3 key"
          ok={config.hasApiKey}
          okText="Configured"
          badText="Not configured"
        />

        {!config.hasApiKey ? (
          <div className="rounded-lg border border-warning/25 bg-warning-subtle p-3.5">
            <p className="text-[13px] font-medium text-foreground">Set up your API key</p>
            <ol className="mt-2 flex list-decimal flex-col gap-1 pl-4 text-[12px] leading-relaxed text-muted-foreground">
              <li>
                Open{" "}
                <a
                  href="https://console.cloud.google.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent underline-offset-2 hover:underline"
                >
                  Google Cloud Console
                </a>{" "}
                and create or select a project.
              </li>
              <li>
                Under <em>APIs &amp; Services → Library</em>, enable{" "}
                <strong className="text-foreground">YouTube Data API v3</strong>.
              </li>
              <li>
                Under <em>Credentials</em>, create an API key.
              </li>
              <li>
                Add it to{" "}
                <code className="rounded bg-surface-hover px-1 py-0.5 text-[11px]">
                  .env.local
                </code>{" "}
                as{" "}
                <code className="rounded bg-surface-hover px-1 py-0.5 text-[11px]">
                  YOUTUBE_API_KEY=your-key
                </code>
                , then restart the dev server.
              </li>
            </ol>
            <p className="mt-2.5 text-[11px] leading-relaxed text-subtle-foreground">
              The default quota is 10,000 units per day. A full channel refresh
              costs roughly 1 unit per 50 videos, so this comfortably supports
              dozens of channels refreshed several times a day.
            </p>
          </div>
        ) : null}

        <StatusRow
          icon={<Database />}
          label="Database"
          ok
          okText={config.databaseProvider === "sqlite" ? "SQLite (local file)" : "PostgreSQL"}
          badText=""
        />

        <div className="rounded-lg border border-border bg-surface-sunken p-3 text-[12px] leading-relaxed text-muted-foreground">
          History window: <strong className="text-foreground">{config.lookbackDays} days</strong>.
          Each refresh walks a channel&rsquo;s uploads back this far, which is
          what makes the 180-day period and custom ranges possible.
        </div>

        <div className="rounded-lg border border-border bg-surface-sunken p-3 text-[12px] leading-relaxed text-muted-foreground">
          Reports and payroll summaries are branded{" "}
          <strong className="text-foreground">{companyName}</strong>.
        </div>
      </CardContent>
    </Card>
  );
}

function StatusRow({
  icon,
  label,
  ok,
  okText,
  badText,
}: {
  icon: React.ReactNode;
  label: string;
  ok: boolean;
  okText: string;
  badText: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-sunken px-3.5 py-3">
      <span className="flex items-center gap-2.5 text-[13px] text-foreground [&_svg]:size-4 [&_svg]:text-subtle-foreground">
        {icon}
        {label}
      </span>
      <span
        className={cn(
          "flex items-center gap-1.5 text-[12px]",
          ok ? "text-success" : "text-warning",
        )}
      >
        {ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
        {ok ? okText : badText}
      </span>
    </div>
  );
}

function DefaultsCard({
  settings,
  onChange,
  saving,
}: {
  settings: OrganizationSettingsDTO;
  onChange: (patch: OrganizationPatch) => void;
  saving: boolean;
}) {
  const [customThreshold, setCustomThreshold] = React.useState(
    String(settings.defaultThreshold),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Analysis defaults</CardTitle>
        <CardDescription>
          The threshold and period every colleague&rsquo;s dashboard opens with.
          One row for the whole team — a hit rate two people disagree about is
          not a metric. Changing either on a page only affects that session.
          {/* Said here because this is the screen that sets the number, and its
              reach is narrower than it looks: a selected niche uses its own
              threshold, or reports no hit rate at all if it has none. */}{" "}
          This threshold applies when no niche is selected; each niche is scored
          at its own, and a niche with none reports no hit rate until an Admin
          sets one.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label>Default hit threshold</Label>
          <div className="flex flex-wrap gap-1.5">
            {THRESHOLD_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                disabled={saving}
                onClick={() => {
                  setCustomThreshold(String(preset));
                  onChange({ defaultThreshold: preset });
                }}
                className={cn(
                  "tnum rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors",
                  settings.defaultThreshold === preset
                    ? "border-accent bg-accent-subtle text-foreground"
                    : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
                )}
              >
                ≥ {formatCompactNumber(preset)}
              </button>
            ))}
          </div>

          <div className="mt-1 flex items-center gap-2">
            <Input
              value={customThreshold}
              inputMode="numeric"
              onChange={(event) => setCustomThreshold(event.target.value)}
              className="h-8 w-40 text-[13px]"
              aria-label="Custom default threshold"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={saving}
              onClick={() => {
                const parsed = Number(customThreshold.replace(/[,\s_]/g, ""));
                if (!Number.isFinite(parsed) || parsed < 1) {
                  toast.error("Enter a positive number");
                  return;
                }
                onChange({ defaultThreshold: Math.trunc(parsed) });
              }}
            >
              Set custom
            </Button>
          </div>
          <FieldHint>
            Currently {formatNumber(settings.defaultThreshold)} views.
          </FieldHint>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Default period</Label>
          <div className="flex flex-wrap gap-1.5">
            {[7, 30, 90, 180].map((days) => (
              <button
                key={days}
                type="button"
                disabled={saving}
                onClick={() => onChange({ defaultPeriodDays: days })}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors",
                  settings.defaultPeriodDays === days
                    ? "border-accent bg-accent-subtle text-foreground"
                    : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
                )}
              >
                {days}D
              </button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * =========================================================================
 * WHAT SHARE OF VIEWS YOUTUBE ACTUALLY PAYS FOR
 * =========================================================================
 *
 * The owner's request in full: "Add an option for Engaged Views, since RPM is
 * only calculated based on engaged views. Engaged Views are usually around 50%
 * of the total views you get, so set the default value to 50%, but we should be
 * able to change it."
 *
 * ITS OWN CARD RATHER THAN A FIELD IN "ANALYSIS DEFAULTS", because it is a
 * different kind of thing. The threshold and the period are choices about how
 * to LOOK at the data — change one and the same facts are shown differently.
 * This is a claim about the outside world that multiplies every money figure in
 * the product, and burying it under a heading about dashboard defaults would
 * misrepresent how much it moves.
 *
 * WHOLE PERCENT IN THE BOX, BASIS POINTS ON THE WIRE. Nobody types "5000" and
 * means half. The field takes a percentage with an optional decimal — 50, 47.5
 * — and the conversion happens here, once, at the boundary. Storing percent
 * instead would have been the simpler thing and cannot express 47.5%; storing a
 * float would have put a binary fraction directly upstream of every currency
 * amount, which the money rule forbids.
 *
 * THE PARSE IS ON DIGIT STRINGS, not `Number(text) * 100`. `47.5 * 100` is
 * 4749.999999999999 in IEEE 754 and `Math.round` rescues that one — but the
 * habit is what fails eventually, and this file has no business being the place
 * a float first touches a money input. Splitting on the separator and padding
 * the fraction to two digits is exact for every input by construction.
 */
function EngagedViewsCard({
  settings,
  onChange,
  saving,
}: {
  settings: OrganizationSettingsDTO;
  onChange: (patch: OrganizationPatch) => void;
  saving: boolean;
}) {
  const [value, setValue] = React.useState(
    basisPointsToPercentText(settings.engagedViewShareBasisPoints),
  );
  const [error, setError] = React.useState<string | null>(null);

  const parsed = parsePercentToBasisPoints(value);
  // The soft warning, shown while typing rather than on submit — following the
  // RPM dialog's implausibility hint. A share outside 20–80% is far more likely
  // to be a scale mistake (5 for "50%") than a considered belief, and saying so
  // before the save costs nothing. It is a hint, not a rule: somebody who means
  // it can still save it.
  const implausible =
    parsed !== null &&
    (parsed < ENGAGED_VIEW_SHARE_IMPLAUSIBLE_BELOW_BASIS_POINTS ||
      parsed > ENGAGED_VIEW_SHARE_IMPLAUSIBLE_ABOVE_BASIS_POINTS);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Engaged views</CardTitle>
        <CardDescription>{ENGAGED_VIEWS_GLOSS}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="engaged-view-share">Engaged share of views (%)</Label>
          <div className="flex gap-2">
            <Input
              id="engaged-view-share"
              inputMode="decimal"
              value={value}
              invalid={Boolean(error)}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              className="w-40"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={saving}
              onClick={() => {
                const basisPoints = parsePercentToBasisPoints(value);
                if (basisPoints === null) {
                  setError("Enter a percentage like 50 or 47.5.");
                  return;
                }
                if (basisPoints < MIN_ENGAGED_VIEW_SHARE_BASIS_POINTS) {
                  // The same refusal an RPM of nothing gets, for the same
                  // reason: 0% says no view is ever engaged, which prices every
                  // niche in the organization at nothing.
                  setError(
                    "0% would say no view is ever paid for, which prices every niche at nothing. Enter at least 0.01%.",
                  );
                  return;
                }
                if (basisPoints > MAX_ENGAGED_VIEW_SHARE_BASIS_POINTS) {
                  setError(
                    "Engaged views are a subset of views, so the share cannot be above 100%.",
                  );
                  return;
                }
                onChange({ engagedViewShareBasisPoints: basisPoints });
              }}
            >
              Save
            </Button>
          </div>

          {error ? (
            <FieldHint tone="danger">{error}</FieldHint>
          ) : implausible ? (
            <FieldHint tone="danger">
              That is outside the 20–80% range a Shorts channel normally sees. Check
              you have not typed 5 for 50% — this number multiplies every money
              figure in the app. Save it anyway if you mean it.
            </FieldHint>
          ) : (
            <FieldHint>
              Currently {formatEngagedViewShare(settings.engagedViewShareBasisPoints)}.
              100% turns the assumption off — every view is treated as paid, which is
              how the app behaved before this setting existed.
            </FieldHint>
          )}
        </div>

        {/* WHERE IT DOES AND DOES NOT APPLY, stated plainly, because the
            asymmetry is the part that surprises people: a niche priced by hand
            moves when this changes and a niche measured from Northstar's own
            revenue does not. Somebody who edits this and watches one card move
            while another sits still should find the reason here rather than
            conclude the screen is broken. */}
        <p className="rounded-lg border border-border bg-surface-sunken p-3.5 text-[12px] leading-relaxed text-muted-foreground">
          This applies to niche RPM ranges entered by hand, which are quoted per
          1,000 engaged views. It does NOT apply where Northstar operates a
          monetized channel in the niche and the rate is measured from what that
          channel actually earned — that figure is already net of engagement,
          because the money in it is what YouTube really paid, so discounting it
          again would halve a measurement.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Basis points -> the text the box shows. 5000 becomes "50", 4750 "47.5".
 *
 * Trailing zeros are trimmed for the same reason `rpmToInputText` trims them:
 * the extra digits exist to hold a value, not to be typed past, and "50.00" in
 * a percentage box invites somebody to think the precision means something.
 */
function basisPointsToPercentText(basisPoints: number): string {
  const safe = normalizeEngagedViewShare(basisPoints);
  const whole = Math.trunc(safe / 100);
  const fraction = String(safe % 100).padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * The text somebody typed -> basis points, or `null` when it cannot be read.
 *
 * ARITHMETIC ON DIGIT STRINGS, never `Number(text) * 100`. See the card's
 * header: the float route happens to survive `Math.round` today and is the
 * wrong habit directly upstream of a money multiplier. A comma is accepted as
 * the separator alongside a dot, matching `parseRpmToMinorPerMillion`, because
 * the same people type both.
 */
function parsePercentToBasisPoints(input: string): number | null {
  const text = input.replace(/[\s%]/g, "");
  if (!text || text.length > 12) return null;
  if (!/^\d*[.,]?\d*$/.test(text)) return null;

  const separator = text.includes(",") ? "," : ".";
  const [whole = "", fraction = ""] = text.split(separator);
  if (whole === "" && fraction === "") return null;

  // Two digits past the point is exactly the basis-point scale. A third is
  // rounded rather than truncated, so somebody typing 47.555 is not silently
  // rounded downward.
  const kept = fraction.slice(0, 2).padEnd(2, "0");
  const dropped = fraction.slice(2);
  let value = Number(`${whole === "" ? "0" : whole}${kept}`);
  if (!Number.isFinite(value)) return null;
  if (dropped.length > 0 && Number(dropped[0]) >= 5) value += 1;
  return Number.isSafeInteger(value) ? value : null;
}

function RefreshCard({
  settings,
  onChange,
  saving,
}: {
  settings: OrganizationSettingsDTO;
  onChange: (patch: OrganizationPatch) => void;
  saving: boolean;
}) {
  const [lookback, setLookback] = React.useState(String(settings.lookbackDays));
  const [interval, setIntervalValue] = React.useState(String(settings.refreshIntervalMinutes));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Data collection</CardTitle>
        <CardDescription>
          How much history to keep and how eagerly to refresh it. These directly
          control YouTube API usage, which is a shared quota — which is why they
          are one setting for the team rather than one per person.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="lookback">History window (days)</Label>
            <div className="flex gap-2">
              <Input
                id="lookback"
                inputMode="numeric"
                value={lookback}
                onChange={(event) => setLookback(event.target.value)}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={saving}
                onClick={() => {
                  const parsed = Number(lookback);
                  if (!Number.isFinite(parsed) || parsed < 7 || parsed > 3650) {
                    toast.error("Enter between 7 and 3650 days");
                    return;
                  }
                  onChange({ lookbackDays: Math.trunc(parsed) });
                }}
              >
                Save
              </Button>
            </div>
            <FieldHint>
              Must exceed your longest period. Below 180 days the 180D view will
              be incomplete.
            </FieldHint>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="interval">Staleness threshold (minutes)</Label>
            <div className="flex gap-2">
              <Input
                id="interval"
                inputMode="numeric"
                value={interval}
                onChange={(event) => setIntervalValue(event.target.value)}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={saving}
                onClick={() => {
                  const parsed = Number(interval);
                  if (!Number.isFinite(parsed) || parsed < 0) {
                    toast.error("Enter a non-negative number of minutes");
                    return;
                  }
                  onChange({ refreshIntervalMinutes: Math.trunc(parsed) });
                }}
              >
                Save
              </Button>
            </div>
            <FieldHint>
              A channel is only re-fetched by the bulk refresh after this long.
              Manual refreshes always run.
            </FieldHint>
          </div>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-surface-sunken p-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-foreground">
                Automatic background refresh
              </span>
              <Badge variant="outline" size="sm">
                Needs a scheduler
              </Badge>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              This app does not run its own scheduler. Point an external one
              (cron, a Vercel Cron job, a worker) at{" "}
              <code className="text-[11px]">/api/cron/sync</code> and set{" "}
              <code className="text-[11px]">CRON_SECRET</code> — that endpoint
              has no session, so it authenticates with that shared secret and
              refuses to run without it. Only channels older than the staleness
              threshold are refreshed, so it is safe to call hourly. This switch
              is the on/off: with it off, the scheduler still prunes expired
              data but spends no YouTube quota.
            </p>
          </div>
          <Switch
            checked={settings.autoRefreshEnabled}
            onCheckedChange={(checked) => onChange({ autoRefreshEnabled: checked })}
            aria-label="Enable automatic background refresh"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ShortsDetectionCard({
  settings,
  probeEnabledInEnv,
  onChange,
}: {
  settings: OrganizationSettingsDTO;
  probeEnabledInEnv: boolean;
  onChange: (patch: OrganizationPatch) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Shorts detection</CardTitle>
        <CardDescription>
          The YouTube Data API has no field that marks a video as a Short, so
          classification combines several signals.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-surface-sunken p-3.5">
          <div className="min-w-0">
            <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
              <ShieldCheck className="size-4 text-subtle-foreground" />
              Shorts URL verification
            </span>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              Checks whether{" "}
              <code className="text-[11px]">youtube.com/shorts/&#123;id&#125;</code>{" "}
              serves the Shorts player or redirects to the regular watch page.
              This is YouTube&rsquo;s own classification and costs no API quota.
              Turn it off only if your network blocks youtube.com — detection
              then falls back to duration plus player aspect ratio.
            </p>
            {!probeEnabledInEnv ? (
              <p className="mt-1.5 text-[11px] text-warning">
                Currently disabled by <code>SHORTS_PROBE_ENABLED=false</code> in
                the environment, which overrides this switch.
              </p>
            ) : null}
          </div>
          <Switch
            checked={settings.shortsProbeEnabled}
            onCheckedChange={(checked) => onChange({ shortsProbeEnabled: checked })}
            aria-label="Enable Shorts URL verification"
          />
        </div>

        <div className="rounded-lg border border-border bg-surface-sunken p-3.5">
          <p className="text-[12px] font-medium text-foreground">
            How a video is classified
          </p>
          <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-4 text-[12px] leading-relaxed text-muted-foreground">
            <li>
              <strong className="text-foreground">Duration gate.</strong> Longer
              than 3 minutes means it cannot be a Short. Free, definitive, and
              settles most long-form uploads with no network request.
            </li>
            <li>
              <strong className="text-foreground">Shorts URL check.</strong>{" "}
              YouTube serves the Shorts player for a real Short and redirects
              everything else to <code className="text-[11px]">/watch</code>.
            </li>
            <li>
              <strong className="text-foreground">Aspect ratio.</strong> Vertical
              or square plus a short duration is YouTube&rsquo;s own eligibility
              rule — used when the URL check is unavailable.
            </li>
            <li>
              <strong className="text-foreground">Otherwise: excluded.</strong>{" "}
              A video that can&rsquo;t be confirmed is left out of both the
              numerator and denominator, with the reason recorded. Guessing would
              corrupt the hit rate; abstaining only narrows the sample.
            </li>
          </ol>
          <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-subtle-foreground">
            <RefreshCw className="size-3" />
            Verdicts are cached permanently per video. Only new and previously
            unresolved videos are re-examined on a refresh.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
