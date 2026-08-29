import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The audit log must not become the way around `payroll.view` — or around
 * `finance.view`, which is a different permission and must stay one.
 *
 * `employee.pay_updated` is the one entry in this system that carries money in
 * its metadata deliberately: a salary change with no record of what it changed
 * from is not an audit entry. But the entry itself is readable by anyone with
 * `audit.view`, which is a strictly WIDER group — `audit.view` is individually
 * grantable, so an admin can hand somebody the log to investigate an incident
 * and, without the redaction these tests pin down, hand them every salary in
 * the company along with it.
 *
 * The finance half is the same defect one permission over, and it leaked twice:
 * the amounts were in `metadata` (closed by the same key-stripping) AND spelled
 * out in the `summary` prose, which was returned verbatim. Both are covered
 * here, because the prose path is the one that was missed the first time.
 *
 * ONE MONEY FLAG WAS THE OTHER HALF OF THE BUG. `payroll.view` used to decide
 * whether a reader saw ANY amount, which made it a key to the ledger and left
 * `finance.view` unlocking nothing. So these tests assert the cross cases in
 * both directions: payroll alone must not open finance, and finance alone must
 * not open payroll.
 *
 * So the rule under test is: the row is written whole, and the READ decides how
 * much of it the caller may see. Written-side tests could not prove this —
 * the rows that leak today are already in the database.
 *
 * Prisma is mocked rather than run, because none of this is a query. The
 * decision lives entirely in how `listAuditEvents` maps a row it has already
 * fetched, and a test that needed a database to prove it would be testing
 * Prisma.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 9).toString("base64");

/** The row shape `listAuditEvents` selects, as its mapper reads it. */
interface AuditRow {
  id: string;
  action: string;
  summary: string;
  actorUserId: string | null;
  actorLabel: string | null;
  targetType: string | null;
  targetLabel: string | null;
  metadata: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  actor: { name: string | null; email: string | null } | null;
}

/**
 * Mutable stand-in for the table. Hoisted because `vi.mock` factories run
 * before the file body, and the mock has to close over something the tests can
 * still write to.
 */
const db = vi.hoisted(() => ({
  rows: [] as unknown[],
  /** When set, `create` rejects with it — see the logging test at the bottom. */
  createError: null as Error | null,
}));

vi.mock("@/server/db", () => ({
  prisma: {
    auditEvent: {
      findMany: () => Promise.resolve(db.rows),
      count: () => Promise.resolve(db.rows.length),
      create: () => (db.createError ? Promise.reject(db.createError) : Promise.resolve({})),
    },
  },
}));

type AuditServiceModule = typeof import("@/server/audit/audit-service");
type AuditActionsModule = typeof import("@/lib/audit/actions");

let auditService: AuditServiceModule;
let auditActions: AuditActionsModule;

beforeAll(async () => {
  auditService = await import("@/server/audit/audit-service");
  auditActions = await import("@/lib/audit/actions");
});

afterEach(() => {
  db.rows = [];
  db.createError = null;
  vi.restoreAllMocks();
});

const ORG = "org_northstar";

/**
 * Exactly what `updateEmployeePay` writes: the amounts, plus the non-financial
 * context that makes the entry an accountability record.
 */
const PAY_METADATA = {
  currency: "TRY",
  salaryMinorFrom: 4_500_00,
  salaryMinorTo: 5_200_00,
  hitPaymentMinorFrom: 150_00,
  hitPaymentMinorTo: 200_00,
  joinedOn: "2025-01-06T00:00:00.000Z",
  employmentEndedOn: null,
  notesChanged: true,
  created: false,
} as const;

function row(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: "evt_1",
    action: "employee.pay_updated",
    summary: "Updated pay configuration for Deniz",
    actorUserId: "usr_admin",
    actorLabel: "Admin",
    targetType: "user",
    targetLabel: "Deniz",
    metadata: JSON.stringify(PAY_METADATA),
    ipAddress: null,
    userAgent: null,
    createdAt: new Date("2026-08-01T09:00:00.000Z"),
    actor: { name: "Admin", email: "admin@northstarstudios.cc" },
    ...overrides,
  };
}

/**
 * Reads the fixture row as a caller holding exactly the listed money
 * permissions — `undefined` for a call site that passed no flag at all.
 *
 * Spelled as a permission list rather than a boolean because that is the point
 * of the change under test: there is no such thing as "may see money", only
 * "may see payroll figures" and "may see finance figures", and a test helper
 * that collapsed them would be unable to express the cross cases below.
 */
