"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { nicheColor } from "@/components/niches/niche-chip";
import { useCanReadNicheEconomics } from "@/components/niches/niche-rpm-dialog";
import {
  NICHE_EARNINGS_LABEL,
  NICHE_EARNINGS_NOTHING_PRICED,
  NICHE_EARNINGS_PARTIAL_TOTAL,
  NO_TOTAL_EXPLANATION,
  buildNicheEarnings,
  measuredSpanNoteFrom,
  nicheEarningsDefinition,
  type NicheEarningsRow,
} from "@/lib/analytics/niche-earnings";
import {
  ESTIMATED_RPM_CHIP,
  MEASURED_RPM_CHIP,
  NICHE_HISTORY_TOO_THIN,
  NICHE_NO_VIEWS_GAINED,
  UNPRICED_NICHE_SHORT,
  VIEWS_GAINED_UNAVAILABLE,
  formatEngagedViewShare,
  formatRpmBounds,
  nicheHistoryTooThinExplanation,
  rpmBounds,
  rpmQuoteUnit,
} from "@/lib/analytics/niche-rpm";
import type { DateRange } from "@/lib/analytics/types";
import { useDatasetFormat } from "@/hooks/dataset-format-context";
import { nicheGainedById, useNicheViewsGained } from "@/hooks/use-views-gained";
import { toNicheFormat } from "@/lib/niches/niche-format";
import type { NicheDTO } from "@/lib/dto";
import { formatMoney, formatMoneyCompact } from "@/lib/finance/money";
import { formatCompactNumber } from "@/lib/format";

/**
 * =========================================================================
 * WHAT EACH NICHE IS GENERATING — ON OVERVIEW, FOR ADMINS ONLY
 * =========================================================================
 *
 * The owner's seventh request. `niche-earnings.ts` holds the arithmetic and the
 * refusals; this file is the rendering and the one wiring decision that
 * matters, which is where the numbers come from.
 *
 * ---------------------------------------------------------------------------
 * THE VIEWS ARE GAINS, FETCHED — NOT A RE-SLICE OF THE DATASET
 * ---------------------------------------------------------------------------
 * What is priced is views GAINED during the period, which is a difference
 * between snapshot readings the browser never holds — so unlike every other
 * figure on this page it is fetched, through `useNicheViewsGained`, keyed on
 * the period. The niche cards read the same hook with the same key, so the
 * React Query cache — not discipline — is what keeps the two surfaces pricing
 * the same period from the same measurement. While the read is in flight the
 * panel shows skeletons, never a stale period's numbers; when it fails it says
 * so in words, never a zero.
 *
 * ---------------------------------------------------------------------------
 * THE GATE IS THE DATA, NOT A CONDITIONAL
 * ---------------------------------------------------------------------------
 * There are two checks here and only one of them is the boundary.
 *
 * The REAL gate is `NicheDTO.rpm === null`. The server withholds niche
 * economics from anybody without `finance.view` — `resolveNicheRpmByNiche`
 * returns null rather than an empty map, `toNicheDTO` cannot invent one — so an
 * unpermitted reader's dataset simply contains nothing to render, and
 * `buildNicheEarnings` reports `disclosed: false`. No client-side condition is
 * load-bearing, which is the property that survives somebody deleting a line.
 *
 * `useCanReadNicheEconomics()` is here as well, and it is an OPTIMISATION plus
 * an intent marker rather than a rule: it keeps the gains query disabled for a
 * reader who could never see the result, and it says out loud on the page
 * that this block is finance-gated. If the two ever disagree, the data wins,
 * because the data is what the server decided.
 *
 * THE SECOND NARROWING IS ALREADY APPLIED UPSTREAM and is easy to forget:
 * `getVisibleNicheIds` means a niche-scoped member granted `finance.view` gets
 * economics for their own niches and NO ENTRY at all for the rest. So this
 * panel is per-reader by construction — it renders whatever they were sent,
 * which is why it must never sum a figure it labels as the whole portfolio
 * without checking what it actually holds.
 *
 * ---------------------------------------------------------------------------
 * IT READS THE PAGE'S OWN PERIOD, AND ADDS NO STATE
 * ---------------------------------------------------------------------------
 * `range` comes from `useFilters()` through the caller, which is the same value
 * `PeriodSelector` writes and every other aggregate on the page consumes. A
 * second period control here would be a second answer to "which period am I
 * looking at", and the first one to disagree would win silently.
 */
