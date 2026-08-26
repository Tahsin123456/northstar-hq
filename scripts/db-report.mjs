#!/usr/bin/env node
/**
 * Database report.
 *
 *   npm run db:report
 *
 * Prints what is actually stored: row counts, how every video was classified
 * and by which signal, the refresh audit trail, and total YouTube quota spent.
 *
 * Useful for answering "is the Shorts classifier behaving?" and "how much
 * quota have I burned today?" without opening Prisma Studio.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(join(projectRoot, ".env.local"));
loadEnvFile(join(projectRoot, ".env"));

process.env.DATABASE_URL ??= "file:./prisma/dev.db";

// Match the runtime's SQLite path normalisation (see src/server/env.ts).
if (process.env.DATABASE_URL.startsWith("file:")) {
  const rawPath = process.env.DATABASE_URL.replace(/^file:/, "");
  if (!/^([a-zA-Z]:[\\/]|\/)/.test(rawPath)) {
    process.env.DATABASE_URL = `file:${resolve(projectRoot, rawPath).split(sep).join("/")}`;
  }
}

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();

try {
  const [channels, tracked, activeTracked, videos, shorts, snapshots, runs] =
    await Promise.all([
      prisma.channel.count(),
      prisma.trackedChannel.count(),
      prisma.trackedChannel.count({ where: { isActive: true } }),
      prisma.video.count(),
      prisma.video.count({ where: { isShort: true } }),
      prisma.videoSnapshot.count(),
      prisma.channelRefreshRun.count(),
    ]);

  const classification = await prisma.video.groupBy({
    by: ["classification", "classificationMethod"],
    _count: { _all: true },
    orderBy: { _count: { classification: "desc" } },
  });

  const runRows = await prisma.channelRefreshRun.findMany({
    select: {
      status: true,
      trigger: true,
      videosDiscovered: true,
      shortsClassified: true,
      snapshotsWritten: true,
      quotaUnitsUsed: true,
      startedAt: true,
      error: true,
    },
    orderBy: { startedAt: "desc" },
    take: 10,
  });

  const quotaToday = runRows
    .filter((r) => Date.now() - r.startedAt.getTime() < 86_400_000)
    .reduce((sum, r) => sum + r.quotaUnitsUsed, 0);

  console.log("\n=== Storage ===");
  console.table({
    channels,
    trackedTotal: tracked,
    trackedActive: activeTracked,
    videos,
    shorts,
    excluded: videos - shorts,
    snapshots,
    refreshRuns: runs,
  });

  const ownership = await prisma.trackedChannel.groupBy({
    by: ["ownershipType"],
    where: { isActive: true },
    _count: { _all: true },
  });

  const nicheRows = await prisma.niche.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      _count: { select: { channels: { where: { trackedChannel: { isActive: true } } } } },
    },
  });

  const uncategorised = await prisma.trackedChannel.count({
    where: { isActive: true, niches: { none: {} } },
  });

  console.log("\n=== Ownership ===");
  console.table(
    ownership.map((row) => ({ type: row.ownershipType, channels: row._count._all })),
  );

  console.log("\n=== Niches ===");
  if (nicheRows.length === 0) {
    console.log("(none defined)");
  } else {
    console.table(
      nicheRows.map((row) => ({ niche: row.name, channels: row._count.channels })),
    );
  }
  console.log(`Uncategorised tracked channels: ${uncategorised}`);

  console.log("\n=== Shorts classification ===");
  console.table(
    classification.map((row) => ({
      classification: row.classification,
      signal: row.classificationMethod,
      videos: row._count._all,
    })),
  );

  console.log("\n=== Recent refreshes ===");
  console.table(
    runRows.map((row) => ({
      when: row.startedAt.toISOString().replace("T", " ").slice(0, 19),
      trigger: row.trigger,
      status: row.status,
      found: row.videosDiscovered,
      classified: row.shortsClassified,
      snapshots: row.snapshotsWritten,
      quota: row.quotaUnitsUsed,
      error: row.error ?? "",
    })),
  );

  console.log(
    `\nYouTube quota used in the last 24h: ${quotaToday} units (daily allowance is typically 10,000)\n`,
  );
} finally {
  await prisma.$disconnect();
}
