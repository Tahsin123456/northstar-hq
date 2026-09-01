"use client";

import * as React from "react";
import {
  DERIVED_RPM_EXPLANATION,
  ENGAGED_VIEWS_GLOSS,
  ESTIMATED_RPM_CHIP,
  MANUAL_RPM_EXPLANATION,
  MANUAL_RPM_UNCONVERTIBLE_EXPLANATION,
  MEASURED_RPM_CHIP,
  NO_SHORTS_TO_PRICE_EXPLANATION,
  RPM_NOT_MEASURED_BECAUSE,
  RPM_REJECTION_EXPLANATION,
  RPM_WINDOW_DAYS,
  TRACKED_NICHE_VALUE_LABEL,
  UNCONVERTIBLE_NICHE_SHORT,
  UNPRICED_NICHE_EXPLANATION,
  UNPRICED_NICHE_SHORT,
  calculateNicheValue,
  trackedNicheValueDefinition,
  unpricedNicheNothingPublished,
  engagedViewShareNote,
  formatEngagedViewShare,
  formatRpmBounds,
  manualRpmBasis,
  rpmBounds,
  rpmQuoteUnit,
  type NicheRpmResolution,
  type ProjectedMoney,
  type RpmChannelOutcome,
} from "@/lib/analytics/niche-rpm";
import { toNicheFormat, type NicheFormat } from "@/lib/niches/niche-format";
import type { NicheDTO } from "@/lib/dto";
import { formatMoney, formatMoneyCompact } from "@/lib/finance/money";
import { formatCompactNumber, formatPercent } from "@/lib/format";
import { InfoTip } from "@/components/ui/tooltip";
import { RPM_MENU_ITEM_LABEL } from "./niche-rpm-dialog";

