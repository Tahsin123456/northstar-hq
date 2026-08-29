"use client";

import * as React from "react";
import Link from "next/link";
import { Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SetNicheThresholdButton } from "@/components/niches/niche-threshold-dialog";
import { useNicheList } from "@/hooks/use-niches";
import { formatNumber, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PayrollSkippedNicheDTO } from "@/server/services/payroll-service";

/**
 * "These Shorts were not counted, and here is the setting that would count
 * them."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A PAYROLL SCREEN CARRIES A CONFIGURATION WARNING AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * A niche with no hit threshold cannot produce a hit — the dashboard has always
 * said so, and payroll now agrees. But payroll is the one consumer where that
 * silence costs somebody money: every Short in an unconfigured niche used to be
 * judged against the organization default and paid a bonus, and it no longer
 * is. The difference is real pay, and a reduction that arrives with no
 * explanation is indistinguishable from a bug — the person losing it cannot
 * tell, and neither can the admin approving the run.
 *
 * So this sits at the top of the page body, above the table: the earliest
 * point on the last screen where the fix is still cheap, since after
 * finalization the figures are a document.
 *
 * IT IS NOT WHAT GUARDS THE BUTTON, THOUGH. "Finalize period" lives in the
 * page header's actions slot, above everything this renders next to, and an
 * admin can click it without having scrolled anywhere. What nobody can get
 * past is `SkippedNichesSummary` at the foot of this file, which the finalize
 * dialog puts directly above the control that freezes the month. That one is
 * the gate; this one is the same facts with the fix attached to them.
 *
 * IT IS A WARNING, NOT AN ERROR. Nothing has failed and no figure is wrong. A
 * decision has not been made yet, and the same warning tone the rest of the
 * product uses for an unconfigured threshold says so here too.
 *
 * IT ONLY EVER APPEARS ON A DRAFT, WHICH IS WHY IT CAN PROMISE RETROACTIVITY.
 * "Set a threshold and this run recounts against it" would be a lie about a
 * finalized period — that one never recalculates, so the same act only affects
 * runs from then on, and telling an admin otherwise is how somebody ends up
 * underpaid and told they were not. It is safe to say unconditionally here
 * because the state where it would be false is the state where this component
 * is not on screen: `PayrollPeriodDTO.skippedNiches` is populated only while a
 * period is still being recalculated on every read, `buildPeriodDTO` returns
 * an empty list for a frozen one, and an empty list renders nothing. The
 * history screen mounts this for finalized months too and correctly gets
 * silence — what a frozen run skipped is answered by the
 * `payroll.period_finalized` audit entry, written at the moment it was true.
 */
export function SkippedNichesNotice({
  skippedNiches,
  className,
}: {
  skippedNiches: readonly PayrollSkippedNicheDTO[];
  className?: string;
}) {
  // The empty check lives OUTSIDE the panel so that the hook inside it never
  // runs on the ordinary payroll load, where every niche is configured and
  // there is nothing to report. Hooks cannot sit behind a condition, so the
  // condition has to sit behind a component boundary — one that a caller can
  // mount unconditionally without paying for a catalogue fetch it will not use.
  if (skippedNiches.length === 0) return null;

  return <SkippedNichesPanel skippedNiches={skippedNiches} className={className} />;
}

