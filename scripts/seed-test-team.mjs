/**
 * Seeds a test team into the LOCAL database so the employee and payroll
 * systems can be exercised against realistic data.
 *
 * The brief asks for verification with multiple employees across multiple
 * niches, different roles, and correct per-niche thresholds. Doing that by hand
 * through the UI would take twenty minutes and would not be repeatable.
 *
 * REFUSES TO RUN AGAINST POSTGRES. These are fictional people with fictional
 * salaries; they belong nowhere near the production database.
 *
 *   node scripts/seed-test-team.mjs          # create
 *   node scripts/seed-test-team.mjs --clean  # remove everything it created
 */
import path from "node:path";
import process from "node:process";
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? `file:${path.resolve(process.cwd(), "prisma/dev.db").split(path.sep).join("/")}`;
if (!url.startsWith("file:")) {
  console.error("Refusing to run: DATABASE_URL is not a local SQLite file.");
  console.error("This seeds fictional employees and salaries and must never touch production.");
  process.exit(1);
}
process.env.DATABASE_URL = url;

const prisma = new PrismaClient();
const CLEAN = process.argv.includes("--clean");

/** Everything this script creates is tagged, so --clean is exact. */
const TEST_EMAIL_DOMAIN = "@payroll-test.invalid";

const TEAM = [
  {
    email: `john${TEST_EMAIL_DOMAIN}`,
    name: "John Carter",
    role: "head_of_shorts",
    niches: ["GTA", "Red Dead Redemption", "The Last of Us"],
    salaryMinor: 400_000, // $4,000
    hitPaymentMinor: 1_000, // $10
  },
  {
    email: `alex${TEST_EMAIL_DOMAIN}`,
    name: "Alex Rivera",
    role: "short_form_editor",
    niches: ["GTA"],
    salaryMinor: 200_000, // $2,000
    hitPaymentMinor: 500, // $5
  },
  {
    email: `priya${TEST_EMAIL_DOMAIN}`,
    name: "Priya Shah",
    role: "short_form_editor",
    niches: ["Red Dead Redemption", "The Last of Us"],
    salaryMinor: 220_000,
    hitPaymentMinor: 700,
  },
  {
    email: `marcus${TEST_EMAIL_DOMAIN}`,
    name: "Marcus Bell",
    role: "short_form_clip_producer",
    niches: ["The Last of Us"],
    salaryMinor: 150_000,
    hitPaymentMinor: 300,
  },
  {
    // No niches on purpose: a niche-scoped role with nothing assigned must see
    // nothing and earn no bonus, rather than falling through to everything.
    email: `dana${TEST_EMAIL_DOMAIN}`,
    name: "Dana Okoro",
    role: "long_form_editor",
    niches: [],
    salaryMinor: 180_000,
    hitPaymentMinor: 400,
  },
  {
    // Sits behind the approval gate, so the pending state is visible in the UI.
    email: `sam${TEST_EMAIL_DOMAIN}`,
    name: "Sam Whitfield",
    role: "short_form_editor",
    niches: ["GTA"],
    salaryMinor: 190_000,
    hitPaymentMinor: 500,
    status: "pending_approval",
  },
];

async function clean(organizationId) {
  const users = await prisma.appUser.findMany({
    where: { email: { endsWith: TEST_EMAIL_DOMAIN } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) {
    console.log("Nothing to clean.");
    return;
  }

  // Payroll records carry no foreign key to the user by design, so they are
  // removed by id rather than by cascade.
  await prisma.payrollHit.deleteMany({ where: { record: { userId: { in: ids } } } });
  await prisma.payrollRecord.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: ids } } });
  await prisma.appUser.deleteMany({ where: { id: { in: ids } } });

  // Periods left with no records are noise.
  const empty = await prisma.payrollPeriod.findMany({
    where: { organizationId, records: { none: {} } },
    select: { id: true },
  });
  await prisma.payrollPeriod.deleteMany({ where: { id: { in: empty.map((p) => p.id) } } });

  console.log(`Removed ${ids.length} test accounts and their payroll rows.`);
}

async function main() {
  const organization = await prisma.organization.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
  if (!organization) throw new Error("No organization. Run scripts/backfill-organization.mjs first.");

  if (CLEAN) {
    await clean(organization.id);
    return;
  }

  const niches = await prisma.niche.findMany({
    where: { organizationId: organization.id },
    select: { id: true, name: true, hitThreshold: true },
  });
  const nicheByName = new Map(niches.map((n) => [n.name, n]));

  console.log(`Organization: ${organization.name}`);
  console.log("Niches and their thresholds (payroll reads these, not a copy):");
  for (const niche of niches) {
    console.log(`   ${niche.name.padEnd(24)} ${niche.hitThreshold?.toLocaleString() ?? "inherits"}`);
  }
  console.log();

  for (const member of TEAM) {
    const user = await prisma.appUser.upsert({
      where: { email: member.email },
      update: { name: member.name, status: member.status ?? "active" },
      create: {
        email: member.email,
        name: member.name,
        status: member.status ?? "active",
        // No passwordHash: these accounts exist to be looked at, not signed
        // into. An account with no password cannot authenticate.
        settings: { create: {} },
      },
      select: { id: true },
    });

    const membership = await prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
      update: { role: member.role },
      create: { organizationId: organization.id, userId: user.id, role: member.role },
      select: { id: true },
    });

    await prisma.employeeProfile.upsert({
      where: { userId: user.id },
      update: {
        salaryMinor: member.salaryMinor,
        hitPaymentMinor: member.hitPaymentMinor,
      },
      create: {
        organizationId: organization.id,
        userId: user.id,
        salaryMinor: member.salaryMinor,
        hitPaymentMinor: member.hitPaymentMinor,
        currency: "USD",
        joinedOn: new Date(Date.UTC(2026, 0, 15)),
      },
    });

    await prisma.memberNiche.deleteMany({ where: { memberId: membership.id } });
    for (const nicheName of member.niches) {
      const niche = nicheByName.get(nicheName);
      if (!niche) {
        console.log(`   ! ${member.name}: no niche called "${nicheName}"`);
        continue;
      }
      await prisma.memberNiche.create({
        data: { memberId: membership.id, nicheId: niche.id },
      });
    }

    console.log(
      `   ${member.name.padEnd(16)} ${member.role.padEnd(26)} ` +
        `$${(member.salaryMinor / 100).toLocaleString()}/mo + $${member.hitPaymentMinor / 100}/hit  ` +
        `[${member.niches.join(", ") || "no niches"}]` +
        (member.status === "pending_approval" ? "  (awaiting approval)" : ""),
    );
  }

  console.log(`\n${TEAM.length} test employees ready. Remove them with --clean.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
