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
 *
 * TWO PERMISSIONS, NOT ONE
 * Creating and naming a niche is `niches.manage` — a Head of Shorts organises
 * their own taxonomy and does not need an admin to do it. Setting its
 * `hitThreshold` is `settings.manage`, and that split is deliberate: the
 * threshold is not a property of the label, it is the definition of a hit for
 * every chart, every report and the payroll run, which is precisely the
 * organization-wide analysis configuration `settings.manage` already guards.
 *
 * The check lives in this file rather than only in the route because a service
 * function is reachable from anywhere on the server — another service, a job, a
 * future route somebody writes in a hurry. A rule enforced one layer up is a
 * rule that holds only for the callers that happen to exist today.
 */

import { z } from "zod";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import { requireActor } from "@/server/auth/dal";
import {
  MAX_HIT_WINDOW_HOURS,
  MAX_THRESHOLD,
  MIN_HIT_WINDOW_HOURS,
  MIN_THRESHOLD,
} from "@/lib/analytics/constants";
import { toNicheDTO } from "@/server/mappers";
import type { NicheDTO } from "@/lib/dto";
import { getCurrentOrgId, getScope } from "./user-service";
import { reevaluateHitsForNiche } from "./hit-evaluation-service";

/**
 * The columns needed to name a niche's author.
 *
 * Selected explicitly rather than including the whole user: an admin's list of
 * niches has no business carrying password hashes across a service boundary,
 * however carefully the DTO is written afterwards.
 */
const AUTHOR_SELECT = { select: { id: true, name: true, email: true } } as const;

/**
 * Refuses a rule write from somebody who may organise niches but may not
 * configure the organization's analysis.
 *
 * BOTH HALVES ARE THE SAME PERMISSION. The window is not a lesser setting than
 * the threshold — "1M views ever" and "1M views in 48 hours" are different
 * definitions of a hit, and the second one is a bigger claim than the first.
 * Guarding the number and leaving the clock open would let an employee redefine
 * every chart and every bonus by editing the half nobody thought to protect.
 *
 * Called only when the caller actually sent one of the fields. Omitting them is
 * not an attempt to set them, so an employee creating an ordinary niche never
 * touches this path — but sending an explicit `null` *is* a write (it clears
 * the number), and is refused for the same reason setting one is.
 */
async function assertMayConfigureRule(): Promise<void> {
  const actor = await requireActor();
  if (!actor.permissions.has("settings.manage")) {
    throw errors.forbidden(
      "set a hit rate threshold. Hit rate thresholds and windows are configured by an Admin",
    );
  }
}

/** True when the caller sent the field at all, an explicit null included. */
function sent(input: object, key: string): boolean {
  return key in input && (input as Record<string, unknown>)[key] !== undefined;
}

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
  hitWindowHours: z
    .number()
    .int()
    .min(MIN_HIT_WINDOW_HOURS)
    .max(MAX_HIT_WINDOW_HOURS)
    .nullable()
    .optional(),
});

export const updateNicheSchema = z.object({
  name: nicheNameSchema.optional(),
  colorIndex: z.number().int().min(0).max(NICHE_COLOR_COUNT - 1).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  /**
   * `null` clears the threshold, leaving the niche unconfigured — which is now
   * a visible state ("Hit rate threshold: Not configured"), not a quiet fall
   * back to the organization default.
   */
  hitThreshold: z
    .number()
    .int()
    .min(MIN_THRESHOLD)
    .max(MAX_THRESHOLD)
    .nullable()
    .optional(),
  /**
   * The other half of the rule, in hours. `null` clears it and leaves the niche
   * unscoreable — a visible state, not a quiet fall back to anything.
   */
  hitWindowHours: z
    .number()
    .int()
    .min(MIN_HIT_WINDOW_HOURS)
    .max(MAX_HIT_WINDOW_HOURS)
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
      // The byline. An admin looking at a niche that still needs a threshold
      // has to know whose niche it is before they can ask what the number
      // should be — "Needs hit rate configuration" with no name attached is a
      // task with nobody to talk to.
      createdBy: AUTHOR_SELECT,
      _count: {
        // Only count channels still in the tracker — a niche should not claim
        // channels the team has removed.
        select: { channels: { where: { trackedChannel: { isActive: true } } } },
      },
    },
  });

  return niches.map((niche) =>
    toNicheDTO(niche, niche._count.channels, niche.createdBy),
  );
}

