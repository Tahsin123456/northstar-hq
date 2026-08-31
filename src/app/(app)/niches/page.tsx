"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  DollarSign,
  Layers,
  MoreHorizontal,
  Pencil,
  Plus,
  StickyNote,
  Target,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { ThresholdSelector } from "@/components/dashboard/threshold-selector";
import { ErrorState } from "@/components/common/error-state";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { nicheColor } from "@/components/niches/niche-chip";
import {
  NicheThresholdDialog,
  useCanConfigureThreshold,
} from "@/components/niches/niche-threshold-dialog";
import {
  NeedsRuleBadge,
  NicheByline,
  needsRuleConfiguration,
  unconfiguredFirst,
} from "@/components/niches/niche-threshold-status";
import {
  NicheRpmDialog,
  RPM_MENU_ITEM_LABEL,
  useCanConfigureRpm,
} from "@/components/niches/niche-rpm-dialog";
import { NicheValueStrip } from "@/components/niches/niche-value-strip";
import { NotesPanel } from "@/components/notes/notes-panel";
import { HitRateBounds } from "@/components/metrics/hit-rate-value";
import { useChannelRows, type ChannelRow } from "@/hooks/use-channel-analytics";
import { useDataset } from "@/hooks/use-dataset";
import { useCreateNiche, useDeleteNiche, useRenameNiche } from "@/hooks/use-niches";
import { useFilters } from "@/components/providers/filters-provider";
import { calculateChannelMetrics, calculatePortfolioSummary } from "@/lib/analytics";
import { calculateMarketShare } from "@/lib/analytics/market-share";
import type { NicheDTO } from "@/lib/dto";
import {
  NICHE_KIND_DESCRIPTION,
  NICHE_KIND_LABEL,
  NICHE_KIND_PLURAL,
  NICHE_KINDS,
  type NicheKind,
} from "@/lib/niches/niche-kind";
import { EM_DASH, formatCompactNumber, formatNumber, formatPercent } from "@/lib/format";
import {
  EMPLOYEE_HIT_RULE_NOTICE,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  THRESHOLD_PRESETS,
  UNCONFIGURED_RULE_SHORT,
} from "@/lib/analytics/constants";
import { cn } from "@/lib/utils";

/**
 * Niches — organisation with just enough analytics to be worth visiting.
 *
 * Deliberately *not* a second dashboard. Each card answers "is this niche worth
 * my attention?" in four numbers and then hands off to the real dashboard,
 * filtered. Rebuilding charts and tables per niche would duplicate the product
 * and give two places where the same number could disagree.
 */
