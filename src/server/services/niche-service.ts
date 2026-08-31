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
 * THE RPM RANGE IS A THIRD PERMISSION AND NOT THE SECOND ONE. What a niche PAYS
 * PER 1,000 VIEWS needs `settings.manage` AND `finance.view` together, because
 * it is read behind `finance.view`: where the studio owns a monetized channel
 * in a niche, the rate shown is that channel's reported revenue divided by its
 * views, and anybody who can see it beside the view count can multiply back to
 * what the channel earned. Gating the READ on `settings.manage` would have made
 * the only way to show a Head of Shorts what a niche is worth also handing them
 * the sync cadence and the org's currency; gating the WRITE on it alone would
 * have let somebody who cannot see a stored range save an empty box over it.
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
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import { actorCan, requireActor } from "@/server/auth/dal";
import {
  MAX_HIT_WINDOW_HOURS,
  MAX_THRESHOLD,
  MIN_HIT_WINDOW_HOURS,
  MIN_THRESHOLD,
} from "@/lib/analytics/constants";
import { CURRENCY_CODES, MAX_MONEY_MINOR, isSupportedCurrency } from "@/lib/finance/money";
import {
  MAX_RPM_MAJOR_PER_THOUSAND,
  maxRpmMinorPerMillion,
} from "@/lib/analytics/niche-rpm";
import { NICHE_KINDS, type NicheKind } from "@/lib/niches/niche-kind";
import { toNicheDTO } from "@/server/mappers";
import type { NicheDTO } from "@/lib/dto";
import { getCurrentOrgId, getScope } from "./user-service";
import { reevaluateHitsForNiche } from "./hit-evaluation-service";
// Only the resolver. `mayReadNicheEconomics` is not imported here on purpose:
// the resolver asks it itself and returns `null` before touching the database,
// so a second check in this file would be a second place the gate could drift.
import { resolveNicheRpmByNiche } from "./niche-rpm-service";

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

/**
 * Refuses an RPM write from somebody who cannot see what they are overwriting.
 *
 * TWO PERMISSIONS, BOTH REQUIRED, and the second one is the point. Setting a
 * rate is organization-wide analysis configuration, which is `settings.manage`
 * — the same reasoning as the hit rule above. But an RPM range is READ behind
 * `finance.view`, because a derived rate is company revenue divided by a view
 * count, and both keys are individually grantable.
 *
 * So `settings.manage` alone is a real combination somebody could be granted,
 * and it would produce the worst kind of writer: the dialog would open with
 * empty boxes over a stored range — because the DTO withheld it — and saving
 * would write that emptiness over a number an admin chose. Requiring the read
 * permission to write makes that state unreachable rather than merely unlikely,
 * which is a stronger guarantee than the patch builder can give on its own.
 */
