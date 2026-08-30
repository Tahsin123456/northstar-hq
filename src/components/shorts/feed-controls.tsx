"use client";

import * as React from "react";
import { ChevronDown, Eye, SlidersHorizontal } from "lucide-react";
import type { OutlierSortKey } from "@/lib/analytics/outliers";
import type { DateRange } from "@/lib/analytics/types";
import type { DatasetDTO } from "@/lib/dto";
import type { OwnershipFilter } from "@/lib/filters-store";
import { tallyEffectiveShorts } from "@/lib/content-types/tally";
import { useFilters } from "@/components/providers/filters-provider";
import {
  ContentTypeFilterControl,
  NicheFilterControl,
} from "@/components/dashboard/scope-filters";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNow } from "@/hooks/use-now";
import { formatCompactNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Controls for the Winners / Outliers feeds.
 *
 * These pages need a *tighter* time axis than the dashboard — "what is hot"
 * is a 24-hour-to-30-day question — so they carry their own window control
 * rather than reusing the 7/30/90/180 analysis periods. Niche stays on the
 * global filter, so moving between the dashboard and a feed keeps the same
 * market in view.
 */

const TRIGGER_CLASS =
  "group inline-flex h-[30px] items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 text-[12px] font-medium transition-colors duration-150 hover:border-border-strong";

export interface FeedWindow {
  readonly id: string;
  readonly label: string;
  readonly days: number;
}

export const FEED_WINDOWS: readonly FeedWindow[] = [
  { id: "1d", label: "24 hours", days: 1 },
  { id: "3d", label: "3 days", days: 3 },
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "180d", label: "180 days", days: 180 },
];

const MIN_VIEW_OPTIONS = [0, 10_000, 100_000, 250_000, 500_000, 1_000_000] as const;

const SORT_OPTIONS: { id: OutlierSortKey; label: string }[] = [
  { id: "outlierMultiple", label: "Outlier multiple" },
  { id: "views", label: "Views" },
  { id: "viewsPerDay", label: "Views per day" },
  { id: "publishedAt", label: "Most recent" },
];

export interface FeedControlsState {
  windowDays: number;
  setWindowDays: (days: number) => void;
  range: DateRange;
  ownership: OwnershipFilter;
  setOwnership: (value: OwnershipFilter) => void;
  minViews: number;
  setMinViews: (value: number) => void;
  channelId: string | null;
  setChannelId: (value: string | null) => void;
  sort: OutlierSortKey;
  setSort: (value: OutlierSortKey) => void;
}

export function useFeedControls(defaults: {
  defaultWindowDays: number;
  defaultOwnership: OwnershipFilter;
  defaultSort: OutlierSortKey;
}): FeedControlsState {
  const [windowDays, setWindowDays] = React.useState(defaults.defaultWindowDays);
  const [ownership, setOwnership] = React.useState<OwnershipFilter>(defaults.defaultOwnership);
  const [minViews, setMinViews] = React.useState(0);
  const [channelId, setChannelId] = React.useState<string | null>(null);
  const [sort, setSort] = React.useState<OutlierSortKey>(defaults.defaultSort);

  const now = useNow();

  const range = React.useMemo<DateRange>(() => {
    // `now === 0` before the clock store subscribes; an epoch-anchored window
    // would match nothing, so hold the range empty for that one frame rather
    // than computing an impure Date.now() during render.
    const end = now === 0 ? 0 : now;
    return { startMs: end - windowDays * 86_400_000, endMs: end };
  }, [now, windowDays]);

  return {
    windowDays,
    setWindowDays,
    range,
    ownership,
    setOwnership,
    minViews,
    setMinViews,
    channelId,
    setChannelId,
    sort,
    setSort,
  };
}