export default function NichesPage() {
  const { data, isLoading, error, refetch } = useDataset();
  const [createOpen, setCreateOpen] = React.useState(false);

  const rows = useChannelRows(data);

  /*
   * Unconfigured niches float to the top.
   *
   * The brief asks for them to be visible rather than buried, and the default
   * `sortOrder` buries them by construction — a niche created yesterday sorts
   * last, and a niche created yesterday is exactly the one still waiting for a
   * number. This is the ordering for everybody, not just admins: an employee
   * seeing their own unconfigured niche at the top is the fastest route to them
   * asking an Admin for the number.
   */
  const niches = React.useMemo(
    () => unconfiguredFirst(data?.niches ?? []),
    [data?.niches],
  );

  /*
   * GROUPED BY KIND, WITH THE TWO GROUPS NAMED AND SEPARATED.
   *
   * They are two different jobs. Production niches are the ones Northstar
   * publishes into: they are the scorecard, they pay, and they are what the
   * portfolio hit rate is measured over. Watchlist niches are the ones the
   * studio follows for formats worth stealing and openings worth taking —
   * fully browsable, fully analysed, and deliberately outside "how are WE
   * doing". One grid mixing them is what made the portfolio average describe
   * work the studio does not do, so the page stops presenting them as one list.
   *
   * The unconfigured-first ordering survives inside each group: it is about
   * what still needs a decision, which is a question within a group rather than
   * across the two.
   */
  const production = React.useMemo(
    () => niches.filter((niche) => niche.kind === "production"),
    [niches],
  );
  const watchlist = React.useMemo(
    () => niches.filter((niche) => niche.kind === "watchlist"),
    [niches],
  );

  /*
   * Counted over PRODUCTION niches only.
   *
   * A watchlist niche with no threshold is not a task anybody has to do —
   * nothing is paid for it and nobody is judged on it — so putting it in a
   * banner that says "no hit rate is reported until an Admin sets one" would
   * manufacture work. The badge on its own card still marks it, because a
   * watchlist niche with no rule genuinely does report nothing, and somebody
   * watching a niche presumably wants to see how it is doing.
   */
  const unconfiguredCount = production.filter(needsRuleConfiguration).length;

  const unassigned = React.useMemo(
    () => rows.filter((row) => row.channel.niches.length === 0),
    [rows],
  );

  /*
   * There is no per-niche content-type count here any more.
   *
   * There was one for a round, when each niche owned its own vocabulary and
   * "does this niche have a working list yet?" was a real question about a real
   * per-niche number. Content types are one flat org-wide list again, so every
   * card would print the same figure — which is not a fact about the niche and
   * would read as if it were.
   */

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Niches"
        // Says what the two groups are, because the split changes how the page
        // is read: the production group is the studio's scorecard and the
        // watchlist group is research. No single number belongs in this
        // sentence — each card is scored at its own threshold and the ones with
        // none are not scored at all.
        description="How each niche is performing, each scored at its own hit threshold. Production niches are the ones Northstar publishes into and the ones the portfolio hit rate is measured over; watchlist niches are followed rather than competed in. A niche with no complete rule reports no hit rate until one is set. Click one to open the dashboard filtered to it."
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            New niche
          </Button>
        }
      />

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <PeriodSelector />
            <ThresholdSelector />
          </div>

          {isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-44 w-full rounded-lg" />
              ))}
            </div>
          ) : niches.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Layers />}
                title="No niches yet"
                description="Group your tracked channels by topic — GTA, Minecraft, Finance, Fitness, whatever matches how you actually work. Nothing is preset; you define them."
                action={
                  <Button variant="primary" onClick={() => setCreateOpen(true)}>
                    <Plus />
                    Create your first niche
                  </Button>
                }
              />
            </Card>
          ) : (
            <>
              {unconfiguredCount > 0 ? (
                <UnconfiguredSummary count={unconfiguredCount} />
              ) : null}

              <NicheKindGroup kind="production" niches={production} rows={rows} />
              <NicheKindGroup kind="watchlist" niches={watchlist} rows={rows} />
            </>
          )}

          {unassigned.length > 0 ? (
            <UncategorisedCard rows={unassigned} />
          ) : null}
        </>
      )}

      <CreateNicheDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageContainer>
  );
}

/**
 * One kind of niche, under its own heading.
 *
 * A heading and a sentence rather than a tab or a filter, because both groups
 * are worth looking at and they answer different questions — the point of a
 * watchlist niche is that somebody DOES read its numbers. Hiding one behind a
 * control would make the split feel like a preference rather than what it is: a
 * statement about which of these the studio is accountable for.
 *
 * Renders nothing when the group is empty. An account with no watchlist niches
 * should not carry a heading explaining a concept it is not using.
 */
function NicheKindGroup({
  kind,
  niches,
  rows,
}: {
  kind: NicheKind;
  niches: readonly NicheDTO[];
  rows: readonly ChannelRow[];
}) {
  if (niches.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border pb-2">
        <h2 className="text-[13px] font-medium text-foreground">
          {NICHE_KIND_PLURAL[kind]}
        </h2>
        <span className="tnum text-[12px] text-subtle-foreground">
          {formatNumber(niches.length)}
        </span>
        <p className="w-full max-w-prose text-[12px] leading-relaxed text-muted-foreground">
          {NICHE_KIND_DESCRIPTION[kind]}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {niches.map((niche) => (
          <NicheCard key={niche.id} niche={niche} rows={rows} />
        ))}
      </div>
    </section>
  );
}

