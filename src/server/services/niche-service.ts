/**
 * Niche management — create, rename, delete, assign.
 *
 * Niches are entirely team-defined. Nothing is hardcoded: the app ships with
 * no niches at all and the organization builds whatever taxonomy fits how it
 * actually works. Deleting a niche unassigns it from every channel but never
 * touches the channels themselves.
 *
 * The taxonomy belongs to the ORGANIZATION, not to whoever typed it in. Two
 * people on the same team filtering by "GTA" must be filtering by the same
 * niche, so every query here scopes on `organizationId`; `createdById` is
 * recorded for the byline only and is never used to decide who may see or edit
 * a niche.
 */

import { z } from "zod";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import { MAX_THRESHOLD, MIN_THRESHOLD } from "@/lib/analytics/constants";
import { toNicheDTO } from "@/server/mappers";
import type { NicheDTO } from "@/lib/dto";
import { getCurrentOrgId, getScope } from "./user-service";

/** How many accent colours the niche chips cycle through (`--chart-1..6`). */
const NICHE_COLOR_COUNT = 6;

export const nicheNameSchema = z
  .string()
  .trim()
  .min(1, "Give the niche a name.")
  .max(48, "Niche names must be 48 characters or fewer.");

export const createNicheSchema = z.object({
  name: nicheNameSchema,
  colorIndex: z.number().int().min(0).max(NICHE_COLOR_COUNT - 1).optional(),
  hitThreshold: z.number().int().min(MIN_THRESHOLD).max(MAX_THRESHOLD).nullable().optional(),
});

export const updateNicheSchema = z.object({
  name: nicheNameSchema.optional(),
  colorIndex: z.number().int().min(0).max(NICHE_COLOR_COUNT - 1).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  /** `null` clears the override and returns the niche to the organization default. */
  hitThreshold: z
    .number()
    .int()
    .min(MIN_THRESHOLD)
    .max(MAX_THRESHOLD)
    .nullable()
    .optional(),
});

/**
 * Case- and whitespace-insensitive key.
 *
 * SQLite and PostgreSQL disagree about case-insensitive collation, so
 * uniqueness is enforced on a normalised column rather than relying on the
 * database to be clever. "GTA", "gta" and " Gta " all collide, which is what a
 * user expects when they accidentally create a niche twice.
 */
function toSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function listNiches(): Promise<NicheDTO[]> {
  const organizationId = await getCurrentOrgId();

  const niches = await prisma.niche.findMany({
    // The whole team shares one taxonomy, so this lists the organization's
    // niches rather than the ones the signed-in user happened to create.
    where: { organizationId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      _count: {
        // Only count channels still in the tracker — a niche should not claim
        // channels the team has removed.
        select: { channels: { where: { trackedChannel: { isActive: true } } } },
      },
    },
  });

  return niches.map((niche) => toNicheDTO(niche, niche._count.channels));
}

export async function createNiche(input: {
  name: string;
  colorIndex?: number;
  hitThreshold?: number | null;
}): Promise<NicheDTO> {
  // Both halves of the scope: the organization decides where the row lives and
  // what it collides with, the user is recorded only as its author.
  const { organizationId, userId } = await getScope();
  const name = input.name.trim();
  const slug = toSlug(name);

  // Uniqueness is per organization: one team cannot hold two "GTA" niches, but
  // another team's "GTA" is a different row and must not block this one.
  const existing = await prisma.niche.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
  });
  if (existing) {
    throw errors.invalidInput(`A niche called “${existing.name}” already exists.`);
  }

  const count = await prisma.niche.count({ where: { organizationId } });

  const niche = await prisma.niche.create({
    data: {
      organizationId,
      // Attribution for the byline. Never read back as a filter — a niche is
      // the team's the moment it exists, including after its author leaves.
      createdById: userId,
      name,
      slug,
      // Cycle the accent so consecutively created niches are visually distinct
      // without the user having to pick a colour.
      colorIndex: input.colorIndex ?? count % NICHE_COLOR_COUNT,
      hitThreshold: input.hitThreshold ?? null,
      sortOrder: count,
    },
  });

  return toNicheDTO(niche, 0);
}

