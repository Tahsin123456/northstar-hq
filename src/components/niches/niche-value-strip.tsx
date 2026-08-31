"use client";

import * as React from "react";
import {
  DERIVED_RPM_EXPLANATION,
  ESTIMATED_RPM_CHIP,
  MANUAL_RPM_EXPLANATION,
  MANUAL_RPM_UNCONVERTIBLE_EXPLANATION,
  MEASURED_RPM_CHIP,
  NO_SHORTS_TO_PRICE_EXPLANATION,
  RPM_NOT_MEASURED_BECAUSE,
  RPM_REJECTION_EXPLANATION,
  RPM_WINDOW_DAYS,
  TRACKED_NICHE_VALUE_DEFINITION,
  TRACKED_NICHE_VALUE_LABEL,
  UNCONVERTIBLE_NICHE_SHORT,
  UNPRICED_NICHE_EXPLANATION,
  UNPRICED_NICHE_SHORT,
  UNPRICED_NICHE_SHORT_NO_SHORTS,
  calculateNicheValue,
  formatRpmBounds,
  rpmBounds,
  type NicheRpmResolution,
  type ProjectedMoney,
  type RpmChannelOutcome,
} from "@/lib/analytics/niche-rpm";
import type { NicheDTO } from "@/lib/dto";
import { formatMoney, formatMoneyCompact } from "@/lib/finance/money";
import { formatCompactNumber, formatPercent } from "@/lib/format";
import { InfoTip } from "@/components/ui/tooltip";
import { SetNicheRpmButton } from "./niche-rpm-dialog";

/**
 * What the tracked niche is generating, and how much of it is Northstar's.
 *
 * A FOURTH STRIP ON THE NICHE CARD rather than a fourth column in the stat row.
 * The row is `grid-cols-3` on a card that is a third of an `xl:grid-cols-3`
 * grid, and `MiniStat` truncates its value — a fourth column would clip "$184K"
 * to "$18…". These are also not two independent stats but a ratio, and a ratio
 * reads as a sentence rather than as two adjacent figures.
 *
 * `relative z-10` IS LOAD-BEARING. The whole card is one stretched link: a
 * `<span className="absolute inset-0">` inside the title's `<Link>` covers
 * every pixel of it. Without the stacking context the "Set RPM range" button
 * below — and the info tip beside the label — would never receive a click,
 * which is the same trap the card's footer comment already names.
 *
 * ---------------------------------------------------------------------------
 * DERIVED AND GUESSED ARE DISTINGUISHABLE FROM ACROSS THE ROOM
 * ---------------------------------------------------------------------------
 * MARKED ON WHERE THE RATE CAME FROM, NOT ON HOW WIDE IT IS. The earlier
 * version keyed the "Est" chip on whether the two ends differed, on the theory
 * that the distinction falls out of the data — the owner's input IS a range and
 * a measurement IS one number. It does not: the form deliberately accepts equal
 * ends "for somebody who genuinely means one number", so a hand-typed
 * 0.05 / 0.05 rendered exactly like a measured rate. `rpm.source` is the fact
 * being communicated, so `rpm.source` is what the chip reads.
 *
 * BOTH STATES ARE MARKED, so neither is the unmarked default. "No chip" is not
 * a label anybody reads as "guessed", and a missing chip is indistinguishable
 * from a chip that failed to render.
 *
 * THE MIDPOINT OF A RANGE IS NEVER SHOWN. It is a figure nobody entered, and
 * printing one turns a stated uncertainty into a false precision.
 */

/** The chip that marks an estimate, borrowed verbatim from the ledger's amount cell. */
function SourceChip({ measured }: { measured: boolean }) {
  return (
    <span
      className="rounded bg-surface-hover px-1 py-px text-[9px] font-medium uppercase tracking-wider text-subtle-foreground"
      title={
        measured
          ? "Measured from what Northstar's own channels in this niche actually earned, divided by the views they gained over the same window."
          : "An estimate from a hand-entered RPM range, not a measurement. Every figure beside it is that estimate multiplied out."
      }
    >
      {measured ? MEASURED_RPM_CHIP : ESTIMATED_RPM_CHIP}
    </span>
  );
}