function SkippedNichesPanel({
  skippedNiches,
  className,
}: {
  skippedNiches: readonly PayrollSkippedNicheDTO[];
  className?: string;
}) {
  // Only for the niches themselves; the counts come from the run. The dialog
  // that fixes one seeds itself from the niche's current threshold, and a run
  // reports an id and a name — hence the second read.
  const { data } = useNicheList();

  const nicheById = new Map((data?.niches ?? []).map((niche) => [niche.id, niche]));
  const shortCount = skippedNiches.reduce((sum, niche) => sum + niche.shortCount, 0);

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-subtle/40 px-4 py-4",
        className,
      )}
      role="status"
    >
      <div className="flex items-start gap-3">
        <Target className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground">
            {formatNumber(shortCount)} {pluralize(shortCount, "Short")} could not be
            counted for hit bonuses
          </p>
          <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-muted-foreground">
            {skippedNiches.length === 1 ? "This niche has" : "These niches have"} no
            hit rate threshold, so there is no definition of a hit to judge their
            Shorts against and no bonus can be paid for them. Nobody&rsquo;s salary
            is affected — only the hit bonus.
          </p>
        </div>
      </div>

      <ul className="flex flex-col gap-1.5 pl-7">
        {skippedNiches.map((niche) => {
          const full = nicheById.get(niche.nicheId);

          return (
            <li
              key={niche.nicheId}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/20 pb-1.5 last:border-0 last:pb-0"
            >
              <span className="min-w-0 text-[13px] text-foreground">
                <span className="font-medium">{niche.nicheName}</span>
                <span className="text-muted-foreground">
                  {" "}
                  — {formatNumber(niche.shortCount)}{" "}
                  {pluralize(niche.shortCount, "Short")} not considered
                </span>
              </span>

              {/*
                The fix, where the problem is. `SetNicheThresholdButton` renders
                nothing without `settings.manage`, so a payroll admin who cannot
                set thresholds is not offered a door that would not open — they
                still see which niches to ask about, which is the part they can
                act on. Until the catalogue lands there is simply no button.
              */}
              {full ? <SetNicheThresholdButton niche={full} size="sm" /> : null}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-3 pl-7">
        {/*
          One sentence, not a pair behind a flag: see the note at the top of
          this file. The period this is on is always still open, so the
          retroactive half is always the true half.
        */}
        <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted-foreground">
          Set a threshold and this run recounts against it the next time it is
          opened, so these Shorts are included before the month is frozen. Once
          the period is finalized the figures stop moving and a threshold set
          afterwards only counts towards later periods.
        </p>
        <Button variant="secondary" size="sm" asChild>
          <Link href="/admin/niches">Review niches</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * The same facts, compact and with nothing to click, for the finalize dialog.
 *
 * A second component rather than a prop on the first, for the reason the
 * "Not configured" pair upstairs is also two components: the controls are what
 * differ, and a `compact` flag that also removed two buttons and rewrote a
 * paragraph would be a second component wearing a boolean.
 *
 * NO "SET THRESHOLD" BUTTON HERE ON PURPOSE. It would open a dialog on top of
 * this one, over a confirmation whose whole job is to be the last clear moment
 * before an irreversible act. The admin cancels, fixes the niche, and comes
 * back — which is the outcome this block is trying to produce anyway.
 */
export function SkippedNichesSummary({
  skippedNiches,
}: {
  skippedNiches: readonly PayrollSkippedNicheDTO[];
}) {
  if (skippedNiches.length === 0) return null;

  const shortCount = skippedNiches.reduce((sum, niche) => sum + niche.shortCount, 0);

  return (
    <div className="flex gap-3 rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3">
      <Target className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="text-[13px] leading-relaxed text-foreground">
          {formatNumber(shortCount)} {pluralize(shortCount, "Short")} in{" "}
          {formatNumber(skippedNiches.length)}{" "}
          {pluralize(skippedNiches.length, "niche")} will be recorded as
          earning no hit bonus, because{" "}
          {skippedNiches.length === 1 ? "that niche has" : "those niches have"} no
          hit rate threshold to judge them against.
        </p>
        <ul className="flex flex-col gap-0.5 text-[12px] text-muted-foreground">
          {skippedNiches.map((niche) => (
            <li key={niche.nicheId}>
              <span className="text-foreground">{niche.nicheName}</span> —{" "}
              {formatNumber(niche.shortCount)} {pluralize(niche.shortCount, "Short")}
            </li>
          ))}
        </ul>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Freezing the month records that as the answer. Cancel and set the
          thresholds first if those Shorts should have paid a bonus — once this
          period is finalized, setting them changes nothing about it.
        </p>
      </div>
    </div>
  );
}