/**
 * What the tracked niche is generating, and how much of it is Northstar's.
 *
 * A FOURTH STRIP ON THE NICHE CARD rather than a fourth column in the stat row.
 * The row is `grid-cols-3` on a card that is a third of an `xl:grid-cols-3`
 * grid, and `MiniStat` truncates its value — a fourth column would clip "$184K"
 * to "$18…". These are also not two independent stats but a ratio, and a ratio
 * reads as a sentence rather than as two adjacent figures.
 *
 * `relative z-10` IS STILL LOAD-BEARING, AND THIS COMMENT IS WHY IT SURVIVED.
 * The whole card is one stretched link: a `<span className="absolute inset-0">`
 * inside the title's `<Link>` covers every pixel of it. Without the stacking
 * context, nothing inside this strip receives a click at all. The class used to
 * be justified by naming the "Set RPM range" button first, and that button is
 * gone — moved into the card's "…" menu at the owner's request, because two
 * inline accent links in the middle of a money figure read as debris. The INFO
 * TIP beside the label still needs the stacking context, so removing `relative
 * z-10` along with the button would silently break the one control left in
 * here. It is named here rather than left to be rediscovered.
 *
 * ---------------------------------------------------------------------------
 * ENGAGED VIEWS ARE NAMED, NOT APPLIED SILENTLY
 * ---------------------------------------------------------------------------
 * A hand-entered rate now prices roughly half the views on the card, because
 * that is the half YouTube pays for. Halving a money figure without saying so
 * makes a number a reader recognised yesterday look like a bug today, so the
 * assumption is written under the rate with its current value in it. The VIEW
 * counts above stay raw — engagement is a fact about how YouTube pays, not
 * about how many people watched, and understating reach to explain money would
 * be a second wrong number solving the first.
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

  // The niche's own format decides how a hand-entered rate is read — engaged
  // for shorts, raw for long form — and it travels on the DTO, so nothing has
  // to be threaded from the page. Re-narrowed at this boundary per the DTO's
  // own rule: the wire type is `string`.
  const format = toNicheFormat(niche.format);
  const bounds = rpmBounds(rpm, format);
  const value = calculateNicheValue({
    ourViews,
    competitorViews,
    bounds,
    // Off the resolution, never off a settings payload. The share is welded to
    // the rate it scales precisely so this line cannot read a stale one, or
    // silently fall back to a default the organization did not choose.
    engagedViewShareBasisPoints: rpm.engagedViewShareBasisPoints,
  });
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
              made last month", which it is not. Selected on the niche's own
              format: the Shorts sentence about engaged views would state the
              OPPOSITE of a Long Form niche's arithmetic. */}
          <InfoTip>{trackedNicheValueDefinition(format)}</InfoTip>
        </span>
        {bounds !== null ? <SourceChip measured={rpm.source === "derived"} /> : null}
      </div>

      {value.trackedRevenue === null ? (
        <UnpricedNiche niche={niche} rpm={rpm} />
      ) : nothingPublished ? (
        <div className="flex flex-col gap-1">
          <span
            className="text-[12px] text-subtle-foreground"
            aria-label={`${TRACKED_NICHE_VALUE_LABEL}: ${unpricedNicheNothingPublished(format)}. ${NO_SHORTS_TO_PRICE_EXPLANATION}`}
          >
            {unpricedNicheNothingPublished(format)}
          </span>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {NO_SHORTS_TO_PRICE_EXPLANATION}
          </p>
          <RateLine rpm={rpm} format={format} />
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

          {/*
              THE ENGAGED-VIEW STEP BELONGS TO THE FIGURE DIRECTLY ABOVE IT.

              `pricedViews` is `ourPayable + competitorPayable` — the engaged
              subset of the WHOLE tracked niche — so it is the denominator
              behind `trackedRevenue`, the headline. It previously hung off the
              end of the "Northstar's X of Y tracked views, worth Z" sentence,
              where the money named is Northstar's ALONE: a reader dividing that
              money by these views got a rate several times off, and the closer
              they read the more wrong they got. Same number, moved to the
              sentence it is the denominator of.
          */}
          {value.basis === "engaged" && value.pricedViews !== null ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Of {formatCompactNumber(value.trackedNicheViews)} tracked views,{" "}
              {formatCompactNumber(value.pricedViews)} are priced as engaged (
              {formatEngagedViewShare(value.engagedViewShareBasisPoints)}).
            </p>
          ) : null}

          {value.ourRevenue !== null ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {/* RAW view counts, deliberately. These are what the channels did
                  — the reach half of the sentence — and the money that follows
                  is what YouTube pays for the engaged subset of them. Halving
                  the reach figure to make the arithmetic look self-evident
                  would understate the niche on the one line that is not about
                  money at all. The engaged step is named in the line ABOVE
                  instead, against the tracked total it is the denominator of —
                  never here, where the money is Northstar's alone. */}
              Northstar&rsquo;s {formatCompactNumber(value.ourViews)} of{" "}
              {formatCompactNumber(value.trackedNicheViews)} tracked views, worth{" "}
              {formatProjected(value.ourRevenue, false)}.
            </p>
          ) : null}

          <RateLine rpm={rpm} format={format} />
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
function RateLine({ rpm, format }: { rpm: NicheRpmResolution; format: NicheFormat }) {
  const bounds = rpmBounds(rpm, format);
  if (bounds === null) return null;

  if (rpm.source === "derived") {
    const channels = rpm.evidence.channels.length;
    return (
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        <span className="tnum font-medium text-foreground">
          {formatRpmBounds(bounds)}
        </span>{" "}
        {/* THE UNIT IS READ OFF THE BASIS, not hard-coded. A measured rate and
            an entered one are quoted against different denominators — see
            `RpmBasis` — and two figures wearing the identical label while
            meaning different things is the same failure as an unlabelled
            currency. */}
        {rpmQuoteUnit(bounds.basis)} — measured from {channels}{" "}
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
        {/*
          THE UNIT IS SPELLED OUT ON THE SUPERSEDED RANGE TOO.

          The stored estimate is quoted per 1,000 ENGAGED views and the measured
          rate above it per 1,000 views, so the two numbers are not comparable
          by eye however similar they look. Printing them side by side with one
          unit between them would invite exactly that comparison — which is the
          reader concluding the measurement is "twice" the estimate when it is
          the denominators that differ.
        */}
        {rpm.supersededRange !== null
          ? `The entered estimate of ${formatRpmBounds({
              lowMinorPerMillion: rpm.supersededRange.lowMinorPerMillion,
              highMinorPerMillion: rpm.supersededRange.highMinorPerMillion,
              currency: rpm.supersededRange.currency,
              // The unit a hand-entered range for THIS format is quoted on —
              // engaged for shorts, raw for long form.
              basis: manualRpmBasis(format),
            })} ${rpmQuoteUnit(manualRpmBasis(format))} is stored but not used here.`
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
        <span className="inline-flex items-center gap-1">
          {rpmQuoteUnit(bounds.basis)}
          {/* The gloss on first use. "Engaged views" is a YouTube term of art
              and this is the first place a studio owner meets it — and it is
              the reason the money beside it is about half what they were
              expecting, so it cannot be left to be inferred. */}
          {bounds.basis === "engaged" ? <InfoTip>{ENGAGED_VIEWS_GLOSS}</InfoTip> : null}
        </span>{" "}
        — {MANUAL_RPM_EXPLANATION}
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
              // A currency conversion does not change what the rate is quoted
              // AGAINST — only what it is quoted IN. The basis survives it.
              basis: bounds.basis,
            })} and converted at the organization's configured rate.`
          : null}
      </p>
      {/* The assumption, in words, with the value actually in force in it. A
          reader can argue with "50% of views are engaged"; they cannot argue
          with a money figure that is quietly half what they expected. */}
      {bounds.basis === "engaged" ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {engagedViewShareNote(
            formatEngagedViewShare(rpm.engagedViewShareBasisPoints),
          )}
        </p>
      ) : null}
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

  // Same rule as everywhere on this strip: the stored range is quoted on the
  // NICHE'S format's manual basis, never on a hardcoded one.
  const format = toNicheFormat(niche.format);

  if (unconvertible !== null) {
    const stored = formatRpmBounds({
      lowMinorPerMillion: unconvertible.lowMinorPerMillion,
      highMinorPerMillion: unconvertible.highMinorPerMillion,
      currency: unconvertible.currency,
      basis: manualRpmBasis(format),
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
          {stored} {rpmQuoteUnit(manualRpmBasis(format))} is stored for {niche.name}.{" "}
          {MANUAL_RPM_UNCONVERTIBLE_EXPLANATION}
        </p>
        <WhereToSetTheRate />
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
      <WhereToSetTheRate />
    </div>
  );
}

/**
 * Where the rate is set, now that it is not set from here.
 *
 * A SENTENCE, NOT A BUTTON, and that is the whole of the owner's second
 * request. Two inline accent links sitting inside a money figure — one for the
 * hit rule, one for the rate — were the "really ugly" part: they are controls
 * dressed as prose, in the middle of a paragraph explaining why there is no
 * number. The action moved to the card's "…" menu, where the card's other four
 * actions already live and where it is now permanently visible rather than
 * revealed on hover.
 *
 * The pointer stays because removing the button without it would leave an
 * unpriced niche explaining a gap and offering nothing to close it. It is shown
 * to everybody rather than gated on the write permission: somebody who cannot
 * open that dialog still benefits from knowing the decision exists and has a
 * home, which is what turns "this screen is broken" into "I should ask an
 * admin". `SetNicheRpmButton` was deleted along with its last call site — a
 * component with no consumers is a component the next reader has to work out
 * the status of.
 */
function WhereToSetTheRate() {
  return (
    <p className="text-[11px] leading-relaxed text-subtle-foreground">
      Set it from this card&rsquo;s &ldquo;&hellip;&rdquo; menu, under{" "}
      {RPM_MENU_ITEM_LABEL}.
    </p>
  );
}
