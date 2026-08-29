"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Wallet } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { InfoTip } from "@/components/ui/tooltip";
import { Stat, StatSkeleton } from "@/components/metrics/stat";
import { IfPermitted } from "@/components/providers/session-provider";
import {
  ExpenseBreakdownDonut,
  NetProfitChart,
  RevenueByChannelChart,
  RevenueExpenseChart,
} from "@/components/charts/finance-charts";
import { useFinanceOverview } from "@/hooks/use-finance";
import { formatMoney, profitMargin } from "@/lib/finance/money";
import type { FinanceChannelRow } from "@/lib/finance/types";
import { EM_DASH, formatDate, formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Finance — the overview.
 *
 * Four figures, four charts, one table, in that order: what the period made,
 * how it moved, where it came from and where it went, and finally which
 * channels are carrying it. The brief was explicit that this page must not
 * become a second dashboard, so anything that is a *record* rather than a
 * *reading* — the ledger itself, categories, rates — lives on the sibling tabs.
 *
 * WHAT THIS SCREEN REFUSES TO DO
 * It never fills a gap with a number. A period with no revenue has no margin,
 * so the margin tile shows an em dash rather than 0% — "we broke even" and "we
 * earned nothing" are opposite findings and 0% says the wrong one. When the
 * server reports `truncated`, the breakdowns below the headline are built from
 * the newest slice of the period rather than all of it, and the page says so in
 * plain words instead of presenting them as the period's result.
 */
export default function FinancePage() {
  const { data, isLoading, isFetching, error, refetch } = useFinanceOverview();

  if (error) {
    return (
      <PageContainer className="flex flex-col gap-5">
        <PageHeader title="Finance" description={PAGE_DESCRIPTION} />
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader title="Finance" description={PAGE_DESCRIPTION} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <PeriodSelector />
        {data ? (
          <span className="text-[11px] text-subtle-foreground">
            {formatDate(data.range.startMs)} {EM_DASH}{" "}
            {/* The stored end bound is exclusive midnight, so the last day the
                window actually includes is the millisecond before it. */}
            {formatDate(data.range.endMs - 1)} · all figures in {data.baseCurrency}
            {isFetching ? " · updating…" : ""}
          </span>
        ) : null}
      </div>

      {isLoading || !data ? (
        <OverviewSkeleton />
      ) : isPeriodEmpty(data.summary) ? (
        <Card>
          <EmptyState
            icon={<Wallet />}
            title="No finance entries in this period"
            description={
              <>
                This page reads one ledger. Add what the studio{" "}
                <strong className="text-foreground">earned</strong> — AdSense payouts,
                sponsorships, affiliate income — and what it{" "}
                <strong className="text-foreground">spent</strong> — editors, thumbnails,
                software, ads — and the totals, trends and per-channel profit below fill
                themselves in. Entries dated outside{" "}
                {formatDate(data.range.startMs)} {EM_DASH}{" "}
                {formatDate(data.range.endMs - 1)} are not counted here, so a wider period
                may already have something to show.
              </>
            }
            action={
              <IfPermitted
                to="finance.manage"
                fallback={
                  <Button variant="secondary" asChild>
                    <Link href="/finance/entries">Open entries</Link>
                  </Button>
                }
              >
                <Button variant="primary" asChild>
                  <Link href="/finance/entries">Add the first entry</Link>
                </Button>
              </IfPermitted>
            }
          />
        </Card>
      ) : (
        <>
          <KpiRow
            revenueMinor={data.summary.revenueMinor}
            expenseMinor={data.summary.expenseMinor}
            netMinor={data.summary.netMinor}
            margin={data.summary.margin}
            currency={data.baseCurrency}
            estimatedRevenueMinor={data.estimated.revenueMinor}
          />

          {data.estimated.revenueMinor > 0 ? (
            <EstimateNotice
              estimatedRevenueMinor={data.estimated.revenueMinor}
              revenueMinor={data.summary.revenueMinor}
              entryCount={data.estimated.entryCount}
              currency={data.baseCurrency}
            />
          ) : null}

          {data.truncated ? <TruncationNotice /> : null}

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Revenue vs expenses</CardTitle>
                <CardDescription>
                  Money in against money out, by {data.granularity}. The gap between each
                  pair is that {data.granularity}&rsquo;s profit.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RevenueExpenseChart
                  points={data.series}
                  currency={data.baseCurrency}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Net profit over time</CardTitle>
                <CardDescription>
                  Revenue minus expenses per {data.granularity}. Anything below the zero
                  line is a {data.granularity} that lost money.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <NetProfitChart points={data.series} currency={data.baseCurrency} />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.6fr_minmax(260px,1fr)]">
            <Card>
              <CardHeader>
                <CardTitle>Revenue by channel</CardTitle>
                <CardDescription>
                  Which channels brought the money in. Income not attributed to one channel
                  is grouped as company-wide rather than shared out.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RevenueByChannelChart
                  slices={data.summary.revenueByChannel}
                  currency={data.baseCurrency}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Expense breakdown</CardTitle>
                <CardDescription>What the studio spent on, by category.</CardDescription>
              </CardHeader>
              <CardContent>
                <ExpenseBreakdownDonut
                  slices={data.summary.expenseByCategory}
                  currency={data.baseCurrency}
                  totalMinor={sumSlices(data.summary.expenseByCategory)}
                />
              </CardContent>
            </Card>
          </div>

          <ChannelProfitTable rows={data.byChannel} currency={data.baseCurrency} />
        </>
      )}
    </PageContainer>
  );
}

const PAGE_DESCRIPTION =
  "What the studio earned, what it spent, and which channels are carrying the rest. Every figure is converted to the organisation's base currency at the rate in force on the day it was booked.";

/**
 * True only when the period really is empty.
 *
 * `entryCount` counts the entries in the payload, while the two totals come
 * from a database aggregate over the whole period — they cannot disagree today,
 * because a period with entries always yields a non-empty page. Requiring all
 * three anyway means that if they ever *did* diverge, the failure is a screen
 * showing real money with sparse breakdowns rather than a screen confidently
 * announcing there is nothing here.
 */
function isPeriodEmpty(summary: {
  entryCount: number;
  revenueMinor: number;
  expenseMinor: number;
}): boolean {
  return (
    summary.entryCount === 0 && summary.revenueMinor === 0 && summary.expenseMinor === 0
  );
}

function sumSlices(slices: readonly { amountMinor: number }[]): number {
  // Integer minor units, so this addition is exact.
  let total = 0;
  for (const slice of slices) total += slice.amountMinor;
  return total;
}

/** Sign-driven colour. The one place directional colour carries real meaning. */
function netToneClass(minor: number): string {
  if (minor > 0) return "text-success";
  if (minor < 0) return "text-danger";
  return "text-foreground";
}

// ---------------------------------------------------------------------------
// HEADLINE FIGURES
// ---------------------------------------------------------------------------

/**
 * The four numbers the page exists to deliver.
 *
 * These come from a grouped database aggregate over the whole period, not from
 * the entries embedded in the payload — so they stay exact even when the
 * breakdowns underneath are capped. That distinction is the entire reason the
 * truncation notice below is worded the way it is.
 */
function KpiRow({
  revenueMinor,
  expenseMinor,
  netMinor,
  margin,
  currency,
  estimatedRevenueMinor,
}: {
  revenueMinor: number;
  expenseMinor: number;
  netMinor: number;
  margin: number | null;
  currency: string;
  /** A share of `revenueMinor`, never an addition to it. */
  estimatedRevenueMinor: number;
}) {
  const hasEstimate = estimatedRevenueMinor > 0;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Card className="p-4">
        <Stat
          label="Revenue"
          value={formatMoney(revenueMinor, currency)}
          /*
           * The caveat is attached to the tile, not only to the note below it.
           * A KPI tile is the part of this page that gets screenshotted into a
           * deck, and a figure that travels without the sentence qualifying it
           * is how an estimate becomes a commitment in somebody else's meeting.
           */
          caption={
            hasEstimate
              ? `Money in · ${formatMoney(estimatedRevenueMinor, currency)} of it estimated`
              : "Money in"
          }
          hint={
            hasEstimate ? (
              <InfoTip>
                Part of this total is imported from YouTube, which reports estimates and
                revises them at month end. It is counted here in full because it is the
                best figure available — but it has not settled, so it should not be read as
                cash in the bank.
              </InfoTip>
            ) : undefined
          }
        />
      </Card>

      <Card className="p-4">
        <Stat
          label="Expenses"
          value={formatMoney(expenseMinor, currency)}
          caption="Money out"
        />
      </Card>

      <Card className="p-4">
        <Stat
          label="Net profit"
          // The tone lives on an inner span so it wins over `Stat`'s own
          // foreground colour without `Stat` needing to know about signs.
          value={
            <span className={netToneClass(netMinor)}>
              {formatMoney(netMinor, currency, { signDisplay: "always" })}
            </span>
          }
          caption="Revenue minus expenses"
        />
      </Card>

      <Card className="p-4">
        <Stat
          label="Margin"
          // `profitMargin` returns null for zero revenue and this renders the
          // em dash it asks for. Never 0% — see the note at the top of the file.
          value={margin === null ? EM_DASH : formatPercent(margin, 1)}
          hint={
            <InfoTip>
              Net profit as a share of revenue. A period with no revenue has no margin to
              take a share of, so it shows a dash rather than 0% — spending money and
              earning none is not breaking even.
            </InfoTip>
          }
          caption={margin === null ? "No revenue in this period" : "Net as a share of revenue"}
        />
      </Card>
    </div>
  );
}

