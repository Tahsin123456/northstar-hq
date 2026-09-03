"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/tooltip";
import { nicheColor } from "@/components/niches/niche-chip";
import { useCanReadNicheEconomics } from "@/components/niches/niche-rpm-dialog";
import {
  NICHE_EARNINGS_LABEL,
  NICHE_EARNINGS_NOTHING_PRICED,
  NICHE_EARNINGS_PARTIAL_TOTAL,
  NO_TOTAL_EXPLANATION,
  buildNicheEarnings,
  nicheEarningsDefinition,
  nicheViewTotals,
  type NicheEarningsRow,
} from "@/lib/analytics/niche-earnings";
import {
  ESTIMATED_RPM_CHIP,
  MEASURED_RPM_CHIP,
  NICHE_NO_VIEWS,
  UNPRICED_NICHE_SHORT,
  formatEngagedViewShare,
  formatRpmBounds,
  rpmBounds,
  rpmQuoteUnit,
} from "@/lib/analytics/niche-rpm";
import type { ChannelRow } from "@/hooks/use-channel-analytics";
import { useDatasetFormat } from "@/hooks/dataset-format-context";
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
 * THE VIEWS ARE EVERY VIEW THE TRACKED CHANNELS HAVE, OUT OF THE DATASET
 * ---------------------------------------------------------------------------
 * `videosOfFormat` over each member channel's videos, summed. No date filter
 * at all: what a niche generates is the whole of what its channels have
 * earned in views, priced at the niche's rate — not the lifetime views of
 * whatever happened to be uploaded inside the period, and not a snapshot
 * delta over it.
 *
 * NOTHING IS FETCHED HERE, and that is the point rather than a convenience.
 * Every video's current view count already ships in the dataset payload the
 * page is holding, so the figure exists the moment the page renders: no
 * endpoint, no coverage floor, no skeleton, and no state in which the panel
 * has to print a sentence about missing history where an owner asked for
 * money. The two surfaces that price a niche — this panel and the niche
 * card's value strip — read the same rows through the same selector, so they
 * cannot disagree about the same niche.
 *
 * THE PERIOD IS THEREFORE NOT AN INPUT. There is no `range` prop, and its
 * absence is the enforcement: a figure that must not move with the selector
 * is best served by a component that cannot see it. The definition beside the
 * heading says so in words, because a money number sitting under a 7d/30d
 * control that ignores it otherwise reads as broken.
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
 * an intent marker rather than a rule: it skips the per-niche view summing for
 * a reader who could never see the result, and it says out loud on the page
 * that this block is finance-gated. If the two ever disagree, the data wins,
 * because the data is what the server decided.
 *
 * THE SECOND NARROWING IS ALREADY APPLIED UPSTREAM and is easy to forget:
 * `getVisibleNicheIds` means a niche-scoped member granted `finance.view` gets
 * economics for their own niches and NO ENTRY at all for the rest. So this
 * panel is per-reader by construction — it renders whatever they were sent,
 * which is why it must never sum a figure it labels as the whole portfolio
 * without checking what it actually holds.
 */
export function NicheEarningsPanel({
  niches,
  rows,
}: {
  niches: readonly NicheDTO[];
  rows: readonly ChannelRow[];
}) {
  const mayRead = useCanReadNicheEconomics();
  // Which product's page mounted this panel — it picks the definition's noun,
  // nothing arithmetical. Each ROW still reads its own niche's format for
  // pricing, for its view total and for its wording.
  const pageFormat = useDatasetFormat();

  const panel = React.useMemo(() => {
    // Skips the per-niche summing for a reader who would be shown nothing
    // anyway. Not the boundary — see the header.
    if (!mayRead) return null;

    return buildNicheEarnings(
      niches.map((niche) => {
        // Narrowed once per niche: it picks both the pricing basis in
        // `buildNicheEarnings` and which format's views are counted, so the
        // denominator and the rate cannot disagree.
        const format = toNicheFormat(niche.format);
        const members = rows.filter((row) =>
          row.channel.niches.some((n) => n.id === niche.id),
        );
        /*
         * EVERY VIDEO THE PAYLOAD HOLDS FOR THOSE CHANNELS, of this format,
         * through the selector the niche card also uses — so the two surfaces
         * cannot report different money for the same niche. No date filter
         * anywhere in it; see `nicheViewTotals`.
         */
        const totals = nicheViewTotals(
          members.map((row) => ({
            ownedByNorthstar: row.channel.ownershipType === "own",
            videos: row.videos,
          })),
          format,
        );

        return {
          id: niche.id,
          name: niche.name,
          colorIndex: niche.colorIndex,
          format,
          rpm: niche.rpm,
          ourViews: totals.ourViews,
          competitorViews: totals.competitorViews,
          // For the double-count check. See `buildNicheEarnings`.
          ownChannelIds: members
            .filter((row) => row.channel.ownershipType === "own")
            .map((row) => row.channel.id),
        };
      }),
    );
  }, [mayRead, niches, rows]);

  // ABSENT, not empty. An employee sees an Overview with no money on it rather
  // than a locked panel inviting them to ask what is behind it.
  if (panel === null || !panel.disclosed) return null;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          {NICHE_EARNINGS_LABEL}
          {/* The definition, next to the heading, because the period selector
              at the top of this page makes the wrong reading the natural one:
              these figures do not move with it, and the sentence says so. */}
          <InfoTip>{nicheEarningsDefinition(pageFormat)}</InfoTip>
        </h3>

        {panel.total !== null ? (
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

      {panel.noTotalReason === "nothing_priced" ? (
        /*
         * Words rather than a table of "$0.00" — the same rule the niche card
         * follows, and the one this whole feature is written around. A zero
         * here would tell an owner his catalogue generates nothing, which is a
         * claim about the catalogue rather than about what the app can see.
         *
         * GATED ON THE REASON, NOT ON `pricedCount === 0`. Those are not the
         * same condition: a niche with a rate whose channels hold no views is
         * also not "priced", and the rows already say the right thing there, so
         * that state falls through to the list below and keeps it.
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
                  )} tracked views.`}
                >
                  @ {formatEngagedViewShare(row.value.engagedViewShareBasisPoints)} engaged
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      ) : (
        /*
         * WORDS, NEVER "$0" AND NEVER AN EM DASH — and two DIFFERENT words,
         * because the two states are different instructions: an unpriced niche
         * waits for a decision, a no-views one for channels or the next
         * refresh. Collapsing them hides which.
         */
        <span className="text-[11px] text-subtle-foreground">
          {row.state === "no_views" ? NICHE_NO_VIEWS : UNPRICED_NICHE_SHORT}
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
