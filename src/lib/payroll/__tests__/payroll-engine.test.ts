import { describe, expect, it } from "vitest";
import { HOUR_MS } from "@/lib/analytics/hit-rate";
import {
  calculateEmployeePayroll,
  calculatePayrollRun,
  payDateFor,
  periodContaining,
  periodForMonth,
  periodLabel,
  previousPeriod,
  type PayrollEmployee,
  type PayrollHitEvidence,
  type PayrollNiche,
  type PayrollShort,
} from "@/lib/payroll/payroll-engine";

/**
 * Payroll is the one calculation here that moves money, so these tests are
 * written against the brief's own worked examples, against the specific ways a
 * bonus could be paid twice, and against the way one used to be paid for a hit
 * nobody had defined.
 *
 * THE DEFINITION OF A HIT CHANGED UNDER THIS FILE. A hit is now a threshold
 * reached WITHIN A WINDOW, so a fixture that only sets a view count no longer
 * says anything — the same Short is a hit, a miss, a pending or an unknown
 * depending on when it was published, what was recorded about it, and what time
 * it is now. `hit()` below is the fixture for "this one cleared the bar inside
 * its window, and here is the evidence", which is what every test that used to
 * write `views: 2_000_000` actually meant.
 */

const SEVEN_DAYS = 168;
const TWO_DAYS = 48;

const NICHES: PayrollNiche[] = [
  { id: "gta", name: "GTA", hitThreshold: 1_000_000, hitWindowHours: SEVEN_DAYS },
  { id: "rdr", name: "Red Dead Redemption", hitThreshold: 750_000, hitWindowHours: SEVEN_DAYS },
  { id: "tlou", name: "The Last of Us", hitThreshold: 500_000, hitWindowHours: SEVEN_DAYS },
  // Nobody has said what a hit is here. Nothing in it can be one.
  { id: "science", name: "Science", hitThreshold: null, hitWindowHours: null },
  // Half a rule: a bar with no clock. Exactly as unscoreable as no bar at all,
  // and the case the skipped-niche notice could not express before.
  { id: "history", name: "History", hitThreshold: 250_000, hitWindowHours: null },
];

const AUGUST = periodForMonth(2026, 8);
/** Well after every window in these fixtures has shut. */
const NOW = Date.UTC(2026, 8, 15);

const employee = (overrides: Partial<PayrollEmployee> = {}): PayrollEmployee => ({
  userId: "u1",
  name: "John",
  email: "john@northstarstudios.cc",
  role: "head_of_shorts",
  salaryMinor: 400_000, // $4,000.00
  hitPaymentMinor: 1_000, // $10.00
  currency: "USD",
  nicheIds: ["gta", "rdr", "tlou"],
  joinedOnMs: null,
  employmentEndedOnMs: null,
  // Nothing frozen behind them, which is the ordinary case. The tests that care
  // set it — see "a Short is paid once, ever".
  alreadyPaidVideoIds: [],
  ...overrides,
});

/**
 * Evidence that a Short was already over `views` at `atHours` old.
 *
 * A ROW THAT RECORDS NO RULE, which is deliberate: with `thresholdApplied` and
 * `windowHoursApplied` null there is no stored verdict for payroll to read, so
 * these fixtures exercise the path that evaluates from the reading. Its
 * `outcome` is therefore inert, and set to the "unknown" such a row really
 * carries rather than to something flattering.
 *
 * Without a reading, a Short over the bar today whose window has shut is an
 * "unknown" and never a hit — the whole point of the windowed rule, and the
 * reason these fixtures have to be explicit.
 */
const seen = (views: number, atHours = 24, nicheId: string | null = null): PayrollHitEvidence => ({
  outcome: "unknown",
  nicheId,
  thresholdApplied: null,
  windowHoursApplied: null,
  windowClosesAtMs: null,
  viewsAtWindow: views,
  observedAtHours: atHours,
});

let sequence = 0;
const short = (overrides: Partial<PayrollShort> = {}): PayrollShort => {
  sequence += 1;
  return {
    videoId: `v${sequence}`,
    title: `Short ${sequence}`,
    channelId: "c1",
    channelName: "The 6th Star",
    views: 2_000_000,
    publishedAtMs: Date.UTC(2026, 7, 15),
    nicheIds: ["gta"],
    isOwnChannel: true,
    evaluation: null,
    ...overrides,
  };
};

/** A Short that demonstrably cleared `views` inside its window. */
const hit = (overrides: Partial<PayrollShort> = {}): PayrollShort => {
  const base = short(overrides);
  return { ...base, evaluation: base.evaluation ?? seen(base.views) };
};

const run = (emp: PayrollEmployee, shorts: PayrollShort[], nowMs = NOW) =>
  calculateEmployeePayroll({
    employee: emp,
    shorts,
    niches: NICHES,
    period: AUGUST,
    nowMs,
  });

