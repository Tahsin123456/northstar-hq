"use client";

import * as React from "react";
import Link from "next/link";
import { CalendarRange, ChevronRight, Info, Lock, Target } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/components/providers/session-provider";
import {
  formatUtcDay,
  fromUtcDayInputValue,
  toUtcDayInputValue,
} from "@/components/admin/payroll/payroll-format";
import { formatMoneyTrimmed } from "@/lib/finance/money";
import { formatDate, formatNumber } from "@/lib/format";
import { useNow } from "@/hooks/use-now";
import {
  useMyEarnings,
  useMyEarningsHistory,
  useMyEarningsHistoryBreakdown,
  type EarningsPeriodQuery,
} from "@/hooks/use-earnings";
import type {
  MyEarningsDTO,
  MyEarningsHistoryRowDTO,
  MyEarningsNicheLineDTO,
} from "@/server/services/payroll-service";
import { cn } from "@/lib/utils";

/**
 * Your Earnings.
 *
 * The employee's own pay, and nothing else. It reads /api/me/earnings, which
 * takes a period and never a person — there is no way to point this screen at a
 * colleague because there is no parameter that would carry one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PAGE LOOKS NOTHING LIKE THE PAYROLL SCREENS
 * ─────────────────────────────────────────────────────────────────────────────
 * The bar the brief sets is that a five-year-old should be able to read it. The
 * admin payroll pages answer "is this run correct?" and earn their density; this
 * one answers "how much am I getting, and why?", which is one sentence and three
 * numbers. So: no table of thresholds and rates, no uppercase stat labels, no
 * per-column tabular alignment to scan. Plain rows in a plain order —
 *
 *     Your normal pay        $4,000
 *     Extra money from hits  $1,240
 *     Total                  $5,240
 *
 * — and then the hits themselves as arithmetic anybody can check by eye:
 * `120 hits × $5 = $600`. The multiplication is written out rather than
 * summarised because it is the whole explanation of the second row, and an
 * employee who cannot reproduce their own bonus has to take it on trust.
 *
 * WHAT IS DELIBERATELY STILL HERE
 * The threshold each niche was judged against, on its own line under the niche.
 * It is the one piece of vocabulary this page cannot drop — "you got 120 hits"
 * means nothing without "a hit in GTA is 100,000 views" — and it is stated as a
 * sentence rather than a column header called "Threshold".
 *
 * THE ZERO THAT IS NOT A ZERO
 * A niche with no threshold set cannot produce a hit, so somebody whose niches
 * are all unconfigured earns no bonus at all. Rendered naively that is a column
 * of zeroes, which reads as "you did not land one" — a verdict on their work
 * for what is actually an empty field on an admin's settings screen. Every
 * surface that could carry that misreading says the true thing instead: the row
 * under the total, the per-niche line, and a block at the top of the hits card.
 * `noMeasurableNiche` comes from the server so all three agree.
 *
 * The `notices` from the server are rendered as prominently as the total. The
 * most common honest answer on this screen is "nothing yet, and here is why",
 * and a bare zero is indistinguishable from a broken page.
 *
 * NOTHING HERE IS EDITABLE. There is no mutation on this page, no form that
 * posts, and no hook that writes — the only control is which window to look at.
 */