/** A projected amount as a range, or as one figure when both ends agree. */
function formatProjected(money: ProjectedMoney, compact: boolean): string {
  const format = compact ? formatMoneyCompact : formatMoney;
  const low = format(money.lowMinor, money.currency);
  if (money.lowMinor === money.highMinor) return low;
  return `${low}–${format(money.highMinor, money.currency)}`;
}

/**
 * At most two per-channel reasons, and only the real ones.
 *
 * SHOWN UNDER A HAND-ENTERED RATE AS WELL AS UNDER AN UNPRICED NICHE. The state
 * the owner's request actually describes — "if our channels aren't monetized,
 * newly monetized... I should be able to enter an RPM range" — is the manual
 * one, and it used to be the single state where the reason his own channel was
 * not overriding the guess was computed, sent to the browser, and then dropped
 * on the floor. These sentences carry the only actionable half of the feature:
 * add an exchange rate, turn automatic refresh on, wait for the import.
 *
 * Two is a card, not a report: a niche with six own channels all failing for
 * the same reason says it once, and the dialog is where somebody goes to dig.
 */
function RejectionReasons({
  rejected,
  lead,
}: {
  rejected: readonly RpmChannelOutcome[];
  lead?: string;
}) {
  const reasons = rejected
    .filter((channel) => !channel.accepted)
    .slice(0, 2)
    .map((channel) =>
      channel.accepted
        ? null
        : `${channel.channelName} ${RPM_REJECTION_EXPLANATION[channel.reason]}`,
    )
    .filter((sentence): sentence is string => sentence !== null);

  if (reasons.length === 0) return null;

  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      {lead ? <span className="text-subtle-foreground">{lead} </span> : null}
      {reasons.join(" ")}
    </p>
  );
}

export function NicheValueStrip({
  niche,
  ourViews,
  competitorViews,
}: {
  niche: NicheDTO;
  /** Shorts views from channels the studio owns, over the selected period. */
  ourViews: number;
  /** Shorts views from every other tracked channel in this niche. */
  competitorViews: number;
}) {
  const rpm = niche.rpm;

  /*
   * WITHHELD MEANS THE STRIP IS NOT THERE AT ALL.
   *
   * `rpm === null` is the only meaning of null on this field: a reader with
   * `finance.view` always receives an object for a niche they are assigned to,
   * and "nobody has priced this" is a value of that object rather than an
   * absence. So there is no state in which this returns null while a permitted
   * reader is looking at a niche of theirs, and an employee without finance
   * access sees a card with no economics on it rather than an empty box that
   * invites them to ask why.
   */
  if (rpm === null) return null;

  const bounds = rpmBounds(rpm);
  const value = calculateNicheValue({ ourViews, competitorViews, bounds });
  /*
   * NOTHING PUBLISHED IS NOT A PRICE OF ZERO.
   *
   * `capturePercent` is null exactly when the tracked niche has no views in the
   * period, and `projectRevenue` prices zero views at a perfectly correct
   * `{ low: 0, high: 0 }`. Rendering that would put "$0" under "Tracked niche
   * revenue", which reads as "this niche generates nothing" — a claim about the
   * niche rather than about the period on screen, and the one figure this whole
   * module exists to keep off a screen.
   */
  const nothingPublished = value.capturePercent === null;

  return (
    <div className="relative z-10 mt-3 flex flex-col gap-1.5 border-t border-border pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
          {TRACKED_NICHE_VALUE_LABEL}
          {/* The qualifier the label cannot carry: WHICH views were priced. The
              period selects which uploads count, not which views were earned
              during it, and this figure sits between two period stats beside a
              period selector — so without this it reads as "what this niche
              made last month", which it is not. */}
          <InfoTip>{TRACKED_NICHE_VALUE_DEFINITION}</InfoTip>
        </span>
        {bounds !== null ? <SourceChip measured={rpm.source === "derived"} /> : null}
      </div>

      {value.trackedRevenue === null ? (
        <UnpricedNiche niche={niche} rpm={rpm} />
      ) : nothingPublished ? (
        <div className="flex flex-col gap-1">
          <span
            className="text-[12px] text-subtle-foreground"
            aria-label={`${TRACKED_NICHE_VALUE_LABEL}: ${UNPRICED_NICHE_SHORT_NO_SHORTS}. ${NO_SHORTS_TO_PRICE_EXPLANATION}`}
          >
            {UNPRICED_NICHE_SHORT_NO_SHORTS}
          </span>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {NO_SHORTS_TO_PRICE_EXPLANATION}
          </p>
          <RateLine rpm={rpm} />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="tnum text-[15px] font-medium text-foreground">
              {formatProjected(value.trackedRevenue, true)}
            </span>
            <span className="text-[11px] text-subtle-foreground">
              {/* The share stays a POINT even where the rate is a range: one
                  rate applied to both halves cancels exactly, so "12% – 12%"
                  would suggest an uncertainty that is not there. */}
              {`${formatPercent(value.capturePercent)} ours`}
            </span>
          </div>

          {value.ourRevenue !== null ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Northstar&rsquo;s {formatCompactNumber(value.ourViews)} of{" "}
              {formatCompactNumber(value.trackedNicheViews)} tracked views, worth{" "}
              {formatProjected(value.ourRevenue, false)}.
            </p>
          ) : null}

          <RateLine rpm={rpm} />
        </>
      )}
    </div>
  );
}