export async function createNiche(input: {
  name: string;
  colorIndex?: number;
  hitThreshold?: number | null;
  hitWindowHours?: number | null;
}): Promise<NicheDTO> {
  // The threshold check comes before anything is read or written. An employee's
  // create request that carries a threshold is REFUSED, not quietly stripped:
  // silently dropping it would create the niche and tell them nothing, and they
  // would go on believing they had set a number that does not exist.
  //
  // `in` rather than `!== undefined` so an explicit `hitThreshold: null` is
  // caught too — clearing a threshold is a threshold write.
  if (sent(input, "hitThreshold") || sent(input, "hitWindowHours")) {
    await assertMayConfigureRule();
  }

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
      // Null when an employee created it, and null is a real state now: the
      // niche exists, works as a filter, and reports no hit rate until an admin
      // says what a hit is.
      hitThreshold: input.hitThreshold ?? null,
      // The clock, and null for the same reason: a niche with no window scores
      // nothing rather than falling back to comparing lifetime views, which is
      // the age-biased number this whole rule exists to replace.
      hitWindowHours: input.hitWindowHours ?? null,
      sortOrder: count,
    },
    include: { createdBy: AUTHOR_SELECT },
  });

  return toNicheDTO(niche, 0, niche.createdBy);
}

export async function updateNiche(
  nicheId: string,
  update: {
    name?: string;
    colorIndex?: number;
    sortOrder?: number;
    hitThreshold?: number | null;
    hitWindowHours?: number | null;
  },
): Promise<NicheDTO> {
  // Same rule as on create, and checked before the row is even looked up: a
  // rename is `niches.manage`, a threshold is `settings.manage`. Somebody who
  // may do the first and not the second gets a 403 rather than a niche that
  // silently kept its old number.
  if (sent(update, "hitThreshold") || sent(update, "hitWindowHours")) {
    await assertMayConfigureRule();
  }

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
    hitWindowHours?: number | null;
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
  if (update.hitWindowHours !== undefined) data.hitWindowHours = update.hitWindowHours;

  const updated = await prisma.niche.update({
    where: { id: niche.id },
    data,
    include: {
      createdBy: AUTHOR_SELECT,
      _count: { select: { channels: { where: { trackedChannel: { isActive: true } } } } },
    },
  });

  // The rule moved, so every stored verdict it produced answers a question
  // nobody is asking any more.
  const ruleChanged =
    (update.hitThreshold !== undefined && update.hitThreshold !== niche.hitThreshold) ||
    (update.hitWindowHours !== undefined && update.hitWindowHours !== niche.hitWindowHours);
  if (ruleChanged) await rejudgeAfterRuleChange(organizationId, niche.id);

  return toNicheDTO(updated, updated._count.channels, updated.createdBy);
}

/**
 * Re-decide every Short this niche judges, immediately.
 *
 * INLINE RATHER THAN LEFT TO THE NEXT CRON RUN. An admin who lowers GTA from 1M
 * to 500K is asking a question about the library they are looking at, and a
 * dashboard that keeps showing the old verdicts for an hour afterwards teaches
 * them that the setting does not work. It is bounded work — one organization's
 * Shorts on one niche's channels, upserted in batches — not a sweep.
 *
 * A FAILURE HERE DOES NOT FAIL THE SAVE. The new rule is already stored, which
 * is the part the admin asked for and the part everything else derives from;
 * the verdicts are a cache of it and the scheduled run rebuilds them from the
 * same rule. Throwing would leave the admin staring at a 500 for a setting that
 * did in fact save.
 */
async function rejudgeAfterRuleChange(
  organizationId: string,
  nicheId: string,
): Promise<void> {
  try {
    await reevaluateHitsForNiche(organizationId, nicheId);
  } catch (error) {
    console.error(
      `[niche-service] re-evaluation after a rule change failed for niche ${nicheId}`,
      error,
    );
  }
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

  /*
   * THERE IS NO CONTENT-TYPE GUARD ANY MORE, and its absence is the correct
   * outcome rather than an oversight.
   *
   * It existed for one round, when a niche OWNED its content types and
   * `ContentType.nicheId` cascaded — deleting a niche would have taken its
   * whole vocabulary with it, and every classification hanging off that
   * vocabulary with it, silently destroying human judgements about individual
   * Shorts that are recorded nowhere else.
   *
   * Content types are flat org-wide tags again. They belong to the
   * organization, not to any niche, so nothing about them cascades from here
   * and deleting a niche cannot reach a single classification. What is left is
   * what a niche delete always was: every channel filed under it becomes
   * unassigned, and no channel, video or snapshot is touched.
   */

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