describe("the brief's worked example", () => {
  it("pays $4,000 salary plus 200 hits at $10 = $6,000", () => {
    // 120 GTA hits and 80 Red Dead hits, exactly as written in the brief.
    const shorts = [
      ...Array.from({ length: 120 }, () => hit({ nicheIds: ["gta"], views: 1_500_000 })),
      ...Array.from({ length: 80 }, () =>
        hit({ nicheIds: ["rdr"], channelId: "c2", channelName: "Bullet & Honor", views: 900_000 }),
      ),
    ];

    const result = run(employee(), shorts);

    expect(result.hitCount).toBe(200);
    expect(result.baseSalaryMinor).toBe(400_000); // $4,000
    expect(result.hitBonusMinor).toBe(200_000); // $2,000
    expect(result.totalMinor).toBe(600_000); // $6,000

    // The breakdown must be per-niche, not one opaque figure.
    const gta = result.byNiche.find((n) => n.nicheId === "gta");
    const rdr = result.byNiche.find((n) => n.nicheId === "rdr");
    expect(gta?.hitCount).toBe(120);
    expect(gta?.bonusMinor).toBe(120_000); // $1,200
    expect(rdr?.hitCount).toBe(80);
    expect(rdr?.bonusMinor).toBe(80_000); // $800
  });

  it("pays the editor a different rate for the same channel's hits", () => {
    // Alex: $2,000 salary, $5/hit, GTA only, 140 hits -> $2,700.
    const shorts = Array.from({ length: 140 }, () => hit({ views: 1_200_000 }));
    const result = run(
      employee({
        userId: "u2",
        name: "Alex",
        role: "short_form_editor",
        salaryMinor: 200_000,
        hitPaymentMinor: 500,
        nicheIds: ["gta"],
      }),
      shorts,
    );

    expect(result.hitCount).toBe(140);
    expect(result.totalMinor).toBe(270_000); // $2,700
  });
});

/**
 * =========================================================================
 * A HIT IS A THRESHOLD REACHED INSIDE A WINDOW
 * =========================================================================
 *
 * The change this whole round of work exists for. Views alone no longer decide
 * anything: the same 5,000,000-view Short is a hit, an unknown or a pending
 * depending entirely on WHEN those views arrived and whether anybody was
 * recording at the time.
 */
describe("the window decides, not the lifetime total", () => {
  it("pays a Short seen over the bar inside its window", () => {
    const result = run(employee(), [
      short({ nicheIds: ["rdr"], views: 900_000, evaluation: seen(800_000, 24) }),
    ]);

    expect(result.hitCount).toBe(1);
    expect(result.hits[0]?.viewsAtWindow).toBe(800_000);
    expect(result.hits[0]?.observedAtHours).toBe(24);
  });

  it("counts a Short that was over the bar on day two as a hit on day seven", () => {
    // Views only rise, so an in-window reading over the bar settles it whenever
    // it was taken. This is the case the schema's doc comment calls out.
    const result = run(employee(), [
      short({ nicheIds: ["tlou"], views: 5_000_000, evaluation: seen(600_000, 48) }),
    ]);

    expect(result.hitCount).toBe(1);
    expect(result.hits[0]?.observedAtHours).toBe(48);
  });

  it("does not pay a Short that only crossed the bar after the window shut", () => {
    // 5,000,000 lifetime views and nothing to say when they arrived. Under the
    // old lifetime rule this paid a bonus; it is now an "unknown", and an
    // unknown never pays.
    const result = run(employee(), [short({ nicheIds: ["gta"], views: 5_000_000 })]);

    expect(result.hitCount).toBe(0);
    expect(result.unresolved.unknownCount).toBe(1);
    expect(result.totalMinor).toBe(400_000); // salary only
  });

  it("calls a Short still under the bar today a miss, with no history at all", () => {
    // The inference that judges 80% of the existing library: a Short that has
    // not reached 1,000,000 in a month did not reach it in its first week.
    const result = run(employee(), [short({ nicheIds: ["gta"], views: 90_000 })]);

    expect(result.hitCount).toBe(0);
    // A judged, settled answer — not something to report as waiting or lost.
    expect(result.unresolved).toEqual({ pendingCount: 0, unknownCount: 0, alreadyPaidCount: 0 });
  });

  it("records the rule each hit was judged under, both halves of it", () => {
    const result = run(employee(), [
      hit({ nicheIds: ["rdr"], views: 800_000 }),
      hit({ nicheIds: ["tlou"], views: 600_000 }),
    ]);

    expect(result.hits.map((h) => h.thresholdApplied).sort((a, b) => a - b)).toEqual([
      500_000, 750_000,
    ]);
    // The threshold alone stopped being a rule when the clock was added, so it
    // never travels alone.
    expect(result.hits.every((h) => h.windowHoursApplied === SEVEN_DAYS)).toBe(true);
  });

  it("counts a Short sitting exactly on the threshold", () => {
    // Inclusive at the boundary, matching the analytics engine everywhere else.
    const result = run(employee(), [hit({ nicheIds: ["rdr"], views: 750_000 })]);
    expect(result.hitCount).toBe(1);
  });

  it("ignores a reading taken after the window had already shut", () => {
    // Observed at 300 hours on a 168-hour rule. It says what the Short did
    // afterwards, which is exactly the question the window refuses to answer.
    const result = run(employee(), [
      short({ nicheIds: ["gta"], views: 5_000_000, evaluation: seen(4_000_000, 300) }),
    ]);

    expect(result.hitCount).toBe(0);
    expect(result.unresolved.unknownCount).toBe(1);
  });
});

/**
 * =========================================================================
 * A HIT IS PAID IN THE PERIOD IT RESOLVES
 * =========================================================================
 *
 * The owner's decision, and the reason the whole selection moved off
 * `publishedAt`. Crediting by publish date under a windowed rule means anything
 * published near a month's end can never earn its bonus, because its window is
 * still open when the month is frozen.
 */