export function NicheEarningsPanel({
  niches,
  range,
}: {
  niches: readonly NicheDTO[];
  range: DateRange;
}) {
  const mayRead = useCanReadNicheEconomics();
  // Which product's page mounted this panel — it picks the definition's noun
  // and which format's gains are fetched. Each ROW still reads its own
  // niche's format for pricing and wording.
  const pageFormat = useDatasetFormat();

  /*
   * The same disclosure test the builder makes, taken early so the fetch can
   * be skipped for a reader the panel will not render for. `some` rather than
   * `every`-negated: a scoped reader with one visible niche's economics is
   * disclosed to, and must not be blanked by the nulls beside it.
   */
  const disclosed =
    mayRead && niches.length > 0 && niches.some((niche) => niche.rpm !== null);

  const gains = useNicheViewsGained(pageFormat, range, disclosed);
  const gainedById = React.useMemo(
    () => (gains.data === undefined ? null : nicheGainedById(gains.data)),
    [gains.data],
  );

  const panel = React.useMemo(() => {
    if (!disclosed || gainedById === null) return null;

    return buildNicheEarnings(
      niches.map((niche) => {
        const entry = gainedById.get(niche.id);
        return {
          id: niche.id,
          name: niche.name,
          colorIndex: niche.colorIndex,
          // Narrowed once per niche: it picks the pricing basis and the
          // wording of the row's own rate.
          format: toNicheFormat(niche.format),
          rpm: niche.rpm,
          ourViewsGained: entry?.ourViewsGained ?? 0,
          competitorViewsGained: entry?.competitorViewsGained ?? 0,
          // A niche the endpoint did not answer for was not measured — the
          // builder renders words for it, never a zero dressed as a gain.
          measured:
            entry === undefined
              ? null
              : { coveredVideos: entry.coveredVideos, totalVideos: entry.totalVideos },
          // For the double-count check. See `buildNicheEarnings`.
          ownChannelIds: entry?.ownChannelIds ?? [],
        };
      }),
    );
  }, [disclosed, niches, gainedById]);

  // ABSENT, not empty. An employee sees an Overview with no money on it rather
  // than a locked panel inviting them to ask what is behind it.
  if (!disclosed) return null;

  // The label the period selector implies versus the span the history could
  // actually measure. Derived from the server's own echo of the request.
  const spanNote = gains.data === undefined ? null : measuredSpanNoteFrom(gains.data);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          {NICHE_EARNINGS_LABEL}
          {/* The definition, next to the heading: what is priced is views
              gained in the period, and where the history falls short the note
              below the heading says what was measured instead. */}
          <InfoTip>{nicheEarningsDefinition(pageFormat)}</InfoTip>
        </h3>

        {panel !== null && panel.total !== null ? (
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {/* The label comes from the builder, which counted what it actually
                summed. It used to read "all niches" over a sum of the priced
                ones only — see `nicheEarningsTotalLabel`. */}
            <span className="text-[11px] text-subtle-foreground">
              {panel.totalLabel}
            </span>
            <span className="tnum text-[15px] font-medium text-foreground">
              {formatRange(panel.total.lowMinor, panel.total.highMinor, panel.total.currency, true)}
            </span>
          </span>
        ) : null}
      </div>

      {/* Where the measurement actually starts, whenever that is not where the
          period does. Under the heading, above every figure it qualifies. */}
      {spanNote !== null ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{spanNote}</p>
      ) : null}

      {gains.isError ? (
        /* A failed read is words, never a zero and never yesterday's cache:
           nothing below is rendered, because every figure would be a claim
           about a period nothing measured. */
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {VIEWS_GAINED_UNAVAILABLE}
        </p>
      ) : panel === null ? (
        /* In flight. Skeletons, never the previous period's numbers — a stale
           figure under a fresh period label is a wrong number wearing the
           right heading. */
        <div className="flex flex-col gap-2" aria-hidden>
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      ) : panel.noTotalReason === "nothing_priced" ? (
        /*
         * Words rather than a table of "$0.00" — the same rule the niche card
         * follows, and the one this whole feature is written around. A zero
         * here would tell an owner his catalogue generates nothing, which is a
         * claim about the catalogue rather than about what the app can see.
         *
         * GATED ON THE REASON, NOT ON `pricedCount === 0`. Those are not the
         * same condition: a niche with a rate that gained nothing — or whose
         * history is too thin — is also not "priced", and the rows already say
         * the right thing there, so those states fall through to the list
         * below and keep them.
         */
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {NICHE_EARNINGS_NOTHING_PRICED}
        </p>
      ) : (
        <>
          <div className="flex flex-col divide-y divide-border">
            {panel.rows.map((row) => (
              <NicheEarningsLine key={row.id} row={row} />
            ))}
          </div>

          {/* A missing total is EXPLAINED rather than simply absent. Somebody
              who can see five niche figures and no sum will otherwise assume
              the sum failed to render. */}
          {panel.noTotalReason !== null ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {NO_TOTAL_EXPLANATION[panel.noTotalReason]}
            </p>
          ) : null}

          {/* A total that is really a SUBTOTAL says so twice: in its own label,
              and here, where the consequence can be spelled out. The omitted
              niches are unknown rather than zero, which is the difference
              between a figure to plan against and one to plan around. */}
          {panel.totalIsPartial ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {NICHE_EARNINGS_PARTIAL_TOTAL}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

/** One niche's line. Money where there is money, a sentence where there is not. */
function NicheEarningsLine({ row }: { row: NicheEarningsRow }) {
  const bounds = rpmBounds(row.rpm, row.format);
  const measured = row.rpm.source === "derived";

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ background: nicheColor(row.colorIndex) }}
        />
        {/* Through to the dashboard filtered to this niche, which is where the
            reader goes next if a figure surprises them. Same destination the
            niche card's title uses — WHICH BRANCHES ON THE ROW'S FORMAT: a
            Long Form niche clicks through to the Long Form overview, never to
            the Shorts dashboard, where its id resolves to no niche and the
            reader silently lands on unfiltered Shorts data. */}
        <Link
          href={
            row.format === "shorts"
              ? `/?niche=${encodeURIComponent(row.id)}`
              : `/longform?niche=${encodeURIComponent(row.id)}`
          }
          className="truncate text-[13px] text-foreground transition-colors hover:text-accent"
        >
          {row.name}
        </Link>
      </span>

      {row.state === "priced" && row.value.trackedRevenue !== null ? (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="tnum text-[13px] font-medium text-foreground">
            {formatRange(
              row.value.trackedRevenue.lowMinor,
              row.value.trackedRevenue.highMinor,
              row.value.trackedRevenue.currency,
              true,
            )}
          </span>
          {row.value.ourRevenue !== null ? (
            <span className="tnum text-[11px] text-subtle-foreground">
              {formatRange(
                row.value.ourRevenue.lowMinor,
                row.value.ourRevenue.highMinor,
                row.value.ourRevenue.currency,
                false,
              )}{" "}
              ours
            </span>
          ) : null}
          {/* The rate, its unit and — where it is an assumption — the share it
              was applied at. Two figures on this list can be quoted against
              different denominators (a measured rate against all views, an
              entered one against engaged views), so the unit travels with each
              one rather than being stated once for the panel. */}
          {bounds !== null ? (
            <span className="text-[10px] uppercase tracking-wider text-subtle-foreground">
              <span title={`${formatRpmBounds(bounds)} ${rpmQuoteUnit(bounds.basis)}`}>
                {measured ? MEASURED_RPM_CHIP : ESTIMATED_RPM_CHIP}
              </span>
              {bounds.basis === "engaged" ? (
                <span
                  className="ml-1 normal-case tracking-normal"
                  title={`Priced on ${formatCompactNumber(
                    row.value.pricedViews ?? 0,
                  )} engaged views of ${formatCompactNumber(
                    row.value.trackedNicheViews,
                  )} tracked views gained.`}
                >
                  @ {formatEngagedViewShare(row.value.engagedViewShareBasisPoints)} engaged
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      ) : (
        /*
         * WORDS, NEVER "$0" AND NEVER AN EM DASH — and three DIFFERENT words,
         * because the three states are different instructions: an unpriced
         * niche waits for a decision, a no-gains one for a wider period or the
         * next refresh, a thin-history one only for time. Collapsing them
         * hides which. The thin-history line carries its coverage counts in
         * the title so the refusal can be weighed, not just believed.
         */
        <span
          className="text-[11px] text-subtle-foreground"
          title={
            row.state === "insufficient_history" && row.measured !== null
              ? nicheHistoryTooThinExplanation(
                  row.measured.coveredVideos,
                  row.measured.totalVideos,
                )
              : undefined
          }
        >
          {row.state === "no_gains"
            ? NICHE_NO_VIEWS_GAINED
            : row.state === "insufficient_history"
              ? NICHE_HISTORY_TOO_THIN
              : UNPRICED_NICHE_SHORT}
        </span>
      )}
    </div>
  );
}

/**
 * A projected amount as a range, or as one figure when both ends agree.
 *
 * A measured rate produces a point and an entered range produces two ends; the
 * card's whole at-a-glance signal is that a measurement is one figure and a
 * guess is two, and printing "$450–$450" would dress a measurement up as an
 * estimate. Never a midpoint: the middle of a range is a figure nobody entered.
 */
function formatRange(
  lowMinor: number,
  highMinor: number,
  currency: string,
  compact: boolean,
): string {
  const format = compact ? formatMoneyCompact : formatMoney;
  const low = format(lowMinor, currency);
  if (lowMinor === highMinor) return low;
  return `${low}–${format(highMinor, currency)}`;
}