function NicheCard({
  niche,
  rows,
}: {
  niche: NicheDTO;
  rows: readonly ChannelRow[];
}) {
  const { range } = useFilters();
  /*
   * This niche's own definition of a hit — and nothing else.
   *
   * There is deliberately no `?? accountThreshold` here any more. A card that
   * borrowed the organization default would print "Hit rate ≥1M · 34.2%" for a
   * niche whose threshold nobody has chosen, and that percentage is the whole
   * bug: real arithmetic over an invented input, indistinguishable on screen
   * from a real measurement.
   */
  const nicheThreshold = niche.hitThreshold;
  const needsThreshold = needsRuleConfiguration(niche);
  const canConfigure = useCanConfigureThreshold();

  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [notesOpen, setNotesOpen] = React.useState(false);
  const [thresholdOpen, setThresholdOpen] = React.useState(false);
  const [rpmOpen, setRpmOpen] = React.useState(false);
  const canConfigureRpm = useCanConfigureRpm();

  const members = React.useMemo(
    () => rows.filter((row) => row.channel.niches.some((n) => n.id === niche.id)),
    [rows, niche.id],
  );

  // Recomputed at this niche's bar rather than reusing row.metrics, which is
  // annotated against whatever the page-level bar happens to be.
  //
  // THE HIT RATE IS THE SAME EITHER WAY, and that is the change worth noting:
  // it is counted from the verdicts stored on the Shorts, each decided against
  // the rule of the niche that governs it, so no threshold passed in here can
  // move it. What the bar still changes is the shading and the ratio column.
  // A niche with no rule yields `unscoreable` Shorts, a null rate, and a card
  // reading "Not configured" — with the volume figures beside it unaffected
  // and still entirely real.
  const entries = React.useMemo(
    () =>
      members.map((row) => ({
        id: row.channel.id,
        name: row.channel.displayName,
        metrics: calculateChannelMetrics({
          videos: row.videos,
          range,
          threshold: nicheThreshold,
        }),
        // TRUE FOR EVERY CARD, INCLUDING A WATCHLIST ONE. This card is one
        // niche's own analytics, which is exactly what a watchlist niche is
        // for — the whole reason to watch a niche is to see how it performs.
        // The exclusion belongs to the POOLED portfolio figure, where mixing
        // the two produces one number describing two different jobs; here
        // there is only ever one niche in the pool and it is the one named at
        // the top of the card.
        countsTowardHitRate: true,
      })),
    [members, range, nicheThreshold],
  );

  const summary = React.useMemo(() => calculatePortfolioSummary(entries), [entries]);

  /*
   * The two view totals the money strip prices: ours, and everybody else we
   * track in this niche.
   *
   * `calculateMarketShare` already splits exactly this way and already carries
   * the honesty rules — a share of nothing is `null`, and the denominator is
   * the TRACKED set rather than the market. Reusing it means the money figure
   * and the share on the dashboard are built from one view measure rather than
   * two that can drift.
   *
   * NOTE WHICH VIEW MEASURE THAT IS: current lifetime views of Shorts PUBLISHED
   * in the period, per `getShortsInDateRange`. It is not views EARNED in the
   * period, which needs the snapshot series nothing is currently writing. That
   * distinction is why this figure is only ever used to size the niche and is
   * never fed back into deriving a rate — pairing lifetime views of new videos
   * with a month of revenue produces a number with no interpretation.
   */
  const share = React.useMemo(() => {
    const own = members.filter((row) => row.channel.ownershipType === "own");
    const others = members.filter((row) => row.channel.ownershipType !== "own");
    return calculateMarketShare(
      own.map((row) => ({ videos: row.videos })),
      others.map((row) => ({ videos: row.videos })),
      range,
    );
  }, [members, range]);

  const best = summary.topChannel;
  /*
   * The top channel's OWN verdicts, so the range printed beside its rate is its
   * range and not the niche's.
   *
   * `topChannel` carries a bare number by design — it is the result of a
   * ranking, not a measurement anybody should quote — so the summary it was
   * ranked from is looked back up here rather than widened into the portfolio
   * shape. Pooling the niche's bounds onto one channel's percentage would be a
   * new wrong number in place of an incomplete one.
   */
  const bestHits = best
    ? (entries.find((entry) => entry.id === best.id)?.metrics.hits ?? null)
    : null;

  return (
    <>
      <Card className="group relative flex flex-col p-4 transition-colors duration-150 hover:border-border-strong">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ background: nicheColor(niche.colorIndex) }}
            />
            <Link
              href={`/?niche=${encodeURIComponent(niche.id)}`}
              className="truncate text-[14px] font-medium text-foreground transition-colors hover:text-accent"
            >
              {niche.name}
              <span className="absolute inset-0" aria-hidden />
            </Link>
          </div>

          <div className="relative z-10">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                {/*
                  ALWAYS VISIBLE, at the owner's request, and the fix is the
                  deletion rather than an addition.

                  This carried `opacity-0` plus three rules that each existed
                  only to undo it on hover, on focus and while the menu was
                  open. Remove the `opacity-0` and all three become dead, so
                  the whole group goes and the Button's own variant styling is
                  what shows. There is nothing left to reveal, which is why no
                  focus or open handling has to be re-added.

                  This menu is now also the ONLY way into the RPM dialog — the
                  inline "Set RPM range" links were removed from the money strip
                  — so a control that only appeared under a pointer would have
                  made pricing a niche unreachable on a touch screen.
                */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${niche.name}`}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Only for somebody the server will actually let through.
                    Renaming a niche is `niches.manage`; the threshold is
                    `settings.manage`, so this one item is gated separately
                    rather than the whole menu. */}
                {canConfigure ? (
                  <DropdownMenuItem onSelect={() => setThresholdOpen(true)}>
                    <Target />
                    Hit rule
                  </DropdownMenuItem>
                ) : null}
                {/* A separate item for a separate decision behind a separate
                    pair of permissions. The hit rule says what counts as a win
                    here; the RPM says what the market pays for views, which is
                    a fact about the outside world. */}
                {/* THE ONLY ENTRY POINT NOW. The money strip below used to
                    carry its own inline "Set RPM range" links; they are gone,
                    so this item is what the strip's sentence points at. Its
                    label is imported rather than typed, so the two cannot
                    drift. */}
                {canConfigureRpm ? (
                  <DropdownMenuItem onSelect={() => setRpmOpen(true)}>
                    <DollarSign />
                    {RPM_MENU_ITEM_LABEL}
                  </DropdownMenuItem>
                ) : null}
                {/* There was a "Niche settings" item here, and a second link to
                    the same page lower down the card. Both are gone with the
                    page they opened: once content types stopped being per-niche
                    it held a threshold, a price and an author line, and the
                    first two are edited in the Hit rule dialog directly above
                    while the third is on the card itself. Two doors into a page
                    that restated what this card already says is what made them
                    useless. */}
                <DropdownMenuItem onSelect={() => setNotesOpen(true)}>
                  <StickyNote />
                  Niche notes
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                  <Pencil />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem tone="danger" onSelect={() => setDeleteOpen(true)}>
                  <Trash2 />
                  Delete niche
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* The marker and the byline, together: what needs doing, and whose
            niche it is. An admin scanning this grid for work to chase needs
            both in the same glance. */}
        {needsThreshold ? (
          <div className="relative z-10 mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
            <NeedsRuleBadge niche={niche} />
            <NicheByline niche={niche} />
            {canConfigure ? (
              <button
                type="button"
                onClick={() => setThresholdOpen(true)}
                className="text-[11px] font-medium text-accent transition-colors hover:text-accent-hover"
              >
                Set hit rule
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-3">
          <MiniStat label="Channels" value={formatNumber(members.length)} />
          <MiniStat label="Shorts" value={formatNumber(summary.totalShorts)} />
          <MiniStat
            label={
              nicheThreshold === null
                ? "Hit rate"
                : `Hit rate ≥${formatCompactNumber(nicheThreshold)}`
            }
            // Words, not an em dash. "—" is the app's symbol for "no Shorts in
            // this period", and reusing it here would say the niche was
            // measured and came up empty.
            value={
              nicheThreshold === null
                ? UNCONFIGURED_RULE_SHORT
                : formatPercent(summary.averageHitRate)
            }
            muted={nicheThreshold === null}
          />
        </div>

        {/* Between the volume stats and the top-channel footer: what the
            tracked niche is worth follows what it did, and precedes who in it
            did best. Renders nothing at all for a reader without finance
            access — see the note on `NicheDTO.rpm`. */}
        <NicheValueStrip
          niche={niche}
          ourViews={share.ourViews}
          competitorViews={share.competitorViews}
        />

        <div className="mt-3 flex min-h-[32px] items-center justify-between gap-2 border-t border-border pt-3">
          {nicheThreshold === null ? (
            <span className="text-[12px] text-subtle-foreground">
              {members.length === 0
                ? "No channels assigned yet"
                : `${formatNumber(members.length)} ${members.length === 1 ? "channel" : "channels"}, no hit rate until a threshold is set`}
            </span>
          ) : best ? (
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-subtle-foreground">
                Top channel
              </div>
              {/* The name yields the width, not the figures: a single `truncate`
                  over the whole line would clip the range off the end, which is
                  the one part of it a reader cannot reconstruct. Compact and
                  title-only because this footer sits UNDER the card's stretched
                  link, where an info button would never receive a click. */}
              <div className="flex min-w-0 items-baseline gap-1.5 text-[12px] text-foreground">
                <span className="truncate">{best.name}</span>
                <span className="tnum shrink-0 text-subtle-foreground">
                  {formatPercent(best.hitRate)}
                </span>
                {bestHits ? <HitRateBounds summary={bestHits} compact /> : null}
              </div>
            </div>
          ) : (
            <span className="text-[12px] text-subtle-foreground">
              {members.length === 0
                ? "No channels assigned yet"
                : "No Shorts in this period"}
            </span>
          )}

          <ArrowRight className="size-3.5 shrink-0 text-subtle-foreground transition-transform group-hover:translate-x-0.5" />
        </div>
      </Card>

      <NicheThresholdDialog
        niche={niche}
        open={thresholdOpen}
        onOpenChange={setThresholdOpen}
      />
      <NicheRpmDialog niche={niche} open={rpmOpen} onOpenChange={setRpmOpen} />
      <NicheNotesDialog niche={niche} open={notesOpen} onOpenChange={setNotesOpen} />
      <RenameNicheDialog niche={niche} open={renameOpen} onOpenChange={setRenameOpen} />
      <DeleteNicheDialog
        niche={niche}
        channelCount={members.length}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </>
  );
}

/**
 * Channels with no niche.
 *
 * Surfaced rather than hidden: unfiled channels are invisible to every niche
 * filter, so a user who never sees this list would never know their taxonomy
 * has gaps.
 */
function UncategorisedCard({ rows }: { rows: readonly ChannelRow[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-[13px] font-medium text-foreground">Uncategorised</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {rows.length} tracked {rows.length === 1 ? "channel is" : "channels are"} not in
          any niche. Assign one from the channel menu, or open the channel and use its
          niche control.
        </p>
      </div>

      <Card className="divide-y divide-border">
        {rows.map((row) => (
          <div key={row.channel.id} className="flex items-center gap-3 px-4 py-2.5">
            <Avatar src={row.channel.avatarUrl} name={row.channel.displayName} size={26} />
            <Link
              href={`/channels/${row.channel.id}`}
              className="min-w-0 flex-1 truncate text-[13px] text-foreground transition-colors hover:text-accent"
            >
              {row.channel.displayName}
            </Link>
            {/* An unfiled channel is one nobody has characterised yet, so its
                Shorts are the likeliest in the app to have gone unrecorded.
                Printing the rate here without the range would be the bare
                figure at its least defensible. */}
            <span className="tnum flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
              {row.metrics.hits.rate === null
                ? EM_DASH
                : formatPercent(row.metrics.hits.rate)}
              <HitRateBounds summary={row.metrics.hits} compact />
            </span>
          </div>
        ))}
      </Card>
    </div>
  );
}

function MiniStat({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  /** For a value that is a word rather than a figure — "Not configured". */
  muted?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
        {label}
      </span>
      <span
        className={cn(
          "truncate font-medium",
          muted
            ? "text-[12px] text-subtle-foreground"
            : "tnum text-[15px] text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The count of niches still waiting for a number, above the grid.
 *
 * Not an error banner and not dismissible: it is a standing fact about the
 * team's configuration, and it disappears on its own the moment the last niche
 * is configured. It exists because the grid can be three screens long, and
 * "sorted first" only helps somebody who scrolls to the top.
 */
function UnconfiguredSummary({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning-subtle/40 px-3 py-2">
      <Target className="size-3.5 shrink-0 text-warning" aria-hidden />
      <p className="text-[12px] text-foreground">
        {count === 1
          ? "1 niche has no complete hit rule"
          : `${formatNumber(count)} niches have no complete hit rule`}
        <span className="text-muted-foreground">
          {" "}
          — no hit rate is reported for {count === 1 ? "it" : "them"} until an Admin sets
          one. Shown first below.
        </span>
      </p>
    </div>
  );
}

function CreateNicheDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {open ? <CreateNicheForm onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Creating a niche, in the two shapes it legitimately has.
 *
 * An Admin — someone holding `settings.manage` alongside `niches.manage` — is
 * asked for a "Hit Rate View Count" here, because they are the person who can
 * answer it and the moment of creation is when the answer is cheapest to give.
 * It stays optional: an admin who does not know the number yet should not be
 * blocked from making the niche, and the card will carry "Needs hit rate
 * configuration" until they come back to it.
 *
 * An employee — `niches.manage` without `settings.manage` — is not shown the
 * field at all, and the request their browser sends does not carry the key.
 * They are told plainly what that means, in the words the brief asked for,
 * rather than being left to wonder why their niche shows no hit rate. The
 * server refuses a threshold from them regardless of what this form does, which
 * is what makes the omission an affordance rather than the security boundary.
 */
function CreateNicheForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [name, setName] = React.useState("");
  const [thresholdInput, setThresholdInput] = React.useState("");
  // Production by default, deliberately: it is the inclusive answer, and a
  // niche that defaulted to watchlist would drop its channels out of the
  // portfolio hit rate the moment somebody created one.
  const [kind, setKind] = React.useState<NicheKind>("production");
  const [error, setError] = React.useState<string | null>(null);
  const canConfigure = useCanConfigureThreshold();
  const create = useCreateNiche();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    let hitThreshold: number | undefined;
    if (canConfigure) {
      // People paste view counts: "1,000,000" and "1 000 000" both mean 1M.
      const cleaned = thresholdInput.replace(/[,\s_]/g, "");
      if (cleaned) {
        const parsed = Number(cleaned);
        if (!Number.isFinite(parsed) || parsed < MIN_THRESHOLD) {
          setError(`Enter a number of at least ${MIN_THRESHOLD}, or leave it empty.`);
          return;
        }
        if (parsed > MAX_THRESHOLD) {
          setError("That is higher than any video has ever been viewed.");
          return;
        }
        hitThreshold = Math.trunc(parsed);
      }
    }

    // The key is absent, not null, when there is no threshold to send. The
    // server treats a present `hitThreshold` — null included — as a threshold
    // write and refuses it without `settings.manage`. `kind` rides on
    // `niches.manage`, which anybody reaching this form already holds.
    create.mutate(
      hitThreshold === undefined
        ? { name: trimmed, kind }
        : { name: trimmed, kind, hitThreshold },
      {
        onSuccess: ({ niche }) => {
          toast.success(`Niche “${niche.name}” created`, {
            description:
              niche.hitThreshold === null
                ? "No complete hit rule yet — a hit needs both a view threshold and a window — so no hit rate is reported for it."
                : `A hit in ${niche.name} is ${formatCompactNumber(niche.hitThreshold)} views.`,
          });
          onOpenChange(false);
        },
        onError: (error) =>
          toast.error("Could not create that niche", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>New niche</DialogTitle>
        <DialogDescription>
          A niche is just a label you define — use whatever matches how you organise
          your research.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="niche-name">Name</Label>
          <Input
            id="niche-name"
            autoFocus
            value={name}
            maxLength={48}
            placeholder="e.g. GTA"
            onChange={(event) => setName(event.target.value)}
          />
          <FieldHint>
            Names are case-insensitive, so “GTA” and “gta” are the same niche.
          </FieldHint>
        </div>

        {/*
          Asked at creation because it is the cheapest moment to answer it, and
          because getting it wrong is not free: a watchlist niche filed as
          production drags channels nobody is trying to be into the portfolio
          hit rate. `niches.manage` is the floor for this whole form, so
          everybody who can see it can answer this.
        */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="niche-kind-new">Kind</Label>
          <div id="niche-kind-new" className="flex flex-wrap gap-1.5">
            {NICHE_KINDS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={kind === option}
                onClick={() => setKind(option)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors",
                  kind === option
                    ? "border-accent bg-accent-subtle text-foreground"
                    : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
                )}
              >
                {NICHE_KIND_LABEL[option]}
              </button>
            ))}
          </div>
          <FieldHint>{NICHE_KIND_DESCRIPTION[kind]}</FieldHint>
        </div>

        {canConfigure && kind === "production" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="niche-hit-rate">Hit Rate View Count</Label>
            <Input
              id="niche-hit-rate"
              inputMode="numeric"
              placeholder="e.g. 1000000"
              value={thresholdInput}
              invalid={Boolean(error)}
              onChange={(event) => {
                setThresholdInput(event.target.value);
                setError(null);
              }}
            />
            {error ? (
              <FieldHint tone="danger">{error}</FieldHint>
            ) : (
              <FieldHint>
                How many views make a Short a hit in this niche. Optional — leave it
                empty and set it later; no hit rate is reported until you do.
              </FieldHint>
            )}
            <div className="flex flex-wrap gap-1.5">
              {THRESHOLD_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => {
                    setThresholdInput(String(preset));
                    setError(null);
                  }}
                  className={cn(
                    "tnum rounded-md border px-2 py-1 text-[12px] font-medium transition-colors",
                    Number(thresholdInput) === preset
                      ? "border-accent bg-accent-subtle text-foreground"
                      : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
                  )}
                >
                  ≥ {formatCompactNumber(preset)}
                </button>
              ))}
            </div>
          </div>
        ) : kind === "watchlist" ? (
          /* No threshold field for a watchlist niche at creation, for the same
             reason there is no payment field for one in the rule dialog: it is
             a niche to follow, and its rule is a decision to make once somebody
             has decided what they are watching for. It can be set any time from
             the niche's own dialog. */
          <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
            A watchlist niche is followed rather than published into. It gets its own
            hit rate once a rule is set for it, it is left out of the portfolio hit
            rate, and no hit in it is paid.
          </p>
        ) : (
          /* Friendly and specific, not a permission error. They are allowed to
             be here; the number is simply somebody else's to choose. */
          <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
            {EMPLOYEE_HIT_RULE_NOTICE}
          </p>
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
          Create niche
        </Button>
      </DialogFooter>
    </form>
  );
}

function RenameNicheDialog({
  niche,
  open,
  onOpenChange,
}: {
  niche: NicheDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {open ? <RenameNicheForm niche={niche} onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameNicheForm({
  niche,
  onOpenChange,
}: {
  niche: NicheDTO;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = React.useState(niche.name);
  const rename = useRenameNiche();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    rename.mutate(
      { id: niche.id, name: trimmed },
      {
        onSuccess: () => {
          toast.success("Niche renamed");
          onOpenChange(false);
        },
        onError: (error) =>
          toast.error("Could not rename that niche", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Rename niche</DialogTitle>
        <DialogDescription>
          Every channel filed under it keeps its assignment.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-2">
        <Label htmlFor="rename-niche">Name</Label>
        <Input
          id="rename-niche"
          autoFocus
          value={name}
          maxLength={48}
          onChange={(event) => setName(event.target.value)}
        />
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={rename.isPending} disabled={!name.trim()}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeleteNicheDialog({
  niche,
  channelCount,
  open,
  onOpenChange,
}: {
  niche: NicheDTO;
  channelCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteNiche();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{niche.name}”?</DialogTitle>
          <DialogDescription>This removes the label, nothing else.</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {channelCount === 0
              ? "No channels are filed under this niche."
              : `${channelCount} ${channelCount === 1 ? "channel" : "channels"} will become uncategorised.`}{" "}
            No channel is removed from your tracker and no Shorts, view counts or history
            are affected — a niche is only a label.
          </p>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(niche.id, {
                onSuccess: ({ unassignedChannels }) => {
                  toast.success(`Niche “${niche.name}” deleted`, {
                    description:
                      unassignedChannels > 0
                        ? `${unassignedChannels} ${unassignedChannels === 1 ? "channel is" : "channels are"} now uncategorised.`
                        : undefined,
                  });
                  onOpenChange(false);
                },
                onError: (error) =>
                  toast.error("Could not delete that niche", {
                    description: error instanceof Error ? error.message : undefined,
                  }),
              })
            }
          >
            Delete niche
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NicheNotesDialog({
  niche,
  open,
  onOpenChange,
}: {
  niche: NicheDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="pr-6">{niche.name} notes</DialogTitle>
          <DialogDescription>
            Context about this niche as a whole — what is driving performance, what
            formats are working.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="pt-0">
          {open ? (
            <NotesPanel
              targetType="niche"
              targetId={niche.id}
              title="Niche notes"
              compact
              className="border-0 bg-transparent"
            />
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
