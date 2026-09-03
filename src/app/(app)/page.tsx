"use client";

import * as React from "react";
import { FilterX, SearchX, Sparkles } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { AddChannelDialog } from "@/components/channels/add-channel-dialog";
import { ConnectYouTubePanel } from "@/components/youtube/connect-youtube-panel";
import { ChannelTable } from "@/components/dashboard/channel-table";
import { DataFreshness, StaleDataNotice } from "@/components/dashboard/data-freshness";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { SearchInput } from "@/components/dashboard/search-input";
import { SummaryCards } from "@/components/dashboard/summary-cards";
import { ThresholdSelector } from "@/components/dashboard/threshold-selector";
import { ApiKeyNotice, ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  channelCountsByContentType,
  untaggedChannelCount,
  useContentTypePerformance,
  usePortfolioSummary,
  useChannelRows,
  useScopedRows,
  useVisibleRows,
} from "@/hooks/use-channel-analytics";
import { ContentTypePerformanceTable } from "@/components/dashboard/content-type-performance-table";
import { NicheEarningsPanel } from "@/components/dashboard/niche-earnings-panel";
import {
  ContentTypeFilterControl,
  NicheFilterControl,
  OwnershipFilterControl,
  ScopeSummary,
} from "@/components/dashboard/scope-filters";
import { useDataset } from "@/hooks/use-dataset";
import { useFilters } from "@/components/providers/filters-provider";
import { DEFAULT_SORT, type SortState } from "@/lib/sorting";
import { previousRange } from "@/lib/analytics/trends";
import { GenerateReportDialog } from "@/components/report/generate-report-dialog";
import { HitRuleNotConfiguredNotice } from "@/components/metrics/hit-rule-not-configured";
import { SetNicheThresholdButton } from "@/components/niches/niche-threshold-dialog";
import {
  HIT_RATE_DEFINITION,
  UNCONFIGURED_RULE_LABEL,
} from "@/lib/analytics/constants";
import { resolveHitDisplayState } from "@/lib/analytics/hit-display";
import { asksAboutOneNiche, isStudioChannel } from "@/lib/niches/niche-kind";
import { BRAND } from "@/lib/brand";

/**
 * Overview — the primary screen.
 *
 * The whole page is derived from one cached dataset. Period, threshold, search
 * and sort are all client-side transforms over that same array, which is why
 * every control on this page responds instantly and none of them touch YouTube.
 */