/**
 * The server capped the entries it sent, so everything derived from them is a
 * partial view. Said out loud, in the same place as the figures it qualifies.
 *
 * Deliberately not a dismissible toast: the qualification applies for as long
 * as the charts are on screen, and a warning the reader can make disappear is a
 * warning that will be missing the next time someone screenshots this page for
 * a board deck.
 */
function TruncationNotice() {
  return (
    <Card className="flex items-start gap-3 border-warning/25 bg-warning-subtle p-4">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 text-[12px] leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground">
          The breakdowns below cover only the most recent entries in this period.
        </p>
        <p className="mt-1">
          This period holds more entries than one response carries. The four totals above
          are still exact — they are computed over the whole period in the database — but
          the charts and the per-channel table are built from the entries that fit, so
          they understate every line they show. Narrow the period to bring them back into
          agreement.
        </p>
      </div>
    </Card>
  );
}

/**
 * Part of the revenue above has not settled, and every figure derived from it
 * inherits that.
 *
 * The four tiles cannot each carry this without turning into a paragraph, and
 * the one that matters most is not the revenue tile at all — it is net profit,
 * which is the number somebody makes a decision on. Saying it once, directly
 * under the row, qualifies all four at the point they are read.
 *
 * Rendered only when there is an estimate in the period. A permanent "some of
 * this may be estimated" would be noise on the majority of periods and would
 * teach people to look past exactly the sentence that matters on the periods
 * where it is true. Nothing on screen means nothing estimated — a claim this
 * page can make, because the figure comes from the same exact aggregate as the
 * totals rather than from the capped entry list.
 *
 * Not dismissible, for the same reason the truncation notice is not: the
 * qualification holds for as long as the figures are on screen.
 */