async function firstEntry(held?: readonly ("payroll.view" | "finance.view")[]) {
  const page = await auditService.listAuditEvents({
    organizationId: ORG,
    ...(held === undefined
      ? {}
      : {
          moneyAccess: {
            "payroll.view": held.includes("payroll.view"),
            "finance.view": held.includes("finance.view"),
          },
        }),
  });
  const entry = page.entries[0];
  if (!entry) throw new Error("the fixture row did not come back");
  return entry;
}

/** Nothing beyond `audit.view`. */
const NEITHER: readonly ("payroll.view" | "finance.view")[] = [];

/** Exactly what `createEntry` writes alongside a finance summary. */
const FINANCE_METADATA = {
  kind: "revenue",
  occurredOn: "2026-08-14",
  amountMinor: 410_000,
  currency: "USD",
  baseAmountMinor: 13_940_000,
  baseCurrency: "TRY",
  exchangeRate: 34,
  categoryId: "cat_adsense",
  channelId: "chn_northstar",
} as const;

/**
 * A finance row as the log holds it TODAY — the summary written before the
 * amount was taken out of it.
 *
 * The fixture is deliberately the legacy shape, because that is the row that
 * leaks: every finance entry recorded up to this change still has its figure
 * spelled out in `summary`, and no write-side fix reaches them.
 */
function financeRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return row({
    id: "evt_fin",
    action: "finance.entry_created",
    summary: "Recorded a $4,100.00 revenue entry",
    targetType: "finance_entry",
    targetLabel: "revenue",
    metadata: JSON.stringify(FINANCE_METADATA),
    ...overrides,
  });
}

describe("a reader without payroll.view", () => {
  it("cannot see any amount in an employee.pay_updated entry", async () => {
    db.rows = [row()];

    const entry = await firstEntry(NEITHER);
    const metadata = entry.metadata ?? {};

    // The keys are GONE, not nulled. `salaryMinorTo: null` would read as "pay
    // was set to nothing", which is a false statement rather than a withheld
    // one — and a redaction that lies is worse than the leak it fixes.
    for (const key of [
      "salaryMinorFrom",
      "salaryMinorTo",
      "hitPaymentMinorFrom",
      "hitPaymentMinorTo",
    ]) {
      expect(key in metadata).toBe(false);
    }

    // The figures themselves, checked against the serialised entry rather than
    // key by key: this is the assertion that still fails if somebody adds a
    // fifth amount under a name nobody thought of.
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain("450000");
    expect(serialised).not.toContain("520000");
    expect(serialised).not.toContain("15000");
    expect(serialised).not.toContain("20000");
  });

  it("still gets an entry worth reading", async () => {
    db.rows = [row()];

    const entry = await firstEntry(NEITHER);

    // Redacted, not withheld. Who did it, to whom, when, and which parts of the
    // record moved — everything `audit.view` is granted for survives.
    expect(entry.action).toBe("employee.pay_updated");
    expect(entry.summary).toBe("Updated pay configuration for Deniz");
    expect(entry.actorName).toBe("Admin");
    expect(entry.targetLabel).toBe("Deniz");
    expect(entry.metadata).toMatchObject({
      currency: "TRY",
      joinedOn: "2025-01-06T00:00:00.000Z",
      employmentEndedOn: null,
      notesChanged: true,
      created: false,
    });
  });

  it("is what a call site that forgets the flag gets", async () => {
    db.rows = [row()];

    // The default has to be the safe one. A new caller of `listAuditEvents`
    // that has not thought about payroll must redact, because the failure mode
    // of the other default is silent and total.
    const entry = await firstEntry(undefined);
    expect("salaryMinorTo" in (entry.metadata ?? {})).toBe(false);
  });

  it("keeps non-money entries exactly as they were written", async () => {
    db.rows = [
      row({
        id: "evt_2",
        action: "user.role_changed",
        summary: "Changed Deniz's role",
        metadata: JSON.stringify({ fromRole: "short_form_editor", toRole: "head_of_shorts" }),
      }),
    ];

    // Redaction is keyed on the action, so it must not quietly thin out the
    // rest of the log — an audit trail that drops fields it was not asked to
    // drop is a different bug in the same place.
    const entry = await firstEntry(NEITHER);
    expect(entry.metadata).toEqual({
      fromRole: "short_form_editor",
      toRole: "head_of_shorts",
    });
  });

  it("cannot see an amount that appears under a payroll.* action either", async () => {
    db.rows = [
      row({
        id: "evt_3",
        action: "payroll.record_adjusted",
        summary: "Adjusted Deniz's August payroll — corrected hit count",
        metadata: JSON.stringify({
          year: 2026,
          month: 8,
          reason: "corrected hit count",
          adjustmentMinor: 75_00,
        }),
      }),
    ];

    const entry = await firstEntry(NEITHER);
    // The whole payroll family is covered even though today's writers keep
    // money out of it — the entry that leaks is always the one written after
    // the redaction list was last reviewed.
    expect(entry.metadata).toEqual({ year: 2026, month: 8, reason: "corrected hit count" });
  });
});

