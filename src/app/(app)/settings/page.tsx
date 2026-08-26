"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Database, KeyRound, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import type { SettingsDTO } from "@/lib/dto";
import { DATASET_KEY } from "@/hooks/use-dataset";
import { THRESHOLD_PRESETS } from "@/lib/analytics/constants";
import { formatCompactNumber, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Settings.
 *
 * Split deliberately into what the *user* controls (defaults, refresh
 * behaviour) and what the *environment* controls (API key, database). The
 * second group is read-only and shows status rather than inputs: secrets belong
 * in `.env.local`, never in a form that would persist them to a database or
 * echo them back over the wire.
 */
export default function SettingsPage() {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });

  const update = useMutation({
    mutationFn: (patch: Partial<SettingsDTO>) => api.updateSettings(patch),
    onSuccess: ({ settings }) => {
      queryClient.setQueryData(["settings"], (prev: typeof data) =>
        prev ? { ...prev, settings } : prev,
      );
      // Lookback affects how much history the dataset returns.
      queryClient.invalidateQueries({ queryKey: DATASET_KEY });
      toast.success("Settings saved");
    },
    onError: (mutationError) =>
      toast.error("Could not save settings", {
        description: mutationError instanceof Error ? mutationError.message : undefined,
      }),
  });

  if (error) {
    return (
      <PageContainer>
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex max-w-3xl flex-col gap-5">
      <PageHeader
        title="Settings"
        description="Defaults for new sessions, refresh behaviour, and the current server configuration."
      />

      {isLoading || !data ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      ) : (
        <>
          <ConfigurationCard config={data.config} />
          <DefaultsCard
            settings={data.settings}
            onChange={(patch) => update.mutate(patch)}
            saving={update.isPending}
          />
          <RefreshCard
            settings={data.settings}
            onChange={(patch) => update.mutate(patch)}
            saving={update.isPending}
          />
          <ShortsDetectionCard
            settings={data.settings}
            probeEnabledInEnv={data.config.probeEnabledInEnv}
            onChange={(patch) => update.mutate(patch)}
          />
        </>
      )}
    </PageContainer>
  );
}

function ConfigurationCard({
  config,
}: {
  config: { hasApiKey: boolean; databaseProvider: string; lookbackDays: number };
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
  settings: SettingsDTO;
  onChange: (patch: Partial<SettingsDTO>) => void;
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
          Applied when you open the app in a new browser. Changing the period or
          threshold on a page only affects that session.
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

function RefreshCard({
  settings,
  onChange,
  saving,
}: {
  settings: SettingsDTO;
  onChange: (patch: Partial<SettingsDTO>) => void;
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
          control YouTube API usage.
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
  settings: SettingsDTO;
  probeEnabledInEnv: boolean;
  onChange: (patch: Partial<SettingsDTO>) => void;
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