function EstimateNotice({
  estimatedRevenueMinor,
  revenueMinor,
  entryCount,
  currency,
}: {
  estimatedRevenueMinor: number;
  revenueMinor: number;
  entryCount: number;
  currency: string;
}) {
  // Guarded rather than assumed: a share of nothing is not 100%, and this note
  // must not be the one place on the page that invents a number.
  const share = revenueMinor > 0 ? (estimatedRevenueMinor / revenueMinor) * 100 : null;

  return (
    <Card className="flex items-start gap-3 border-warning/25 bg-warning-subtle p-4">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 text-[12px] leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground">
          <span className="tnum">{formatMoney(estimatedRevenueMinor, currency)}</span> of this
          period&rsquo;s revenue is an estimate, not settled cash
          {share === null ? "" : <> &mdash; {formatPercent(share, 1)} of the total</>}.
        </p>
        <p className="mt-1">
          It comes from {formatNumber(entryCount)}{" "}
          {entryCount === 1 ? "entry" : "entries"} imported automatically from YouTube, which
          reports estimated earnings and revises them at month end — sometimes weeks later.
          The figure is included in revenue, net profit and margin above because it is the
          best number available, but those three move when YouTube adjusts it.{" "}
          {/* No `?kind=revenue`: the ledger's filters are component state, not
              URL parameters, and a query string it ignores would be a link that
              quietly does not do what it says. */}
          <Link href="/finance/entries" className="text-accent underline-offset-4 hover:underline">
            See which entries
          </Link>{" "}
          — imported rows are chipped &ldquo;YouTube&rdquo; and marked &ldquo;Est&rdquo;.
        </p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// PER-CHANNEL PROFIT
// ---------------------------------------------------------------------------

/**
 * Profit per channel — the table the owner asked for by name.
 *
 * Rows arrive sorted by net profit descending from `financeByChannel`, which is
 * the order that answers "which channels are carrying us?", so this does not
 * re-sort them. Channels with no entries keep their row: "this channel earned
 * nothing and cost nothing" is a finding, and a channel quietly missing from
 * the table reads as an oversight instead.
 *
 * The totals row sums the rows shown and nothing else. Company-wide entries —
 * anything not attributed to a single channel — are not distributed across
 * channels, because splitting shared costs needs an allocation rule nobody has
 * agreed on, and inventing one would put an indefensible number in front of a
 * decision. That is why this total can come in under the headline net above,
 * and why the footnote says so rather than leaving the reader to find the gap.
 */
function ChannelProfitTable({
  rows,
  currency,
}: {
  rows: readonly FinanceChannelRow[];
  currency: string;
}) {
  const totals = React.useMemo(() => {
    let revenueMinor = 0;
    let expenseMinor = 0;
    let entryCount = 0;
    for (const row of rows) {
      revenueMinor += row.revenueMinor;
      expenseMinor += row.expenseMinor;
      entryCount += row.entryCount;
    }
    return {
      revenueMinor,
      expenseMinor,
      netMinor: revenueMinor - expenseMinor,
      // The same helper every other margin on this page goes through, so the
      // zero-revenue case cannot be handled differently here by accident.
      margin: profitMargin(revenueMinor, expenseMinor),
      entryCount,
    };
  }, [rows]);

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>Profit by channel</CardTitle>
        <CardDescription>
          Every tracked channel, most profitable first. Channel names come from the
          tracker, so they match the rest of the app.
        </CardDescription>
      </CardHeader>

      {rows.length === 0 ? (
        <div className="px-5 pb-5">
          <div className="flex items-center justify-center rounded-lg border border-dashed border-border px-4 py-10 text-center text-[13px] text-subtle-foreground">
            No channels are being tracked yet, so there is nothing to attribute money to.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[620px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-sunken">
                <th className="px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                  Channel
                </th>
                <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                  Revenue
                </th>
                <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                  Expenses
                </th>
                <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-accent">
                  Net profit
                </th>
                <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                  Margin
                </th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.channelId}
                  className="border-b border-border transition-colors last:border-b-0 hover:bg-surface-hover/40"
                >
                  <td className="max-w-[280px] px-4 py-2.5">
                    <span className="block truncate text-[12px] text-foreground">
                      {row.channelName}
                    </span>
                    <span className="tnum block text-[10px] text-subtle-foreground">
                      {row.entryCount === 0
                        ? "No entries"
                        : `${formatNumber(row.entryCount)} ${row.entryCount === 1 ? "entry" : "entries"}`}
                    </span>
                  </td>
                  <td className="tnum px-4 py-2.5 text-right text-[12px] text-muted-foreground">
                    {formatMoney(row.revenueMinor, currency)}
                  </td>
                  <td className="tnum px-4 py-2.5 text-right text-[12px] text-muted-foreground">
                    {formatMoney(row.expenseMinor, currency)}
                  </td>
                  <td
                    className={cn(
                      "tnum px-4 py-2.5 text-right text-[13px] font-medium",
                      netToneClass(row.netMinor),
                    )}
                  >
                    {formatMoney(row.netMinor, currency, { signDisplay: "always" })}
                  </td>
                  <td className="tnum px-4 py-2.5 text-right text-[12px] text-muted-foreground">
                    {/* Null, not zero: a channel that earned nothing has no
                        margin, however much it cost. */}
                    {row.margin === null ? EM_DASH : formatPercent(row.margin, 1)}
                  </td>
                </tr>
              ))}
            </tbody>

            <tfoot>
              <tr className="border-t border-border-strong bg-surface-sunken">
                <td className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-subtle-foreground">
                  Total
                </td>
                <td className="tnum px-4 py-2.5 text-right text-[12px] font-medium text-foreground">
                  {formatMoney(totals.revenueMinor, currency)}
                </td>
                <td className="tnum px-4 py-2.5 text-right text-[12px] font-medium text-foreground">
                  {formatMoney(totals.expenseMinor, currency)}
                </td>
                <td
                  className={cn(
                    "tnum px-4 py-2.5 text-right text-[13px] font-semibold",
                    netToneClass(totals.netMinor),
                  )}
                >
                  {formatMoney(totals.netMinor, currency, { signDisplay: "always" })}
                </td>
                <td className="tnum px-4 py-2.5 text-right text-[12px] font-medium text-foreground">
                  {totals.margin === null ? EM_DASH : formatPercent(totals.margin, 1)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-subtle-foreground">
        This total covers channel-attributed money only. Company-wide revenue and costs —
        entries filed against no single channel — are left out rather than shared across
        the rows, so it can come in under the headline figures above. A dash in the margin
        column means the channel earned nothing in this period, which is not the same as a
        margin of zero.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// LOADING
// ---------------------------------------------------------------------------

/** Mirrors the real layout so nothing jumps when the payload lands. */
function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i} className="p-4">
            <StatSkeleton />
          </Card>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-[320px] w-full rounded-lg" />
        <Skeleton className="h-[320px] w-full rounded-lg" />
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.6fr_minmax(260px,1fr)]">
        <Skeleton className="h-[300px] w-full rounded-lg" />
        <Skeleton className="h-[300px] w-full rounded-lg" />
      </div>
      <Skeleton className="h-[260px] w-full rounded-lg" />
    </div>
  );
}
