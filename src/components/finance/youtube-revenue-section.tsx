"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Link2Off, PlugZap, Youtube } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { YouTubeRevenueReport } from "@/server/services/youtube-revenue-report";
import { formatMoney } from "@/lib/finance/money";
import { EM_DASH, formatDateTime, formatNumber, formatRelativeTime } from "@/lib/format";

/**
 * =========================================================================
 * WHAT YOUTUBE ACTUALLY REPORTED, AND WHAT NOBODY IS READING
 * =========================================================================
 *
 * Two things the owner asked for, and they belong in one place because either
 * one alone is misleading.
 *
 * "Revenue by channel and month under Finance, clearly marked as YouTube's
 * ESTIMATE and distinguishable from a typed figure" — the table below. Every row
 * carries "Est", the figures are in YouTube's own reporting currency rather than
 * the ledger's base, and the header says out loud that these are not the
 * converted numbers in the totals above. That is the distinguishing act: a typed
 * figure is settled money in the org's currency, and these are neither.
 *
 * "The Finance overview should show what is connected and what is not — a
 * revenue figure that silently omits an unconnected channel is worse than no
 * figure" — the coverage panel, which lists EVERY own channel including the ones
 * with no connection at all. That is why it is above the table rather than a
 * footnote under it: the qualification has to be read before the number, not
 * after.
 *
 * WHAT THE COVERAGE PANEL REFUSES TO DO
 * It never writes 0 against an unconnected channel. "We could not ask" and "the
 * answer was nothing" are different sentences, and the whole revenue subsystem
 * is built on not confusing them — see the header of
 * `youtube-revenue-service.ts`. An unconnected channel gets an em dash and a
 * reason.
 */