export default function OverviewPage() {
  const { data, isLoading, error, refetch, isFetching } = useDataset();
  const {
    // NOTE: the threshold is deliberately NOT read here any more. It is a
    // display lens over the distribution and decides no verdict, so gating an
    // unconfigured-rule banner on it asked the wrong question — see the banner
    // below.
    nicheId,
    nicheName,
    niche,
    contentType,
    ownership,
    ownFirst,
    clearScopeFilters,
    range,
  } = useFilters();

  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortState>(DEFAULT_SORT);

  const rows = useChannelRows(data);

  // Scope first, then search and sort. The summary cards read the *scoped* set,
  // not the global one, so "GTA + Our Channels" reports the average hit rate of
  // those channels rather than of everything being tracked.
  const scopedRows = useScopedRows(rows, niche, ownership, contentType);
  // Everything the niche and ownership filters allow, BEFORE the content-type
  // predicate. This is the set the Type menu describes: its "Unstated" count
  // has to agree with what selecting it would show, and a count taken over the
  // whole tracker would offer a number from outside the current niche.
  const nicheScopedRows = useScopedRows(rows, niche, ownership);
  const visibleRows = useVisibleRows(
    rows,
    query,
    sort,
    niche,
    ownership,
    ownFirst,
    contentType,
  );
  /*
   * WHICH CHANNELS THE HEADLINE RATE IS OVER.
   *
   * With no niche selected this is the studio's own scorecard, so watchlist
   * channels are counted as volume and left out of the rate — averaging in
   * channels nobody at Northstar is trying to be produces a number describing
   * work the studio does not do. Pick one niche and the question changes: the
   * viewer is asking about THAT niche, watchlist or not, and refusing to answer
   * would be excluding a watchlist niche from the product rather than from the
   * average. "Unassigned" stays on the scorecard rule, since a channel nobody
   * has filed is not a channel somebody filed as a watchlist.
   */
  const oneNicheSelected = asksAboutOneNiche(niche);
  const summary = usePortfolioSummary(scopedRows, {
    includeWatchlist: oneNicheSelected,
  });
  // The same portfolio metrics over the immediately preceding window, so every
  // KPI can show movement rather than a bare number.
  const previousSummary = usePortfolioSummary(scopedRows, {
    overrideRange: previousRange(range),
    includeWatchlist: oneNicheSelected,
  });

  const niches = data?.niches ?? [];
  const contentTypes = data?.contentTypes ?? [];

  // The niche an Admin would configure from the banner below. Only a *selected*
  // niche can be unconfigured, so it is found by id rather than inferred.
  // Keyed off `data` rather than the `niches` fallback array, whose identity
  // changes on every render and would defeat the memo.
  /*
   * BOTH HALVES COUNT AS UNCONFIGURED, and the memo used to look for only one.
   *
   * It searched for `hitThreshold === null`. Every niche on this deployment has
   * a threshold and no window — half a rule, which scores exactly as much as no
   * rule at all — so the search never resolved and the banner below rendered
   * without its "set the rule" button, leaving an admin told what was wrong and
   * given nothing to click. The gate is also no longer `threshold === null`;
   * see the banner itself.
   */
  const unconfiguredNiche = React.useMemo(
    () =>
      nicheId
        ? (data?.niches.find(
            (n) =>
              n.id === nicheId &&
              (n.hitThreshold === null || n.hitWindowHours === null),
          ) ?? null)
        : null,
    [data, nicheId],
  );

  const unassignedCount = React.useMemo(
    () => rows.filter((row) => row.channel.niches.length === 0).length,
    [rows],
  );
  const untypedCount = React.useMemo(
    () => untaggedChannelCount(nicheScopedRows),
    [nicheScopedRows],
  );
  // The per-type badges beside it, from the same rows. Both readings of one
  // derivation, so the menu cannot offer a number the list will not deliver.
  const typeChannelCounts = React.useMemo(
    () => channelCountsByContentType(nicheScopedRows),
    [nicheScopedRows],
  );

  /*
   * "Performance by content type", over the NICHE-AND-OWNERSHIP scope — not the
   * content-type-filtered one.
   *
   * Deliberate, and the only place on this page where a table ignores a filter.
   * Selecting "Rankings" narrows the channel list to channels that make
   * rankings, which is what that control is for; feeding the same selection into
   * this table would collapse it to a single row and destroy the comparison it
   * exists to make. The table's whole job is to rank the types against each
   * other, so it reads the scope the comparison is *within* — niche, ownership,
   * period, threshold — and not the selection made among its own rows.
   *
   * IT DOES READ THE SCORECARD SCOPE, THOUGH, and that is the second aggregate
   * on this page that pools every niche. "Rankings: 34%" is a hit rate, and a
   * hit rate over channels nobody at Northstar is trying to be describes work
   * the studio does not do — exactly the number the headline above it stopped
   * reporting. Same rule, same exception: pick one niche and the question is
   * about that niche, watchlist or not.
   */
  const scorecardRows = React.useMemo(
    () =>
      oneNicheSelected
        ? nicheScopedRows
        : nicheScopedRows.filter((row) => isStudioChannel(row.channel.niches)),
    [nicheScopedRows, oneNicheSelected],
  );
  const contentTypePerformance = useContentTypePerformance(
    scorecardRows,
    contentTypes,
  );
  const ownCount = React.useMemo(
    () => rows.filter((row) => row.channel.ownershipType === "own").length,
    [rows],
  );

  const hasChannels = rows.length > 0;
  const showEmptyTracker = !isLoading && !error && !hasChannels;
  const scopeIsEmpty = hasChannels && scopedRows.length === 0;

  /*
   * Shorts in scope, and no rule reached any of them. The same predicate every
   * card and cell on this page uses, so the banner cannot disagree with the
   * figures it is explaining.
   *
   * OVER THE SCORECARD'S OWN SHORTS, not the tracker's. `pooled` is built from
   * scorecard entries and `totalShorts` counts every entry including watchlist
   * ones, so the pair compares two different populations: a period in which the
   * watchlist published and the studio did not gives an all-zero tally against
   * a positive count, and this banner — full width, above every number on the
   * page — would announce that the niches have no hit rule when they are
   * configured perfectly and simply had nothing to judge.
   */
  const nothingScoreableInScope =
    resolveHitDisplayState(summary.pooled, summary.scorecardTotalShorts) ===
    "notConfigured";

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Overview"
        description={
          !hasChannels
            ? "Track the Shorts channels you care about."
            : nothingScoreableInScope
              ? /*
                 * Read off the pooled verdicts, not off the threshold control,
                 * and off the SAME resolved state as the banner underneath it.
                 *
                 * The headline question needs a rule to be a question, and the
                 * rule is now per niche and has two halves. When nothing in
                 * scope could be judged the page states the situation instead
                 * of pretending to ask; when things are judged, the question is
                 * the one the product actually answers, with the clock in it.
                 *
                 * It used to have its own `pooled.judged === 0 && totalShorts >
                 * 0` — the same two mismatched populations as the banner, plus
                 * the "nothing decided yet" case, so a page whose windows had
                 * simply not shut yet was told its niches were unconfigured and
                 * sent to fix something that was not broken.
                 */
                `${UNCONFIGURED_RULE_LABEL} for ${nicheName ?? "these niches"}, so no hit rate is shown below.`
              : "Out of every 100 Shorts these channels publish, how many reach their niche's view threshold inside its hit window?"
        }
        actions={
          <>
            {data ? <DataFreshness oldestFetchedAt={data.oldestFetchedAt} /> : null}
            {rows.length > 0 ? <GenerateReportDialog /> : null}
            <AddChannelDialog
              trigger={
                <Button variant="primary" size="sm">
                  <span className="text-base leading-none">+</span>
                  Add Channel
                </Button>
              }
            />
          </>
        }
      />

      {data && !data.hasApiKey ? <ApiKeyNotice /> : null}

      {error ? (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      ) : showEmptyTracker ? (
        <EmptyTracker />
      ) : (
        <>
          {/*
            The product's mental model, left to right:
              niche → type → channels → period → threshold → answer.
            All five are the same weight and the same interaction, so adding
            to them did not add a second layer of UI.
          */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <NicheFilterControl niches={niches} unassignedCount={unassignedCount} />
              <ContentTypeFilterControl
                contentTypes={contentTypes}
                unassignedCount={untypedCount}
                channelCounts={typeChannelCounts}
              />
              <OwnershipFilterControl
                ownCount={ownCount}
                competitorCount={rows.length - ownCount}
              />
              <PeriodSelector />
              <ThresholdSelector />
            </div>

            <div className="flex items-center gap-3">
              <ScopeSummary shown={scopedRows.length} total={rows.length} />
              <SearchInput
                value={query}
                onChange={setQuery}
                resultCount={query ? visibleRows.length : undefined}
                className="w-full lg:w-64"
              />
            </div>
          </div>

          {/*
            THE DATA'S AGE, ABOVE EVERY NUMBER IT AFFECTS.

            The pill in the header says the same thing and gets missed. Silent
            when the tracker is current, so it stays worth reading.
          */}
          {data ? <StaleDataNotice oldestFetchedAt={data.oldestFetchedAt} /> : null}

          {/* The banner sits above the numbers rather than beside one of them:
              hit rate is the column the whole table is ranked by, so an
              unconfigured niche changes how the entire screen should be read,
              not just one cell.

              GATED ON WHAT THE CARDS ARE GATED ON, not on the threshold. It
              used to render when `threshold === null` — the threshold half of
              the rule only — so on a deployment where every niche has a
              threshold and no window it never appeared, even though nothing on
              the page was scoreable and the page header eight lines above was
              already saying so. The screen contradicted itself, and the half
              that stayed silent was the half with the fix attached to it. */}
          {nothingScoreableInScope ? (
            <HitRuleNotConfiguredNotice
              nicheName={nicheName}
              action={
                unconfiguredNiche ? (
                  <SetNicheThresholdButton niche={unconfiguredNiche} />
                ) : null
              }
            />
          ) : null}

          <SummaryCards
            summary={summary}
            previousSummary={previousSummary}
            viewsDefinition={data?.viewsDefinition ?? null}
            loading={isLoading}
          />

          {!isLoading && scopeIsEmpty ? (
            <div className="rounded-lg border border-border bg-surface">
              <EmptyState
                icon={<FilterX />}
                title="No channels match these filters"
                description="Nothing in your tracker fits this niche and channel-type combination."
                action={
                  <Button variant="secondary" onClick={clearScopeFilters}>
                    Clear filters
                  </Button>
                }
              />
            </div>
          ) : !isLoading && visibleRows.length === 0 && query ? (
            <div className="rounded-lg border border-border bg-surface">
              <EmptyState
                icon={<SearchX />}
                title={`No channels match “${query}”`}
                description="Search looks at the channel name, its YouTube title and its @handle."
                action={
                  <Button variant="secondary" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                }
              />
            </div>
          ) : (
            <ChannelTable
              rows={visibleRows}
              sort={sort}
              onSortChange={setSort}
              loading={isLoading}
            />
          )}

          {/*
            HERE, AND ONLY HERE.

            "What kind of content is working?" is a portfolio question, and the
            Overview is the one screen that already holds every channel's Shorts
            alongside the active period, threshold and scope — so this is the
            only place the table can be built without a second data path or a
            second definition of a hit. A copy on the niche page would answer a
            narrower question with the same title, and a copy on a channel page
            would rank formats over a sample of one channel; both would be a
            second number that could disagree with this one.

            LAST ON THE PAGE, at the owner's request. It used to sit between the
            portfolio KPIs and the channel ranking, and the argument for that
            position was the order of the questions — how did we do, what kind
            of work did it, who did it. The argument against turned out to be
            stronger in use: the channel table is what this screen is opened
            for, and a second table above it pushed the thing people came to
            read below the fold on a laptop. The order is now the two answers
            people came for, then the breakdown they go looking for afterwards.

            Above the hit-rate footnote rather than below it, because that
            footnote defines the hit rate THIS table also reports — a definition
            that appears after the last thing it defines is a definition nobody
            reads in time.

            THE GATE IS THE ONE IT ALWAYS HAD, and an earlier draft of this move
            was wrong about that. It briefly also required `!scopeIsEmpty`, on
            the theory that "no channels match these filters" followed by a full
            table reads as a contradiction, and that `scorecardRows` would be
            empty in that case anyway so nothing was being hidden. The second
            half is false, and it is the half the first half rested on.

            `scopeIsEmpty` is measured over `scopedRows`, which applies the
            CONTENT-TYPE filter; this table is built from `scorecardRows`, which
            comes off `nicheScopedRows` and deliberately does not — see the long
            note on `scorecardRows` above for why. The two therefore diverge on
            exactly one input, and it is a reachable one: pick a type no channel
            claims (Unassigned, on an org that has tagged everything) and
            `scopedRows` is empty while this table is fully populated and
            correct. Gating on `scopeIsEmpty` deleted a real breakdown from the
            screen at the one moment it was the only thing left on it.

            When the scope is empty for any OTHER reason — a niche or an
            ownership with no channels — `nicheScopedRows` is empty too, so the
            table renders its own "nothing to group yet" state under the empty
            card, which is a pair of consistent statements rather than a
            contradiction. The search-empty branch never gated it either: search
            narrows the channel list, not this table's scope, so its figures are
            still true while a search matches nothing.
          */}
          {!isLoading && contentTypes.length > 0 ? (
            <ContentTypePerformanceTable performance={contentTypePerformance} />
          ) : null}

          {/*
            LAST, below the content-type table.

            It sat directly under the summary cards, which put a money figure —
            visible only to an admin — above the channel table every role opens
            for. Moving it here also groups it with the other two panels that
            summarise ACROSS the table rather than listing it, so the page now
            reads top to bottom as: the headline figures, the channels
            themselves, then what those channels amount to by content type and
            by niche.

            Still ungated on `isLoading` and `scopeIsEmpty`: it renders its own
            honest empty state, and on a deployment where no niche has a rate
            that empty state is the whole of what it has to say. It reads the
            page's own `range`, because it prices what the period GAINED.
          */}
          <NicheEarningsPanel niches={niches} range={range} />

          <p className="px-1 text-[11px] leading-relaxed text-subtle-foreground">
            {HIT_RATE_DEFINITION}
            {isFetching && !isLoading ? (
              <span className="ml-2 text-accent">Refreshing…</span>
            ) : null}
          </p>
        </>
      )}
    </PageContainer>
  );
}

