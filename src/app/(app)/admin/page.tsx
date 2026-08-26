"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  History,
  Lock,
  ServerCog,
  Sparkles,
  TrendingUp,
  Tv2,
  Users,
  Wallet,
} from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { InfoTip } from "@/components/ui/tooltip";
import { Stat, StatSkeleton } from "@/components/metrics/stat";
import { IfPermitted, useSession } from "@/components/providers/session-provider";
import { useFilters } from "@/components/providers/filters-provider";
import { useAdminOverview, useAdminUsers } from "@/hooks/use-admin";
import { useFinanceOverview } from "@/hooks/use-finance";
import { useDataset } from "@/hooks/use-dataset";
import { useChannelRows, usePortfolioSummary } from "@/hooks/use-channel-analytics";
import { useNow } from "@/hooks/use-now";
import {
  calculateMarketShare,
  TRACKED_MARKET_SHARE_DEFINITION,
} from "@/lib/analytics/market-share";
import {
  HIT_RATE_DEFINITION,
  TOTAL_VIEWS_DEFINITION,
  TOTAL_VIEWS_VS_STUDIO,
} from "@/lib/analytics/constants";
import { auditActionLabel } from "@/lib/audit/actions";
import { PERMISSION_LABELS, ROLE_ORDER } from "@/lib/auth/permissions";
import { formatMoney } from "@/lib/finance/money";
import {
  EM_DASH,
  formatCompactNumber,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatThreshold,
} from "@/lib/format";
import { BRAND } from "@/lib/brand";
import type { AdminUserDTO } from "@/server/services/admin-service";
import type { AuditEntryDTO } from "@/server/audit/audit-service";
import { cn } from "@/lib/utils";

/**
 * Admin — the command centre.
 *
 * One screen that answers "is the business healthy, is the operation working,
 * and is anything broken?" without opening five pages. Deliberately grouped and
 * deliberately shallow: five named groups of three or four figures each, every
 * one of them a link to the page that can actually explain it. A flat wall of
 * twenty numbers would be the same data and none of the meaning.
 *
 * WHERE THE NUMBERS COME FROM, AND WHY NOT FROM HERE
 * Nothing on this page computes a metric of its own. Shorts and Channels run
 * the same `useChannelRows` → `usePortfolioSummary` path the dashboard runs,
 * over the same cached dataset; market share is the same `calculateMarketShare`
 * Our vs Market uses; the money is the finance service's own exact totals. That
 * is not laziness — a "hit rate" here that disagreed with the one on the
 * dashboard by a rounding step would quietly destroy trust in both screens, and
 * the only way to guarantee they agree is for there to be one implementation.
 *
 * PERMISSIONS SHAPE THE PAGE, NOT JUST ITS VISIBILITY
 * `finance.view` and `users.manage` each gate a *fetch* as well as a panel, so
 * the query for a group the viewer cannot read is never issued and never 403s.
 * Both gated blocks are separate components for exactly that reason: a hook
 * cannot be called conditionally, but a component can go unrendered.
 */