export async function updateNiche(
  nicheId: string,
  update: {
    name?: string;
    colorIndex?: number;
    sortOrder?: number;
    hitThreshold?: number | null;
  },
): Promise<NicheDTO> {
  const organizationId = await getCurrentOrgId();

  // Scoped by organization, not by author: any teammate may rename or recolour
  // a shared niche. The scope clause is still what makes an id from another
  // tenant read as "not found" rather than as someone else's row.
  const niche = await prisma.niche.findFirst({ where: { id: nicheId, organizationId } });
  if (!niche) throw errors.notFound("niche");

  const data: {
    name?: string;
    slug?: string;
    colorIndex?: number;
    sortOrder?: number;
    hitThreshold?: number | null;
  } = {};

  if (update.name !== undefined) {
    const name = update.name.trim();
    const slug = toSlug(name);
    if (slug !== niche.slug) {
      const clash = await prisma.niche.findUnique({
        where: { organizationId_slug: { organizationId, slug } },
      });
      if (clash) {
        throw errors.invalidInput(`A niche called “${clash.name}” already exists.`);
      }
    }
    data.name = name;
    data.slug = slug;
  }

  if (update.colorIndex !== undefined) data.colorIndex = update.colorIndex;
  if (update.sortOrder !== undefined) data.sortOrder = update.sortOrder;
  if (update.hitThreshold !== undefined) data.hitThreshold = update.hitThreshold;

  const updated = await prisma.niche.update({
    where: { id: niche.id },
    data,
    include: {
      _count: { select: { channels: { where: { trackedChannel: { isActive: true } } } } },
    },
  });

  return toNicheDTO(updated, updated._count.channels);
}

/**
 * Delete a niche.
 *
 * The join rows cascade, so every channel filed under it simply becomes
 * unassigned. No channel, video or snapshot is affected — deleting a label
 * must never destroy data the label was attached to.
 */
export async function deleteNiche(nicheId: string): Promise<{ unassignedChannels: number }> {
  const organizationId = await getCurrentOrgId();

  const niche = await prisma.niche.findFirst({
    // Deleting is a team action on a team-owned label, so the guard is the
    // organization. Being the creator grants nothing extra here, and not being
    // the creator takes nothing away.
    where: { id: nicheId, organizationId },
    include: { _count: { select: { channels: true } } },
  });
  if (!niche) throw errors.notFound("niche");

  await prisma.niche.delete({ where: { id: niche.id } });

  return { unassignedChannels: niche._count.channels };
}

/**
 * Replace a tracked channel's niche assignments wholesale.
 *
 * Set semantics rather than add/remove: the client sends the complete desired
 * list and the server reconciles. That makes the operation idempotent and
 * removes a whole class of drift bugs from partial updates.
 */
export async function setChannelNiches(
  channelId: string,
  nicheIds: readonly string[],
): Promise<void> {
  const organizationId = await getCurrentOrgId();

  const tracking = await prisma.trackedChannel.findFirst({
    where: { organizationId, channelId },
    select: { id: true },
  });
  if (!tracking) throw errors.notFound("channel");

  const unique = [...new Set(nicheIds)];

  if (unique.length > 0) {
    // Verify every id belongs to this ORGANIZATION before writing anything.
    // Both sides of this join are scoped above — the tracked channel and now
    // the niches — which is what stops a crafted request from filing one
    // tenant's channel under another tenant's niche. Note the check is
    // deliberately not narrowed to the caller: a teammate's niche is a valid
    // choice, a stranger's is not.
    const owned = await prisma.niche.findMany({
      where: { id: { in: unique }, organizationId },
      select: { id: true },
    });
    if (owned.length !== unique.length) {
      throw errors.invalidInput("One or more of those niches no longer exists.");
    }
  }

  await prisma.$transaction([
    prisma.trackedChannelNiche.deleteMany({
      where: { trackedChannelId: tracking.id },
    }),
    ...(unique.length > 0
      ? [
          prisma.trackedChannelNiche.createMany({
            data: unique.map((nicheId) => ({ trackedChannelId: tracking.id, nicheId })),
          }),
        ]
      : []),
  ]);
}

/** Resolves niche names to ids, creating any that do not exist yet. */
export async function resolveOrCreateNiches(
  names: readonly string[],
): Promise<string[]> {
  // Hoisted out of the loop: the scope cannot change between iterations, and
  // resolving it once makes it obvious that every lookup below shares one
  // organization.
  const organizationId = await getCurrentOrgId();

  const ids: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const slug = toSlug(trimmed);
    // Reuses the team's existing niche when the name already exists, so an
    // import does not mint a duplicate "Gaming" alongside a colleague's.
    const existing = await prisma.niche.findUnique({
      where: { organizationId_slug: { organizationId, slug } },
    });
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const created = await createNiche({ name: trimmed });
    ids.push(created.id);
  }
  return ids;
}
