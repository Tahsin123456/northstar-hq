/**
 * =========================================================================
 * ROLLING DAILY YOUTUBE REVENUE UP INTO MONTHS AND HEADLINE FIGURES
 * =========================================================================
 *
 * Pure arithmetic over rows that have already been read, deliberately kept out
 * of the service that reads them. Two reasons, and the second is the one that
 * matters.
 *
 * The first is testability: these are the calculations a reader acts on, and
 * they are testable here without a database.
 *
 * The second is that the two bugs this module exists to fix were both bugs of
 * ARITHMETIC MEETING PRESENTATION, which is exactly the seam that hides inside a
 * function that also does I/O:
 *
 *   • A month the selected window only partly covers was grouped and rendered as
 *     a whole-month row carrying a clipped total. On the default 30-day window
 *     that misstates the previous month on every single load — and the footnote
 *     under the table blamed YouTube for not having finished computing, which is
 *     the wrong explanation and flatly untrue for a month that ended weeks ago.
 *     `clippedByPeriod` below is that fact, carried on the row, so the table can
 *     say which months it is only showing part of.
 *
 *   • "Total / this month / previous month" did not exist anywhere. The only
 *     period control is 7/30/90/180 days plus a custom range, so those three
 *     figures could only be reached by hand-picking calendar dates — and none of
 *     them is what a trailing 30-day window shows. They are computed here from
 *     the daily rows, independently of whatever period the page is on, because
 *     "this month" that changes when somebody moves a date picker is not this
 *     month.
 *
 * EVERYTHING IS UTC. `ChannelRevenueDay.day` is a UTC date and the ledger rollup
 * groups on the UTC month, so a local-time month boundary here would put a day's
 * revenue in a different month from the ledger entry built out of the same row.
 *
 * MONEY IS INTEGER MINOR UNITS throughout, and currencies are never mixed: every
 * figure is a list of per-currency amounts, so a workspace whose channels report
 * in two currencies gets two amounts rather than one invented sum.
 */

/** One stored day of revenue, as the rollup needs to see it. */
export interface RevenueDayInput {
  readonly channelId: string;
  /** The channel's display name, resolved by the caller. */
  readonly channelName: string;
  /** UTC midnight of the day the revenue belongs to. */
  readonly dayMs: number;
  readonly amountMinor: number;
  readonly currency: string;
  /** How many times YouTube has revised this day since it was first read. */
  readonly revisionCount: number;
}

export interface RevenueMonthBucket {
  readonly channelId: string;
  readonly channelName: string;
  /** `YYYY-MM`, UTC — the same key the ledger rollup groups on. */
  readonly month: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** Days of the month with a stored figure. Not the length of the month. */
  readonly dayCount: number;
  readonly revisedDayCount: number;
  /**
   * True when the selected period does not cover the whole calendar month, so
   * this row is a PART of that month and not the month.
   *
   * The distinction the reader needs and the table could not previously make:
   * a low day count on a clipped month means the window stops early, while a
   * low day count on a month the window covers whole means YouTube has not
   * reported those days. Same number, opposite meanings, and only one of them
   * is a reason to widen the period.
   */
  readonly clippedByPeriod: boolean;
}

/** A figure in one currency. Never summed across currencies. */
export interface CurrencyTotal {
  readonly currency: string;
  readonly amountMinor: number;
}

export interface RevenueHeadline {
  /** Every day ever stored, per currency. */
  readonly total: readonly CurrencyTotal[];
  readonly thisMonth: readonly CurrencyTotal[];
  readonly previousMonth: readonly CurrencyTotal[];
  /** `YYYY-MM` of each, so the screen can label them rather than assume. */
  readonly thisMonthKey: string;
  readonly previousMonthKey: string;
}

/** `YYYY-MM` for a UTC instant. */
export function monthKeyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** The half-open `[start, end)` UTC bounds of a `YYYY-MM` key. */
export function monthWindow(month: string): { startMs: number; endMs: number } {
  const [year, monthNumber] = month.split("-").map(Number);
  return {
    startMs: Date.UTC(year, monthNumber - 1, 1),
    // Month 12 rolls into January of the next year on its own: Date.UTC
    // normalises an out-of-range month rather than failing.
    endMs: Date.UTC(year, monthNumber, 1),
  };
}