/**
 * The rate itself, and where it came from.
 *
 * UNDER THE FIGURE RATHER THAN IN A TOOLTIP. A derived rate is only meaningful
 * beside the window and the sample it came from — "$0.045 measured from 2
 * channels over 28 days" is a claim somebody can weigh, "$0.045" alone is one
 * they can only believe — and a fact that exists only on hover does not exist
 * on a printout, in a screenshot, or to a keyboard user.
 */
function RateLine({ rpm }: { rpm: NicheRpmResolution }) {
  const bounds = rpmBounds(rpm);
  if (bounds === null) return null;

  if (rpm.source === "derived") {
    const channels = rpm.evidence.channels.length;
    return (
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        <span className="tnum font-medium text-foreground">
          {formatRpmBounds(bounds)}
        </span>{" "}
        per 1,000 views — measured from {channels}{" "}
        {channels === 1 ? "channel" : "channels"} Northstar operates here over{" "}
        {RPM_WINDOW_DAYS} settled days ({formatCompactNumber(rpm.evidence.viewsUsed)}{" "}
        views).{" "}
        {/*
          THE OVERRIDDEN RANGE IS NAMED, not silently dropped.

          The owner asked for a measured rate to override everything, so a
          stored range really is being ignored — and somebody who edits it and
          watches nothing move learns that the screen is broken. Saying it here
          is the difference between an override and a bug.
        */}
        {rpm.supersededRange !== null
          ? `The entered estimate of ${formatRpmBounds({
              lowMinorPerMillion: rpm.supersededRange.lowMinorPerMillion,
              highMinorPerMillion: rpm.supersededRange.highMinorPerMillion,
              currency: rpm.supersededRange.currency,
            })} is stored but not used here.`
          : DERIVED_RPM_EXPLANATION}
      </p>
    );
  }

  // Bounds exist and the rate is not derived, so it is the hand-entered one.
  // Stated as a guard rather than assumed: `rpmBounds` and the union are two
  // separate facts, and a future third source would otherwise fall silently
  // through this branch wearing the estimate's wording.
  if (rpm.source !== "manual") return null;

  return (
    <>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        <span className="tnum font-medium text-foreground">{formatRpmBounds(bounds)}</span>{" "}
        per 1,000 views — {MANUAL_RPM_EXPLANATION}
        {/*
          A converted range says so. The digits somebody typed are not the
          digits on screen, and a reader comparing this card against the dialog
          has to be able to see why they differ.
        */}
        {rpm.enteredRange.currency !== rpm.range.currency
          ? ` Entered as ${formatRpmBounds({
              lowMinorPerMillion: rpm.enteredRange.lowMinorPerMillion,
              highMinorPerMillion: rpm.enteredRange.highMinorPerMillion,
              currency: rpm.enteredRange.currency,
            })} and converted at the organization's configured rate.`
          : null}
      </p>
      <RejectionReasons rejected={rpm.rejectedChannels} lead={RPM_NOT_MEASURED_BECAUSE} />
    </>
  );
}

