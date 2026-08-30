import { describe, expect, it } from "vitest";
import { periodForMonth } from "@/lib/payroll/payroll-engine";
import {
  TELEGRAM_MESSAGE_LIMIT,
  buildPayrollMessage,
  formatEmployeeBlock,
  formatPayAmount,
  formatPayDate,
  formatPayrollMessage,
  type PayrollMessageEmployee,
  type PayrollMessageInput,
} from "@/lib/payroll/payroll-message";

/**
 * The message is the only part of payroll most of the team ever reads, so the
 * wording is tested as carefully as the arithmetic. These assertions exist to
 * make a careless edit to the formatting loud rather than silent.
 */

const AUGUST = periodForMonth(2026, 8);

const john: PayrollMessageEmployee = {
  name: "John",
  roleLabel: "Head of Shorts",
  baseSalaryMinor: 400_000, // $4,000.00
  hitPaymentMinor: 1_000, // $10.00
  adjustmentMinor: 0,
  adjustmentReason: null,
  totalMinor: 600_000, // $6,000.00
  currency: "USD",
  byNiche: [
    { nicheName: "GTA", hitCount: 120, hitPaymentMinor: 1_000, bonusMinor: 120_000 },
    { nicheName: "RDR", hitCount: 80, hitPaymentMinor: 1_000, bonusMinor: 80_000 },
  ],
};

const mia: PayrollMessageEmployee = {
  name: "Mia",
  roleLabel: "Short Form Editor",
  baseSalaryMinor: 250_000, // $2,500.00
  hitPaymentMinor: 1_000,
  adjustmentMinor: 0,
  adjustmentReason: null,
  totalMinor: 270_000, // $2,700.00
  currency: "USD",
  byNiche: [{ nicheName: "GTA", hitCount: 20, hitPaymentMinor: 1_000, bonusMinor: 20_000 }],
};

const run = (overrides: Partial<PayrollMessageInput> = {}): PayrollMessageInput => ({
  companyName: "Northstar Studios",
  period: AUGUST,
  employees: [john, mia],
  totalMinor: 870_000, // $8,700.00
  currency: "USD",
  ...overrides,
});

describe("formatPayDate", () => {
  it("reports the first of the month AFTER the period, which is when money moves", () => {
    expect(formatPayDate(AUGUST)).toBe("September 1, 2026");
  });

  it("rolls the year over for a December period", () => {
    expect(formatPayDate(periodForMonth(2026, 12))).toBe("January 1, 2027");
  });
});

describe("formatPayAmount", () => {
  it("drops the decimals on a round figure, as the brief's example does", () => {
    expect(formatPayAmount(400_000, "USD")).toBe("$4,000");
  });

  it("keeps them when they are not zero, so nothing is misreported", () => {
    expect(formatPayAmount(400_050, "USD")).toBe("$4,000.50");
  });

  it("handles a currency with no minor units at all", () => {
    expect(formatPayAmount(120_000, "JPY")).toBe("¥120,000");
  });
});

describe("formatPayrollMessage", () => {
  it("renders the brief's example, line for line", () => {
    expect(formatPayrollMessage(run())).toBe(
      [
        "Northstar Studios — Monthly Payroll",
        "September 1, 2026",
        "",
        "John — Head of Shorts",
        "Base salary: $4,000",
        "GTA hits: 120 × $10 = $1,200",
        "RDR hits: 80 × $10 = $800",
        "Total: $6,000",
        "",
        "Mia — Short Form Editor",
        "Base salary: $2,500",
        "GTA hits: 20 × $10 = $200",
        "Total: $2,700",
        "",
        "Total Northstar Studios Payroll: $8,700",
      ].join("\n"),
    );
  });

  it("uses the configured company name rather than a hardcoded one", () => {
    expect(formatPayrollMessage(run({ companyName: "Polaris Media" }))).toContain(
      "Polaris Media — Monthly Payroll",
    );
  });

  it("says so plainly when nobody was on payroll", () => {
    const message = formatPayrollMessage(run({ employees: [], totalMinor: 0 }));
    expect(message).toContain("Nobody was on payroll for this period.");
    expect(message).toContain("Total Northstar Studios Payroll: $0");
  });
});

