import { describe, expect, it } from "vitest";
import {
  calculateEmployeePayroll,
  calculatePayrollRun,
  payDateFor,
  periodContaining,
  periodForMonth,
  periodLabel,
  previousPeriod,
  type PayrollEmployee,
  type PayrollNiche,
  type PayrollShort,
} from "@/lib/payroll/payroll-engine";

/**
 * Payroll is the one calculation here that moves money, so these tests are
 * written against the brief's own worked examples, against the specific ways a
 * bonus could be paid twice, and against the way one used to be paid for a hit
 * nobody had defined.
 */

const NICHES: PayrollNiche[] = [
  { id: "gta", name: "GTA", hitThreshold: 1_000_000 },
  { id: "rdr", name: "Red Dead Redemption", hitThreshold: 750_000 },
  { id: "tlou", name: "The Last of Us", hitThreshold: 500_000 },
  // Nobody has said what a hit is here. Nothing in it can be one.
  { id: "science", name: "Science", hitThreshold: null },
];

const AUGUST = periodForMonth(2026, 8);

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
  ...overrides,
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
    ...overrides,
  };
};

const run = (emp: PayrollEmployee, shorts: PayrollShort[]) =>
  calculateEmployeePayroll({
    employee: emp,
    shorts,
    niches: NICHES,
    period: AUGUST,
  });

