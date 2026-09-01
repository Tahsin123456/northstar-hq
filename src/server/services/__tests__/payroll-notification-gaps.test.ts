import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * THE FACT REACHING THE MESSAGE THAT IS ACTUALLY SENT
 * =========================================================================
 *
 * `payroll-message.test.ts` pins the WORDS. This file pins the WIRING, which is
 * where the whole thing was broken and where a plausible fix would still have
 * shipped a message that never mentions a gap.
 *
 * WHY THE OBVIOUS FIX DOES NOT WORK. Adding a field to `PayrollMessageEmployee`
 * and mapping it in `toMessageInput` compiles, reads correctly and discloses
 * nothing — because the source it would map from is empty by construction.
 * `PayrollPeriodDTO.skippedNiches` is hardcoded `[]` for a frozen period, and
 * both Telegram entry points refuse to send anything but a finalized one, so
 * that literal is on the path of 100% of sends. `PayrollRecordDTO` has no gap
 * field at all, because `PayrollRecord` has no column for one.
 *
 * So the per-employee fact has to travel from the run that computed it to the
 * send that announces it, joined back to the rows by user id. That hand-off is
 * what these assertions hold in place.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");
process.env.TELEGRAM_BOT_TOKEN = "test-token";

const ORG_ID = "org_northstar";
const JOHN = "user_john";
const MIA = "user_mia";

const mocks = vi.hoisted(() => ({
  findPeriod: vi.fn(),
  findSettings: vi.fn(),
  createSettings: vi.fn(),
  findNotification: vi.fn(),
  createNotification: vi.fn(),
  updateNotification: vi.fn(),
  getPeriodForOrganization: vi.fn(),
  sendMessage: vi.fn(),
  telegramStatus: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/server/db", () => {
  const tx = {
    payrollNotification: {
      findUnique: mocks.findNotification,
      create: mocks.createNotification,
      update: mocks.updateNotification,
    },
  };
  return {
    prisma: {
      notificationSettings: {
        findUnique: mocks.findSettings,
        create: mocks.createSettings,
      },
      payrollNotification: { update: mocks.updateNotification },
      payrollPeriod: { findUnique: mocks.findPeriod },
      $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    },
  };
});

vi.mock("../telegram-service", () => ({
  sendMessage: mocks.sendMessage,
  sendTestMessage: vi.fn(),
  telegramStatus: mocks.telegramStatus,
}));

vi.mock("../user-service", () => ({
  getOrgSettings: async () => ({ companyName: "Northstar Studios", baseCurrency: "USD" }),
}));

vi.mock("../payroll-service", () => ({
  getPeriodForOrganization: mocks.getPeriodForOrganization,
}));

vi.mock("@/server/audit/audit-service", () => ({ recordAudit: mocks.recordAudit }));

const { sendPayrollNotification, sendPayrollNotificationForMonth } = await import(
  "../notification-service"
);
const { periodForMonth } = await import("@/lib/payroll/payroll-engine");

const AUGUST = periodForMonth(2026, 8);

/** John earned his salary and nothing else. Mia had a clean month. */
function record(userId: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `rec_${userId}`,
    userId,
    employeeName: name,
    employeeEmail: `${name.toLowerCase()}@example.com`,
    role: "short_form_editor",
    roleLabel: "Editor",
    baseSalaryMinor: 190_000,
    hitPaymentMinor: 0,
    hitCount: 0,
    hitBonusMinor: 0,
    adjustmentMinor: 0,
    adjustmentReason: null,
    totalMinor: 190_000,
    currency: "USD",
    paymentStatus: "pending",
    paidAt: null,
    byNiche: [] as unknown[],
    hits: [] as unknown[],
    ...overrides,
  };
}

function periodDTO() {
  return {
    year: 2026,
    month: 8,
    label: "August 2026",
    startsAt: AUGUST.startsAtMs,
    endsAt: AUGUST.endsAtMs,
    payOn: AUGUST.endsAtMs,
    status: "finalized",
    isDraft: false,
    hasEnded: true,
    finalizedAt: Date.now(),
    finalizedByName: null,
    totals: {
      employeeCount: 2,
      hitCount: 0,
      baseSalaryMinor: 380_000,
      hitBonusMinor: 0,
      adjustmentMinor: 0,
      totalMinor: 380_000,
      paidMinor: 0,
      pendingMinor: 380_000,
      currency: "USD",
      currencyMixed: false,
    },
    records: [record(JOHN, "John"), record(MIA, "Mia")],
    // THE LITERAL THIS WHOLE FILE IS ABOUT. A frozen period reports nothing
    // here, and a frozen period is the only kind that is ever sent.
    skippedNiches: [],
    unresolved: { pendingCount: 0, unknownCount: 0, alreadyPaidCount: 0 },
  };
}

/** What the message actually posted to the chat. */
function sentMessage(): string {
  return String(mocks.sendMessage.mock.calls[0]?.[1] ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSettings.mockResolvedValue({
    organizationId: ORG_ID,
    telegramChatId: "chat_1",
    telegramEnabled: true,
    payrollNotificationsEnabled: true,
  });
  mocks.telegramStatus.mockReturnValue({ tokenConfigured: true, chatConfigured: true });
  mocks.findNotification.mockResolvedValue(null);
  mocks.createNotification.mockResolvedValue({ id: "notif_1" });
  mocks.updateNotification.mockResolvedValue({ id: "notif_1" });
  mocks.getPeriodForOrganization.mockResolvedValue(periodDTO());
  mocks.sendMessage.mockResolvedValue({ sent: true });
});

