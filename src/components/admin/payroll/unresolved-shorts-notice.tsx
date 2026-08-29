"use client";

import * as React from "react";
import { CheckCheck, Clock, EyeOff } from "lucide-react";
import { formatNumber, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PayrollUnresolvedDTO } from "@/server/services/payroll-service";

/**
 * "These Shorts earned nothing, and here is which kind of nothing."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A WAIT, A LOSS AND A BONUS ALREADY BANKED PRODUCE THE SAME ZERO
 * ─────────────────────────────────────────────────────────────────────────────
 * Under a windowed rule a Short that has not paid a bonus is in one of three
 * very different states, and none of them is "it missed":
 *
 *   PENDING — its window is still open. Nothing is decided; the figure on this
 *             screen can still go up before the month is frozen. Waiting costs
 *             nothing and finalizing early costs the bonus.
 *   UNKNOWN — its window shut while nothing was being recorded, and it is over
 *             the threshold today. It got there; there is no way to say whether
 *             it got there in time, and there never will be, because the
 *             evidence would have had to be captured at the time. This bonus is
 *             gone.
 *   ALREADY  — it was paid for in a finalized period, and a later edit to the
 *   PAID      niche's window moved its resolution date into this one. A Short
 *             pays once, ever, so this run does not credit it again. Nothing is
 *             lost and nothing is waiting; the money is on an earlier payslip.
 *
 * From the total they are indistinguishable, and the actions they call for
 * differ: "come back on the 1st", "this is what not collecting snapshots costs,
 * permanently", and "this one is not missing, go and look at February". So they
 * are shown as separate rows and the sentences say which is which rather than
 * leaving an admin to infer it from a word.
 *
 * THE THIRD ROW IS THE VISIBLE HALF OF A GUARD. Without it a run that silently
 * declined to pay a Short twice would look exactly like a run that miscounted,
 * and an admin with no way to tell the two apart has to doubt the whole figure.
 *
 * PENDING IS STRUCTURALLY ABSENT FROM A MONTH THAT HAS ENDED. A window closing
 * inside the period has necessarily closed once the period is over, so by the
 * time finalizing is the obvious thing to do, every wait has already turned
 * into a hit, a miss or an unknown. Seeing a pending count here means the month
 * is still running — which is exactly when it is worth knowing.
 *
 * IT ONLY EVER APPEARS ON A DRAFT. `PayrollPeriodDTO.unresolved` is zeroed for
 * a finalized period — nothing about what was waiting is stored, and re-deriving
 * it from today's data would be a claim about a document that cannot move — and
 * zeroes render nothing. The history screen can mount this for a frozen month
 * and correctly get silence.
 */
export function UnresolvedShortsNotice({
  unresolved,
  className,
}: {
  unresolved: PayrollUnresolvedDTO;
  className?: string;
}) {
  const { pendingCount, unknownCount, alreadyPaidCount } = unresolved;
  const total = pendingCount + unknownCount + alreadyPaidCount;
  if (total === 0) return null;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-surface-sunken px-4 py-4",
        className,
      )}
      role="status"
    >
      <p className="text-[13px] font-medium text-foreground">
        {formatNumber(total)} {pluralize(total, "Short")} in this period earned
        no hit bonus without missing
      </p>

      {pendingCount > 0 ? (
        <Row
          icon={<Clock className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />}
          heading={`${formatNumber(pendingCount)} still inside ${pluralize(pendingCount, "its window", "their windows")}`}
        >
          Nothing is decided until a window closes, so these are not misses. They
          will be counted in this period once they resolve, and the total above
          can still go up. Finalizing now records them as earning nothing.
        </Row>
      ) : null}

      {unknownCount > 0 ? (
        <Row
          icon={<EyeOff className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />}
          heading={`${formatNumber(unknownCount)} with no view history from inside ${pluralize(unknownCount, "its window", "their windows")}`}
        >
          These passed their thresholds at some point, but nobody was recording
          view counts while the window was open, so there is no way to tell
          whether they got there in time. Unlike the ones above, waiting will not
          settle them — the evidence would have had to be captured at the time.
          Turning on automatic refreshes stops this happening to future Shorts;
          it cannot recover these.
        </Row>
      ) : null}

      {alreadyPaidCount > 0 ? (
        <Row
          icon={<CheckCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />}
          heading={`${formatNumber(alreadyPaidCount)} already paid in a finalized period`}
        >
          A hit is paid in the period its window closed in, and editing a
          niche&apos;s hit window moves that date — so{" "}
          {alreadyPaidCount === 1 ? "this Short" : "these Shorts"} now{" "}
          {alreadyPaidCount === 1 ? "resolves" : "resolve"} into this period
          having already been paid for in an earlier one. A Short is paid once,
          so this run does not credit{" "}
          {alreadyPaidCount === 1 ? "it" : "them"} again. Nothing is owed and
          nothing is lost; the bonus is on the earlier payslip, which is frozen
          and does not change.
        </Row>
      ) : null}
    </div>
  );
}