export default function AdminOverviewPage() {
  const { data, isLoading, error, refetch } = useDataset();
  const { range, threshold } = useFilters();

  const rows = useChannelRows(data);
  const summary = usePortfolioSummary(rows);

  const ourChannels = React.useMemo(
    () => rows.filter((row) => row.channel.ownershipType === "own"),
    [rows],
  );
  const competitorChannels = React.useMemo(
    () => rows.filter((row) => row.channel.ownershipType !== "own"),
    [rows],
  );

  const share = React.useMemo(
    () =>
      calculateMarketShare(
        ourChannels.map((row) => ({ videos: row.videos })),
        competitorChannels.map((row) => ({ videos: row.videos })),
        range,
      ),
    [ourChannels, competitorChannels, range],
  );

  /**
   * Share is only a claim worth printing when both sides of it are tracked.
   *
   * With no competitors the arithmetic returns 100%, and with no channels of
   * our own it returns 0% — both true of the tracked set and both read as a
   * statement about the market, which is not what they mean. Our vs Market
   * refuses to render for the same reason; here the tile shows an em dash and
   * says which side is missing.
   */
  const shareIsMeaningful = ourChannels.length > 0 && competitorChannels.length > 0;

  const trackerIsEmpty = !isLoading && !error && rows.length === 0;

  return (
    <PageContainer className="flex flex-col gap-6">
      <PageHeader
        title="Command centre"
        description={`Everything ${BRAND.company} runs on, in one screen. The Business, Shorts and Channels figures describe the selected period.`}
        actions={<PeriodSelector />}
      />

      {/* BUSINESS — the only group that is invisible rather than degraded to
          somebody without the permission. Money is not a partial disclosure:
          either the viewer may read it or the group is not on the page. */}
      <IfPermitted to="finance.view">
        <BusinessGroup />
      </IfPermitted>

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : isLoading ? (
        <>
          <GroupSkeleton label="Shorts" icon={TrendingUp} tiles={4} />
          <GroupSkeleton label="Channels" icon={Tv2} tiles={3} />
        </>
      ) : trackerIsEmpty ? (
        // Both groups describe the tracker, so one honest message beats two
        // cards of zeroes that look like a reading rather than an absence.
        <Card>
          <EmptyState
            icon={<Sparkles />}
            title="Nothing is being tracked yet"
            description="Shorts and channel figures appear here once the tracker has channels in it. Add the channels you run and the competitors you watch, and this screen fills in."
            action={
              <Button variant="primary" asChild>
                <Link href="/channels">Manage channels</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <TileGroup
            label="Shorts"
            icon={TrendingUp}
            columns="grid-cols-2 lg:grid-cols-4"
            action={<GroupLink href="/">Dashboard</GroupLink>}
          >
            <Tile>
              <Stat
                label="Total views"
                value={formatCompactNumber(summary.totalViews)}
                hint={
                  <InfoTip>
                    {TOTAL_VIEWS_DEFINITION} {TOTAL_VIEWS_VS_STUDIO}
                  </InfoTip>
                }
                caption={`${formatNumber(summary.channelsWithData)} of ${formatNumber(summary.channelCount)} channels published`}
              />
            </Tile>

            <Tile>
              <Stat
                label="Hit rate"
                emphasis="strong"
                value={formatPercent(summary.averageHitRate)}
                hint={
                  <InfoTip>
                    The mean of each channel&rsquo;s own hit rate, counting only
                    channels that uploaded Shorts this period. {HIT_RATE_DEFINITION}
                  </InfoTip>
                }
                caption={
                  summary.averageHitRate === null
                    ? "No Shorts uploaded in this period"
                    : `At ${formatThreshold(threshold)} views`
                }
              />
            </Tile>

            <Tile>
              <Stat
                label="Uploads"
                value={formatNumber(summary.totalShorts)}
                caption={`${formatNumber(summary.totalHits)} of them cleared the threshold`}
              />
            </Tile>

            <Tile>
              <Stat
                label="Tracked market share"
                value={shareIsMeaningful ? formatPercent(share.sharePercent) : EM_DASH}
                hint={<InfoTip>{TRACKED_MARKET_SHARE_DEFINITION}</InfoTip>}
                caption={
                  !shareIsMeaningful
                    ? ourChannels.length === 0
                      ? "No channels marked as ours"
                      : "No competitor channels tracked"
                    : `${formatCompactNumber(share.ourViews)} of ${formatCompactNumber(share.totalViews)} tracked views`
                }
              />
            </Tile>
          </TileGroup>

          <TileGroup
            label="Channels"
            icon={Tv2}
            columns="grid-cols-2 lg:grid-cols-3"
            action={<GroupLink href="/channels">Channels</GroupLink>}
          >
            <Tile>
              <Stat
                label="Our channels"
                value={formatNumber(ourChannels.length)}
                caption={`${formatNumber(share.ourShorts)} Shorts this period`}
              />
            </Tile>

            <Tile>
              <Stat
                label="Competitors"
                value={formatNumber(competitorChannels.length)}
                caption={`${formatNumber(share.competitorShorts)} Shorts this period`}
              />
            </Tile>

            <Tile className="col-span-2 lg:col-span-1">
              <Stat
                label="Best performing"
                value={
                  summary.topChannel ? (
                    <Link
                      href={`/channels/${summary.topChannel.id}`}
                      className="block truncate transition-colors hover:text-accent"
                      title={summary.topChannel.name}
                    >
                      {summary.topChannel.name}
                    </Link>
                  ) : (
                    EM_DASH
                  )
                }
                caption={
                  summary.topChannel
                    ? `${formatPercent(summary.topChannel.hitRate)} hit rate — the highest tracked`
                    : "No channel has Shorts in this period"
                }
              />
            </Tile>
          </TileGroup>
        </>
      )}

      {/* TEAM, SYSTEM and the activity trail all come out of /api/admin/overview,
          which requires users.manage. Gating the component rather than the tiles
          means the request is never made by somebody who would only get a 403. */}
      <IfPermitted to="users.manage" fallback={<AdministrationRestricted />}>
        <TeamAndSystem oldestFetchedAt={data?.oldestFetchedAt ?? null} />
      </IfPermitted>
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// BUSINESS
// ---------------------------------------------------------------------------

/**
 * Revenue, expenses, net and margin for the selected period.
 *
 * `useFinanceOverview()` follows the global period control, so this group moves
 * with the Shorts figures above it rather than describing a different month.
 *
 * WHY `truncated` DOES NOT UNDERMINE THESE FOUR
 * The finance service computes revenue and expense from a grouped database
 * aggregate, not from the capped entry array it also returns — precisely so a
 * period with more entries than one payload carries still reports exact totals.
 * `truncated` describes the breakdowns further down the Finance page, and the
 * note below says so rather than leaving the flag unsurfaced.
 */
function BusinessGroup() {
  const { data, isLoading, error, refetch } = useFinanceOverview();

  if (error) {
    return (
      <GroupShell label="Business" icon={Wallet}>
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      </GroupShell>
    );
  }

  // `isLoading` is false while the query is disabled during the first hydration
  // pass, so the absence of data is what decides, not the flag.
  if (isLoading || !data) {
    return <GroupSkeleton label="Business" icon={Wallet} tiles={4} />;
  }

  const { summary, baseCurrency } = data;

  return (
    <TileGroup
      label="Business"
      icon={Wallet}
      columns="grid-cols-2 lg:grid-cols-4"
      action={<GroupLink href="/finance">Finance</GroupLink>}
      footer={
        data.truncated ? (
          <p className="px-1 text-[11px] leading-relaxed text-subtle-foreground">
            This period holds more ledger entries than one payload carries. The
            four figures above are exact totals from the ledger, but the
            per-category and per-channel breakdowns on the Finance page are
            capped.
          </p>
        ) : null
      }
    >
      <Tile>
        <Stat
          label="Revenue"
          value={formatMoney(summary.revenueMinor, baseCurrency)}
          caption="Booked in this period"
        />
      </Tile>

      <Tile>
        <Stat
          label="Expenses"
          value={formatMoney(summary.expenseMinor, baseCurrency)}
          caption="Booked in this period"
        />
      </Tile>

      <Tile>
        <Stat
          label="Net profit"
          emphasis="strong"
          value={
            <span
              className={cn(
                summary.netMinor > 0 && "text-success",
                summary.netMinor < 0 && "text-danger",
              )}
            >
              {formatMoney(summary.netMinor, baseCurrency, { signDisplay: "exceptZero" })}
            </span>
          }
          caption="Revenue minus expenses"
        />
      </Tile>

      <Tile>
        <Stat
          label="Margin"
          // `margin` is null when the period earned nothing, and formatPercent
          // renders that as an em dash. Never 0% — "we broke even" and "we
          // earned nothing and spent money" are different sentences.
          value={formatPercent(summary.margin)}
          caption={
            summary.margin === null
              ? "No revenue to take a share of"
              : "Net profit as a share of revenue"
          }
        />
      </Tile>
    </TileGroup>
  );
}

// ---------------------------------------------------------------------------
// TEAM + SYSTEM + ACTIVITY
// ---------------------------------------------------------------------------

/**
 * Everything behind `users.manage`: who is on the team, whether the machinery
 * is running, and what has been done to the workspace lately.
 *
 * One error state covers all three because they come from one request, and a
 * page that renders two of three panels next to an error is harder to read than
 * one that says plainly that this part could not load.
 */
function TeamAndSystem({ oldestFetchedAt }: { oldestFetchedAt: number | null }) {
  const { data, isLoading, error, refetch } = useAdminOverview();
  const now = useNow();

  if (error) {
    return (
      <GroupShell label="Team & system" icon={ServerCog}>
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      </GroupShell>
    );
  }

  if (isLoading || !data) {
    return (
      <>
        <GroupSkeleton label="Team" icon={Users} tiles={2} />
        <GroupSkeleton label="System" icon={ServerCog} tiles={4} />
        <GroupShell label="Recent activity" icon={History}>
          <Card className="flex flex-col gap-3 p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </Card>
        </GroupShell>
      </>
    );
  }

  /*
   * `data.channels` and `data.niches` are deliberately left on the floor.
   *
   * The Channels group above already states those counts, derived from the
   * tracker dataset — and although the two queries apply an identical filter
   * (`organizationId`, `isActive`) and so can only ever agree in principle,
   * they are two responses fetched at two moments. Printing both would create a
   * window in which one refreshes and the other has not, which is precisely the
   * "tile quietly disagreeing with the table underneath it" failure the admin
   * hooks invalidate a whole namespace to avoid. One source per fact.
   */
  const { users, youtube, sync } = data;

  const teamCaption = [
    users.invited > 0 ? `${formatNumber(users.invited)} invited` : null,
    users.deactivated > 0 ? `${formatNumber(users.deactivated)} deactivated` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <>
      <TileGroup
        label="Team"
        icon={Users}
        columns="grid-cols-1 sm:grid-cols-2"
        action={<GroupLink href="/admin/users">Users</GroupLink>}
      >
        <Tile>
          <Stat
            label="Active users"
            emphasis="strong"
            value={formatNumber(users.active)}
            caption={teamCaption || "Everyone in the workspace is active"}
          />
        </Tile>

        <Tile>
          <RoleBreakdown />
        </Tile>
      </TileGroup>

      <TileGroup label="System" icon={ServerCog} columns="grid-cols-2 lg:grid-cols-4">
        <Tile>
          <Stat
            label="Last sync"
            /*
             * "Last sync", not "last successful sync". The payload carries when
             * the most recent run *started* and how it ended — there is no
             * last-success timestamp in it, and printing this one under a
             * success label would assert something the data does not say on the
             * exact occasion it matters. The status is stated instead.
             */
            value={sync.lastRunAt === null ? "Never" : relativeSince(sync.lastRunAt, now)}
            caption={<SyncStatusCaption status={sync.lastStatus} />}
          />
        </Tile>

        <Tile>
          <Stat
            label="Data freshness"
            value={oldestFetchedAt === null ? EM_DASH : relativeSince(oldestFetchedAt, now)}
            // The oldest fetch, matching the dashboard's freshness pill: a
            // comparison is only as current as its stalest input.
            caption={
              oldestFetchedAt === null
                ? "Nothing has been fetched yet"
                : "Oldest fetch across tracked channels"
            }
          />
        </Tile>

        <Tile>
          <Stat
            label="YouTube"
            value={formatNumber(youtube.connections)}
            caption={
              youtube.needingReauth > 0 ? (
                <span className="text-warning">
                  {formatNumber(youtube.needingReauth)} need re-authorisation
                </span>
              ) : youtube.connections === 0 ? (
                "No Google accounts connected"
              ) : (
                "All connections healthy"
              )
            }
          />
        </Tile>

        <Tile>
          <Stat
            label="Failed syncs (24h)"
            value={
              <span className={cn(sync.failuresLast24h > 0 && "text-danger")}>
                {formatNumber(sync.failuresLast24h)}
              </span>
            }
            caption={
              sync.runsLast24h === 0
                ? "No runs in the last 24 hours"
                : `of ${formatNumber(sync.runsLast24h)} runs`
            }
          />
        </Tile>
      </TileGroup>

      <RecentActivity entries={data.recentActivity} now={now} />
    </>
  );
}

/**
 * How the active team splits across roles.
 *
 * The overview payload has no role histogram in it, so this reads the admin
 * directory — the same cache entry the Users tab renders from, which makes it a
 * request the section was going to make anyway rather than one spent here.
 *
 * It fails softly and on its own: the tile beside it is already on screen with
 * a number in it, and blanking the whole Team group because a secondary read
 * did not arrive would be a worse trade than one honest line.
 */
function RoleBreakdown() {
  const { data, isLoading, error } = useAdminUsers();

  const counts = React.useMemo(() => {
    const byRole = new Map<string, { label: string; count: number }>();

    for (const user of data?.users ?? []) {
      if (!isActiveMember(user)) continue;
      const existing = byRole.get(user.role);
      byRole.set(user.role, {
        label: user.roleLabel,
        count: (existing?.count ?? 0) + 1,
      });
    }

    return [...byRole.entries()]
      .map(([role, value]) => ({ role, ...value }))
      .sort((a, b) => rolePriority(a.role) - rolePriority(b.role));
  }, [data]);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
        Roles
      </span>

      {isLoading ? (
        <div className="flex flex-col gap-1.5 pt-0.5">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-3 w-full" />
          ))}
        </div>
      ) : error ? (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          The role breakdown could not be loaded. The count beside it is
          unaffected.
        </p>
      ) : counts.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          No active members to break down.
        </p>
      ) : (
        <dl className="flex flex-col gap-1">
          {counts.map((entry) => (
            <div key={entry.role} className="flex items-baseline justify-between gap-3">
              <dt className="truncate text-[12px] text-muted-foreground">{entry.label}</dt>
              <dd className="tnum text-[12px] font-medium text-foreground">
                {formatNumber(entry.count)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * Mirrors the bucketing `getAdminOverview` does server-side.
 *
 * A deactivated account keeps whatever `status` string it had, so the
 * deactivation test has to come first — and it has to be the *same* test, or
 * the role rows would sum to a different number than the "Active users" tile
 * eighteen pixels to their left.
 */
function isActiveMember(user: AdminUserDTO): boolean {
  if (user.deactivatedAt !== null || user.status === "deactivated") return false;
  return user.status !== "invited";
}

/** Most privileged first; a role no longer in the table sorts last, not first. */
function rolePriority(role: string): number {
  const index = ROLE_ORDER.findIndex((known) => known === role);
  return index < 0 ? ROLE_ORDER.length : index;
}

function SyncStatusCaption({ status }: { status: string | null }) {
  if (status === null) return <>No sync has run yet</>;
  if (status === "error") return <span className="text-danger">The last run failed</span>;
  if (status === "partial") {
    return <span className="text-warning">The last run finished partly</span>;
  }
  return <>The last run completed</>;
}

// ---------------------------------------------------------------------------
// RECENT ACTIVITY
// ---------------------------------------------------------------------------

const ACTIVITY_ROWS = 8;

/**
 * The tail of the audit trail.
 *
 * The entries ride along on the overview payload rather than costing a second
 * request. /api/admin/overview returns an empty array — not a 403 — when the
 * viewer holds `users.manage` without `audit.view`, because the two are
 * separate capabilities on purpose. An empty list therefore has two completely
 * different meanings, and guessing between them would either hide a real gap or
 * accuse a quiet workspace of withholding something. The viewer's own
 * permission is what tells them apart.
 */
function RecentActivity({
  entries,
  now,
}: {
  entries: readonly AuditEntryDTO[];
  now: number;
}) {
  const session = useSession();
  const mayReadAudit = session.can("audit.view");

  return (
    <GroupShell
      label="Recent activity"
      icon={History}
      action={mayReadAudit ? <GroupLink href="/admin/audit">Audit log</GroupLink> : undefined}
    >
      <Card className="overflow-hidden">
        {entries.length === 0 ? (
          mayReadAudit ? (
            <EmptyState
              icon={<History />}
              title="Nothing recorded yet"
              description="Access changes, channel edits, connections and financial entries are written here as they happen."
            />
          ) : (
            <EmptyState
              icon={<Lock />}
              title="Activity is hidden from this account"
              description={`Reading the trail is a separate capability from managing people — it needs “${PERMISSION_LABELS["audit.view"]}”. An admin can grant it.`}
            />
          )
        ) : (
          <ul className="flex flex-col">
            {entries.slice(0, ACTIVITY_ROWS).map((entry) => (
              <li
                key={entry.id}
                className="flex items-baseline gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
              >
                <span className="hidden w-[168px] shrink-0 truncate text-[11px] font-medium text-muted-foreground sm:block">
                  {auditActionLabel(entry.action)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                  {entry.summary}
                </span>
                {/* The log is denormalised at write time, so an actor who has
                    since been removed still has a name here. A null one is a
                    system action, not a missing row. */}
                <span className="hidden w-[120px] shrink-0 truncate text-right text-[11px] text-subtle-foreground md:block">
                  {entry.actorName ?? "System"}
                </span>
                <span className="tnum w-[84px] shrink-0 text-right text-[11px] text-subtle-foreground">
                  {relativeSince(entry.createdAt, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </GroupShell>
  );
}

/**
 * What somebody with `audit.view` but not `users.manage` sees in place of the
 * three admin panels.
 *
 * They belong in this section — the layout let them in and the audit log is
 * theirs to read — so the honest answer is to name what is missing and point at
 * the tab that is not, rather than to render nothing and let the page look
 * broken.
 */
function AdministrationRestricted() {
  const session = useSession();

  return (
    <GroupShell label="Team & system" icon={Lock}>
      <Card>
        <EmptyState
          icon={<Lock />}
          title="Team and system status are not visible to this account"
          description={`Membership, sync health and connection status sit behind “${PERMISSION_LABELS["users.manage"]}”. Everything above is yours to read.`}
          action={
            session.can("audit.view") ? (
              <Button variant="secondary" asChild>
                <Link href="/admin/audit">Open the audit log</Link>
              </Button>
            ) : undefined
          }
        />
      </Card>
    </GroupShell>
  );
}

// ---------------------------------------------------------------------------
// LAYOUT PRIMITIVES
// ---------------------------------------------------------------------------

/**
 * A labelled group: a quiet uppercase heading, an optional link out, and a
 * bordered surface.
 *
 * The heading sits *outside* the card. That is what creates the hierarchy the
 * page needs — five groups reading as five answers — without giving each one a
 * coloured header bar and turning the screen into a dashboard of dashboards.
 */
function GroupShell({
  label,
  icon: Icon,
  action,
  footer,
  children,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={label}>
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
          <Icon className="size-3" />
          {label}
        </h2>
        {action}
      </div>

      {children}
      {footer}
    </section>
  );
}

/**
 * The tiled variant: hairlines come from a 1px grid gap over the border colour,
 * so the dividers are correct at every breakpoint without a per-child ladder of
 * responsive border utilities.
 */
function TileGroup({
  label,
  icon,
  action,
  footer,
  columns,
  children,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  columns: string;
  children: React.ReactNode;
}) {
  return (
    <GroupShell label={label} icon={icon} action={action} footer={footer}>
      <Card className="overflow-hidden">
        <div className={cn("grid gap-px bg-border", columns)}>{children}</div>
      </Card>
    </GroupShell>
  );
}

function Tile({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("bg-surface p-4 sm:p-5", className)}>{children}</div>;
}

function GroupLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      {children}
      <ArrowRight className="size-3" />
    </Link>
  );
}

function GroupSkeleton({
  label,
  icon,
  tiles,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tiles: number;
}) {
  return (
    <GroupShell label={label} icon={icon}>
      <Card className="grid grid-cols-2 gap-x-6 gap-y-6 p-4 sm:p-5 lg:grid-cols-4">
        {Array.from({ length: tiles }, (_, i) => (
          <StatSkeleton key={i} />
        ))}
      </Card>
    </GroupShell>
  );
}

/**
 * `useNow()` is 0 until the shared clock subscribes, and passing that through
 * would date everything to 1970 for one frame. Falling back to the tool's
 * default — the same thing the dashboard's freshness pill does — keeps the
 * first paint sensible, and the next tick makes it exact.
 */
function relativeSince(ms: number, now: number): string {
  return formatRelativeTime(ms, now === 0 ? undefined : now);
}