describe("a reader with payroll.view", () => {
  it("sees the amounts, which is the whole point of recording them", async () => {
    db.rows = [row()];

    const entry = await firstEntry(["payroll.view"]);
    expect(entry.metadata).toEqual(PAY_METADATA);
  });

  it("sees the before and after, not just the after", async () => {
    db.rows = [row()];

    // The `From`/`To` pair is what makes the entry answer "what changed".
    // Redacting one and keeping the other would leave an entry that looks
    // complete and is not.
    const entry = await firstEntry(["payroll.view"]);
    expect(entry.metadata?.salaryMinorFrom).toBe(4_500_00);
    expect(entry.metadata?.salaryMinorTo).toBe(5_200_00);
  });
});

describe("a reader without finance.view", () => {
  it("cannot see a finance amount in the metadata", async () => {
    db.rows = [financeRow()];

    const entry = await firstEntry(NEITHER);
    const metadata = entry.metadata ?? {};

    for (const key of ["amountMinor", "baseAmountMinor"]) {
      expect(key in metadata).toBe(false);
    }
  });

  it("cannot see a finance amount in the summary either", async () => {
    db.rows = [financeRow()];

    // THE ACTUAL BUG. The metadata path was closed and the prose path was not,
    // so `summary` handed the figure to every holder of `audit.view` — the
    // same defect class as the salary-through-audit leak, one permission over.
    const entry = await firstEntry(NEITHER);
    expect(entry.summary).not.toContain("4,100.00");
    expect(entry.summary).not.toContain("$");

    // Checked against the whole serialised entry too, so a figure that finds a
    // third way out — a target label, a field added later — fails this as well.
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain("410000");
    expect(serialised).not.toContain("13940000");
  });

  it("still gets an entry worth reading", async () => {
    db.rows = [financeRow()];

    // Redacted, not withheld: which side of the ledger, when, in what currency,
    // under which category and channel. Everything except the figure.
    const entry = await firstEntry(NEITHER);
    expect(entry.action).toBe("finance.entry_created");
    expect(entry.summary).toContain("revenue entry");
    expect(entry.metadata).toEqual({
      kind: "revenue",
      occurredOn: "2026-08-14",
      currency: "USD",
      baseCurrency: "TRY",
      exchangeRate: 34,
      categoryId: "cat_adsense",
      channelId: "chn_northstar",
    });
  });

  it("reads a summary written the new way exactly as written", async () => {
    // What `createEntry` writes now: the entry identified, the figure left in
    // the metadata where redaction is exact. The scrub must pass it through
    // untouched — an ISO date is not an amount, and a redaction that eats one
    // is a redaction nobody will trust with the next summary.
    db.rows = [financeRow({ summary: "Recorded a revenue entry dated 2026-08-14" })];

    const entry = await firstEntry(NEITHER);
    expect(entry.summary).toBe("Recorded a revenue entry dated 2026-08-14");
  });

  it("catches the amount however Intl happened to format it", async () => {
    // `formatMoney` goes through Intl, so a stored summary's shape depends on
    // the currency and on the locale of whichever process wrote the row. These
    // are all $4,100.00. The scrub is best-effort by construction — this is the
    // set of shapes it is known to handle, not a proof it handles every one.
    const forms = [
      "Recorded a $4,100.00 revenue entry",
      "Recorded a US$4,100.00 revenue entry",
      "Updated a 4.100,00 € expense entry",
      "Deleted a ¥4100 revenue entry",
      "Imported a 4 100,00 ₺ revenue entry from youtube_ads",
      "Recorded a 4,100.00 TRY revenue entry",
      "Recorded a TRY 4.100,00 revenue entry",
      // Zero-decimal currencies, where the figure has no separator at all.
      "Recorded a 4100 JPY revenue entry",
      "Recorded a JPY 4100 revenue entry",
      "youtube_ads revised a revenue entry from $4,100.00 to $4,250.00",
      /*
       * The two shapes that escaped a review of this scrub, kept here because
       * both failed in ways worth remembering.
       *
       * de-CH groups with an apostrophe. With that character outside the
       * magnitude class the scrub did not merely miss "EUR 13'940.00" — it
       * half-ate "$ 4'100.00" into "[redacted]'100.00", which looks like it
       * worked while the figure is still perfectly readable.
       *
       * he-IL separates the number from the symbol with U+200F, the
       * right-to-left mark: invisible, zero-width, and not matched by JS `\s`,
       * so a gap written as `\s*` could not bridge it at all.
       */
      "Recorded a 4'100.00 CHF revenue entry",
      "Recorded a $ 4'100.00 revenue entry",
      "Recorded a ‏4100 ‏$ revenue entry",
    ];

    for (const summary of forms) {
      db.rows = [financeRow({ summary })];
      const entry = await firstEntry(NEITHER);

      /*
       * ANY run of digits, not the four spellings of "4100".
       *
       * Checking for the literal forms let a PARTIAL redaction pass: with the
       * apostrophe missing from the magnitude class, "$ 4'100.00" came out as
       * "[redacted]'100.00", which contains none of those four strings and is
       * still perfectly readable as the amount. A half-eaten figure is the
       * worst outcome this scrub has — it looks like it worked — so the
       * assertion is that no multi-digit run survives at all.
       */
      expect(entry.summary, `leaked from: ${summary}`).not.toMatch(/\d\d/);
      // Over-redacting is the accepted cost; erasing the sentence is not. The
      // entry must still say which side of the ledger moved.
      expect(entry.summary).toMatch(/revenue|expense/);
    }
  });

  it("leaves a summary with no money in it entirely alone", async () => {
    // Every action outside the money-carrying set skips the scrub, and the
    // scrub itself matches nothing without a currency marker or a grouped
    // number — so an ordinary sentence, a year and a headcount all survive.
    const untouched = [
      "Changed Deniz's role",
      "Finalized August 2026 payroll for 12 employees",
      "Adjusted Deniz's August payroll — corrected hit count",
      "Short content types assigned to 400 videos",
    ];

    for (const summary of untouched) {
      db.rows = [financeRow({ action: "payroll.period_finalized", summary })];
      const entry = await firstEntry(NEITHER);
      expect(entry.summary).toBe(summary);
    }
  });

  it("does not eat the unit out of an exchange-rate summary", async () => {
    // `finance.rate_updated` writes "Set 1 USD = 34.15 TRY". The "1 USD" is a
    // ratio's left-hand side, not an amount, and a scrub that took it would
    // leave a sentence saying nothing — which is the one failure mode worse
    // than over-redacting. The rate itself is finance data and may go.
    db.rows = [
      financeRow({ action: "finance.rate_updated", summary: "Set 1 USD = 34.15 TRY" }),
    ];

    const entry = await firstEntry(NEITHER);
    expect(entry.summary).toContain("1 USD");
    expect(entry.summary).not.toContain("34.15");
  });
});

