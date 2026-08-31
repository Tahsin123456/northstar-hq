#!/usr/bin/env node
/**
 * Applies pending migrations, but only where migrations are how the schema
 * actually travels.
 *
 * WHY THIS IS NOT JUST `prisma migrate deploy` IN THE BUILD SCRIPT
 * The two databases this project runs on get their schema by different routes,
 * and that asymmetry is deliberate rather than an oversight. Production is
 * Postgres with a migration history. Local development is a SQLite file created
 * by `db push` — no history, no `_prisma_migrations` table — because the whole
 * point of the SQLite path is zero setup for someone cloning the repo.
 *
 * Running `migrate deploy` against that SQLite file fails with P3005 ("the
 * database schema is not empty"), which is Prisma correctly refusing to assume
 * an unbaselined database matches migration one. Wiring the bare command into
 * `npm run build` therefore fixed deployment and broke every local build — the
 * shape of fix that gets reverted in a hurry a week later by someone who does
 * not know why it was there.
 *
 * So: look at DATABASE_URL, and migrate only when it points at Postgres.
 *
 * WHY FAILING IS THE RIGHT OUTCOME IN PRODUCTION
 * When this does run and cannot apply a migration, it exits non-zero and takes
 * the build with it. That is the desired behaviour: Vercel does not promote a
 * failed build, so the alias stays on the previous deployment — code that
 * matches the schema the database is actually on. The alternative is a green
 * build serving queries against columns that do not exist yet.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Reads DATABASE_URL the way the app does.
 *
 * The environment wins: on Vercel the variable is injected and no .env file
 * exists, and locally the file is the only source. Checking the environment
 * first means a developer with a Postgres URL exported gets the production
 * behaviour, which is what they asked for by exporting it.
 */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  for (const file of [".env.local", ".env"]) {
    const path = join(projectRoot, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^\s*DATABASE_URL\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      // Strip one layer of quotes, the way every dotenv reader does.
      return match[1].trim().replace(/^["'](.*)["']$/s, "$1");
    }
  }
  return null;
}

const url = databaseUrl();
const isPostgres = url !== null && /^postgres(ql)?:\/\//i.test(url);

if (!isPostgres) {
  // Not an error. A SQLite dev database is a supported, documented state, and a
  // build that stopped here would be refusing to work for the reason the SQLite
  // path exists.
  console.log(
    `  migrations: skipped — DATABASE_URL is ${url === null ? "not set" : "not Postgres"}, ` +
      "so this is a local SQLite database kept in sync by `npm run db:push`.",
  );
  process.exit(0);
}

console.log("  migrations: applying any pending ones before the build...");

const child = spawn(
  process.execPath,
  [join(projectRoot, "scripts", "prisma-run.mjs"), "migrate", "deploy"],
  { stdio: "inherit", cwd: projectRoot },
);

child.on("close", (code) => {
  if (code !== 0) {
    console.error(
      "\n  A migration could not be applied, so the build is being failed on purpose.\n" +
        "  Nothing is deployed and the live site stays on the previous version, whose\n" +
        "  code matches the schema the database is actually on.\n",
    );
  }
  process.exit(code ?? 1);
});