/**
 * The state every niche on this deployment is in today.
 *
 * WORDS, NEVER `$0` AND NEVER AN EM DASH. "$0" would assert that the niche
 * generates nothing, which is the fabricated figure the revenue module refuses
 * on every one of its four states; the em dash is this app's symbol for "no
 * Shorts in this period", and reusing it here would say the niche was measured
 * and came up empty. It is also not hidden: a card with no strip at all would
 * make an unpriced niche indistinguishable from one nobody has channels in.
 */
function UnpricedNiche({
  niche,
  rpm,
}: {
  niche: NicheDTO;
  rpm: NicheRpmResolution;
}) {
  /*
   * A stored estimate that cannot be converted is a DIFFERENT state from one
   * nobody entered, and it is the only one of the two with an owner and a fix.
   * Collapsing it into "Not estimated" would tell the admin who priced this
   * niche last month that they never did.
   */
  const unconvertible =
    rpm.source === "none" && rpm.reason === "manual_range_unconvertible"
      ? rpm.unconvertibleRange
      : null;

  if (unconvertible !== null) {
    const stored = formatRpmBounds({
      lowMinorPerMillion: unconvertible.lowMinorPerMillion,
      highMinorPerMillion: unconvertible.highMinorPerMillion,
      currency: unconvertible.currency,
    });
    return (
      <div className="flex flex-col gap-1">
        <span
          className="text-[12px] text-subtle-foreground"
          aria-label={`${TRACKED_NICHE_VALUE_LABEL}: ${UNCONVERTIBLE_NICHE_SHORT}. ${MANUAL_RPM_UNCONVERTIBLE_EXPLANATION}`}
        >
          {UNCONVERTIBLE_NICHE_SHORT}
        </span>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {stored} per 1,000 views is stored for {niche.name}.{" "}
          {MANUAL_RPM_UNCONVERTIBLE_EXPLANATION}
        </p>
        <SetNicheRpmButton niche={niche} />
      </div>
    );
  }

  /*
   * The specific reason where there is one, the general sentence where there is
   * not. A niche with an own channel that YouTube is simply not reporting
   * revenue for is in a completely different situation from one the studio has
   * never entered, and collapsing the two into "not estimated" would hide the
   * only actionable half.
   */
  const hasReasons = rpm.rejectedChannels.some((channel) => !channel.accepted);

  return (
    <div className="flex flex-col gap-1">
      <span
        className="text-[12px] text-subtle-foreground"
        aria-label={`${TRACKED_NICHE_VALUE_LABEL}: ${UNPRICED_NICHE_SHORT}. ${UNPRICED_NICHE_EXPLANATION}`}
      >
        {UNPRICED_NICHE_SHORT}
      </span>
      {hasReasons ? (
        <RejectionReasons rejected={rpm.rejectedChannels} />
      ) : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {UNPRICED_NICHE_EXPLANATION}
        </p>
      )}
      <SetNicheRpmButton niche={niche} />
    </div>
  );
}
