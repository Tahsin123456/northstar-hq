#!/usr/bin/env node
/**
 * Runs the opt-in network integration tests.
 *
 * Exists because `VAR=value command` is POSIX shell syntax that cmd.exe does
 * not understand, and this project should not need a cross-env dependency to
 * set one environment variable.
 *
 * These tests reach youtube.com to confirm the one external assumption the
 * Shorts classifier depends on. They use no API quota and need no API key.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const vitestEntrypoints = [
  join(projectRoot, "node_modules", "vitest", "vitest.mjs"),
  join(projectRoot, "node_modules", "vitest", "dist", "cli.js"),
];
const entrypoint = vitestEntrypoints.find((p) => existsSync(p));

if (!entrypoint) {
  console.error("[integration] Could not locate the Vitest CLI. Run `npm install` first.");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [entrypoint, "run", "shorts-probe", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    cwd: projectRoot,
    env: { ...process.env, RUN_NETWORK_TESTS: "true" },
  },
);

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("[integration] Failed to launch Vitest:", err.message);
  process.exit(1);
});
