import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The audit log must not become the way around `payroll.view`.
 *
 * `employee.pay_updated` is the one entry in this system that carries money in
 * its metadata, and it carries it deliberately: a salary change with no record
 * of what it changed from is not an audit entry. But the entry itself is
 * readable by anyone with `audit.view`, which is a strictly WIDER group —
 * `audit.view` is individually grantable, so an admin can hand somebody the log
 * to investigate an incident and, without the redaction these tests pin down,
 * hand them every salary in the company along with it.
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

async function firstEntry(includeSensitiveMetadata?: boolean) {
  const page = await auditService.listAuditEvents({
    organizationId: ORG,
    ...(includeSensitiveMetadata === undefined ? {} : { includeSensitiveMetadata }),
  });
  const entry = page.entries[0];
  if (!entry) throw new Error("the fixture row did not come back");
  return entry;
}

describe("a reader without payroll.view", () => {
  it("cannot see any amount in an employee.pay_updated entry", async () => {
    db.rows = [row()];

    const entry = await firstEntry(false);
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

    const entry = await firstEntry(false);

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
    const entry = await firstEntry(false);
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

    const entry = await firstEntry(false);
    // The whole payroll family is covered even though today's writers keep
    // money out of it — the entry that leaks is always the one written after
    // the redaction list was last reviewed.
    expect(entry.metadata).toEqual({ year: 2026, month: 8, reason: "corrected hit count" });
  });
});

describe("a reader with payroll.view", () => {
  it("sees the amounts, which is the whole point of recording them", async () => {
    db.rows = [row()];

    const entry = await firstEntry(true);
    expect(entry.metadata).toEqual(PAY_METADATA);
  });

  it("sees the before and after, not just the after", async () => {
    db.rows = [row()];

    // The `From`/`To` pair is what makes the entry answer "what changed".
    // Redacting one and keeping the other would leave an entry that looks
    // complete and is not.
    const entry = await firstEntry(true);
    expect(entry.metadata?.salaryMinorFrom).toBe(4_500_00);
    expect(entry.metadata?.salaryMinorTo).toBe(5_200_00);
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