export function FeedControls({
  controls,
  dataset,
  showNiche = true,
  showOwnership = true,
  showSort = true,
  className,
}: {
  controls: FeedControlsState;
  dataset: DatasetDTO | undefined;
  showNiche?: boolean;
  showOwnership?: boolean;
  showSort?: boolean;
  className?: string;
}) {
  const { niche } = useFilters();
  // Memoised so the fallback [] keeps a stable identity between renders.
  const channels = React.useMemo(() => dataset?.channels ?? [], [dataset]);
  const niches = dataset?.niches ?? [];
  const contentTypes = dataset?.contentTypes ?? [];

  const unassignedCount = channels.filter((c) => c.channel.niches.length === 0).length;

  /*
   * Shorts with no classification, counted over the Shorts this feed can show.
   *
   * The unit is a SHORT here, not a channel — the rows on these pages are
   * Shorts, and `useShortsFeed` matches each one's EFFECTIVE tags. Counting
   * channels would offer "Untagged · 4" above a list of two hundred Shorts.
   *
   * RESOLVED, because the badge has to agree with the filter it labels. A Short
   * on a tagged channel is classified whether or not a row exists for it, so
   * counting empty rows would advertise "Untagged · 3,900" and then produce an
   * empty feed — the badge and the predicate reading the same rule is the only
   * thing that keeps that promise honest.
   *
   * Deliberately over every stored Short rather than the feed's current window:
   * the window is a page-local control that moves constantly, and a count that
   * moved with it would be a different promise on every click. It is an
   * order-of-magnitude cue for whether the option is worth picking, which is all
   * a menu badge ever is.
   */
  const shortsTally = React.useMemo(
    () =>
      tallyEffectiveShorts(
        channels.map((entry) => ({
          rules: entry.channel.contentTypeRules,
          videos: entry.videos,
        })),
      ),
    [channels],
  );

  // The channel picker only offers channels inside the active niche, so the two
  // filters cannot contradict each other.
  const selectableChannels = React.useMemo(
    () =>
      channels
        .filter((entry) => {
          if (niche === "all") return true;
          if (niche === "unassigned") return entry.channel.niches.length === 0;
          return entry.channel.niches.some((n) => n.id === niche);
        })
        .map((entry) => entry.channel),
    [channels, niche],
  );

  const activeChannel = selectableChannels.find((c) => c.id === controls.channelId) ?? null;

  const currentWindow =
    FEED_WINDOWS.find((w) => w.days === controls.windowDays) ?? FEED_WINDOWS[2];

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {/* --- Window --- */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={TRIGGER_CLASS}>
            <span className="text-muted-foreground">Uploaded in</span>
            <span className="text-foreground">last {currentWindow.label}</span>
            <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={String(controls.windowDays)}
            onValueChange={(value) => controls.setWindowDays(Number(value))}
          >
            {FEED_WINDOWS.map((option) => (
              <DropdownMenuRadioItem key={option.id} value={String(option.days)}>
                Last {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {showNiche ? (
        <NicheFilterControl niches={niches} unassignedCount={unassignedCount} />
      ) : null}

      {/* The global content-type filter, in its per-Short reading. It is shown
          here rather than left invisible because a filter that narrows a feed
          without appearing above it is indistinguishable from missing data. */}
      <ContentTypeFilterControl
        contentTypes={contentTypes}
        unassignedCount={shortsTally.untagged}
        shortCounts={shortsTally.byType}
        unit="short"
      />

      {/* --- Channel type (page-local, not the global filter) --- */}
      {showOwnership ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={TRIGGER_CLASS}>
              <span className="text-muted-foreground">Channels</span>
              <span className="text-foreground">
                {controls.ownership === "all"
                  ? "All"
                  : controls.ownership === "own"
                    ? "Ours"
                    : "Competitors"}
              </span>
              <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={controls.ownership}
              onValueChange={(value) => controls.setOwnership(value as OwnershipFilter)}
            >
              <DropdownMenuRadioItem value="competitor">Competitors</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="own">Our channels</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="all">All channels</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {/* --- Specific channel --- */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={TRIGGER_CLASS}>
            <span className="text-muted-foreground">Channel</span>
            <span className="max-w-[130px] truncate text-foreground">
              {activeChannel ? activeChannel.displayName : "Any"}
            </span>
            <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[320px] overflow-y-auto">
          <DropdownMenuRadioGroup
            value={controls.channelId ?? "any"}
            onValueChange={(value) => controls.setChannelId(value === "any" ? null : value)}
          >
            <DropdownMenuRadioItem value="any">Any channel</DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            {selectableChannels.map((channel) => (
              <DropdownMenuRadioItem key={channel.id} value={channel.id}>
                <span className="max-w-[200px] truncate">{channel.displayName}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* --- Minimum views --- */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={TRIGGER_CLASS}>
            <Eye className="size-3.5 text-subtle-foreground" />
            <span className="text-muted-foreground">Min views</span>
            <span className="tnum text-foreground">
              {controls.minViews === 0 ? "Any" : formatCompactNumber(controls.minViews)}
            </span>
            <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={String(controls.minViews)}
            onValueChange={(value) => controls.setMinViews(Number(value))}
          >
            {MIN_VIEW_OPTIONS.map((value) => (
              <DropdownMenuRadioItem key={value} value={String(value)}>
                {value === 0 ? "Any" : `${formatCompactNumber(value)}+`}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* --- Sort --- */}
      {showSort ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={TRIGGER_CLASS}>
              <SlidersHorizontal className="size-3.5 text-subtle-foreground" />
              <span className="text-muted-foreground">Sort</span>
              <span className="text-foreground">
                {SORT_OPTIONS.find((o) => o.id === controls.sort)?.label}
              </span>
              <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Rank by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={controls.sort}
              onValueChange={(value) => controls.setSort(value as OutlierSortKey)}
            >
              {SORT_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