async function assertMayConfigureRpm(): Promise<void> {
  const actor = await requireActor();
  if (!actor.permissions.has("settings.manage") || !actor.permissions.has("finance.view")) {
    throw errors.forbidden(
      "set an RPM range. Niche RPM is revenue configuration and needs both system settings and finance access",
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
 * One end of a hand-entered RPM range, in minor units per 1,000,000 views.
 *
 * `min(1)` for the same reason the hit payment uses it: zero is not a rate. A
 * niche priced at nothing would multiply its whole tracked view count by zero
 * and print "$0" as a considered estimate, which is the fabricated figure this
 * entire feature is written around avoiding. Clearing is done by sending both
 * ends as `null`.
 *
 * The ceiling here is the widest any supported currency allows; the real,
 * currency-correct bound is applied in the refinement below, where the code
 * being entered is actually known.
 */
const rpmEndpointSchema = z
  .number()
  .int("An RPM is a whole number of minor units per million views, never a fraction.")
  .min(1, "An RPM of nothing is not a rate. Clear both ends to leave it unset.")
  .max(maxRpmMinorPerMillion("USD") * 100, "That RPM is too large to record.")
  .nullable()
  .optional();

/**
 * The currency the range was typed in.
 *
 * Stored rather than inherited from `OrganizationSettings.baseCurrency`,
 * because that column's own comment says individual entries keep their own
 * currency: a range typed as $0.03–$0.06 must not silently become €0.03–€0.06
 * on the day an admin switches the base. That would be a number nobody entered,
 * sitting inside a figure somebody plans against.
 *
 * VALIDATED AGAINST THE CURRENCY TABLE, not merely as three letters, and for
 * the reason `finance-service` gives on its own currency field: `minorUnitsFor`
 * is what turns the stored integer back into an amount, and it silently answers
 * 2 for a code it has never heard of. A stored range of 3,000 accepted as "ZZZ"
 * would be re-read at a scale nobody chose. The dialog can only ever send the
 * organization's base, so this is unreachable through the app — which is
 * precisely why it belongs on the server, where every other caller arrives.
 */
const rpmCurrencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(3, "A currency is a three-letter code like USD.")
  .refine(isSupportedCurrency, {
    message: `Currency must be one of ${CURRENCY_CODES.join(", ")}.`,
  })
  .nullable()
  .optional();

/**
 * The three RPM columns move together or not at all.
 *
 * BOTH ENDS OR NEITHER, the same rule `hitThreshold` and `hitWindowHours`
 * follow: half a range is not a range, it is an unfinished thought that would
 * render as a bound with no other end. Equality is allowed, because an admin
 * who genuinely believes one number should not be made to invent a spread.
 *
 * Checked here rather than in the database because the portability contract
 * rules out check constraints — they are outside the intersection of SQLite and
 * PostgreSQL this schema targets — so the invariant lives in the one place
 * every write passes through.
 */
function refineRpmRange(
  value: {
    rpmLowMinorPerMillion?: number | null;
    rpmHighMinorPerMillion?: number | null;
    rpmCurrency?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  const low = value.rpmLowMinorPerMillion ?? null;
  const high = value.rpmHighMinorPerMillion ?? null;
  const currency = value.rpmCurrency ?? null;

  const sentAny =
    value.rpmLowMinorPerMillion !== undefined ||
    value.rpmHighMinorPerMillion !== undefined ||
    value.rpmCurrency !== undefined;
  if (!sentAny) return;

  if ((low === null) !== (high === null)) {
    ctx.addIssue({
      code: "custom",
      message:
        "An RPM needs both ends. Enter a low and a high, or clear both to leave the niche unpriced.",
    });
    return;
  }

  if (low === null) {
    // Clearing. The currency goes with it — a code with no range attached is a
    // fact about nothing, and leaving one behind would make the next reader
    // wonder what it was the currency of.
    if (currency !== null) {
      ctx.addIssue({
        code: "custom",
        message: "Clear the currency along with the range.",
      });
    }
    return;
  }

  if (currency === null) {
    ctx.addIssue({
      code: "custom",
      message: "Say which currency the RPM range is in.",
    });
    return;
  }

  if (high !== null && high < low) {
    ctx.addIssue({
      code: "custom",
      message: "The low end of the RPM range has to be at or below the high end.",
    });
    return;
  }

  const ceiling = maxRpmMinorPerMillion(currency);
  if ((high ?? low) > ceiling) {
    ctx.addIssue({
      code: "custom",
      message: `An RPM above ${MAX_RPM_MAJOR_PER_THOUSAND} ${currency} per 1,000 views is higher than any format has ever paid, so it is almost certainly a decimal place in the wrong place.`,
    });
  }
}

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

export const updateNicheSchema = z
  .object({
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
  /**
   * What 1,000 views in this niche are worth, as a hand-entered low–high band.
   *
   * A RANGE RATHER THAN A POINT because a guess IS a range. Whoever fills this
   * in has no measurement to enter — they have a band they believe the niche
   * pays in — and demanding one number would launder that belief into a figure
   * the screen then presents with more confidence than it was given.
   *
   * `null` on both ends clears it, exactly as an empty threshold clears the
   * bar: the niche keeps working and simply reports no money figure until
   * somebody prices it again.
   */
  rpmLowMinorPerMillion: rpmEndpointSchema,
  rpmHighMinorPerMillion: rpmEndpointSchema,
  rpmCurrency: rpmCurrencySchema,
  })
  .superRefine(refineRpmRange);

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

export async function listNiches(): Promise<NicheDTO[]> {
  const organizationId = await getCurrentOrgId();
  const includePay = await mayReadHitPayment();

  const niches = await listNicheRows(organizationId);

  /*
   * Resolved once for the whole catalogue, AFTER the rows are in hand.
   *
   * `listNiches` is on the two reads every signed-in person makes — the niche
   * endpoint and the dataset — so a per-niche resolution would turn one page
   * load into dozens of queries against the revenue and snapshot tables. It is
   * also skipped entirely for a reader who may not see niche economics: the
   * resolver returns `null` before it touches the database, so withholding the
   * figure costs nothing rather than computing it and throwing it away.
   */
  const rpm = await resolveNicheRpmByNiche({ niches });

  return niches.map((niche) =>
    toNicheDTO(niche, niche._count.channels, niche.createdBy, {
      includePay,
      rpm: rpm?.get(niche.id) ?? null,
    }),
  );
}

/**
 * One niche's resolution, for the two write paths that return a single DTO.
 *
 * Goes through the same resolver as the list rather than shortcutting, so a
 * niche that has just been repriced comes back with the rate a reader will
 * actually see — including the case where an own channel's measurement is
 * overriding the range that was just typed. A save that echoed back the typed
 * range while the card showed something else would look like a bug in the save.
 */
async function resolveOneNicheRpm(
  niche: { id: string } & Parameters<typeof resolveNicheRpmByNiche>[0]["niches"][number],
) {
  const resolved = await resolveNicheRpmByNiche({ niches: [niche] });
  return resolved?.get(niche.id) ?? null;
}

/** The catalogue read, split out so `listNiches` can name its own row type. */
function listNicheRows(organizationId: string) {
  return prisma.niche.findMany({
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
}

export async function createNiche(input: {
  name: string;
  colorIndex?: number;
  kind?: NicheKind;
  hitThreshold?: number | null;
  hitWindowHours?: number | null;
  hitPaymentMinor?: number | null;
}): Promise<NicheDTO> {
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
      // Production unless somebody says otherwise — the inclusive default. A
      // niche that defaulted to watchlist would drop its channels out of the
      // portfolio hit rate the moment it was created, which is a number moving
      // for a reason nobody chose. Opting OUT of the scorecard is deliberate.
      kind: input.kind ?? "production",
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
    // A niche that has existed for one millisecond has no channels, so nothing
    // can be derived and nothing has been entered. Resolved rather than
    // hardcoded to "none" all the same: the reason travels with it, and a
    // hardcoded answer here would be a second place that decides what an
    // unpriced niche is.
    rpm: await resolveOneNicheRpm(niche),
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
    rpmLowMinorPerMillion?: number | null;
    rpmHighMinorPerMillion?: number | null;
    rpmCurrency?: string | null;
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

  /*
   * The RPM range is its own act with its own gate, checked separately.
   *
   * It rides in the same PATCH as the hit rule only because it is the same
   * table; it is a different decision, needs `finance.view` on top of
   * `settings.manage`, and is refused rather than stripped for the same reason
   * the rule is — silently dropping it would save the request and leave
   * somebody believing they had priced a niche they had not.
   */
  if (
    sent(update, "rpmLowMinorPerMillion") ||
    sent(update, "rpmHighMinorPerMillion") ||
    sent(update, "rpmCurrency")
  ) {
    await assertMayConfigureRpm();
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
    kind?: NicheKind;
    hitThreshold?: number | null;
    hitWindowHours?: number | null;
    hitPaymentMinor?: number | null;
    rpmLowMinorPerMillion?: number | null;
    rpmHighMinorPerMillion?: number | null;
    rpmCurrency?: string | null;
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
  /*
   * The three RPM columns are written together, and only when they arrive.
   *
   * An absent key is not a write — the same rule the rest of this function
   * follows — and it is what lets the dialog save a niche whose stored range
   * was withheld from it without destroying that range. The schema has already
   * refused a partial trio, so writing them one `if` at a time here cannot
   * leave a low end without a high one.
   *
   * NOTHING IS CLEARED WHEN AN OWN CHANNEL STARTS OVERRIDING THE RANGE, which
   * is the same reasoning that keeps the hit payment through a reclassification.
   * A derived rate can stop being derivable — a connection lapses, monetization
   * changes, a snapshot run breaks — and the entered range is what the niche
   * falls back to. Deleting it the day a measurement arrived would make that
   * fallback silently disappear.
   */
  if (update.rpmLowMinorPerMillion !== undefined) {
    data.rpmLowMinorPerMillion = update.rpmLowMinorPerMillion;
  }
  if (update.rpmHighMinorPerMillion !== undefined) {
    data.rpmHighMinorPerMillion = update.rpmHighMinorPerMillion;
  }
  if (update.rpmCurrency !== undefined) data.rpmCurrency = update.rpmCurrency;

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
    rpm: await resolveOneNicheRpm(updated),
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