describe("the period a hit is paid in", () => {
  it("pays a Short published before the period whose window closed inside it", () => {
    // Published 28 July, seven-day window, resolves 4 August. August pays it.
    const result = run(employee(), [
      hit({
        nicheIds: ["gta"],
        views: 1_500_000,
        publishedAtMs: Date.UTC(2026, 6, 28),
      }),
    ]);

    expect(result.hitCount).toBe(1);
    expect(new Date(result.hits[0]!.publishedAtMs).toISOString()).toBe(
      "2026-07-28T00:00:00.000Z",
    );
    expect(new Date(result.hits[0]!.windowClosesAtMs).toISOString()).toBe(
      "2026-08-04T00:00:00.000Z",
    );
  });

  it("does not pay it again in the period it was published in", () => {
    // The same Short, run for July. Exactly one month owes this bonus, and a
    // Short that appeared on both runs would be paid twice — the unique
    // constraint cannot catch it, because those are two different records.
    const published = hit({
      nicheIds: ["gta"],
      views: 1_500_000,
      publishedAtMs: Date.UTC(2026, 6, 28),
    });

    const july = calculateEmployeePayroll({
      employee: employee(),
      shorts: [published],
      niches: NICHES,
      period: periodForMonth(2026, 7),
      nowMs: NOW,
    });

    expect(july.hitCount).toBe(0);
  });

  it("does not pay a Short published inside the period whose window closes after it", () => {
    // Published 28 August, resolves 4 September. September's run, not this one.
    const result = run(employee(), [
      hit({
        nicheIds: ["gta"],
        views: 1_500_000,
        publishedAtMs: Date.UTC(2026, 7, 28),
      }),
    ]);

    expect(result.hitCount).toBe(0);
    // Nor is it reported as waiting: August is never going to see it resolve.
    expect(result.unresolved.pendingCount).toBe(0);
  });

  it("credits a Short to the same niche whichever period is being calculated", () => {
    // The ranking is period-independent on purpose. If it were not, the same
    // Short could resolve into two different months under two different niches.
    const ambiguous = hit({ nicheIds: ["gta", "tlou"], views: 1_500_000 });

    const august = run(employee(), [ambiguous]);
    const september = calculateEmployeePayroll({
      employee: employee(),
      shorts: [ambiguous],
      niches: NICHES,
      period: periodForMonth(2026, 9),
      nowMs: NOW,
    });

    expect(august.hits[0]?.nicheId).toBe("tlou");
    expect(september.hitCount).toBe(0);
  });
});

/**
 * =========================================================================
 * PENDING IS A WAIT. UNKNOWN IS A LOSS.
 * =========================================================================
 */
describe("Shorts that earn nothing yet", () => {
  it("pays nothing for a Short whose window is still open, and says it is waiting", () => {
    // Published 2 August, seven-day window, and it is only the 4th. Already
    // over the bar and still not counted: the window has not shut, so nothing
    // is decided. Counting it now would let the in-flight cohort contribute its
    // winners and none of its unfinished siblings.
    const result = run(
      employee(),
      [
        short({
          nicheIds: ["gta"],
          views: 5_000_000,
          publishedAtMs: Date.UTC(2026, 7, 2),
          evaluation: seen(4_000_000, 12),
        }),
      ],
      Date.UTC(2026, 7, 4),
    );

    expect(result.hitCount).toBe(0);
    expect(result.hitBonusMinor).toBe(0);
    expect(result.unresolved).toEqual({ pendingCount: 1, unknownCount: 0, alreadyPaidCount: 0 });
  });

  it("pays nothing for an unknown, and reports it apart from a pending one", () => {
    const result = run(
      employee(),
      [
        // Window shut on 9 August, nobody recording, over the bar today.
        short({ nicheIds: ["gta"], views: 5_000_000, publishedAtMs: Date.UTC(2026, 7, 2) }),
        // Window still open on the 15th.
        short({ nicheIds: ["gta"], views: 5_000_000, publishedAtMs: Date.UTC(2026, 7, 12) }),
      ],
      Date.UTC(2026, 7, 15),
    );

    expect(result.hitCount).toBe(0);
    // One will resolve and may yet pay; the other never can. Told apart because
    // whoever runs payroll needs to know which they are looking at.
    expect(result.unresolved).toEqual({ pendingCount: 1, unknownCount: 1, alreadyPaidCount: 0 });
  });

  it("counts distinct Shorts across the run, not the sum of everyone's", () => {
    const shorts = [
      short({ nicheIds: ["gta"], views: 5_000_000 }),
      short({ nicheIds: ["gta"], views: 4_000_000 }),
    ];

    const team = calculatePayrollRun({
      employees: [employee({ userId: "u1" }), employee({ userId: "u2", name: "Alex" })],
      shorts,
      niches: NICHES,
      period: AUGUST,
      nowMs: NOW,
    });

    expect(team.unresolved).toEqual({ pendingCount: 0, unknownCount: 2, alreadyPaidCount: 0 });
  });
});

/**
 * =========================================================================
 * AN INCOMPLETE RULE PAYS NOTHING, AND SAYS WHICH HALF IS MISSING
 * =========================================================================
 *
 * This block replaces a test that asserted the opposite — "falls back to the
 * organization default for an unconfigured niche" — which encoded the bug
 * rather than a rule. It now covers the second way a niche can be unscoreable:
 * a threshold with no window is exactly as useless as no threshold, because
 * judging it on lifetime views is the age-biased comparison being removed.
 */
