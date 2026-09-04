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
 * THE THREE NUMBERS ARE ONE RULE, SO THEY SHARE ONE PERMISSION. A hit is a bar,
 * a clock, and — now — what it is worth. `hitPaymentMinor` joins the other two
 * behind `settings.manage` rather than getting a permission of its own: it is
 * the same decision made in the same dialog, and guarding two thirds of a rule
 * would let somebody redefine what a hit pays by editing the third nobody
 * thought to protect.
 *
 * `kind` IS DIFFERENT AND STAYS ON `niches.manage`. Calling a niche production
 * or watchlist is a statement about what the studio is doing, not about how a
 * number is computed — it is the same class of act as naming the niche in the
 * first place, and the person who organises the taxonomy is the person who
 * knows the answer. It does move the portfolio hit rate, which is why it is not
 * free: it is `niches.manage`, the floor for touching a shared label at all.
 *
 * The check lives in this file rather than only in the route because a service
 * function is reachable from anywhere on the server — another service, a job, a
 * future route somebody writes in a hurry. A rule enforced one layer up is a
 * rule that holds only for the callers that happen to exist today.
 */

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import { actorCan, requireActor } from "@/server/auth/dal";
import { requireFormat, resolveAllowedFormats } from "@/server/auth/format-scope";
import {
  MAX_HIT_WINDOW_HOURS,
  MAX_THRESHOLD,
  MIN_HIT_WINDOW_HOURS,
  MIN_THRESHOLD,
} from "@/lib/analytics/constants";
import { MAX_MONEY_MINOR } from "@/lib/finance/money";
import { NICHE_KINDS, type NicheKind } from "@/lib/niches/niche-kind";
import {
  DEFAULT_NICHE_FORMAT,
  NICHE_FORMATS,
  toNicheFormat,
  type NicheFormat,
} from "@/lib/niches/niche-format";
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
      "set a hit rate threshold. Hit rate thresholds, windows and payments are configured by an Admin",
    );
  }
}

/** True when the caller sent the field at all, an explicit null included. */
function sent(input: object, key: string): boolean {
  return key in input && (input as Record<string, unknown>)[key] !== undefined;
}

/**
 * The `where` fragment that narrows niche rows to one format's list.
 *
 * The shorts branch is `format != "longform"` rather than `format ==
 * "shorts"`, and the asymmetry is the point: `toNicheFormat` reads anything
 * that is not exactly "longform" as shorts — the fail-closed direction — and a
 * query that disagreed with the narrower would make a garbage-valued row
 * visible in neither list, which is exactly the silent disappearance the
 * fail-closed rule exists to prevent.
 */
export function nicheFormatWhere(format: NicheFormat): Prisma.NicheWhereInput {
  return format === "longform"
    ? { format: "longform" }
    : { format: { not: "longform" } };
}

/** How many accent colours the niche chips cycle through (`--chart-1..6`). */
const NICHE_COLOR_COUNT = 6;

export const nicheNameSchema = z
  .string()
  .trim()
  .min(1, "Give the niche a name.")
  .max(48, "Niche names must be 48 characters or fewer.");

/**
 * What one hit is worth, in minor units.
 *
 * `min(1)` rather than `min(0)`: zero is not a rate anybody meant to type, and
 * letting it through would produce a niche that looks configured and pays
 * nothing — the silent half-configured state this whole round exists to name.
 * Clearing is done with an explicit `null`, which is a visible "unconfigured"
 * everywhere and is reported before a payroll run is finalized.
 *
 * The ceiling is the money ceiling, because this number is multiplied by a hit
 * count and written into an `Int` column further downstream.
 */
const hitPaymentMinorSchema = z
  .number()
  .int("A hit payment is a whole number of minor units (cents), never a fraction of one.")
  .min(1, "A hit payment of nothing is not a rate. Clear it instead to leave it unset.")
  .max(MAX_MONEY_MINOR, "That hit payment is too large to record.")
  .nullable()
  .optional();