const send = (gaps?: unknown) =>
  sendPayrollNotification({
    organizationId: ORG_ID,
    periodId: "period_1",
    period: AUGUST,
    actorUserId: null,
    actorLabel: "Scheduled payroll",
    ...(gaps === undefined ? {} : { unpaidNicheGaps: gaps as never }),
  });

describe("the run's own report reaches the chat", () => {
  it("prints the gap under the person it belongs to, not the whole run", async () => {
    await send([
      {
        userId: JOHN,
        nicheName: "GTA",
        missing: { rule: null, payment: true },
        shortCount: 1,
      },
    ]);

    const message = sentMessage();
    const blocks = message.split("\n\n");
    const johnBlock = blocks.find((block) => block.startsWith("John —")) ?? "";
    const miaBlock = blocks.find((block) => block.startsWith("Mia —")) ?? "";

    expect(johnBlock).toContain("GTA hits: 1 — not paid, no hit payment set");
    // Joined on user id. Mia shares nothing with John's gap and must not
    // inherit it — a name-based join would have put it on both.
    expect(miaBlock).not.toContain("GTA");
    expect(message).toContain("Some Shorts earned nothing this month.");
  });

  /**
   * THE STATE THE PRODUCT WAS ACTUALLY IN. Every field the message is built
   * from is present and correct; the fact simply is not in any of them.
   */
  it("says nothing at all when the caller has no run to report", async () => {
    await send();

    const message = sentMessage();
    expect(message).toContain("John — Editor");
    expect(message).toContain("Base salary: $1,900");
    expect(message).toContain("Total: $1,900");
    // No gap line and no explainer: an absence of information, never a claim
    // that nothing was skipped.
    expect(message).not.toContain("not paid, no hit payment set");
    expect(message).not.toContain("Some Shorts earned nothing");
  });

  /**
   * A re-send has no run behind it — `sendPayrollNotificationForMonth` and the
   * `alreadyFinalized` early return both reach here with nothing. It stays
   * silent rather than re-deriving a settled month from today's niches and
   * announcing the result as though it were what was frozen.
   */
  it("stays silent for an empty report, exactly as for a missing one", async () => {
    await send([]);
    expect(sentMessage()).not.toContain("Some Shorts earned nothing");
  });

  it("changes no figure in the message it sends", async () => {
    await send([
      { userId: JOHN, nicheName: "GTA", missing: { rule: null, payment: true }, shortCount: 1 },
      {
        userId: MIA,
        nicheName: "Science",
        missing: { rule: "threshold", payment: false },
        shortCount: 3,
      },
    ]);

    const message = sentMessage();
    // Both salaries, both totals and the run total, untouched. The disclosure
    // is a disclosure; if it ever becomes a payment this fails.
    expect(message).toContain("Base salary: $1,900");
    expect(message).toContain("Total: $1,900");
    expect(message).toContain("Total Northstar Studios Payroll: $3,800");
    // And no amount anywhere near a gap line, because there is no rate to state.
    const gapLine = message.split("\n").find((line) => line.startsWith("Science")) ?? "";
    expect(gapLine).toBe("Science: 3 Shorts not counted, no hit threshold set");
  });

  it("still sends exactly one message", async () => {
    await send([
      { userId: JOHN, nicheName: "GTA", missing: { rule: null, payment: true }, shortCount: 1 },
    ]);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentMessage().length).toBeLessThanOrEqual(4096);
  });
});

/**
 * =========================================================================
 * THE HALF OF THE PRODUCT THIS DOES NOT REACH
 * =========================================================================
 *
 * Pinned so nobody has to read the source to find out, and so the two obvious
 * "fixes" are both loud.
 *
 * `sendPayrollNotificationForMonth` is every admin-initiated send: the notify
 * endpoint resolves a year and a month to a period row. It has no run to take
 * the gaps from, because finalizing and announcing are separate requests and
 * nothing durable stores what the run found. So its message carries no gap
 * lines — and NOT only on a re-send. The first send an admin ever makes through
 * the UI arrives here identically empty, which is the sentence the original
 * write-up got wrong.
 *
 * Two things must stay true. It must not start re-deriving the gaps from
 * today's niches, which would describe a frozen month with settings somebody
 * changed since; and it must not silently become the path that carries them,
 * because that could only happen by one of those two routes.
 */
describe("an admin-initiated send", () => {
  beforeEach(() => {
    mocks.findPeriod.mockResolvedValue({ id: "period_1", status: "finalized" });
  });

  it("carries no gap lines even on the very first send of the month", async () => {
    // Never sent before: `findNotification` is null, so this is the first send,
    // not a re-send.
    const attempt = await sendPayrollNotificationForMonth({
      organizationId: ORG_ID,
      year: 2026,
      month: 8,
      actorUserId: "user_admin",
      actorLabel: "An Administrator",
    });

    expect(attempt.status).toBe("sent");

    const message = sentMessage();
    // The pay is all there. Only the explanation is missing.
    expect(message).toContain("John — Editor");
    expect(message).toContain("Total Northstar Studios Payroll: $3,800");
    expect(message).not.toContain("Some Shorts earned nothing");
    expect(message).not.toContain("Hit bonuses went unpaid");
  });

  /**
   * The message is built from the frozen period and nothing else. A niche read
   * here would be today's niche, and the month is not today's.
   */
  it("reads no niche configuration to make one up", async () => {
    await sendPayrollNotificationForMonth({
      organizationId: ORG_ID,
      year: 2026,
      month: 8,
      actorUserId: "user_admin",
      actorLabel: "An Administrator",
    });

    expect(mocks.getPeriodForOrganization).toHaveBeenCalledTimes(1);
    expect(sentMessage()).not.toMatch(/no hit (payment|threshold|window)/);
  });
});