describe("an incomplete rule cannot produce a hit", () => {
  it("does not count a Short whose niche has no threshold", () => {
    // Both of these cleared the old organization default of 1,000,000 and paid
    // a bonus. Nobody ever chose that bar for Science.
    const shorts = [
      hit({ nicheIds: ["science"], views: 1_200_000 }),
      hit({ nicheIds: ["science"], views: 5_000_000 }),
    ];

    const result = run(employee({ nicheIds: ["science"] }), shorts);

    expect(result.hitCount).toBe(0);
    expect(result.hitBonusMinor).toBe(0);
    expect(result.byNiche).toEqual([]);
    expect(result.totalMinor).toBe(400_000); // salary only
  });

  it("does not count a Short whose niche has a threshold but no window", () => {
    // History is set to 250,000 views and no clock. Under the old rule this
    // paid; under the new one there is no rule to apply, and inventing a
    // default window would be the organization-default bug with a clock on it.
    const result = run(employee({ nicheIds: ["history"] }), [
      hit({ nicheIds: ["history"], views: 5_000_000 }),
    ]);

    expect(result.hitCount).toBe(0);
    expect(result.skippedNiches).toEqual([
      { nicheId: "history", nicheName: "History", missing: "window", shortCount: 1 },
    ]);
  });

  it("names which half of the rule each skipped niche is missing", () => {
    const result = run(employee({ nicheIds: ["science", "history"] }), [
      hit({ nicheIds: ["science"], views: 5_000_000 }),
      hit({ nicheIds: ["history"], views: 5_000_000 }),
    ]);

    // "Set a threshold" and "set a window" are two different fields. A notice
    // that said only "unconfigured" would make an admin go and find out which.
    expect(
      result.skippedNiches.map((niche) => [niche.nicheName, niche.missing]).sort(),
    ).toEqual([
      ["History", "window"],
      ["Science", "both"],
    ]);
  });

  it("reports the skipped Shorts, naming the niche responsible", () => {
    const shorts = [
      hit({ nicheIds: ["science"], views: 1_200_000 }),
      hit({ nicheIds: ["science"], views: 5_000_000 }),
    ];

    const result = run(employee({ nicheIds: ["science"] }), shorts);

    // The whole point of the second half of the fix: a bonus that quietly
    // shrinks is indistinguishable from a bug, so the calculation has to be
    // able to say what it could not judge and why.
    expect(result.skippedNiches).toEqual([
      { nicheId: "science", nicheName: "Science", missing: "both", shortCount: 2 },
    ]);
  });

  it("leaves a configured niche completely unaffected", () => {
    const shorts = [
      hit({ nicheIds: ["science"], views: 5_000_000 }), // no rule — skipped
      hit({ nicheIds: ["rdr"], views: 900_000 }), // over 750K in window — paid
      hit({ nicheIds: ["rdr"], views: 700_000 }), // under 750K — a real miss
    ];

    const result = run(employee({ nicheIds: ["science", "rdr"] }), shorts);

    expect(result.hitCount).toBe(1);
    expect(result.hits[0]?.nicheId).toBe("rdr");
    expect(result.hits[0]?.thresholdApplied).toBe(750_000);
    expect(result.hitBonusMinor).toBe(1_000);

    // The Short that genuinely missed RDR's bar is not "skipped" — it was
    // judged, and it lost. Only Science, which could not be judged at all, is
    // reported, and only the Short that is actually in it.
    expect(result.skippedNiches).toEqual([
      { nicheId: "science", nicheName: "Science", missing: "both", shortCount: 1 },
    ]);
  });

  it("does not report a Short that another niche could judge, hit or not", () => {
    // Filed under GTA and Science. GTA's rule governs it and GTA's rule is what
    // it was measured by — it lost, but Science's missing rule cost nothing,
    // because Science was never going to be the one deciding. Billing the
    // missing rule for this Short would overstate what completing it would
    // recover.
    const result = run(employee({ nicheIds: ["gta", "science"] }), [
      hit({ nicheIds: ["gta", "science"], views: 400_000 }),
    ]);

    expect(result.hitCount).toBe(0);
    expect(result.skippedNiches).toEqual([]);
  });

  it("does not report a Short that earned through another niche", () => {
    // Filed under both. It cleared GTA's rule and was paid, so calling it
    // "not considered" would overstate what the missing Science rule cost.
    const result = run(employee({ nicheIds: ["gta", "science"] }), [
      hit({ nicheIds: ["gta", "science"], views: 2_000_000 }),
    ]);

    expect(result.hitCount).toBe(1);
    expect(result.hits[0]?.nicheId).toBe("gta");
    expect(result.skippedNiches).toEqual([]);
  });

  it("reports nothing for somebody who could not have earned a bonus anyway", () => {
    // No per-hit rate: this person's bonus is zero for a reason that has
    // nothing to do with a rule, and an alarm here would point at the wrong
    // problem.
    const result = run(employee({ nicheIds: ["science"], hitPaymentMinor: 0 }), [
      hit({ nicheIds: ["science"], views: 5_000_000 }),
    ]);

    expect(result.skippedNiches).toEqual([]);
  });

  it("counts each skipped Short once, however many rows it arrives in", () => {
    const duplicated = hit({ videoId: "same", nicheIds: ["science"], views: 5_000_000 });
    const result = run(employee({ nicheIds: ["science"] }), [
      duplicated,
      { ...duplicated },
      { ...duplicated },
    ]);

    expect(result.skippedNiches[0]?.shortCount).toBe(1);
  });

  it("ignores Shorts outside the period and off owned channels", () => {
    const result = run(employee({ nicheIds: ["science"] }), [
      hit({ nicheIds: ["science"], views: 5_000_000, publishedAtMs: Date.UTC(2026, 6, 20) }),
      hit({ nicheIds: ["science"], views: 5_000_000, isOwnChannel: false }),
      hit({ nicheIds: ["science"], views: 5_000_000 }), // August, owned
    ]);

    // Drawn from the population the bonus loop considers. A niche with no
    // window has no resolution date to compute, so this one report is scoped by
    // publication rather than by resolution — the only population that can be
    // named at all.
    expect(result.skippedNiches[0]?.shortCount).toBe(1);
  });

  it("counts skipped Shorts distinctly across the run, not per employee", () => {
    // Two people on the same unconfigured niche see the same Shorts go
    // uncounted. Adding their figures would tell an admin twice as many Shorts
    // were affected as exist.
    const shorts = [
      hit({ nicheIds: ["science"], views: 5_000_000 }),
      hit({ nicheIds: ["science"], views: 4_000_000 }),
    ];

    const team = calculatePayrollRun({
      employees: [
        employee({ userId: "u1", nicheIds: ["science"] }),
        employee({ userId: "u2", name: "Alex", nicheIds: ["science"] }),
      ],
      shorts,
      niches: NICHES,
      period: AUGUST,
      nowMs: NOW,
    });

    expect(team.skippedNiches).toEqual([
      { nicheId: "science", nicheName: "Science", missing: "both", shortCount: 2 },
    ]);
    // Salary only, for both.
    expect(team.totalMinor).toBe(800_000);
  });

  it("says nothing about an unconfigured niche nobody is assigned to", () => {
    // It costs no money, so it is not this banner's business — the niches list
    // is where an unassigned one gets chased.
    const team = calculatePayrollRun({
      employees: [employee({ nicheIds: ["gta"] })],
      shorts: [hit({ nicheIds: ["science"], views: 5_000_000 })],
      niches: NICHES,
      period: AUGUST,
      nowMs: NOW,
    });

    expect(team.skippedNiches).toEqual([]);
  });
});