function Row({
  icon,
  heading,
  children,
}: {
  icon: React.ReactNode;
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      {icon}
      <div className="min-w-0">
        <p className="text-[13px] text-foreground">{heading}</p>
        <p className="mt-0.5 max-w-prose text-[12px] leading-relaxed text-muted-foreground">
          {children}
        </p>
      </div>
    </div>
  );
}

/**
 * The same two facts, compact, for the finalize dialog.
 *
 * A second component rather than a prop, matching `SkippedNichesSummary` next
 * door: a confirmation is a different kind of screen from a page banner, and a
 * `compact` flag that rewrote three paragraphs would be a second component
 * wearing a boolean.
 *
 * The wording here is about the irreversible act rather than about the state.
 * On the page, a pending Short is information; over the confirm button it is a
 * bonus that is about to be recorded as zero.
 */
export function UnresolvedShortsSummary({
  unresolved,
}: {
  unresolved: PayrollUnresolvedDTO;
}) {
  const { pendingCount, unknownCount, alreadyPaidCount } = unresolved;
  if (pendingCount === 0 && unknownCount === 0 && alreadyPaidCount === 0) return null;

  return (
    <div className="flex gap-3 rounded-lg border border-border bg-surface-sunken px-4 py-3">
      <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1.5">
        {pendingCount > 0 ? (
          <p className="text-[13px] leading-relaxed text-foreground">
            {formatNumber(pendingCount)} {pluralize(pendingCount, "Short")} in
            this period {pendingCount === 1 ? "is" : "are"} still inside the
            window for counting as a hit. Freezing the month now records{" "}
            {pendingCount === 1 ? "it" : "them"} as earning no bonus, whatever{" "}
            {pendingCount === 1 ? "it goes" : "they go"} on to do. Waiting until
            the last window closes costs nothing.
          </p>
        ) : null}
        {unknownCount > 0 ? (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {formatNumber(unknownCount)} {pluralize(unknownCount, "Short")}{" "}
            {unknownCount === 1 ? "has" : "have"} no view history from inside{" "}
            {pluralize(unknownCount, "its window", "their windows")}, so{" "}
            {unknownCount === 1 ? "it cannot" : "they cannot"} be judged either
            way. That will not change by waiting, and it is not a reason to hold
            the run.
          </p>
        ) : null}
        {alreadyPaidCount > 0 ? (
          // Reassurance rather than a warning, and deliberately last. This is
          // the one line here that describes something already handled: the
          // total is lower than the hits suggest because a bonus is not being
          // paid twice, which is the outcome an admin wants.
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {formatNumber(alreadyPaidCount)}{" "}
            {pluralize(alreadyPaidCount, "Short")}{" "}
            {alreadyPaidCount === 1 ? "was" : "were"} already paid for in a
            finalized period and {alreadyPaidCount === 1 ? "is" : "are"} not
            counted again here. That is why this total may be lower than the
            hits alone suggest; the earlier payslip stands.
          </p>
        ) : null}
      </div>
    </div>
  );
}
