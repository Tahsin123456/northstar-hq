import { PrismaClient } from "@prisma/client";

// Importing env for its side effect: it validates configuration and normalises
// DATABASE_URL *before* PrismaClient reads it.
import { env } from "./env";

/**
 * Prisma client singleton.
 *
 * Next.js dev mode re-evaluates modules on every hot reload; without the global
 * cache each reload would open a fresh connection pool until the database
 * refuses new connections.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.isProduction ? ["error"] : ["error", "warn"],
  });

if (!env.isProduction) {
  globalForPrisma.prisma = prisma;
}