/**
 * First-run state.
 *
 * Explains what the tool measures before asking for anything, so the single
 * input field has context. An empty dashboard is a starting point, not a
 * failure, and should not look like one.
 */
function EmptyTracker() {
  return (
    <div className="flex flex-col gap-5">
      {/*
        Connecting comes FIRST on an empty tracker, above "add a channel".
        For the person setting this up, their own channels are the point and the
        connected account can add them without a single paste — so offering the
        manual path first would send an owner to type an id for a channel the
        app could have listed for them. Non-admins never see this panel and land
        straight on the Add Channel flow below, which is right for them.
      */}
      <ConnectYouTubePanel variant="full" />

      <div className="rounded-lg border border-border bg-surface">
      <EmptyState
        icon={<Sparkles />}
        title={`Track the Shorts channels that matter to ${BRAND.company}.`}
        description={
          <>
            Monitor Shorts views, upload frequency, and hit rate across 7D, 30D,
            90D, 180D, or a custom period. Long-form videos are detected and
            excluded automatically, so every number describes Shorts only.
          </>
        }
        action={
          <AddChannelDialog
            trigger={
              <Button variant="primary" size="lg">
                <span className="text-base leading-none">+</span>
                Add Your First Channel
              </Button>
            }
          />
        }
      />

      <div className="grid gap-px border-t border-border bg-border sm:grid-cols-3">
        {[
          {
            title: "Hit rate, not vanity metrics",
            body: "The share of a channel's Shorts that clear your view threshold — the number that separates a repeatable system from one lucky video.",
          },
          {
            title: "Consistency beats one viral hit",
            body: "A channel at 10M / 8M / 200K / 150K looks impressive on totals. One at a steady 1.2M every time is usually the more valuable model.",
          },
          {
            title: "Shorts only, verified",
            body: "Duration, aspect ratio and YouTube's own Shorts URL are checked before a video counts. Anything ambiguous is excluded, never guessed.",
          },
        ].map((item) => (
          <div key={item.title} className="bg-surface p-5">
            <h4 className="text-[13px] font-medium text-foreground">{item.title}</h4>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
              {item.body}
            </p>
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}
