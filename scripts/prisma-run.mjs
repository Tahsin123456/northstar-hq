#!/usr/bin/env node
/**
 * Provider-aware Prisma launcher.
 *
 * WHY THIS EXISTS
 * `prisma/schema.prisma` is the canonical schema and targets PostgreSQL, which
 * is what this app should run on in production. Prisma does not allow the
 * datasource provider to come from an env var, so running the identical model
 * on SQLite for zero-setup local development needs a derived schema.
 *
 * This script:
 *   1. loads .env.local then .env (first definition wins, like Next.js),
 *   2. looks at DATABASE_URL to decide the provider,
 *   3. for SQLite, writes prisma/.generated/schema.sqlite.prisma — byte-for-byte
 *      the canonical schema with only the `provider` line rewritten,
 *   4. execs the real prisma CLI with the right --schema.
 *
 * The schema is written against the Postgres/SQLite intersection (no enums, no
 * scalar lists, no native type attributes), so the rewrite is genuinely a
 * one-line change and both databases get the same tables, indexes and columns.
 *
 * Usage:  node scripts/prisma-run.mjs generate
 *         node scripts/prisma-run.mjs db push
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalSchema = join(projectRoot, "prisma", "schema.prisma");
const generatedDir = join(projectRoot, "prisma", ".generated");
const sqliteSchema = join(generatedDir, "schema.sqlite.prisma");

const DEFAULT_SQLITE_URL = "file:./prisma/dev.db";

/** Minimal dotenv reader — avoids a dependency for something this small. */
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
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

if (!process.env.DATABASE_URL) {
  // Zero-config path: a brand new checkout with no .env yet still generates.
  process.env.DATABASE_URL = DEFAULT_SQLITE_URL;
}

const url = process.env.DATABASE_URL;
const isSqlite = url.startsWith("file:") || url.startsWith("sqlite:");

// Prisma resolves a relative SQLite path against the *schema file's* directory,
// not the process cwd. Because the SQLite schema is generated into
// prisma/.generated/, a natural-looking "file:./prisma/dev.db" would otherwise
// land at prisma/.generated/prisma/dev.db. Normalise to an absolute path so the
// URL means the same thing here, in the Prisma CLI, and at runtime — see the
// matching logic in src/server/env.ts.
if (isSqlite) {
  const rawPath = url.replace(/^file:/, "").replace(/^sqlite:/, "");
  if (!/^([a-zA-Z]:[\\/]|\/)/.test(rawPath)) {
    const absolute = resolve(projectRoot, rawPath).split(sep).join("/");
    process.env.DATABASE_URL = `file:${absolute}`;
  }
}

let schemaPath = canonicalSchema;

if (isSqlite) {
  const canonical = readFileSync(canonicalSchema, "utf8");
  const rewritten = canonical.replace(
    /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"postgresql"/,
    '$1"sqlite"',
  );
  if (rewritten === canonical) {
    console.error(
      "[prisma-run] Could not rewrite the datasource provider. Has prisma/schema.prisma changed shape?",
    );
    process.exit(1);
  }
  mkdirSync(generatedDir, { recursive: true });
  const header =
    "// AUTO-GENERATED from prisma/schema.prisma by scripts/prisma-run.mjs.\n" +
    "// Do not edit — edit the canonical schema instead.\n\n";
  writeFileSync(sqliteSchema, header + rewritten, "utf8");
  schemaPath = sqliteSchema;
}

const provider = isSqlite ? "sqlite" : "postgresql";

// Pass the schema as a path relative to the project root. The absolute path may
// contain spaces (a Desktop folder, "Program Files", a OneDrive mirror), and
// several layers below us — cmd.exe shims in particular — mangle those.
const relativeSchema = relative(projectRoot, schemaPath).split(sep).join("/");
console.log(`[prisma-run] provider=${provider} schema=./${relativeSchema}`);

const args = [...process.argv.slice(2), "--schema", relativeSchema];

// Prefer invoking Prisma's JS entrypoint with the current Node binary. Going
// through the `prisma` / `prisma.cmd` shim would require `shell: true`, which
// on Windows concatenates argv without quoting and breaks on any path
// containing a space.
const prismaEntrypoints = [
  join(projectRoot, "node_modules", "prisma", "build", "index.js"),
  join(projectRoot, "node_modules", "prisma", "dist", "index.js"),
];
const prismaEntrypoint = prismaEntrypoints.find((p) => existsSync(p));

const child = prismaEntrypoint
  ? spawn(process.execPath, [prismaEntrypoint, ...args], {
      stdio: "inherit",
      cwd: projectRoot,
      env: process.env,
    })
  : spawn(process.platform === "win32" ? "prisma.cmd" : "prisma", args, {
      stdio: "inherit",
      cwd: projectRoot,
      env: process.env,
    });

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("[prisma-run] Failed to launch the Prisma CLI:", err.message);
  process.exit(1);
});