/**
 * True when `[startMs, endMs)` does not contain the whole of `month`.
 *
 * Includes the current month, which every trailing window clips by definition —
 * and saying so is correct: a row covering the first nine days of a month is a
 * partial row whether the rest of the month has not happened yet or is simply
 * outside the window.
 */
export function isMonthClipped(
  month: string,
  range: { startMs: number; endMs: number },
): boolean {
  const bounds = monthWindow(month);
  return range.startMs > bounds.startMs || range.endMs < bounds.endMs;
}

/**
 * Group days into (channel, month, currency) rows, newest month first.
 *
 * Currency is part of the key rather than an assumption. Two currencies in one
 * channel-month is rare and pathological, and the honest rendering is two rows —
 * not a sum of unlike things, and not a silently dropped row.
 */
export function buildMonthRows(
  days: readonly RevenueDayInput[],
  range: { startMs: number; endMs: number },
): RevenueMonthBucket[] {
  interface Mutable {
    channelId: string;
    channelName: string;
    month: string;
    currency: string;
    amountMinor: number;
    dayCount: number;
    revisedDayCount: number;
  }

  const buckets = new Map<string, Mutable>();

  for (const row of days) {
    const month = monthKeyOf(row.dayMs);
    const key = `${row.channelId}:${month}:${row.currency}`;
    const existing = buckets.get(key);

    if (existing) {
      // Integer minor units, so this addition is exact.
      existing.amountMinor += row.amountMinor;
      existing.dayCount += 1;
      if (row.revisionCount > 0) existing.revisedDayCount += 1;
      continue;
    }

    buckets.set(key, {
      channelId: row.channelId,
      channelName: row.channelName,
      month,
      currency: row.currency,
      amountMinor: row.amountMinor,
      dayCount: 1,
      revisedDayCount: row.revisionCount > 0 ? 1 : 0,
    });
  }

  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, clippedByPeriod: isMonthClipped(bucket.month, range) }))
    .sort(
      (a, b) =>
        // Newest month first: the current month is the one anybody opens this to
        // look at. Then largest earner, then name, so the order is total rather
        // than "whatever the map happened to hold".
        b.month.localeCompare(a.month) ||
        b.amountMinor - a.amountMinor ||
        a.channelName.localeCompare(b.channelName),
    );
}

function totalsByCurrency(days: readonly RevenueDayInput[]): CurrencyTotal[] {
  const byCurrency = new Map<string, number>();
  for (const row of days) {
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.amountMinor);
  }
  return [...byCurrency.entries()]
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    // Largest first, so the figure somebody reads first is the one that matters
    // most in a mixed-currency workspace.
    .sort((a, b) => b.amountMinor - a.amountMinor || a.currency.localeCompare(b.currency));
}

/**
 * The three named figures the owner asked for, from every day ever stored.
 *
 * NOT filtered by the page's period, on purpose. "This month" is a calendar
 * fact; a version of it that moved when somebody switched from 30 days to 90
 * would be a different quantity wearing the same label.
 *
 * An empty list means no day in that month has a figure — which the screen must
 * render as "nothing reported", never as a zero. Those are different claims and
 * this whole subsystem is built on not confusing them.
 */
export function summariseRevenueTotals(
  days: readonly RevenueDayInput[],
  nowMs: number,
): RevenueHeadline {
  const now = new Date(nowMs);
  const thisMonthKey = monthKeyOf(nowMs);
  const previousMonthKey = monthKeyOf(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  const inMonth = (month: string) => {
    const bounds = monthWindow(month);
    return days.filter((row) => row.dayMs >= bounds.startMs && row.dayMs < bounds.endMs);
  };

  return {
    total: totalsByCurrency(days),
    thisMonth: totalsByCurrency(inMonth(thisMonthKey)),
    previousMonth: totalsByCurrency(inMonth(previousMonthKey)),
    thisMonthKey,
    previousMonthKey,
  };
}