describe("formatEmployeeBlock", () => {
  it("omits hit lines entirely for someone with no qualifying hits", () => {
    const block = formatEmployeeBlock({ ...john, byNiche: [], totalMinor: 400_000 });
    expect(block).toBe(
      ["John — Head of Shorts", "Base salary: $4,000", "Total: $4,000"].join("\n"),
    );
    expect(block).not.toContain("hits:");
  });

  it("shows an adjustment on its own line, signed, so a correction is visible", () => {
    const block = formatEmployeeBlock({
      ...john,
      adjustmentMinor: 10_000,
      adjustmentReason: "Missed July bonus",
      totalMinor: 610_000,
    });
    expect(block).toContain("Adjustment: +$100.00 — Missed July bonus");
    expect(block).toContain("Total: $6,100");
  });

  it("shows a negative adjustment as a deduction", () => {
    const block = formatEmployeeBlock({
      ...john,
      adjustmentMinor: -5_000,
      adjustmentReason: null,
      totalMinor: 595_000,
    });
    expect(block).toContain("Adjustment: -$50.00");
    expect(block).not.toContain("—  ");
  });

  it("names the niche a bonus was credited to, with the rate spelled out", () => {
    expect(formatEmployeeBlock(john)).toContain("GTA hits: 120 × $10 = $1,200");
  });
});

/**
 * THE PROPERTY THESE TESTS EXIST FOR
 *
 * `buildPayrollMessage` returns a string, not an array, and that type IS the
 * fix. The multi-part version could fail after posting part 1 of 3, and the
 * retry that followed — a platform replay, the admin's button, the next cron
 * finding a failed row claimable — started again from part 1. Everybody's
 * salary went into the chat twice, and Telegram has no unsend.
 *
 * One body makes delivery atomic: it posted or it did not, so a retry has no
 * fragment left over to duplicate. Every case below asserts the same two things
 * — one message, inside the limit — at team sizes that used to force two, four
 * and forty.
 */