/**
 * =========================================================================
 * THE RULE A BONUS WAS PAID UNDER DOES NOT MOVE WHEN THE NICHE DOES
 * =========================================================================
 */
describe("a recorded rule outranks today's configuration", () => {
  it("re-derives the same verdict after an admin widens the niche's window", () => {
    // Judged under a 48-hour rule and recorded as such. The niche is now on
    // seven days, which would move this Short's resolution date — and therefore
    // which month pays it — if today's setting were allowed to win.
    const recorded: PayrollHitEvidence = {
      outcome: "hit",
      nicheId: "gta",
      thresholdApplied: 1_000_000,
      windowHoursApplied: TWO_DAYS,
      windowClosesAtMs: Date.UTC(2026, 7, 15) + TWO_DAYS * HOUR_MS,
      viewsAtWindow: 1_100_000,
      observedAtHours: 12,
    };

    const result = run(employee(), [
      short({
        nicheIds: ["gta"],
        views: 5_000_000,
        publishedAtMs: Date.UTC(2026, 7, 15),
        evaluation: recorded,
      }),
    ]);

    expect(result.hits[0]?.windowHoursApplied).toBe(TWO_DAYS);
    expect(result.hits[0]?.windowClosesAtMs).toBe(Date.UTC(2026, 7, 15) + TWO_DAYS * HOUR_MS);
  });

  it("falls back to the niche when nothing has been evaluated yet", () => {
    // The live case: an open period over Shorts nobody has materialised a
    // verdict for. Not an edge case — it is most of the library today.
    const result = run(employee(), [hit({ nicheIds: ["gta"], views: 2_000_000 })]);
    expect(result.hits[0]?.windowHoursApplied).toBe(SEVEN_DAYS);
  });
});

/**
 * =========================================================================
 * PAYROLL READS THE VERDICT, IT DOES NOT RE-DERIVE ONE
 * =========================================================================
 *
 * The evaluator freezes "hit" and "miss" so a settled answer cannot decay as
 * the library ages. Payroll used to rebuild one observation from the stored row
 * and run the evaluator again over it, which quietly thawed exactly that.
 */
describe("a frozen verdict stays frozen through payroll", () => {
  it("keeps a stored miss a miss after the Short's lifetime views pass the bar", () => {
    // The evaluator settled this from "the lifetime total is still under the
    // bar" — nothing was ever observed, so `viewsAtWindow` is null. The Short
    // has since crept past 1,000,000. Re-deriving would find a shut window, no
    // observations and a lifetime over the bar, and return "unknown": a certain
    // miss decaying into a permanent loss, months after it was decided.
    const result = run(employee(), [
      short({
        nicheIds: ["gta"],
        views: 4_000_000,
        evaluation: {
          outcome: "miss",
          nicheId: "gta",
          thresholdApplied: 1_000_000,
          windowHoursApplied: SEVEN_DAYS,
          windowClosesAtMs: Date.UTC(2026, 7, 15) + SEVEN_DAYS * HOUR_MS,
          viewsAtWindow: null,
          observedAtHours: null,
        },
      }),
    ]);

    expect(result.hitCount).toBe(0);
    // A settled miss is reported nowhere: not as a wait, and above all not as
    // the permanent loss an "unknown" would have made it.
    expect(result.unresolved).toEqual({ pendingCount: 0, unknownCount: 0, alreadyPaidCount: 0 });
  });

  it("still re-decides a stored pending once the window has shut", () => {
    // The other side of the same line. "pending" and "unknown" are NOT frozen —
    // the evaluator re-decides them on every run — so reading one back verbatim
    // would leave a Short reported as waiting long after its window closed,
    // purely because the cron had not caught up.
    const result = run(employee(), [
      short({
        nicheIds: ["gta"],
        views: 4_000_000,
        evaluation: {
          outcome: "pending",
          nicheId: "gta",
          thresholdApplied: 1_000_000,
          windowHoursApplied: SEVEN_DAYS,
          windowClosesAtMs: Date.UTC(2026, 7, 15) + SEVEN_DAYS * HOUR_MS,
          viewsAtWindow: null,
          observedAtHours: null,
        },
      }),
    ]);

    expect(result.unresolved.pendingCount).toBe(0);
    expect(result.unresolved.unknownCount).toBe(1);
  });
});