describe("the brief's worked example", () => {
  it("pays $4,000 salary plus 200 hits at $10 = $6,000", () => {
    // 120 GTA hits and 80 Red Dead hits, exactly as written in the brief.
    const shorts = [
      ...Array.from({ length: 120 }, () => short({ nicheIds: ["gta"], views: 1_500_000 })),
      ...Array.from({ length: 80 }, () =>
        short({ nicheIds: ["rdr"], channelId: "c2", channelName: "Bullet & Honor", views: 900_000 }),
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
    const shorts = Array.from({ length: 140 }, () => short({ views: 1_200_000 }));
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

describe("the niche threshold decides the hit", () => {
  it("uses each niche's own threshold, not one global number", () => {
    const shorts = [
      short({ nicheIds: ["gta"], views: 900_000 }), // under GTA's 1M — no
      short({ nicheIds: ["rdr"], views: 900_000 }), // over RDR's 750K — yes
      short({ nicheIds: ["tlou"], views: 600_000 }), // over TLOU's 500K — yes
      short({ nicheIds: ["tlou"], views: 400_000 }), // under TLOU's 500K — no
    ];

    const result = run(employee(), shorts);
    expect(result.hitCount).toBe(2);
    expect(result.hits.map((h) => h.nicheId).sort()).toEqual(["rdr", "tlou"]);
  });

  it("counts a Short sitting exactly on the threshold", () => {
    // Inclusive at the boundary, matching isHit everywhere else in the app.
    const result = run(employee(), [short({ nicheIds: ["rdr"], views: 750_000 })]);
    expect(result.hitCount).toBe(1);
  });

  it("records the threshold each hit was judged against", () => {
    const result = run(employee(), [
      short({ nicheIds: ["rdr"], views: 800_000 }),
      short({ nicheIds: ["tlou"], views: 600_000 }),
    ]);
    expect(result.hits.map((h) => h.thresholdApplied).sort((a, b) => a - b)).toEqual([
      500_000, 750_000,
    ]);
  });
});

/**
 * =========================================================================
 * AN UNCONFIGURED NICHE PAYS NOTHING, AND SAYS SO
 * =========================================================================
 *
 * This block replaces a test that asserted the opposite — "falls back to the
 * organization default for an unconfigured niche" — which encoded the bug
 * rather than a rule. The product had already been made honest everywhere else:
 * a niche with a null `hitThreshold` resolves to "unconfigured", the dashboard
 * prints "Hit rate threshold: Not configured", and the report dialog refuses to
 * generate. Payroll alone went on borrowing the organization's 1,000,000 and
 * paying a real bonus for hits the product had just said it could not measure.
 *
 * The old test could not be weakened into agreement because it asserted the
 * exact behaviour being removed. It is gone, and these stand in its place: the
 * Short is not counted, it is REPORTED as skipped with its niche named, and a
 * Short in a configured niche is untouched.
 */
describe("an unconfigured niche cannot produce a hit", () => {
  it("does not count a Short whose niche has no threshold", () => {
    // Both of these cleared the old organization default of 1,000,000 and paid
    // a bonus. Nobody ever chose that bar for Science.
    const shorts = [
      short({ nicheIds: ["science"], views: 1_200_000 }),
      short({ nicheIds: ["science"], views: 5_000_000 }),
    ];

    const result = run(employee({ nicheIds: ["science"] }), shorts);

    expect(result.hitCount).toBe(0);
    expect(result.hitBonusMinor).toBe(0);
    expect(result.byNiche).toEqual([]);
    expect(result.totalMinor).toBe(400_000); // salary only
  });

  it("reports the skipped Shorts, naming the niche responsible", () => {
    const shorts = [
      short({ nicheIds: ["science"], views: 1_200_000 }),
      short({ nicheIds: ["science"], views: 5_000_000 }),
    ];

    const result = run(employee({ nicheIds: ["science"] }), shorts);

    // The whole point of the second half of the fix: a bonus that quietly
    // shrinks is indistinguishable from a bug, so the calculation has to be
    // able to say what it could not judge and why.
    expect(result.skippedNiches).toEqual([
      { nicheId: "science", nicheName: "Science", shortCount: 2 },
    ]);
  });

  it("leaves a configured niche completely unaffected", () => {
    const shorts = [
      short({ nicheIds: ["science"], views: 5_000_000 }), // no bar — skipped
      short({ nicheIds: ["rdr"], views: 900_000 }), // over 750K — paid
      short({ nicheIds: ["rdr"], views: 700_000 }), // under 750K — a real miss
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
      { nicheId: "science", nicheName: "Science", shortCount: 1 },
    ]);
  });

  it("does not report a Short that earned through another niche", () => {
    // Filed under both. It cleared GTA's bar and was paid, so calling it
    // "not considered" would overstate what the missing Science bar cost.
    const result = run(employee({ nicheIds: ["gta", "science"] }), [
      short({ nicheIds: ["gta", "science"], views: 2_000_000 }),
    ]);

    expect(result.hitCount).toBe(1);
    expect(result.hits[0]?.nicheId).toBe("gta");
    expect(result.skippedNiches).toEqual([]);
  });

  it("reports nothing for somebody who could not have earned a bonus anyway", () => {
    // No per-hit rate: this person's bonus is zero for a reason that has
    // nothing to do with a threshold, and an alarm here would point at the
    // wrong problem.
    const result = run(employee({ nicheIds: ["science"], hitPaymentMinor: 0 }), [
      short({ nicheIds: ["science"], views: 5_000_000 }),
    ]);

    expect(result.skippedNiches).toEqual([]);
  });

  it("counts each skipped Short once, however many rows it arrives in", () => {
    const duplicated = short({ videoId: "same", nicheIds: ["science"], views: 5_000_000 });
    const result = run(employee({ nicheIds: ["science"] }), [
      duplicated,
      { ...duplicated },
      { ...duplicated },
    ]);

    expect(result.skippedNiches[0]?.shortCount).toBe(1);
  });

  it("ignores Shorts outside the period and off owned channels", () => {
    const result = run(employee({ nicheIds: ["science"] }), [
      short({ nicheIds: ["science"], views: 5_000_000, publishedAtMs: Date.UTC(2026, 6, 20) }),
      short({ nicheIds: ["science"], views: 5_000_000, isOwnChannel: false }),
      short({ nicheIds: ["science"], views: 5_000_000 }), // August, owned
    ]);

    // Drawn from exactly the population the bonus loop considers. A report over
    // a wider set would answer a question nobody asked.
    expect(result.skippedNiches[0]?.shortCount).toBe(1);
  });

  it("counts distinct Shorts across the run, not the sum of everyone's", () => {
    // Two people on the same unconfigured niche see the same Shorts go
    // uncounted. Adding their figures would tell an admin twice as many Shorts
    // were affected as exist.
    const shorts = [
      short({ nicheIds: ["science"], views: 5_000_000 }),
      short({ nicheIds: ["science"], views: 4_000_000 }),
    ];

    const team = calculatePayrollRun({
      employees: [
        employee({ userId: "u1", nicheIds: ["science"] }),
        employee({ userId: "u2", name: "Alex", nicheIds: ["science"] }),
      ],
      shorts,
      niches: NICHES,
      period: AUGUST,
    });

    expect(team.skippedNiches).toEqual([
      { nicheId: "science", nicheName: "Science", shortCount: 2 },
    ]);
    // Salary only, for both.
    expect(team.totalMinor).toBe(800_000);
  });

  it("says nothing about an unconfigured niche nobody is assigned to", () => {
    // It costs no money, so it is not this banner's business — the niches list
    // is where an unassigned one gets chased.
    const team = calculatePayrollRun({
      employees: [employee({ nicheIds: ["gta"] })],
      shorts: [short({ nicheIds: ["science"], views: 5_000_000 })],
      niches: NICHES,
      period: AUGUST,
    });

    expect(team.skippedNiches).toEqual([]);
  });
});

describe("no double counting", () => {
  it("counts a Short once even when its channel spans two assigned niches", () => {
    // The dangerous case: a channel filed under both GTA and TLOU. Without
    // explicit attribution this Short would be counted once per niche.
    const result = run(employee(), [short({ nicheIds: ["gta", "tlou"], views: 1_500_000 })]);

    expect(result.hitCount).toBe(1);
    expect(result.hitBonusMinor).toBe(1_000); // one $10 bonus, not two
  });

  it("credits an ambiguous Short to the lowest threshold it clears", () => {
    // 600K clears TLOU's 500K but not GTA's 1M. It is genuinely a TLOU hit and
    // must not be lost because the channel is also filed under GTA.
    const result = run(employee(), [short({ nicheIds: ["gta", "tlou"], views: 600_000 })]);

    expect(result.hitCount).toBe(1);
    expect(result.hits[0]?.nicheId).toBe("tlou");
    expect(result.hits[0]?.thresholdApplied).toBe(500_000);
  });

  it("ignores a duplicated row in the input", () => {
    // A re-sync or a bad join could present the same video twice.
    const duplicated = short({ videoId: "same", views: 2_000_000 });
    const result = run(employee(), [duplicated, { ...duplicated }, { ...duplicated }]);

    expect(result.hitCount).toBe(1);
  });

  it("is deterministic regardless of input order", () => {
    const shorts = [
      short({ nicheIds: ["gta", "tlou"], views: 600_000 }),
      short({ nicheIds: ["rdr"], views: 900_000 }),
      short({ nicheIds: ["tlou"], views: 550_000 }),
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
      short({ views: 5_000_000, isOwnChannel: false }),
      short({ views: 5_000_000, isOwnChannel: false, nicheIds: ["rdr"] }),
    ]);
    expect(result.hitCount).toBe(0);
    expect(result.totalMinor).toBe(400_000); // salary only
  });

  it("excludes niches the employee is not assigned to", () => {
    const result = run(employee({ nicheIds: ["gta"] }), [
      short({ nicheIds: ["gta"], views: 2_000_000 }),
      short({ nicheIds: ["tlou"], views: 2_000_000 }),
      short({ nicheIds: ["rdr"], views: 2_000_000 }),
    ]);
    expect(result.hitCount).toBe(1);
  });

  it("excludes Shorts published outside the period", () => {
    const result = run(employee(), [
      short({ publishedAtMs: Date.UTC(2026, 6, 31, 23, 59) }), // July
      short({ publishedAtMs: Date.UTC(2026, 7, 1) }), // 1 August — in
      short({ publishedAtMs: Date.UTC(2026, 7, 31, 23, 59) }), // 31 August — in
      short({ publishedAtMs: Date.UTC(2026, 8, 1) }), // 1 September — out
    ]);
    expect(result.hitCount).toBe(2);
  });

  it("pays no bonus to someone with no niches assigned", () => {
    const result = run(employee({ nicheIds: [] }), [short({ views: 5_000_000 })]);
    expect(result.hitCount).toBe(0);
    expect(result.totalMinor).toBe(400_000);
  });

  it("pays no bonus when the hit rate is zero", () => {
    const result = run(employee({ hitPaymentMinor: 0 }), [short({ views: 5_000_000 })]);
    expect(result.hitBonusMinor).toBe(0);
    expect(result.totalMinor).toBe(400_000);
  });
});

describe("employment dates", () => {
  it("excludes someone who left before the period began", () => {
    const result = run(
      employee({ employmentEndedOnMs: Date.UTC(2026, 6, 15) }),
      [short({ views: 2_000_000 })],
    );
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
    });

    expect(team.calculations).toHaveLength(1);
    expect(team.calculations[0]?.userId).toBe("u1");
  });
});

describe("the team run", () => {
  it("totals everyone and sorts by what they earned", () => {
    const shorts = Array.from({ length: 10 }, () => short({ views: 2_000_000 }));
    const team = calculatePayrollRun({
      employees: [
        employee({ userId: "u2", name: "Alex", salaryMinor: 200_000, hitPaymentMinor: 500, nicheIds: ["gta"] }),
        employee(),
      ],
      shorts,
      niches: NICHES,
      period: AUGUST,
    });

    // John: 400,000 + 10 x 1,000 = 410,000. Alex: 200,000 + 10 x 500 = 205,000.
    expect(team.calculations.map((c) => c.name)).toEqual(["John", "Alex"]);
    expect(team.totalMinor).toBe(615_000);
  });

  it("pays two people for the same Short at their own rates", () => {
    // Not double counting — two separate obligations arising from one result.
    const one = short({ views: 2_000_000 });
    const team = calculatePayrollRun({
      employees: [
        employee({ userId: "u1", hitPaymentMinor: 1_000, salaryMinor: 0 }),
        employee({ userId: "u2", name: "Alex", hitPaymentMinor: 500, salaryMinor: 0, nicheIds: ["gta"] }),
      ],
      shorts: [one],
      niches: NICHES,
      period: AUGUST,
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