describe("buildPayrollMessage", () => {
  const bigTeam = (count: number): PayrollMessageEmployee[] =>
    Array.from({ length: count }, (_, index) => ({
      ...john,
      name: `Employee Number ${index + 1}`,
      byNiche: [
        { nicheName: "Grand Theft Auto", hitCount: 12, hitPaymentMinor: 1_000, bonusMinor: 12_000 },
        { nicheName: "Red Dead Redemption", hitCount: 8, hitPaymentMinor: 1_000, bonusMinor: 8_000 },
        { nicheName: "The Last of Us", hitCount: 4, hitPaymentMinor: 1_000, bonusMinor: 4_000 },
      ],
    }));

  const teamOf = (count: number): PayrollMessageInput => {
    const employees = bigTeam(count);
    return run({ employees, totalMinor: employees.length * 600_000 });
  };

  it("renders a normal run exactly as the canonical formatter does", () => {
    expect(buildPayrollMessage(run())).toBe(formatPayrollMessage(run()));
  });

  /**
   * The regression test proper. Every one of these sizes produced more than one
   * message before, and each extra message was another chance to fail halfway
   * and re-post what had already arrived.
   */
  it("returns ONE message inside the limit at every team size", () => {
    for (const count of [0, 1, 2, 40, 400, 4_000]) {
      const message = buildPayrollMessage(teamOf(count));
      expect(typeof message).toBe("string");
      expect(message.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
  });

  it("never numbers parts, because there are never parts to number", () => {
    for (const count of [1, 2, 40, 400]) {
      expect(buildPayrollMessage(teamOf(count))).not.toMatch(/\(\d+\/\d+\)/);
    }
  });

  it("drops the per-niche detail before it drops a person", () => {
    const input = teamOf(40);
    const message = buildPayrollMessage(input);

    // Summarised: a total per person, no account of how the bonus was earned.
    expect(message).toContain("Employee Number 1 — Head of Shorts: $6,000");
    expect(message).not.toContain("× $10 =");

    for (const employee of input.employees) {
      expect(message).toContain(employee.name);
    }
    // Nobody was left out, so nothing claims anybody was.
    expect(message).not.toContain("on payroll. The full breakdown");
  });

  it("collapses one impossibly long breakdown rather than cutting it mid-figure", () => {
    const overloaded: PayrollMessageEmployee = {
      ...john,
      name: "Priya",
      byNiche: Array.from({ length: 500 }, (_, index) => ({
        nicheName: `Niche ${index + 1}`,
        hitCount: 3,
        hitPaymentMinor: 1_000,
        bonusMinor: 3_000,
      })),
    };

    const message = buildPayrollMessage(run({ employees: [overloaded, mia] }));
    expect(message.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(message).toContain("Priya — Head of Shorts: $6,000");
    expect(message).toContain("Mia — Short Form Editor: $2,700");
  });

  it("says how many people it left out, so a clipped roster is not read as the team", () => {
    const message = buildPayrollMessage(teamOf(400));

    const overflow = message.match(/…and (\d+) more people on payroll/);
    expect(overflow).not.toBeNull();

    const omitted = Number(overflow?.[1]);
    const listed = message.match(/Employee Number \d+ —/g)?.length ?? 0;
    expect(listed).toBeGreaterThan(0);
    expect(listed + omitted).toBe(400);
  });

  /**
   * Swept across limits rather than pinned to one, because the exact limit at
   * which the roster starts dropping people depends on the wording of every
   * line — and a test that hardcoded it would fail on a comma.
   *
   * The last person's line is deliberately far longer than the others, so that
   * dropping exactly one of them is a state the packer can actually reach.
   *
   * The sweep starts above the floor of the message (header, overflow line and
   * total, which no path drops); a limit below that is smaller than the
   * shortest honest summary and smaller than anything Telegram would impose.
   */
  it("keeps its own count, in the singular and the plural", () => {
    const employees = [
      ...bigTeam(11),
      {
        ...john,
        name: "Bartholomew Fitzgerald-Wintersmith the Third and Then Some More",
        roleLabel: "Senior Principal Head of Short Form Video Operations",
      },
    ];

    let sawSingular = false;
    let sawPlural = false;

    for (let limit = 250; limit <= 900; limit += 1) {
      const message = buildPayrollMessage(run({ employees }), { limit });
      expect(message.length).toBeLessThanOrEqual(limit);

      const omitted = Number(message.match(/…and (\d+) more/)?.[1] ?? 0);
      if (omitted === 1) {
        sawSingular = true;
        expect(message).toContain("…and 1 more person on payroll");
      }
      if (omitted > 1) {
        sawPlural = true;
        expect(message).toContain(`…and ${omitted} more people on payroll`);
      }
    }

    expect(sawSingular).toBe(true);
    expect(sawPlural).toBe(true);
  });

  it("keeps the header first and the calculated total last, whatever it dropped", () => {
    for (const count of [2, 40, 400]) {
      const message = buildPayrollMessage(
        run({ employees: bigTeam(count), totalMinor: 999_999 }),
      );
      expect(message.startsWith("Northstar Studios — Monthly Payroll")).toBe(true);
      // The total the engine calculated, never a sum of what happened to fit.
      expect(message.endsWith("Total Northstar Studios Payroll: $9,999.99")).toBe(true);
    }
  });

  it("still says plainly that nobody was on payroll", () => {
    const message = buildPayrollMessage(run({ employees: [], totalMinor: 0 }));
    expect(message).toContain("Nobody was on payroll for this period.");
    expect(message).toContain("Total Northstar Studios Payroll: $0");
  });

  it("respects an explicit limit, which is what makes the ladder testable", () => {
    const message = buildPayrollMessage(teamOf(40), { limit: 400 });
    expect(message.length).toBeLessThanOrEqual(400);
    expect(message).toContain("more people on payroll");
  });

  /**
   * The company name is the only free text in the header and the total, and
   * those two are the sections nothing can drop. If a 50,000-character name
   * could get into them, "one message that fits" would stop being a guarantee
   * and go back to being an assumption.
   */
  it("bounds a pathological company name, so the floor really is a floor", () => {
    const message = buildPayrollMessage(
      run({ companyName: "N".repeat(50_000), employees: bigTeam(400) }),
    );
    expect(message.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(message).toContain("— Monthly Payroll");
    expect(message).toContain("Payroll: $8,700");
  });
});