/**
 * =========================================================================
 * A SHORT IS PAID ONCE, EVER
 * =========================================================================
 *
 * The period that pays a Short is the one its window closed in — and that date
 * MOVES, because editing a niche rewrites the recorded rule on every evaluation
 * under it. February pays a Short on 4 February; an admin widens GTA in March;
 * the same Short now closes on 6 March. February is finalized and its
 * `PayrollHit` row correctly survives, so March would pay it again.
 * `@@unique([recordId, videoId])` spans one record and cannot see it.
 */
const NINE_HUNDRED_HOURS = 900;
const FEBRUARY = periodForMonth(2026, 2);
const MARCH = periodForMonth(2026, 3);
const PUBLISHED_28_JANUARY = Date.UTC(2026, 0, 28);

/** GTA after an admin moved its window from seven days to 900 hours. */
const WIDENED: PayrollNiche[] = NICHES.map((niche) =>
  niche.id === "gta" ? { ...niche, hitWindowHours: NINE_HUNDRED_HOURS } : niche,
);

/**
 * One Short, as its stored evaluation stands under a given window.
 *
 * `reevaluateHitsForNiche` rewrites the RECORDED rule on every evaluation in a
 * niche whenever an admin edits it, which is the mechanism that moves the close
 * date out from under a period that has already paid. Both fixtures below are
 * the same video; only the rule stamped on it differs.
 */
const boxingDay = (windowHours: number): PayrollShort =>
  short({
    videoId: "v_boxing_day",
    nicheIds: ["gta"],
    views: 5_000_000,
    publishedAtMs: PUBLISHED_28_JANUARY,
    evaluation: {
      outcome: "hit",
      nicheId: "gta",
      thresholdApplied: 1_000_000,
      windowHoursApplied: windowHours,
      windowClosesAtMs: PUBLISHED_28_JANUARY + windowHours * HOUR_MS,
      viewsAtWindow: 1_200_000,
      observedAtHours: 24,
    },
  });

describe("a Short is paid once, ever", () => {
  it("refuses to credit a Short a finalized period already paid for", () => {
    const result = calculateEmployeePayroll({
      // February paid this videoId to this person, and February is frozen.
      employee: employee({ alreadyPaidVideoIds: ["v_boxing_day"] }),
      shorts: [boxingDay(NINE_HUNDRED_HOURS)],
      niches: WIDENED,
      period: MARCH,
      nowMs: Date.UTC(2026, 2, 20),
    });

    expect(result.hitCount).toBe(0);
    expect(result.hitBonusMinor).toBe(0);
    // Explained, not swallowed. A silent skip looks exactly like the miscount
    // it prevents, and an admin with no way to tell them apart has to doubt
    // the whole run.
    expect(result.unresolved).toEqual({ pendingCount: 0, unknownCount: 0, alreadyPaidCount: 1 });
  });

  it("would have paid it a second time without the ledger", () => {
    // The control, and the bug itself. Identical inputs but for the frozen
    // credits, and the Short lands squarely in March: 28 January plus 900 hours
    // is 6 March, where 28 January plus 168 hours was 4 February.
    const result = calculateEmployeePayroll({
      employee: employee({ alreadyPaidVideoIds: [] }),
      shorts: [boxingDay(NINE_HUNDRED_HOURS)],
      niches: WIDENED,
      period: MARCH,
      nowMs: Date.UTC(2026, 2, 20),
    });

    expect(result.hitCount).toBe(1);
    expect(result.hits[0]?.windowClosesAtMs).toBe(Date.UTC(2026, 2, 6, 12));
  });

  it("scopes the ledger to one person, so a second editor is still paid", () => {
    // The rule this must not break: one GTA hit earns a Head of Shorts and an
    // editor their own bonus each. Paying John in February says nothing about
    // whether Alex may be paid in March.
    const team = calculatePayrollRun({
      employees: [
        employee({ userId: "u1", alreadyPaidVideoIds: ["v_boxing_day"] }),
        employee({ userId: "u2", name: "Alex", alreadyPaidVideoIds: [] }),
      ],
      shorts: [boxingDay(NINE_HUNDRED_HOURS)],
      niches: WIDENED,
      period: MARCH,
      nowMs: Date.UTC(2026, 2, 20),
    });

    expect(team.calculations.find((c) => c.userId === "u1")?.hitCount).toBe(0);
    expect(team.calculations.find((c) => c.userId === "u2")?.hitCount).toBe(1);
    // Somebody WAS paid for it on this run, so the run-level report has nothing
    // to explain — the same reasoning that keeps a credited Short out of the
    // pending and unknown counts.
    expect(team.unresolved.alreadyPaidCount).toBe(0);
  });

  it("reports it at run level when nobody on the run can be paid for it", () => {
    const team = calculatePayrollRun({
      employees: [
        employee({ userId: "u1", alreadyPaidVideoIds: ["v_boxing_day"] }),
        employee({ userId: "u2", name: "Alex", alreadyPaidVideoIds: ["v_boxing_day"] }),
      ],
      shorts: [boxingDay(NINE_HUNDRED_HOURS)],
      niches: WIDENED,
      period: MARCH,
      nowMs: Date.UTC(2026, 2, 20),
    });

    expect(team.calculations.every((c) => c.hitCount === 0)).toBe(true);
    // Counted once over distinct Shorts, not once per employee.
    expect(team.unresolved).toEqual({ pendingCount: 0, unknownCount: 0, alreadyPaidCount: 1 });
  });

  it("lets the same Short move between two DRAFT periods", () => {
    // A draft recalculates on every read by design and has paid nobody, so a
    // Short changing months as its rule changes is correct behaviour rather
    // than a double payment. Nothing enters the ledger until a period is
    // FROZEN, which is why both of these credit it.
    const asDraftFebruary = calculateEmployeePayroll({
      employee: employee(),
      shorts: [boxingDay(SEVEN_DAYS)],
      niches: NICHES,
      period: FEBRUARY,
      nowMs: Date.UTC(2026, 1, 20),
    });

    const asDraftMarch = calculateEmployeePayroll({
      employee: employee(),
      shorts: [boxingDay(NINE_HUNDRED_HOURS)],
      niches: WIDENED,
      period: MARCH,
      nowMs: Date.UTC(2026, 2, 20),
    });

    expect(asDraftFebruary.hitCount).toBe(1);
    expect(asDraftFebruary.hits[0]?.windowClosesAtMs).toBe(Date.UTC(2026, 1, 4));
    expect(asDraftMarch.hitCount).toBe(1);
    expect(asDraftMarch.hits[0]?.windowClosesAtMs).toBe(Date.UTC(2026, 2, 6, 12));
  });

  it("says nothing about a paid Short that resolves into a different month", () => {
    // The ledger is not a blanket exclusion. This Short was paid in February
    // and still closes in February, so March never considers it at all — it is
    // somebody else's month, which is not something to explain on this run.
    const result = calculateEmployeePayroll({
      employee: employee({ alreadyPaidVideoIds: ["v_boxing_day"] }),
      shorts: [boxingDay(SEVEN_DAYS)],
      niches: NICHES,
      period: MARCH,
      nowMs: Date.UTC(2026, 2, 20),
    });

    expect(result.hitCount).toBe(0);
    expect(result.unresolved).toEqual({ pendingCount: 0, unknownCount: 0, alreadyPaidCount: 0 });
  });
});