export default function EarningsPage() {
  const session = useSession();

  /*
   * An admin has no personal earnings page, on purpose.
   *
   * `earnings.view_own` is withheld from the Admin role — they read Admin →
   * Payroll, which is every row including their own, so this would be a
   * narrower answer to a question they can already ask better. The sidebar
   * entry is gated on the same permission, so this is only reachable by typing
   * the URL; without it that lands on the API's 403 rendered as an error, which
   * says something went wrong when nothing did.
   *
   * An affordance, not the boundary: the route refuses regardless.
   */
  if (!session.can("earnings.view_own")) {
    return (
      <PageContainer>
        <Card>
          <EmptyState
            icon={<Lock />}
            title="This page is for employees"
            description="Administrators read the whole payroll instead — your own row is on it, alongside everybody else's."
            action={
              session.can("payroll.view") ? (
                <Button asChild variant="primary" size="sm">
                  <Link href="/admin/payroll">Open Payroll</Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
      </PageContainer>
    );
  }

  return <MyEarnings />;
}

function MyEarnings() {
  const [period, setPeriod] = React.useState<EarningsPeriodQuery>({ kind: "current" });
  const { data, isLoading, error, refetch } = useMyEarnings(period);

  return (
    <PageContainer className="flex max-w-2xl flex-col gap-5">
      <PageHeader
        title="Your Earnings"
        // "on the payroll", not "this page": an administrator no longer has a
        // personal earnings screen at all, so promising they can see this one
        // would be describing a route that answers 403 for them. What is still
        // true — and the thing an employee actually wants to know — is that
        // their figures are not private from the person who sets them.
        description="How much you are paid, and why. Nobody else sees this page; your figures appear on the payroll an administrator runs."
      />

      <PeriodPicker period={period} onChange={setPeriod} />

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : isLoading || !data ? (
        <div className="flex flex-col gap-5">
          <Skeleton className="h-56 w-full rounded-lg" />
          <Skeleton className="h-44 w-full rounded-lg" />
        </div>
      ) : (
        <EarningsView earnings={data.earnings} />
      )}

      {/*
        Outside the block above on purpose: the history does not depend on which
        window the picker has selected, and it should still render when the
        selected period itself failed to load.
      */}
      <EarningsHistory />

      <p className="flex items-center gap-1.5 text-[11px] text-subtle-foreground">
        <Lock className="size-3" />
        These numbers are yours. What the rest of the team earns is a different
        screen that only administrators can open.
      </p>
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// WHICH WINDOW
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/**
 * A custom range is capped at two years by the server, which answers a request
 * outside it with a 400. Checking the same bound here is not a second rule — it
 * is the difference between a sentence under the field and a red toast after a
 * round trip.
 */
const MAX_CUSTOM_DAYS = 731;

function PeriodPicker({
  period,
  onChange,
}: {
  period: EarningsPeriodQuery;
  onChange: (next: EarningsPeriodQuery) => void;
}) {
  const [pickerOpen, setPickerOpen] = React.useState(false);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <PeriodButton
        active={period.kind === "current"}
        onClick={() => onChange({ kind: "current" })}
      >
        This month
      </PeriodButton>
      <PeriodButton
        active={period.kind === "previous"}
        onClick={() => onChange({ kind: "previous" })}
      >
        Last month
      </PeriodButton>

      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors",
              period.kind === "custom"
                ? "border-accent bg-accent-subtle text-foreground"
                : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
            )}
          >
            <CalendarRange className="size-3.5" />
            {period.kind === "custom"
              ? `${formatUtcDay(period.startsAt)} – ${formatUtcDay(period.endsAt - 1, {
                  withYear: true,
                })}`
              : "Pick dates"}
          </button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-[268px] p-3">
          {/*
            Radix unmounts a closed popover, so the form is a fresh mount every
            time it opens and these props seed it. Reopening the picker on an
            active range shows that range rather than two blank fields — the
            question people ask second is "and what if I move the end date?".
          */}
          <CustomRangeForm
            initialStartsAt={period.kind === "custom" ? period.startsAt : null}
            initialEndsAt={period.kind === "custom" ? period.endsAt : null}
            onApply={(startsAt, endsAt) => {
              onChange({ kind: "custom", startsAt, endsAt });
              setPickerOpen(false);
            }}
            onCancel={() => setPickerOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function PeriodButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors",
        active
          ? "border-accent bg-accent-subtle text-foreground"
          : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Two dates, both inclusive, read as UTC calendar days.
 *
 * The two helpers doing the reading live in `payroll-format.ts`, beside the
 * formatter that prints these same days — and they are the `Utc` pair rather
 * than the local-midnight pair in `src/lib/date-range.ts` that the dashboard's
 * picker uses. That distinction is the whole comment above their definition; it
 * is the difference between a range picked as "1 August" and a range the server
 * labels "31 July".
 */
function CustomRangeForm({
  initialStartsAt,
  initialEndsAt,
  onApply,
  onCancel,
}: {
  initialStartsAt: number | null;
  /** Exclusive, as everywhere else. The field below shows the day before it. */
  initialEndsAt: number | null;
  onApply: (startsAt: number, endsAt: number) => void;
  onCancel: () => void;
}) {
  // From the shared clock rather than `Date.now()`, which would be an impure
  // read during render. It is 0 until the first tick, which only costs the
  // `max` attribute for a frame.
  const now = useNow();
  const today = now > 0 ? toUtcDayInputValue(now) : undefined;

  const [start, setStart] = React.useState(() =>
    initialStartsAt === null ? "" : toUtcDayInputValue(initialStartsAt),
  );
  // Step back a day: the stored bound is midnight AFTER the last day included,
  // and showing that day in a field labelled "Last day" would offer back a
  // range one day wider than the one being displayed.
  const [end, setEnd] = React.useState(() =>
    initialEndsAt === null ? "" : toUtcDayInputValue(initialEndsAt - MS_PER_DAY),
  );
  const [error, setError] = React.useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    const startsAt = fromUtcDayInputValue(start);
    const lastDay = fromUtcDayInputValue(end);

    if (startsAt === null || lastDay === null) {
      setError("Pick a first day and a last day.");
      return;
    }
    if (lastDay < startsAt) {
      // Equal is fine — one day is a range — so this is "before", not "after".
      setError("The last day cannot be before the first one.");
      return;
    }
    // The end bound the API wants is exclusive — midnight at the start of the
    // day AFTER the last one the person means to include.
    const endsAt = lastDay + MS_PER_DAY;
    if (endsAt - startsAt > MAX_CUSTOM_DAYS * MS_PER_DAY) {
      setError("Dates can cover at most two years at a time.");
      return;
    }

    onApply(startsAt, endsAt);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="earnings-start">First day</Label>
        <Input
          id="earnings-start"
          type="date"
          value={start}
          max={today}
          onChange={(event) => {
            setStart(event.target.value);
            setError(null);
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="earnings-end">Last day</Label>
        <Input
          id="earnings-end"
          type="date"
          value={end}
          max={today}
          onChange={(event) => {
            setEnd(event.target.value);
            setError(null);
          }}
        />
      </div>

      {error ? (
        <FieldHint tone="danger">{error}</FieldHint>
      ) : (
        <FieldHint>
          Both days are counted. Dates that are not a whole month are always an
          estimate.
        </FieldHint>
      )}

      <div className="flex justify-end gap-2 pt-0.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm">
          Show these dates
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// THE MONEY
// ---------------------------------------------------------------------------

function EarningsView({ earnings }: { earnings: MyEarningsDTO }) {
  const { currency } = earnings;
  const money = (minor: number) => formatMoneyTrimmed(minor, currency);

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-5 py-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-muted-foreground">
                {headlineFor(earnings.period.kind)}
              </p>
              <p className="mt-0.5 text-[12px] text-subtle-foreground">
                {windowSentence(earnings)}
              </p>
            </div>

            {/*
              The one honesty control on this screen. An estimate that looks
              like a payslip is the failure mode that actually costs somebody
              something, so the state sits beside the figure rather than in a
              footnote under it.
            */}
            <Badge
              variant={earnings.basis === "finalized" ? "hit" : "near"}
              size="md"
              className="shrink-0"
            >
              {earnings.basis === "finalized"
                ? earnings.paymentStatus === "paid"
                  ? "Final · paid"
                  : "Final"
                : "Still counting"}
            </Badge>
          </div>

          <div>
            <p className="tnum text-[40px] font-semibold leading-none tracking-tight text-foreground">
              {money(earnings.totalMinor)}
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              {basisSentence(earnings)}
            </p>
          </div>

          <div className="flex flex-col gap-px">
            <MoneyRow label="Your normal pay" value={money(earnings.baseSalaryMinor)} />
            <MoneyRow
              label="Extra money from hits"
              value={money(earnings.hitBonusMinor)}
              note={
                earnings.hitCount > 0
                  ? `${formatNumber(earnings.hitCount)} ${
                      earnings.hitCount === 1 ? "hit" : "hits"
                    }${earnings.basis === "estimate" ? " so far" : ""}`
                  : // A zero that is nobody's performance. "No hits yet" reads
                    // as a verdict on the work; this one is a missing setting,
                    // and the row directly under the total is where somebody
                    // stops reading, so it has to say so here and not only in
                    // the card below.
                    earnings.noMeasurableNiche
                    ? "nothing can be counted yet — see below"
                    : "no hits yet"
              }
            />

            {/*
              Shown, never folded into the total. A figure that does not equal
              base + bonus and carries no explanation is the one number on this
              page nobody could account for — and the reason beside it was
              written to justify the change.
            */}
            {earnings.adjustmentMinor !== 0 ? (
              <MoneyRow
                label="Change made by an administrator"
                value={formatMoneyTrimmed(earnings.adjustmentMinor, currency, {
                  signDisplay: "exceptZero",
                })}
                note={earnings.adjustmentReason ?? undefined}
              />
            ) : null}

            <MoneyRow label="Total" value={money(earnings.totalMinor)} total />
          </div>
        </CardContent>
      </Card>

      {earnings.notices.length > 0 ? (
        <Card>
          <CardContent className="flex flex-col gap-2.5 py-4">
            {earnings.notices.map((notice) => (
              <p
                key={notice}
                className="flex gap-2 text-[12px] leading-relaxed text-muted-foreground"
              >
                <Info className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground" />
                {notice}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {earnings.onPayroll ? <HitsCard earnings={earnings} /> : null}

      {earnings.hits.length > 0 ? <EarningShortsCard earnings={earnings} /> : null}
    </>
  );
}

/**
 * One sentence about how much this figure can still move.
 *
 * FOUR CASES, NOT TWO. "Estimate" covers a month still running, a month that
 * has ended and is waiting for somebody to close the pay run, and a stretch of
 * dates that can never be finalized at all — and telling all three that hits
 * "can still land before the month ends" is wrong for two of them. The server's
 * `notices` draw the same distinction at length; this is the short form that
 * sits directly under the number, where somebody who reads nothing else on the
 * page will still see it.
 */
function basisSentence(earnings: MyEarningsDTO): string {
  if (earnings.basis === "finalized") {
    return earnings.paymentStatus === "paid"
      ? "This is final. It has been paid, and it will not change."
      : "This is final. The number is settled and will not change.";
  }

  if (earnings.period.kind === "custom") {
    // A range that is not a calendar month is not a payroll period and can
    // never be frozen, so there is no later state for this to become.
    return "This is an estimate. Dates that are not a whole month never get closed off, so this is always counted fresh.";
  }

  return earnings.period.hasEnded
    ? "This is not the final number yet. The month is over, but the pay run has not been closed off, so it is still being counted."
    : "This is not the final number yet. Your Shorts are still picking up views, so more hits can still land before the month ends.";
}

/** Plain words for the window, with the exact dates one line below. */
function headlineFor(kind: MyEarningsDTO["period"]["kind"]): string {
  if (kind === "current") return "This month";
  if (kind === "previous") return "Last month";
  return "The dates you picked";
}

function windowSentence(earnings: MyEarningsDTO): string {
  const { startsAt, endsAt } = earnings.period;
  // `endsAt` is exclusive — the first instant after the window — so the last day
  // it actually covers is the millisecond before it, never the day it names.
  return `${formatUtcDay(startsAt)} to ${formatUtcDay(endsAt - 1, { withYear: true })}`;
}

function MoneyRow({
  label,
  value,
  note,
  total = false,
}: {
  label: string;
  value: string;
  note?: string;
  total?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 py-2.5",
        total && "mt-1 border-t border-border pt-3.5",
      )}
    >
      <div className="min-w-0">
        <p
          className={cn(
            "text-[14px]",
            total ? "font-semibold text-foreground" : "text-muted-foreground",
          )}
        >
          {label}
        </p>
        {note ? <p className="text-[11px] text-subtle-foreground">{note}</p> : null}
      </div>
      <p
        className={cn(
          "tnum shrink-0 tracking-tight",
          total ? "text-[19px] font-semibold text-foreground" : "text-[16px] text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WHAT YOU HAVE ALREADY BEEN PAID
// ---------------------------------------------------------------------------

/**
 * Previous months, newest first.
 *
 * Independent of the period picker above on purpose. The picker answers "show
 * me this window"; this answers "what have I actually been paid?", which is a
 * different question and has one answer regardless of what is selected.
 *
 * Every row is a stored record rather than a calculation, so nothing in this
 * list moves. Only finalized months appear at all — a month still being counted
 * has no settled figure to list, and putting an estimate in a payment history
 * would be the one place on this page where a number that can still change
 * looks like one that cannot.
 *
 * THE STATUS COLUMN IS THE CAREFUL ONE. "Paid" is a claim that money left the
 * company's account, and the server only makes it when the record carries the
 * date it happened. A month that is finalized but not yet paid says so, and
 * says when it is due instead — the due date is a schedule, never evidence.
 */
function EarningsHistory() {
  const { data, isLoading, error, refetch } = useMyEarningsHistory();

  if (error) {
    return (
      <Card>
        <ErrorState error={error} onRetry={() => refetch()} />
      </Card>
    );
  }

  if (isLoading || !data) {
    return <Skeleton className="h-40 w-full rounded-lg" />;
  }

  const { rows, hasMore } = data.history;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-5">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
            What you have been paid before
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            {rows.length > 0
              ? "Months that have been closed off. These figures are the ones recorded at the time, and they do not change."
              : "Nothing here yet. A month shows up once the pay run for it has been closed off."}
          </p>
        </div>

        {rows.length > 0 ? (
          <div className="flex flex-col gap-5">
            {rows.map((row) => (
              <HistoryRow key={`${row.year}-${row.month}`} row={row} />
            ))}
          </div>
        ) : null}

        {hasMore ? (
          // Two years already fit in one request, so this only ever shows for
          // somebody with a longer history than that. Saying so beats a "load
          // more" button that quietly implies the list above is incomplete in
          // the normal case.
          <p className="text-[11px] text-subtle-foreground">
            Showing your most recent {formatNumber(rows.length)} months. Ask an
            administrator if you need anything older.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function HistoryRow({ row }: { row: MyEarningsHistoryRowDTO }) {
  const money = (minor: number) => formatMoneyTrimmed(minor, row.currency);
  const paid = row.paymentStatus === "paid";

  // The one piece of state on this screen, and it is which rows are open. It
  // changes nothing about the figures — the panel it reveals is a second read of
  // the same settled month.
  const [open, setOpen] = React.useState(false);
  const panelId = `earnings-history-${row.year}-${row.month}`;

  return (
    <div className="border-b border-border/60 pb-4 last:border-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[14px] font-semibold text-foreground">{row.label}</p>
        <Badge variant={paid ? "hit" : "near"} size="md" className="shrink-0">
          {paid ? "Paid" : "Not paid yet"}
        </Badge>
      </div>

      <div className="mt-1 flex flex-col gap-px">
        <MoneyRow label="Your normal pay" value={money(row.baseSalaryMinor)} />
        <MoneyRow
          label="Extra money from hits"
          value={money(row.hitBonusMinor)}
          note={
            row.hitCount > 0
              ? `${formatNumber(row.hitCount)} ${row.hitCount === 1 ? "hit" : "hits"}`
              : "no hits that month"
          }
        />

        {/* Never folded into the total, for the same reason as the card above:
            a figure that does not equal base + bonus and carries no explanation
            is the one number here nobody could account for. */}
        {row.adjustmentMinor !== 0 ? (
          <MoneyRow
            label="Change made by an administrator"
            value={formatMoneyTrimmed(row.adjustmentMinor, row.currency, {
              signDisplay: "exceptZero",
            })}
            note={row.adjustmentReason ?? undefined}
          />
        ) : null}

        <MoneyRow label="Total" value={money(row.totalMinor)} total />
      </div>

      <p className="mt-2 text-[12px] text-muted-foreground">{paymentSentence(row)}</p>

      {/*
        THE DISCLOSURE IS NOT A CONTROL OVER THE MONEY. It toggles whether a
        second read of this same settled month is shown; there is no form here,
        no mutation behind it, and nothing it reveals can be edited.

        Hidden entirely on a month with no hits. There is no breakdown to open —
        the row above already says "no hits that month" — and a button that opens
        an empty panel is a worse answer than no button.
      */}
      {row.hitCount > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            aria-controls={panelId}
            className="mt-2.5 inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
              aria-hidden
            />
            {open ? "Hide where these hits came from" : "See where these hits came from"}
          </button>

          {open ? (
            <div id={panelId} className="mt-1.5">
              <HistoryBreakdown row={row} />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * One settled month's hits, niche by niche.
 *
 * Fetched only once the row is opened, and rendered through `NicheHitLine` —
 * the same component the current period uses above. That is the point of
 * reusing it: "12 hits × $10 = $120" should be the same sentence whether it is
 * about this month or one from two years ago, and a second component for the
 * same line is how two screens start rounding a bonus differently.
 *
 * `basis="finalized"` because it is. The only thing that word changes in the
 * line is whether a niche with nothing in it reads "No hits" or "No hits yet",
 * and "yet" on a closed month promises a hit that is never coming.
 */
function HistoryBreakdown({ row }: { row: MyEarningsHistoryRowDTO }) {
  const { data, isLoading, error, refetch } = useMyEarningsHistoryBreakdown({
    year: row.year,
    month: row.month,
  });

  if (error) {
    return <ErrorState error={error} onRetry={() => refetch()} />;
  }

  if (isLoading || !data) {
    return <Skeleton className="h-20 w-full rounded-lg" />;
  }

  const { byNiche } = data.breakdown;

  return (
    <div className="rounded-lg border border-border bg-surface-sunken px-3.5 py-3">
      {byNiche.length === 0 ? (
        // The record counted hits but stored no hit rows behind them. Nothing to
        // show, and inventing a line would be worse than saying so — the money
        // above is the record and stands on its own.
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          The Shorts behind this month were not kept, so there is nothing to break
          down. The money above is what was recorded and does not change.
        </p>
      ) : (
        <>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            The hits that earned this month&rsquo;s extra money, and the number
            each niche counted as a win at the time.
          </p>
          <div className="mt-1 flex flex-col gap-px">
            {byNiche.map((line) => (
              <NicheHitLine
                key={line.nicheId ?? line.nicheName}
                line={line}
                currency={data.breakdown.currency}
                basis="finalized"
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * When the money arrived, or when it is due — and never the two confused.
 *
 * `paidAt` is an instant: the moment an administrator recorded the payment. It
 * is formatted in the reader's own time zone, because that is the zone the
 * question "when did I get paid?" is asked in.
 *
 * `scheduledPayOn` is the other kind of date entirely — a stored calendar day,
 * held at UTC midnight like every other payroll date — so it takes the UTC
 * formatter. Rendering it locally would tell anybody west of Greenwich that
 * August's pay is due on 31 August, which is the off-by-one `payroll-format.ts`
 * exists to prevent.
 */
function paymentSentence(row: MyEarningsHistoryRowDTO): string {
  if (row.paidAt !== null) {
    return `Paid on ${formatDate(row.paidAt)}.`;
  }

  // Finalized, and nothing recorded against it. The due date is a schedule, so
  // the sentence says "due", and the row's badge still reads "Not paid yet".
  return `This is settled but has not been marked as paid yet. It is due on ${formatUtcDay(
    row.scheduledPayOn,
    { withYear: true },
  )}.`;
}

// ---------------------------------------------------------------------------
// THE HITS — the arithmetic behind the second row
// ---------------------------------------------------------------------------

/**
 * `120 hits × $5 = $600`, one line per niche.
 *
 * Written out rather than totalled because this is the entire explanation of
 * "extra money from hits", and an employee should be able to check it in their
 * head. Every niche they are assigned to gets a line, INCLUDING the ones that
 * earned nothing — a niche missing from a list looks exactly like a niche
 * somebody forgot to put them on, and those are very different problems.
 */
function HitsCard({ earnings }: { earnings: MyEarningsDTO }) {
  const { currency } = earnings;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-5">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
            Your hits
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            A hit is a Short that passed the view count its niche counts as a
            win. You are paid for each one.
          </p>
        </div>

        {earnings.byNiche.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface-sunken px-3.5 py-3 text-[13px] leading-relaxed text-muted-foreground">
            You are not on any niche yet, so there is nothing to count hits in.
            An administrator adds you to one on your employee page.
          </p>
        ) : (
          <div className="flex flex-col gap-px">
            {/*
              THE STATE THIS BLOCK EXISTS FOR. Somebody whose every niche is
              unconfigured earns no hit bonus at all, and without this the page
              renders that as a column of zeroes — which reads as "you did not
              land a single hit". It is not that. Nothing was measured, because
              nobody has said what a hit is in any niche this person works in,
              and the only person who can fix it is an administrator.

              Above the rows rather than below them, because it changes what
              every row underneath means.
            */}
            {earnings.noMeasurableNiche ? (
              <div className="mb-2 flex gap-2.5 rounded-lg border border-warning/40 bg-warning-subtle/40 px-3.5 py-3">
                <Target className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-foreground">
                    Your hits cannot be counted yet
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                    Nobody has set the number of views that counts as a hit for
                    the {earnings.byNiche.length === 1 ? "niche" : "niches"} you
                    are on, so none of your Shorts can be counted as one. This is
                    a setting an administrator fills in — it is not about your
                    work, and it does not affect your normal pay. Ask an
                    administrator to set a hit number for{" "}
                    {earnings.byNiche.map((line) => line.nicheName).join(", ")}.
                  </p>
                </div>
              </div>
            ) : null}

            {earnings.byNiche.map((line) => (
              <NicheHitLine
                key={line.nicheId ?? line.nicheName}
                line={line}
                currency={currency}
                basis={earnings.basis}
              />
            ))}

            <div className="mt-1 flex items-baseline justify-between gap-4 border-t border-border pt-3.5">
              <p className="text-[14px] font-semibold text-foreground">Hit bonus</p>
              <p className="tnum shrink-0 text-[19px] font-semibold tracking-tight text-foreground">
                {formatMoneyTrimmed(earnings.hitBonusMinor, currency)}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NicheHitLine({
  line,
  currency,
  basis,
}: {
  line: MyEarningsNicheLineDTO;
  currency: string;
  basis: MyEarningsDTO["basis"];
}) {
  const rate = formatMoneyTrimmed(line.hitPaymentMinor, currency);

  /**
   * Nobody has set a number for this niche, so there is nothing to be measured
   * against and no such thing as a hit in it yet.
   *
   * This line used to read "A hit here is 1,000,000 views" — the company-wide
   * number, borrowed. It said the bar was known when it was not, and the bonus
   * underneath it was real money paid against a figure nobody had chosen for
   * this niche. Now the row says the true thing, which is that the setting is
   * missing.
   */
  const unconfigured = line.thresholdSource === "unconfigured";

  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-[14px] font-medium text-foreground">{line.nicheName}</p>
        <p className="text-[11px] leading-relaxed text-subtle-foreground">
          {/*
            The one piece of vocabulary this page cannot drop. "120 hits" is not
            a fact anybody can check without the bar it was measured against, and
            a column header reading "Threshold" is exactly the jargon the brief
            rules out — so it is a sentence instead.
          */}
          {unconfigured || line.thresholdApplied === null
            ? "Nobody has set the number of views that counts as a hit here yet, so nothing in this niche can be counted. An administrator sets it."
            : `A hit here is ${formatNumber(line.thresholdApplied)} views.`}
        </p>
      </div>

      <p className="tnum shrink-0 text-[14px] text-foreground">
        {unconfigured ? (
          // NOT "No hits". Zero hits is an outcome, and this is not one — the
          // counting never happened. Saying "none" here would be the whole bug
          // over again, one row lower down.
          <span className="text-subtle-foreground">Waiting on a number</span>
        ) : line.hitCount === 0 ? (
          // "yet" only while the number can still change. On a closed period it
          // would promise a hit that is never coming.
          <span className="text-subtle-foreground">
            {basis === "estimate" ? "No hits yet" : "No hits"}
          </span>
        ) : (
          <>
            <span className="text-muted-foreground">
              {formatNumber(line.hitCount)} {line.hitCount === 1 ? "hit" : "hits"} × {rate} ={" "}
            </span>
            <span className="font-medium">
              {formatMoneyTrimmed(line.bonusMinor, currency)}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE SHORTS THEMSELVES
// ---------------------------------------------------------------------------

/** How many Shorts to show before the list needs asking for. */
const HITS_PREVIEW = 12;

/**
 * The Shorts behind the bonus, by name.
 *
 * Capped at a preview because a good month is hundreds of rows, and a page that
 * opens two screens deep in a list stops being the simple thing it is for. The
 * rest are one click away, never hidden.
 */
function EarningShortsCard({ earnings }: { earnings: MyEarningsDTO }) {
  const [expanded, setExpanded] = React.useState(false);
  const shown = expanded ? earnings.hits : earnings.hits.slice(0, HITS_PREVIEW);
  const remaining = earnings.hits.length - shown.length;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-5">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
            The Shorts that earned it
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            {earnings.basis === "finalized"
              ? "The view counts as they stood when this period was closed."
              : "The view counts right now. A Short just under its number today can still pass it before the month ends."}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          {shown.map((hit) => (
            <div
              key={hit.videoId}
              className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="truncate text-[13px] text-foreground">{hit.videoTitle}</p>
                <p className="truncate text-[11px] text-subtle-foreground">
                  {hit.channelName} · {hit.nicheName} · put out{" "}
                  {formatUtcDay(hit.publishedAt, { withYear: true })}
                </p>
              </div>
              <span className="tnum shrink-0 text-[13px] text-muted-foreground">
                {formatNumber(hit.viewCountAtRun)} views
              </span>
            </div>
          ))}
        </div>

        {remaining > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => setExpanded(true)}
          >
            Show the other {formatNumber(remaining)}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