/**
 * "production" | "watchlist".
 *
 * A Zod enum over the shared union rather than a free string, because this
 * column decides which niches the portfolio hit rate is measured over — an
 * unrecognised value reaching the database would put a niche in neither group
 * and quietly change the studio's headline number.
 */
const nicheKindSchema = z.enum(
  NICHE_KINDS as unknown as [NicheKind, ...NicheKind[]],
  { message: "A niche is either production or watchlist." },
);

export const createNicheSchema = z.object({
  name: nicheNameSchema,
  colorIndex: z.number().int().min(0).max(NICHE_COLOR_COUNT - 1).optional(),
  /** Absent means production — the column default, and the inclusive answer. */
  kind: nicheKindSchema.optional(),
  /**
   * Which format list the niche joins. Absent means "whatever this role's
   * side of the operation is" — see `createNiche`, where `requireFormat`
   * resolves it. The schema only rules out garbage strings; WHO may say
   * "longform" is the service's decision, not a shape question.
   */
  format: z
    .enum(NICHE_FORMATS as unknown as [NicheFormat, ...NicheFormat[]], {
      message: "A niche is either a Shorts niche or a Long Form one.",
    })
    .optional(),
  hitThreshold: z.number().int().min(MIN_THRESHOLD).max(MAX_THRESHOLD).nullable().optional(),
  hitWindowHours: z
    .number()
    .int()
    .min(MIN_HIT_WINDOW_HOURS)
    .max(MAX_HIT_WINDOW_HOURS)
    .nullable()
    .optional(),
  hitPaymentMinor: hitPaymentMinorSchema,
});