export function YouTubeRevenueSection({
  report,
}: {
  report: YouTubeRevenueReport;
}) {
  const hasMoney = report.months.length > 0;
  const hasOwnChannels = report.channels.length > 0;

  /*
   * Nothing to say at all, and that is a real state rather than an oversight: a
   * workspace tracking only competitors has no YouTube revenue to import and
   * never will. Rendering an empty "connect your channels" card on a Finance
   * page for a team doing pure competitor research would be advice about a
   * feature that does not apply to them. The channels screen and the dashboard
   * carry the connect prompt; this section is about money that exists.
   */
  if (!hasOwnChannels && !hasMoney) return null;

  return (
    <div className="flex flex-col gap-4">
      <CoveragePanel report={report} />
      {hasMoney ? <MonthTable report={report} /> : <NoFiguresYet report={report} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// COVERAGE
// ---------------------------------------------------------------------------

/**
 * Which own channels have something reading their revenue, and which do not.
 *
 * Rendered whether or not anything is wrong. A panel that appears only on
 * failure leaves "every channel is covered" and "nobody has checked" looking
 * identical — the same reasoning that made the admin screen's revenue notice
 * speak in the healthy state too.
 */
function CoveragePanel({ report }: { report: YouTubeRevenueReport }) {
  const uncovered = report.uncoveredChannelCount;
  const total = report.channels.length;

  if (total === 0) {
    // Money in the table with no own channel to attribute it to: the channel was
    // removed from the tracker after its revenue was imported. The figures are
    // still real and still in the ledger, so they are shown — but the coverage
    // question has no subject.
    return null;
  }

  const tone = uncovered > 0 ? "warning" : "ok";

  return (
    <Card
      className={
        tone === "warning"
          ? "border-warning/25 bg-warning-subtle p-4"
          : "border-border p-4"
      }
    >
      <div className="flex items-start gap-3">
        {uncovered > 0 ? (
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
        ) : (
          <Youtube className="mt-0.5 size-4 shrink-0 text-subtle-foreground" />
        )}

        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">
            {uncovered === 0
              ? total === 1
                ? "YouTube revenue is being read for your channel"
                : `YouTube revenue is being read for all ${total} of your channels`
              : `${uncovered} of your ${total} channel${total === 1 ? "" : "s"} ${uncovered === 1 ? "is" : "are"} not reporting revenue`}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            {uncovered === 0
              ? "Every channel you own has a working connection with permission to read its earnings, so the revenue below is the whole of what YouTube reports for this period."
              : "Their earnings are missing from every revenue figure on this page — not counted as zero, simply absent. Connect or reconnect the accounts that own them to include their money in these totals."}
          </p>

          <ul className="mt-3 flex flex-col divide-y divide-border border-t border-border">
            {report.channels.map((channel) => (
              <ChannelCoverageRow key={channel.channelId} channel={channel} />
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

/**
 * One own channel's revenue coverage, in the connection's own vocabulary.
 *
 * The six `revenueSyncStatus` values are NOT collapsed into "working / broken".
 * "YouTube refused a report", "YouTube answered with zeros" and "we were never
 * given permission to ask" are three different situations with three different
 * next steps, and the whole revenue subsystem exists to keep them apart — see
 * the four-way distinction at the top of `youtube-revenue-service.ts`. Flattening
 * them on the one screen where the money is read would undo that.
 */
function ChannelCoverageRow({
  channel,
}: {
  channel: YouTubeRevenueReport["channels"][number];
}) {
  const status = coverageStatus(channel);

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
        {channel.channelName}
      </span>

      <Badge variant={status.badge} size="sm" className="shrink-0 tracking-wider">
        {status.label}
      </Badge>

      <span className="text-[11px] text-subtle-foreground">
        {channel.lastRevenueSyncAt === null ? (
          // Not "never": a channel nobody can ask and a channel that was asked
          // and answered nothing are different facts, and the badge beside this
          // already says which.
          <span title={status.detail}>Not read yet</span>
        ) : (
          <span title={formatDateTime(channel.lastRevenueSyncAt)}>
            Read {formatRelativeTime(channel.lastRevenueSyncAt)}
          </span>
        )}
      </span>
    </li>
  );
}

interface CoverageStatus {
  readonly label: string;
  readonly badge: "hit" | "near" | "danger" | "neutral";
  readonly detail: string;
}

function coverageStatus(
  channel: YouTubeRevenueReport["channels"][number],
): CoverageStatus {
  if (channel.connectionStatus === "none") {
    return {
      label: "Not connected",
      badge: "near",
      detail:
        "No Google account has been connected for this channel, so nothing can read its earnings. " +
        "Its revenue is absent from the figures on this page — not zero.",
    };
  }

  if (channel.connectionStatus !== "connected") {
    return {
      label: "Reconnect needed",
      badge: "danger",
      detail:
        "This channel's Google authorisation has stopped working, so its revenue is no longer " +
        "being updated. Reconnect the account under Admin → YouTube.",
    };
  }

  if (!channel.revenueScopeGranted) {
    return {
      label: "No revenue permission",
      badge: "near",
      detail:
        "The account is connected but was never granted the separate YouTube Analytics permission " +
        "that revenue needs. Reconnect and leave every permission ticked.",
    };
  }

  switch (channel.revenueSyncStatus) {
    case "ok":
      return {
        label: "Reporting",
        badge: "hit",
        detail: "YouTube is reporting earnings for this channel and they are included below.",
      };
    case "reported_zero":
      return {
        label: "Reported nothing",
        badge: "neutral",
        detail:
          "YouTube was asked and answered with zeros for every day in the window. That is an " +
          "observation, not a verdict — a channel outside the Partner Programme reports this, and " +
          "so does one earning fractions of a cent a day.",
      };
    case "not_monetized":
      return {
        label: "Report refused",
        badge: "neutral",
        detail:
          "YouTube refused to produce a revenue report for this channel even though the connection " +
          "has permission to read one. It answers the same way for a channel outside the Partner " +
          "Programme and for a channel this account no longer owns, and does not say which.",
      };
    case "error":
      return {
        label: "Last read failed",
        badge: "danger",
        detail:
          "The last attempt to read this channel's revenue failed. Admin → YouTube carries the " +
          "reason and the next step.",
      };
    default:
      return {
        label: "Not read yet",
        badge: "neutral",
        detail:
          "The permission is in place and the first read has not happened yet. The scheduler will " +
          "pick it up, or it can be run now from Admin → YouTube.",
      };
  }
}

// ---------------------------------------------------------------------------
// THE MONEY
// ---------------------------------------------------------------------------

/** `2026-08` -> `August 2026`, in the reader's locale. */
function formatMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) return month;
  // Day 1 at UTC noon, so a negative timezone offset cannot roll the date back
  // into the previous month and rename it.
  return new Date(Date.UTC(year, monthNumber - 1, 1, 12)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function MonthTable({ report }: { report: YouTubeRevenueReport }) {
  /**
   * Grouped by month for rendering, preserving the server's order.
   *
   * The server sorted newest month first and largest earner within it, so this
   * walks the array and starts a group whenever the month changes rather than
   * re-sorting — one ordering decision, made once, on the side that has all the
   * rows.
   */
  const groups = React.useMemo(() => {
    const out: { month: string; rows: YouTubeRevenueReport["months"][number][] }[] = [];
    for (const row of report.months) {
      const last = out[out.length - 1];
      if (last && last.month === row.month) last.rows.push(row);
      else out.push({ month: row.month, rows: [row] });
    }
    return out;
  }, [report.months]);

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Youtube className="size-4 text-subtle-foreground" />
          YouTube revenue by channel and month
        </CardTitle>
        <CardDescription>
          What YouTube reported, in the currency it reported it in, straight from the daily figures
          rather than from the ledger. These are{" "}
          <strong className="text-foreground">estimates</strong> and YouTube revises them, usually
          at month end. The converted, ledger-side version of these amounts is what feeds the totals
          at the top of this page &mdash; see{" "}
          <Link href="/finance/entries" className="text-accent underline-offset-2 hover:underline">
            Entries
          </Link>
          .
        </CardDescription>
      </CardHeader>

      <div className="overflow-x-auto border-t border-border">
        <table className="w-full min-w-[560px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th className="px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                Channel
              </th>
              <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                Days reported
              </th>
              <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                Revised
              </th>
              <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-accent">
                Estimated revenue
              </th>
            </tr>
          </thead>

          {groups.map((group) => (
            <tbody key={group.month}>
              <tr className="border-b border-border bg-surface-sunken/50">
                <td
                  colSpan={4}
                  className="px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                >
                  {formatMonth(group.month)}
                </td>
              </tr>

              {group.rows.map((row) => (
                <tr
                  key={`${row.channelId}:${row.currency}`}
                  className="border-b border-border transition-colors hover:bg-surface-hover/40"
                >
                  <td className="max-w-[280px] px-4 py-2.5">
                    <span className="block truncate text-[12px] text-foreground">
                      {row.channelName}
                    </span>
                  </td>
                  <td className="tnum px-4 py-2.5 text-right text-[12px] text-muted-foreground">
                    {formatNumber(row.dayCount)}
                  </td>
                  <td className="tnum px-4 py-2.5 text-right text-[12px] text-muted-foreground">
                    {row.revisedDayCount === 0 ? (
                      EM_DASH
                    ) : (
                      <span
                        title={`YouTube has changed its figure for ${row.revisedDayCount} of these days since it was first read. Revisions are normal and are kept rather than overwritten silently.`}
                      >
                        {formatNumber(row.revisedDayCount)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="tnum text-[13px] font-medium text-foreground">
                        {formatMoney(row.amountMinor, row.currency)}
                      </span>
                      {/* On every single row, not once in the header. A row is
                          what gets read, quoted and screenshotted, and a caveat
                          that lives only above the table travels nowhere with
                          it. */}
                      <Badge variant="neutral" size="sm" className="shrink-0 tracking-wider">
                        Est
                      </Badge>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>

      <p className="border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-subtle-foreground">
        Amounts are in the currency YouTube reported them in and are deliberately not converted
        here, so they can be checked against YouTube Studio directly. &ldquo;Days reported&rdquo; is
        how many days of the month YouTube has given a figure for &mdash; fewer than the month has
        is normal for the current month and for the last few days of any month, which YouTube has
        not finished computing.
      </p>
    </Card>
  );
}

/**
 * Own channels exist, but no revenue has landed in this period.
 *
 * Deliberately not an empty table, and deliberately not the word "zero". The
 * coverage panel above has already said which channels can be read; this says
 * only that the window holds nothing, which is a statement about the window.
 */
function NoFiguresYet({ report }: { report: YouTubeRevenueReport }) {
  return (
    <Card className="flex items-start gap-3 p-4">
      {report.configured ? (
        <PlugZap className="mt-0.5 size-4 shrink-0 text-subtle-foreground" />
      ) : (
        <Link2Off className="mt-0.5 size-4 shrink-0 text-subtle-foreground" />
      )}
      <div className="min-w-0 text-[12px] leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground">
          No YouTube revenue has been recorded in this period
        </p>
        <p className="mt-1">
          {report.configured
            ? report.uncoveredChannelCount > 0
              ? "Some of your channels have nothing reading their earnings — see above. For the rest, either YouTube has not reported anything for these dates yet, or the period predates the connection."
              : "Your channels are connected and being read; YouTube simply has not reported earnings for these dates. Figures for the current month usually appear a few days in arrears, and a wider period may already have something to show."
            : "Google sign-in is not configured on this deployment, so no channel's earnings can be imported at all. Admin → YouTube names the variables to set."}
        </p>
      </div>
    </Card>
  );
}

/**
 * The qualification that belongs beside the TOTAL, not beside the breakdown.
 *
 * The owner's sentence was "a revenue figure that silently omits an unconnected
 * channel is worse than no figure", and the operative word is *silently*. The
 * coverage panel further down names each channel, but it sits below four charts
 * and a table — and the number somebody actually acts on is net profit, at the
 * very top. A caveat six cards below the figure it qualifies is a caveat nobody
 * reads in time, so this states it once, directly under the KPI row, in the same
 * shape as the estimate and truncation notices already there.
 *
 * Null when every own channel is covered. A permanent "some channels may be
 * missing" would be noise on the majority of periods and would teach people to
 * look straight past the one sentence that matters on the periods where it is
 * true — the same reasoning as `EstimateNotice`. Nothing on screen means nothing
 * is being left out, and this page is entitled to make that claim because the
 * count comes from the same read as the figures.
 *
 * Not dismissible, for the reason none of the notices on this page are: the
 * qualification holds for as long as the figures are on screen.
 */
export function YouTubeCoverageCaveat({ report }: { report: YouTubeRevenueReport }) {
  if (report.uncoveredChannelCount === 0) return null;

  const many = report.uncoveredChannelCount !== 1;

  return (
    <Card className="flex items-start gap-3 border-warning/25 bg-warning-subtle p-4">
      <Link2Off className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 text-[12px] leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground">
          {many
            ? `${report.uncoveredChannelCount} of your channels are not reporting revenue, so this period's income is incomplete`
            : "One of your channels is not reporting revenue, so this period's income is incomplete"}
        </p>
        <p className="mt-1">
          {many ? "Their" : "Its"} YouTube earnings are missing from revenue, net profit and margin
          above &mdash; <strong className="text-foreground">absent, not counted as zero</strong>,
          because nothing has been able to ask YouTube what {many ? "they" : "it"} earned. The
          YouTube section at the bottom of this page names {many ? "them" : "it"} and says what each
          one needs; connecting or reconnecting{" "}
          <Link href="/admin/youtube" className="text-accent underline-offset-2 hover:underline">
            under Admin &rarr; YouTube
          </Link>{" "}
          brings {many ? "their" : "its"} money into these figures.
        </p>
      </div>
    </Card>
  );
}