describe("a reader with finance.view", () => {
  it("sees the finance amounts, in the metadata and in the prose", async () => {
    db.rows = [financeRow()];

    const entry = await firstEntry(["finance.view"]);
    expect(entry.metadata).toEqual(FINANCE_METADATA);
    // Legacy rows keep their original wording for a reader entitled to it:
    // the scrub is a permission boundary, not a migration.
    expect(entry.summary).toBe("Recorded a $4,100.00 revenue entry");
  });
});

describe("holding one money permission does not unlock the other", () => {
  it("does not let payroll.view read a finance figure", async () => {
    db.rows = [financeRow()];

    // The bug this replaced: ONE flag, resolved from `payroll.view`, decided
    // whether a reader saw any amount at all. Somebody trusted with salaries
    // was thereby handed the ledger.
    const entry = await firstEntry(["payroll.view"]);

    expect("amountMinor" in (entry.metadata ?? {})).toBe(false);
    expect(entry.summary).not.toContain("4,100.00");
    expect(JSON.stringify(entry)).not.toContain("410000");
  });

  it("does not let finance.view read a salary", async () => {
    db.rows = [row()];

    // The mirror image, and the one the old code would have introduced next:
    // `finance.view` is individually grantable, so an accountant given the
    // ledger must not thereby read what their colleagues are paid.
    const entry = await firstEntry(["finance.view"]);

    expect("salaryMinorTo" in (entry.metadata ?? {})).toBe(false);
    expect(JSON.stringify(entry)).not.toContain("520000");
  });

  it("does not let finance.view read a payroll.* figure", async () => {
    db.rows = [
      row({
        id: "evt_pay",
        action: "payroll.record_adjusted",
        summary: "Adjusted Deniz's August payroll — corrected hit count",
        metadata: JSON.stringify({ year: 2026, month: 8, adjustmentMinor: 75_00 }),
      }),
    ];

    const entry = await firstEntry(["finance.view"]);
    expect(entry.metadata).toEqual({ year: 2026, month: 8 });
  });

  it("gives a reader holding both everything", async () => {
    db.rows = [financeRow()];
    expect((await firstEntry(["payroll.view", "finance.view"])).metadata).toEqual(
      FINANCE_METADATA,
    );

    db.rows = [row()];
    expect((await firstEntry(["payroll.view", "finance.view"])).metadata).toEqual(PAY_METADATA);
  });
});