export const updateNicheSchema = z.object({
  name: nicheNameSchema.optional(),
  colorIndex: z.number().int().min(0).max(NICHE_COLOR_COUNT - 1).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  /**
   * Reclassifying a niche. `niches.manage`, like renaming it.
   *
   * Moving a niche to watchlist takes its channels out of the portfolio hit
   * rate and stops any hit in it paying. Moving it back puts them straight
   * back, including the rate it was carrying — nothing is cleared on the way
   * through, so the act is reversible and an admin who mis-clicks loses no
   * number they chose.
   */
  kind: nicheKindSchema.optional(),
  /**
   * What one hit here pays. `null` clears it, leaving the niche unable to pay
   * anything — a visible state the payroll run names before it is finalized,
   * never a quiet fall back to the employee's own rate.
   */
  hitPaymentMinor: hitPaymentMinorSchema,
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

/**
 * Who may see what a hit PAYS, as opposed to what counts as one.
 *
 * `settings.manage` — the same permission that lets somebody SET the rate.
 * Anybody who can change a number can obviously read it, and nobody else has a
 * use for the catalogue-wide view: an employee's own rates reach them through
 * their Earnings page, per niche and beside the hits they earned, which is the
 * only place the figure means anything to them.
 */
async function mayReadHitPayment(): Promise<boolean> {
  return actorCan("settings.manage");
}

export async function listNiches(
  options: {
    /**
     * Which format lists to return. Absent means every format — the reading
     * the standalone catalogue and the admin assignment checklist want, where
     * the caller's entitlement was already resolved by the route. A single
     * entry narrows to that list; both entries are the same as absent.
     */
    formats?: readonly NicheFormat[];
  } = {},
): Promise<NicheDTO[]> {
  const organizationId = await getCurrentOrgId();
  const includePay = await mayReadHitPayment();

  const niches = await listNicheRows(organizationId, options.formats);

  return niches.map((niche) =>
    toNicheDTO(niche, niche._count.channels, niche.createdBy, { includePay }),
  );
}

/** The catalogue read, split out so `listNiches` can name its own row type. */
function listNicheRows(organizationId: string, formats?: readonly NicheFormat[]) {
  // A list naming both formats is no narrowing at all, and expressing it as
  // one would need an OR of the two fragments only to match every row anyway.
  const narrowed =
    formats !== undefined &&
    !(formats.includes("shorts") && formats.includes("longform"));
  return prisma.niche.findMany({
    // The whole team shares one taxonomy, so this lists the organization's
    // niches rather than the ones the signed-in user happened to create.
    where: {
      organizationId,
      ...(narrowed ? nicheFormatWhere(formats[0] ?? DEFAULT_NICHE_FORMAT) : {}),
    },
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
}

export async function createNiche(input: {
  name: string;
  colorIndex?: number;
  kind?: NicheKind;
  format?: NicheFormat;
  hitThreshold?: number | null;
  hitWindowHours?: number | null;
  hitPaymentMinor?: number | null;
}): Promise<NicheDTO> {
  /*
   * WHICH FORMAT LIST THE ROW JOINS, decided here and not in the route, for
   * the file's standing reason: a service function is reachable from anywhere
   * on the server, and a rule enforced one layer up holds only for the callers
   * that happen to exist today. `requireFormat` is the whole check —
   *
   *   • a sent format the role is not entitled to is REFUSED with a 403, never
   *     stripped: a head_of_shorts who typed "longform" must be told, not
   *     handed a Shorts niche they believe is a Long Form one;
   *   • an absent format resolves to the role's own side of the operation —
   *     shorts for every shorts role and for admin (first allowed), longform
   *     for the longs roles. That last case is a deliberate behaviour change
   *     for longs roles, who change completely under this deploy.
   */
  const actor = await requireActor();
  const format = requireFormat(actor.role, input.format);
  // The rule check comes before anything is read or written. An employee's
  // create request that carries any of the three numbers is REFUSED, not
  // quietly stripped: silently dropping one would create the niche and tell
  // them nothing, and they would go on believing they had set a value that does
  // not exist.
  //
  // `in` rather than `!== undefined` so an explicit `null` is caught too —
  // clearing any of the three is a write to the rule.
  if (
    sent(input, "hitThreshold") ||
    sent(input, "hitWindowHours") ||
    sent(input, "hitPaymentMinor")
  ) {
    await assertMayConfigureRule();
  }

  // Both halves of the scope: the organization decides where the row lives and
  // what it collides with, the user is recorded only as its author.
  const { organizationId, userId } = await getScope();
  const name = input.name.trim();
  const slug = toSlug(name);

  // Uniqueness is per organization AND per format: one team cannot hold two
  // Shorts "GTA" niches, but another team's "GTA" is a different row and must
  // not block this one — and a Long Form "GTA" is a different row from the
  // Shorts one, so the dedup looks in the SAME list the create below writes
  // into. Using the requested format here is load-bearing: a lookup pinned to
  // shorts would let a Long Form "GTA" collide with — or silently reuse — a
  // Shorts row.
  const existing = await prisma.niche.findUnique({
    where: {
      organizationId_format_slug: {
        organizationId,
        format,
        slug,
      },
    },
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
      // Production unless somebody says otherwise — the inclusive default. A
      // niche that defaulted to watchlist would drop its channels out of the
      // portfolio hit rate the moment it was created, which is a number moving
      // for a reason nobody chose. Opting OUT of the scorecard is deliberate.
      kind: input.kind ?? "production",
      // The format `requireFormat` resolved above — the visible change the
      // old comment on this line promised. A caller CAN say "longform" now,
      // and what lands here has been validated against the actor's own side
      // of the operation rather than trusted from the request.
      format,
      // Null when an employee created it, and null is a real state now: the
      // niche exists, works as a filter, and reports no hit rate until an admin
      // says what a hit is.
      hitThreshold: input.hitThreshold ?? null,
      // The clock, and null for the same reason: a niche with no window scores
      // nothing rather than falling back to comparing lifetime views, which is
      // the age-biased number this whole rule exists to replace.
      hitWindowHours: input.hitWindowHours ?? null,
      // The price, and null for the same reason again: a niche that cannot say
      // what a hit is worth pays nothing rather than guessing, and the payroll
      // run names it before anybody finalizes.
      hitPaymentMinor: input.hitPaymentMinor ?? null,
      sortOrder: count,
    },
    include: { createdBy: AUTHOR_SELECT },
  });

  return toNicheDTO(niche, 0, niche.createdBy, {
    includePay: await mayReadHitPayment(),
  });
}

export async function updateNiche(
  nicheId: string,
  update: {
    name?: string;
    colorIndex?: number;
    sortOrder?: number;
    kind?: NicheKind;
    hitThreshold?: number | null;
    hitWindowHours?: number | null;
    hitPaymentMinor?: number | null;
  },
): Promise<NicheDTO> {
  // Same rule as on create, and checked before the row is even looked up: a
  // rename and a reclassification are `niches.manage`, the three numbers are
  // `settings.manage`. Somebody who may do the first and not the second gets a
  // 403 rather than a niche that silently kept its old figures.
  if (
    sent(update, "hitThreshold") ||
    sent(update, "hitWindowHours") ||
    sent(update, "hitPaymentMinor")
  ) {
    await assertMayConfigureRule();
  }

  const organizationId = await getCurrentOrgId();

  // Scoped by organization, not by author: any teammate may rename or recolour
  // a shared niche. The scope clause is still what makes an id from another
  // tenant read as "not found" rather than as someone else's row.
  const niche = await prisma.niche.findFirst({ where: { id: nicheId, organizationId } });
  if (!niche) throw errors.notFound("niche");

  /*
   * THE ROW'S OWN FORMAT IS A SCOPE, and it is checked here like `format` is
   * on create: a head_of_shorts holding `niches.manage` may organise the
   * Shorts taxonomy, not the Long Form one, and the API layer is the
   * boundary that says so. Checked in the service for the file's standing
   * reason — any server caller reaches this function, not just today's route.
   *
   * Note the schema deliberately accepts NO `format` field on update: a
   * rename never moves a niche between formats (see the clash check below),
   * and a format change would silently re-file every channel under it into
   * the other product. What is validated here is WHO may touch the row at
   * all, not a request to move it.
   */
  const actor = await requireActor();
  requireFormat(actor.role, toNicheFormat(niche.format));

  const data: {
    name?: string;
    slug?: string;
    colorIndex?: number;
    sortOrder?: number;
    kind?: NicheKind;
    hitThreshold?: number | null;
    hitWindowHours?: number | null;
    hitPaymentMinor?: number | null;
  } = {};

  if (update.name !== undefined) {
    const name = update.name.trim();
    const slug = toSlug(name);
    if (slug !== niche.slug) {
      // The clash that matters is within the row's OWN format list — a rename
      // never moves a niche between formats, so a Long Form "GTA" (once one
      // can exist) must not block renaming a Shorts niche to "GTA". Narrowed
      // through `toNicheFormat` so an unreadable stored value collides in the
      // Shorts list, the same fail-direction the mapper uses.
      const clash = await prisma.niche.findUnique({
        where: {
          organizationId_format_slug: {
            organizationId,
            format: toNicheFormat(niche.format),
            slug,
          },
        },
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
  if (update.kind !== undefined) data.kind = update.kind;
  if (update.hitThreshold !== undefined) data.hitThreshold = update.hitThreshold;
  if (update.hitWindowHours !== undefined) data.hitWindowHours = update.hitWindowHours;
  /*
   * The stored rate is written when it is sent and LEFT ALONE otherwise —
   * including when the niche is being moved to watchlist in the same request.
   *
   * Clearing it on reclassification was the tempting rule and is the wrong one.
   * `kind` is a reversible statement about what the studio is doing, and a
   * mis-click that silently destroyed the number an admin chose for GTA would
   * make it not reversible. Nothing READS the rate while a niche is watchlist —
   * the mapper does not ship it, the payroll engine does not consider the niche
   * at all — so keeping it costs nothing and losing it costs a decision.
   */
  if (update.hitPaymentMinor !== undefined) data.hitPaymentMinor = update.hitPaymentMinor;

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
  //
  // NEITHER `hitPaymentMinor` NOR `kind` IS PART OF THAT TEST, and both
  // omissions are deliberate. A verdict is "did this Short reach the bar inside
  // the window" — what the answer is worth, and whether the studio competes in
  // this niche, change nothing about it. Re-deciding a library because a rate
  // moved would be a lot of work to reach the identical answer, and a watchlist
  // niche keeps scoring its Shorts precisely because watching them is the point.
  const ruleChanged =
    (update.hitThreshold !== undefined && update.hitThreshold !== niche.hitThreshold) ||
    (update.hitWindowHours !== undefined && update.hitWindowHours !== niche.hitWindowHours);
  if (ruleChanged) await rejudgeAfterRuleChange(organizationId, niche.id);

  return toNicheDTO(updated, updated._count.channels, updated.createdBy, {
    includePay: await mayReadHitPayment(),
  });
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

  // The same two lines `updateNiche` runs, for the stronger reason: a
  // head_of_shorts refused a RENAME of a longform niche must not be able to
  // DELETE the same row — the destructive act cannot be the unguarded one.
  // The row's own format is the scope, checked in the service so every server
  // caller meets it, not just today's route.
  const actor = await requireActor();
  requireFormat(actor.role, toNicheFormat(niche.format));

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
  const actor = await requireActor();

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
      select: { id: true, format: true },
    });
    if (owned.length !== unique.length) {
      throw errors.invalidInput("One or more of those niches no longer exists.");
    }
    /*
     * FILING A CHANNEL UNDER A NICHE PLACES IT IN THAT NICHE'S PRODUCT, so
     * each target niche's format is checked against the caller — the same
     * `requireFormat` that guards create, update and delete. Without this, a
     * longs role holding `channels.manage` could file any Shorts-only channel
     * under a longform niche and pull its whole video history into their own
     * dataset — a self-service path around the boundary `/api/dataset`
     * enforces (and a shorts role has the mirror-image write).
     */
    for (const niche of owned) {
      requireFormat(actor.role, toNicheFormat(niche.format));
    }
  }

  /*
   * SET SEMANTICS, WITHIN THE CALLER'S OWN SIDE OF THE OPERATION. The delete
   * used to be wholesale, which made "assign these" carry a second, silent
   * power: a longs role sending their complete longform list — or an empty
   * one — would also strip every SHORTS filing off the channel, assignments
   * their own product never even shows them. So a single-format caller's
   * replace only touches join rows to niches of their format; what they
   * cannot file into, they cannot unfile from. An admin's set stays wholesale
   * across both formats, exactly as before. The shorts side is scoped through
   * `nicheFormatWhere`, so a garbage-valued stored format is deletable by the
   * shorts side — the list `toNicheFormat` files it under.
   */
  const allowed = resolveAllowedFormats(actor.role);
  const deleteScope =
    allowed.length === 1 ? { niche: nicheFormatWhere(allowed[0]) } : {};

  await prisma.$transaction([
    prisma.trackedChannelNiche.deleteMany({
      where: { trackedChannelId: tracking.id, ...deleteScope },
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
    // Shorts explicitly: this import path feeds the Shorts tracker, and
    // `createNiche` below only mints Shorts niches, so the lookup and the
    // create must agree on which format list they are deduplicating in.
    const existing = await prisma.niche.findUnique({
      where: {
        organizationId_format_slug: {
          organizationId,
          format: DEFAULT_NICHE_FORMAT,
          slug,
        },
      },
    });
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    // "shorts" EXPLICITLY, not left to the role default: the lookup above
    // deduplicates in the Shorts list, so the create must write into the same
    // one or an import would mint rows the lookup can never find again. For a
    // longs-role caller `requireFormat` refuses this — which is the boundary
    // working: this import path feeds the Shorts tracker, and a role whose
    // side of the operation is Long Form has no business minting rows in it.
    const created = await createNiche({ name: trimmed, format: DEFAULT_NICHE_FORMAT });
    ids.push(created.id);
  }
  return ids;
}