describe("no double counting", () => {
  it("counts a Short once even when its channel spans two assigned niches", () => {
    // The dangerous case: a channel filed under both GTA and TLOU. Without
    // explicit attribution this Short would be counted once per niche.
    const result = run(employee(), [hit({ nicheIds: ["gta", "tlou"], views: 1_500_000 })]);

    expect(result.hitCount).toBe(1);
    expect(result.hitBonusMinor).toBe(1_000); // one $10 bonus, not two
  });

  it("credits an ambiguous Short to the lowest threshold", () => {
    // 600K clears TLOU's 500K but not GTA's 1M. It is genuinely a TLOU hit and
    // must not be lost because the channel is also filed under GTA. The choice
    // is `pickGoverningRule`'s, shared with the analytics engine.
    const result = run(employee(), [hit({ nicheIds: ["gta", "tlou"], views: 600_000 })]);

    expect(result.hitCount).toBe(1);
    expect(result.hits[0]?.nicheId).toBe("tlou");
    expect(result.hits[0]?.thresholdApplied).toBe(500_000);
  });

  it("ignores a duplicated row in the input", () => {
    // A re-sync or a bad join could present the same video twice.
    const duplicated = hit({ videoId: "same", views: 2_000_000 });
    const result = run(employee(), [duplicated, { ...duplicated }, { ...duplicated }]);

    expect(result.hitCount).toBe(1);
  });

  it("credits each Short exactly once when a period is re-run", () => {
    // Re-running a period must not create a second credit. The engine is pure
    // and deterministic given `nowMs`, so the second run is the first run.
    const shorts = [
      hit({ nicheIds: ["gta"], views: 1_500_000 }),
      hit({ nicheIds: ["rdr"], views: 900_000 }),
    ];

    const first = run(employee(), shorts);
    const second = run(employee(), shorts);

    expect(second.hitCount).toBe(first.hitCount);
    expect(second.totalMinor).toBe(first.totalMinor);
    expect(second.hits.map((h) => h.videoId)).toEqual(first.hits.map((h) => h.videoId));
    // One row per Short, which is what the (record, video) unique constraint
    // absorbs on the way to the database.
    expect(new Set(second.hits.map((h) => h.videoId)).size).toBe(second.hits.length);
  });

  it("is deterministic regardless of input order", () => {
    const shorts = [
      hit({ nicheIds: ["gta", "tlou"], views: 600_000 }),
      hit({ nicheIds: ["rdr"], views: 900_000 }),
      hit({ nicheIds: ["tlou"], views: 550_000 }),
    ];

    const forwards = run(employee(), shorts);
    const backwards = run(employee(), [...shorts].reverse());

    expect(forwards.totalMinor).toBe(backwards.totalMinor);
    expect(forwards.hits.map((h) => h.nicheId).sort()).toEqual(
      backwards.hits.map((h) => h.nicheId).sort(),
    );
  });
});