describe("the money-carrying action set", () => {
  it("covers a payroll action nobody has written yet", () => {
    // Covered by prefix rather than enumeration, so a payroll key added next
    // month is redacted from the moment it exists rather than from the moment
    // somebody remembers this list.
    expect(auditActions.carriesMoneyMetadata("payroll.some_future_key")).toBe(true);
    expect(auditActions.carriesMoneyMetadata("employee.pay_updated")).toBe(true);
  });

  it("does not sweep in the rest of the log", () => {
    for (const action of ["auth.signed_in", "user.role_changed", "channel.added"]) {
      expect(auditActions.carriesMoneyMetadata(action)).toBe(false);
    }
  });

  it("says WHICH permission each action's figures belong to", () => {
    // One classification, not two. The prefixes that decide whether an action
    // carries money are the same ones that decide whose money it is, so the
    // two answers cannot drift apart.
    expect(auditActions.moneyPermissionFor("finance.entry_created")).toBe("finance.view");
    expect(auditActions.moneyPermissionFor("finance.some_future_key")).toBe("finance.view");
    expect(auditActions.moneyPermissionFor("payroll.record_adjusted")).toBe("payroll.view");
    expect(auditActions.moneyPermissionFor("payroll.some_future_key")).toBe("payroll.view");
    expect(auditActions.moneyPermissionFor("employee.pay_updated")).toBe("payroll.view");
    expect(auditActions.moneyPermissionFor("user.role_changed")).toBeNull();
  });
});

describe("a failed audit write", () => {
  it("does not print the salary it was trying to record", async () => {
    // A PrismaClientValidationError renders the rejected call — `data` and all
    // — into its own message. Logging the error whole would put the salary in a
    // server log, which answers to no permission at all and outlives the
    // request. This is the shape of that message.
    const validationError = new Error(
      [
        "",
        "Invalid `prisma.auditEvent.create()` invocation:",
        "",
        "{",
        "  data: {",
        '    metadata: "{\\"salaryMinorTo\\":520000}"',
        "  }",
        "}",
        "Unknown argument `metadata`.",
      ].join("\n"),
    );
    validationError.name = "PrismaClientValidationError";
    db.createError = validationError;

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await auditService.recordAudit(
      { organizationId: ORG, actorUserId: "usr_admin" },
      {
        action: "employee.pay_updated",
        summary: "Updated pay configuration for Deniz",
        metadata: { ...PAY_METADATA },
      },
    );

    expect(logged).toHaveBeenCalledTimes(1);
    const args = logged.mock.calls[0] ?? [];

    // The error object is never an argument: console.error would render its
    // message and stack, and the message is the leak.
    for (const arg of args) {
      expect(arg).not.toBeInstanceOf(Error);
    }

    const line = args.join(" ");
    expect(line).not.toContain("520000");
    expect(line).not.toContain("salaryMinorTo");
    // Still debuggable: which action failed, and what kind of failure it was.
    expect(line).toContain("employee.pay_updated");
    expect(line).toContain("PrismaClientValidationError");
  });

  it("never rethrows, so the action it describes still succeeds", async () => {
    db.createError = new Error("database is gone");

    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      auditService.recordAudit(
        { organizationId: ORG },
        { action: "auth.signed_in", summary: "Signed in" },
      ),
    ).resolves.toBeUndefined();
  });
});
