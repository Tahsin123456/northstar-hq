"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  Layers,
  MoreHorizontal,
  Pencil,
  Plus,
  Shapes,
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
import { NotesPanel } from "@/components/notes/notes-panel";
import { HitRateBounds } from "@/components/metrics/hit-rate-value";
import { useChannelRows, type ChannelRow } from "@/hooks/use-channel-analytics";
import { useDataset } from "@/hooks/use-dataset";
import { useCreateNiche, useDeleteNiche, useRenameNiche } from "@/hooks/use-niches";
import { useFilters } from "@/components/providers/filters-provider";
import { calculateChannelMetrics, calculatePortfolioSummary } from "@/lib/analytics";
import type { NicheDTO } from "@/lib/dto";
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

  const unconfiguredCount = niches.filter(needsRuleConfiguration).length;

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
        // No single number belongs in this sentence. Each card is scored at its
        // own threshold, and the ones with none are not scored at all — the old
        // copy named the account default as the value used "where none is set",
        // which is precisely the fallback this round removed.
        description="How each niche is performing, each scored at its own hit threshold. A niche with no threshold reports no hit rate until one is set. Click one to open the dashboard filtered to it."
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

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {niches.map((niche) => (
                  <NicheCard key={niche.id} niche={niche} rows={rows} />
                ))}
              </div>
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
      })),
    [members, range, nicheThreshold],
  );

  const summary = React.useMemo(() => calculatePortfolioSummary(entries), [entries]);

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
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${niche.name}`}
                  className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
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
                    Hit threshold
                  </DropdownMenuItem>
                ) : null}
                {/* The niche's own page: threshold, author, the settings that
                    genuinely belong to this niche.

                    It said "Content types" until content types stopped being a
                    per-niche vocabulary. They are now one flat set of tags the
                    whole organization shares, so a menu item here would promise
                    a list scoped to this niche that does not exist — and the
                    page it opened would have to explain that it had lied. The
                    catalogue lives at /content-types, in the sidebar. */}
                <DropdownMenuItem asChild>
                  <Link href={`/niches/${niche.id}`}>
                    <Shapes />
                    Niche settings
                  </Link>
                </DropdownMenuItem>
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
                Set threshold
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

        {/*
          The way into the niche's own settings — its threshold and its author.
          It used to lead to the niche's content types; those are one shared
          list now, reached from `/content-types`, and pointing a per-niche link
          at an org-wide catalogue would suggest the two were related. `z-10`
          because the card's title is a stretched link over the whole surface.
        */}
        <Link
          href={`/niches/${niche.id}`}
          className="relative z-10 mt-3 inline-flex items-center gap-1.5 self-start text-[11px] text-muted-foreground transition-colors hover:text-accent"
        >
          <Shapes className="size-3" />
          Niche settings
        </Link>

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
    // write and refuses it without `settings.manage`.
    create.mutate(
      hitThreshold === undefined ? { name: trimmed } : { name: trimmed, hitThreshold },
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

        {canConfigure ? (
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