describe("what does not earn a bonus", () => {
  it("excludes competitor channels", () => {
    // Paying an editor because a rival went viral would be absurd.
    const result = run(employee(), [
      hit({ views: 5_000_000, isOwnChannel: false }),
      hit({ views: 5_000_000, isOwnChannel: false, nicheIds: ["rdr"] }),
    ]);
    expect(result.hitCount).toBe(0);
    expect(result.totalMinor).toBe(400_000); // salary only
  });

  it("excludes niches the employee is not assigned to", () => {
    const result = run(employee({ nicheIds: ["gta"] }), [
      hit({ nicheIds: ["gta"], views: 2_000_000 }),
      hit({ nicheIds: ["tlou"], views: 2_000_000 }),
      hit({ nicheIds: ["rdr"], views: 2_000_000 }),
    ]);
    expect(result.hitCount).toBe(1);
  });

  it("excludes Shorts whose window closed outside the period", () => {
    // Seven-day windows throughout, so the boundaries move a week earlier than
    // the publication dates the old rule compared.
    const result = run(employee(), [
      hit({ publishedAtMs: Date.UTC(2026, 6, 24) }), // resolves 31 July — out
      hit({ publishedAtMs: Date.UTC(2026, 6, 25) }), // resolves 1 August — in
      hit({ publishedAtMs: Date.UTC(2026, 7, 24) }), // resolves 31 August — in
      hit({ publishedAtMs: Date.UTC(2026, 7, 25) }), // resolves 1 September — out
    ]);
    expect(result.hitCount).toBe(2);
  });

  it("pays no bonus to someone with no niches assigned", () => {
    const result = run(employee({ nicheIds: [] }), [hit({ views: 5_000_000 })]);
    expect(result.hitCount).toBe(0);
    expect(result.totalMinor).toBe(400_000);
  });

  it("pays no bonus when the hit rate is zero", () => {
    const result = run(employee({ hitPaymentMinor: 0 }), [hit({ views: 5_000_000 })]);
    expect(result.hitBonusMinor).toBe(0);
    expect(result.totalMinor).toBe(400_000);
  });
});

describe("employment dates", () => {
  it("excludes someone who left before the period began", () => {
    const result = run(employee({ employmentEndedOnMs: Date.UTC(2026, 6, 15) }), [
      hit({ views: 2_000_000 }),
    ]);
    expect(result.employedDuringPeriod).toBe(false);
    expect(result.totalMinor).toBe(0);
  });

  it("excludes someone who joins after the period ends", () => {
    const result = run(employee({ joinedOnMs: Date.UTC(2026, 8, 10) }), []);
    expect(result.employedDuringPeriod).toBe(false);
  });

  it("pays a full salary to someone who joined mid-month", () => {
    // Salary is a fixed monthly figure. Inventing a daily rate would produce a
    // number nobody agreed to, so it is deliberately not pro-rated.
    const result = run(employee({ joinedOnMs: Date.UTC(2026, 7, 20) }), []);
    expect(result.employedDuringPeriod).toBe(true);
    expect(result.baseSalaryMinor).toBe(400_000);
  });

  it("keeps a leaver off the team run entirely", () => {
    const team = calculatePayrollRun({
      employees: [
        employee(),
        employee({ userId: "u9", name: "Departed", employmentEndedOnMs: Date.UTC(2026, 5, 1) }),
      ],
      shorts: [],
      niches: NICHES,
      period: AUGUST,
      nowMs: NOW,
    });

    expect(team.calculations).toHaveLength(1);
    expect(team.calculations[0]?.userId).toBe("u1");
  });
});

describe("the team run", () => {
  it("totals everyone and sorts by what they earned", () => {
    const shorts = Array.from({ length: 10 }, () => hit({ views: 2_000_000 }));
    const team = calculatePayrollRun({
      employees: [
        employee({ userId: "u2", name: "Alex", salaryMinor: 200_000, hitPaymentMinor: 500, nicheIds: ["gta"] }),
        employee(),
      ],
      shorts,
      niches: NICHES,
      period: AUGUST,
      nowMs: NOW,
    });

    // John: 400,000 + 10 x 1,000 = 410,000. Alex: 200,000 + 10 x 500 = 205,000.
    expect(team.calculations.map((c) => c.name)).toEqual(["John", "Alex"]);
    expect(team.totalMinor).toBe(615_000);
  });

  it("pays two people for the same Short at their own rates", () => {
    // Not double counting — two separate obligations arising from one result.
    const one = hit({ views: 2_000_000 });
    const team = calculatePayrollRun({
      employees: [
        employee({ userId: "u1", hitPaymentMinor: 1_000, salaryMinor: 0 }),
        employee({ userId: "u2", name: "Alex", hitPaymentMinor: 500, salaryMinor: 0, nicheIds: ["gta"] }),
      ],
      shorts: [one],
      niches: NICHES,
      period: AUGUST,
      nowMs: NOW,
    });

    expect(team.totalMinor).toBe(1_500);
  });
});

describe("period arithmetic", () => {
  it("builds a half-open month in UTC", () => {
    const august = periodForMonth(2026, 8);
    expect(new Date(august.startsAtMs).toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(new Date(august.endsAtMs).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("rolls over the year boundary in both directions", () => {
    const december = periodForMonth(2026, 12);
    expect(new Date(december.endsAtMs).toISOString()).toBe("2027-01-01T00:00:00.000Z");

    const january = periodForMonth(2027, 1);
    expect(previousPeriod(january)).toEqual(december);
  });

  it("pays on the first of the following month", () => {
    expect(new Date(payDateFor(periodForMonth(2026, 8))).toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("finds the period containing an instant", () => {
    expect(periodContaining(Date.UTC(2026, 7, 26, 13, 5))).toEqual(periodForMonth(2026, 8));
    // The very last millisecond of the month still belongs to it.
    expect(periodContaining(Date.UTC(2026, 7, 31, 23, 59, 59, 999))).toEqual(
      periodForMonth(2026, 8),
    );
  });

  it("labels a period the way a person would say it", () => {
    expect(periodLabel(periodForMonth(2026, 9))).toBe("September 2026");
  });
});
