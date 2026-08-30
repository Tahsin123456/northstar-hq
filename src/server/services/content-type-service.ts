import "server-only";

import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import { recordAudit } from "@/server/audit/audit-service";
import type { AuditAction } from "@/lib/audit/actions";
import {
  getVisibleNicheIds,
  trackedChannelNicheFilter,
} from "@/server/auth/niche-scope";
import { toChannelContentTypeRuleDTO, toContentTypeDTO } from "@/server/mappers";
import type { ChannelContentTypeRuleDTO, ContentTypeDTO } from "@/lib/dto";
/*
 * THE RULE ITSELF LIVES IN `src/lib/`, NOT HERE.
 *
 * Imported rather than reimplemented, and imported from a module the browser
 * also imports, because the client re-slices the dataset in memory without
 * refetching and therefore has to reach the same answer this file does. Two
 * implementations of `(inherited − exclusions) ∪ manual` — or of "which rules
 * cover this publish date" — is the drift this whole round exists to prevent.
 */
import {
  effectiveContentTypeIds,
  inheritedContentTypeIds,
  planDeviations,
  type DeviationPlan,
} from "@/lib/content-types/resolve";
/*
 * And the state machine that retires a rule is a sibling of it, for the same
 * reason: what happens to three columns after somebody removes a tag is a claim
 * worth running in a test rather than reconstructing from Prisma stubs. This
 * file decides WHEN to feed it a signal; it decides what the signal does.
 */
import {
  RULE_AUTO_CLOSE_STREAK,
  recordConfirmation,
  recordOverride,
  type RuleStreakChange,
  type RuleStreakState,
} from "@/lib/content-types/rules";
import { getCurrentOrgId, getScope } from "./user-service";

/**
 * Content types — what a Short *is*, as opposed to which slice of the
 * operation produced it.
 *
 * ==========================================================================
 * ONE CENTRALISED, ORG-WIDE VOCABULARY. A TAG, NOT A NICHE'S PRIVATE LIST.
 * ==========================================================================
 *
 * This reverses the previous round at the owner's explicit instruction:
 * "Content Types are NOT primarily attached to niches. They should function as
 * tags/categories attached to Channels and Videos/Shorts."
 *
 * So `ContentType.nicheId` is gone, uniqueness is `[organizationId, slug]`, and
 * ANY SHORT MAY CARRY ANY OF THE ORGANIZATION'S TAGS. Everything that used to
 * narrow the vocabulary by niche went with it — the "belongs to the X niche"
 * refusals, the per-niche uniqueness, the picker's niche intersection. There is
 * no assignment rule left to enforce beyond ownership: is this tag ours, and is
 * this Short ours.
 *
 * WHAT THAT BUYS, AND WHAT IT COSTS. "Funny Moment" now means one thing across
 * the whole operation, which is what makes "which content type performs best?"
 * a question about the work rather than about a label — see
 * `src/lib/analytics/content-type-performance.ts`, which could not be written
 * against forty per-niche lists that happen to share names. The cost is that
 * two teams have to agree on a word, and the owner has decided that is the
 * trade they want.
 *
 * A TAG ATTACHES TO A STRETCH OF A CHANNEL'S OUTPUT AND IS INHERITED BY THE
 * SHORTS PUBLISHED INSIDE IT
 *
 *   • `ChannelContentTypeRule` — what this channel made, and BETWEEN WHEN AND
 *     WHEN. Hangs off `TrackedChannel` rather than `Channel` because the same
 *     YouTube channel is one global row that two organizations would describe
 *     differently.
 *   • `VideoContentType` — NOT what one Short was. A DEVIATION from what its
 *     channel's rules say, and nothing else.
 *
 * =========================================================================
 * THE RULE EVERYTHING IN THIS FILE FOLLOWS FROM
 * =========================================================================
 *
 *     effective(short) = (rules covering its publish date − exclusions) ∪ manual
 *
 * INHERITED TAGS ARE NEVER STORED. There is no row for an inherited tag and
 * there must never be one — see `src/lib/content-types/resolve.ts`, which is
 * the single implementation of that rule and is imported by the browser too.
 *
 * WHY NOT JUST COPY THE CHANNEL'S TAGS ONTO EACH SHORT. Because the copy is a
 * snapshot and the relationship is not. A channel with 400 Shorts would leave
 * 400 stale rows the moment a tag was removed, and a tag added next month would
 * reach nothing already published. The channel stays the live source; a Short
 * records only where it departs from it, which for the overwhelming majority of
 * Shorts is nowhere at all.
 *
 * What falls out of that, for free, and is pinned by
 * `src/lib/__tests__/content-type-inheritance.test.ts` and
 * `src/lib/__tests__/channel-content-type-rules.test.ts`:
 *   • applying a tag to a channel labels its whole back catalogue immediately,
 *     no backfill;
 *   • a Short imported tomorrow inherits, because nothing was written per Short;
 *   • closing a rule un-labels exactly the Shorts after the switch and none
 *     before it, leaving no stale rows on either side;
 *   • an exclusion is a TOMBSTONE that survives its rule closing, so re-opening
 *     the rule does not silently undo somebody's explicit "no".
 *
 * THE RULE RETIRES ITSELF, AND THIS FILE IS WHERE IT LEARNS TO. Every removal of
 * an inherited tag is fed to the streak machine in
 * `src/lib/content-types/rules.ts`; three consecutive ones close the rule at the
 * date the channel actually changed. See `signalChannelRules` below for which
 * gestures count as evidence and which deliberately do not.
 *
 * The gap between what a channel was expected to make and what its Shorts turned
 * out to be is still visible — it is exactly the set of deviations, which is now
 * the only thing this table stores.
 *
 * NICHE SCOPING STILL EXISTS — IT JUST NO LONGER TOUCHES THE VOCABULARY
 *
 * A niche-scoped editor sees every tag, because the catalogue is org-wide and
 * there is nothing niche-shaped left in it to hide. What they still cannot do
 * is reach a CHANNEL or a SHORT outside their niches, so
 * `trackedChannelNicheFilter` is applied on every assignment path below — the
 * scope narrows the SUBJECT of a tag, never the tag itself.
 *
 * WHERE IT DIVERGES FROM NICHES, AND WHY
 *
 *  • DELETING IS NOT THE DEFAULT. A content type labels a Short, and that label
 *    is a HUMAN JUDGEMENT nobody recorded anywhere else — deleting the type is
 *    the only way to destroy it. So a type with assignments is refused and
 *    offered deactivation instead. See `deleteContentType`.
 *
 *  • THE VIDEO SIDE CARRIES A TENANT COLUMN. `Video` is a global, deduplicated
 *    row: the same YouTube Short is one record however many organizations track
 *    its channel. A classification hung off it alone would be visible to all of
 *    them, so `VideoContentType.organizationId` exists and EVERY query here
 *    filters on it. A missing filter in this file is a cross-tenant leak, not a
 *    slow query.
 *
 * As everywhere else in the app, `organizationId` decides what a row is and who
 * collides with it; `createdById` / `assignedById` are recorded for the byline
 * and the audit trail and are never read back as a filter. A content type
 * belongs to the team the moment it exists, including after its author leaves.
 */

/** How many accent colours the chips cycle through (`--chart-1..6`). */
const CONTENT_TYPE_COLOR_COUNT = 6;

/**
 * Upper bound on one bulk assignment.
 *
 * The bulk path exists to relabel a back catalogue in one go, so the limit is
 * generous — but it is a limit: the id list becomes an `IN (...)` clause and an
 * unbounded one is a way to make the database do arbitrary work with a single
 * request.
 */
export const MAX_BULK_VIDEOS = 500;

/**
 * Upper bound on one reorder.
 *
 * A reorder names every type the organization has, so this is a ceiling on how
 * long the vocabulary may be. Generous enough that no real team meets it, small
 * enough that the request cannot become a thousand writes.
 */
const MAX_REORDER_IDS = 200;

export const contentTypeNameSchema = z
  .string()
  .trim()
  .min(1, "Give the content type a name.")
  .max(48, "Content type names must be 48 characters or fewer.");

export const createContentTypeSchema = z.object({
  // No niche. A content type is the organization's tag, and asking which niche
  // it belongs to is the question this round exists to stop asking.
  name: contentTypeNameSchema,
  colorIndex: z.number().int().min(0).max(CONTENT_TYPE_COLOR_COUNT - 1).optional(),
});

export const updateContentTypeSchema = z
  .object({
    name: contentTypeNameSchema.optional(),
    colorIndex: z.number().int().min(0).max(CONTENT_TYPE_COLOR_COUNT - 1).optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    /** Archive / restore. The soft alternative to a delete. */
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nothing to update.",
  });

/**
 * The whole-set write body: the DESIRED EFFECTIVE SET for one Short.
 *
 * The cap is 100 rather than the 20 it was, because the meaning of this list
 * changed under inheritance. It used to be "the tags somebody put on this
 * Short" — a handful, by nature. It is now the Short's whole effective set,
 * which INCLUDES everything its channel provides, so the ceiling is really a
 * ceiling on the channel's tag count. At 20 an organization that tagged a
 * channel generously would find every save on its Shorts rejected with a
 * message about providing a list, which names nothing a person could act on.
 *
 * It stays bounded — the list becomes an `IN (...)` clause and an unbounded one
 * is a way to make the database do arbitrary work from a single request — but
 * 100 tags on one channel is already far past the point where the vocabulary
 * has stopped meaning anything, so the limit will be reached as a mistake
 * rather than as a constraint.
 */
export const contentTypeIdsSchema = z.array(z.string().min(1)).max(100);

export const reorderContentTypesSchema = z.object({
  orderedIds: z
    .array(z.string().min(1))
    .min(1, "Send the content types in their new order.")
    .max(MAX_REORDER_IDS),
});

export const assignContentTypeSchema = z.object({
  videoIds: z
    .array(z.string().min(1))
    .min(1, "Select at least one Short.")
    .max(MAX_BULK_VIDEOS, `Assign at most ${MAX_BULK_VIDEOS} Shorts at a time.`),
  contentTypeId: z.string().min(1),
  /**
   * "add" leaves any existing classification alone; "replace" makes this the
   * only content type on each Short. Spelled out rather than inferred from an
   * `exclusive` boolean so the request says what it does.
   */
  mode: z.enum(["add", "replace"]).default("add"),
});

export type AssignMode = "add" | "replace";

/**
 * Case- and whitespace-insensitive key.
 *
 * Identical to `niche-service.toSlug`, and deliberately a second copy rather
 * than a shared import: the two taxonomies must be free to disagree about what
 * counts as a duplicate later without one silently changing the other's
 * uniqueness rule, which would be a data migration rather than a refactor.
 * SQLite and PostgreSQL disagree about case-insensitive collation, so
 * uniqueness is enforced on a normalised column rather than by the database.
 */
function toSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The channel-rule count, as a filtered relation count.
 *
 * `ChannelContentTypeRule` reaches the tenant through `TrackedChannel`, so its
 * filter is a join. This is the count that describes REACH: a tag with six rules
 * labels every Short inside those six windows, and there is no row per Short to
 * count anywhere.
 *
 * RULES, NOT DISTINCT CHANNELS, and the honest reason is that Prisma's `_count`
 * cannot express the second — but it is also the number this is wanted for. Both
 * places that read it are asking what a change to this tag would disturb, and a
 * channel carrying "Ranking until March" and "Ranking again from September" has
 * two separate stretches of history at stake. Reporting "1 channel" would
 * understate it. Closed and retired rules count for the same reason: they still
 * label a back catalogue.
 */
function channelRuleCountSelect(organizationId: string) {
  return {
    select: {
      channelRules: { where: { trackedChannel: { organizationId } } },
    },
  } as const;
}

/**
 * The two DEVIATION counts, for as many types as the caller asks about.
 *
 * NOT a `_count` relation like the channels above, and it cannot be: `_count`
 * takes one filter per relation, and the same relation has to be counted twice
 * here under opposite conditions. One `groupBy` answers for the whole catalogue
 * in a single query rather than turning a catalogue listing into two round trips
 * per row.
 *
 * `organizationId` is in the `where` for the reason it is in every query in this
 * file: `Video` is a global row shared between organizations, so an unfiltered
 * read here would count another team's judgements about the same Short.
 *
 * A row whose `state` is neither known value is counted as neither — the column
 * is a plain String for SQLite/PostgreSQL portability, and inventing a meaning
 * for an unrecognised one would put a wrong number in a delete warning.
 */
async function videoDeviationCounts(
  organizationId: string,
  contentTypeIds?: readonly string[],
): Promise<Map<string, { manual: number; excluded: number }>> {
  const rows = await prisma.videoContentType.groupBy({
    by: ["contentTypeId", "state"],
    where: {
      organizationId,
      ...(contentTypeIds ? { contentTypeId: { in: [...contentTypeIds] } } : {}),
    },
    _count: { _all: true },
  });

  const counts = new Map<string, { manual: number; excluded: number }>();
  for (const row of rows) {
    const entry = counts.get(row.contentTypeId) ?? { manual: 0, excluded: 0 };
    if (row.state === "manual") entry.manual += row._count._all;
    else if (row.state === "excluded") entry.excluded += row._count._all;
    counts.set(row.contentTypeId, entry);
  }
  return counts;
}

const NO_DEVIATIONS = { manual: 0, excluded: 0 } as const;

type CountedContentType = Parameters<typeof toContentTypeDTO>[0] & {
  _count: { channelRules: number };
};

function toDTO(
  row: CountedContentType,
  deviations: ReadonlyMap<string, { manual: number; excluded: number }>,
): ContentTypeDTO {
  const counts = deviations.get(row.id) ?? NO_DEVIATIONS;
  return toContentTypeDTO(row, {
    manualVideoCount: counts.manual,
    excludedVideoCount: counts.excluded,
    channelRuleCount: row._count.channelRules,
  });
}

/** Re-reads one type with its counts, so every mutation returns the same shape. */
async function loadContentType(
  organizationId: string,
  contentTypeId: string,
): Promise<ContentTypeDTO> {
  const [row, deviations] = await Promise.all([
    prisma.contentType.findFirstOrThrow({
      where: { id: contentTypeId, organizationId },
      include: { _count: channelRuleCountSelect(organizationId) },
    }),
    videoDeviationCounts(organizationId, [contentTypeId]),
  ]);
  return toDTO(row, deviations);
}

/**
 * Audit helper.
 *
 * Mirrors `finance-service.auditFinance`: the call sites say what happened, and
 * the decision about which actions deserve network context stays in
 * `src/lib/audit/actions.ts` rather than being re-made at each one.
 */
async function auditContentType(
  request: Request | undefined,
  payload: {
    action: AuditAction;
    summary: string;
    /**
     * What the entry is ABOUT, which is not always the content type.
     *
     * Catalogue edits target the type; assignments target the Short or the
     * channel that was labelled, because "show me everything that happened to
     * this Short" is the query an admin actually runs. Getting this wrong would
     * file an edit under the wrong id and make it unfindable from either end.
     */
    targetType: "contentType" | "channel" | "video";
    targetId: string;
    targetLabel: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { organizationId, actor } = await getScope();
  await recordAudit(
    {
      organizationId,
      actorUserId: actor.userId,
      actorLabel: actor.name ?? actor.email,
      request,
    },
    payload,
  );
}

/**
 * "This content type is my organization's."
 *
 * The whole ownership check, and there is nothing else to check. A tag is
 * org-wide, so every member of the organization — niche-scoped or not — sees
 * and may edit the vocabulary they all classify against; a 404 for an id
 * belonging to another team is what stops the endpoint confirming it exists.
 *
 * NOTE WHAT IS DELIBERATELY ABSENT: a niche gate. The previous round narrowed
 * this by `ContentType.nicheId`, which no longer exists. Niche scoping still
 * decides which CHANNELS and SHORTS a member may tag — see `loadTaggableVideos`
 * and `requireVisibleTrackedChannel` — but it has no say over the shared
 * vocabulary itself.
 */
async function requireOwnContentType(organizationId: string, contentTypeId: string) {
  const contentType = await prisma.contentType.findFirst({
    where: { id: contentTypeId, organizationId },
  });
  if (!contentType) throw errors.notFound("content type");
  return contentType;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface ListContentTypesOptions {
  readonly includeInactive?: boolean;
  /**
   * Case-insensitive substring match on the name — the owner asked for search.
   *
   * Matched against `slug`, the lowercased whitespace-collapsed copy of the name
   * that the uniqueness rule already keeps on the row, rather than with Prisma's
   * `mode: "insensitive"` — which PostgreSQL supports and SQLite does not. The
   * portability contract that put `slug` there in the first place is the same
   * one that makes it the right column to search.
   */
  readonly search?: string;
}

/**
 * The catalogue — one flat, ordered list.
 *
 * Flat because that is what it now is. The grouped, niche-keyed shape this
 * returned last round described a vocabulary that no longer exists, and every
 * consumer of it wanted the same thing: the organization's tags, in the order
 * the team put them in.
 *
 * NOT narrowed by niche. There is nothing niche-shaped left to narrow by, and
 * hiding tags from a niche-scoped editor would hide the labels on the very
 * Shorts they are entitled to see.
 */
export async function listContentTypes(
  options: ListContentTypesOptions = {},
): Promise<ContentTypeDTO[]> {
  const organizationId = await getCurrentOrgId();

  // Normalised through the same function that built the stored slug, so a
  // search for "  Funny   Moment " matches the row saved as "Funny Moment".
  // An empty or whitespace-only term is no filter at all rather than a match on
  // "", which would be indistinguishable but would read as deliberate.
  const search = options.search ? toSlug(options.search) : "";

  const [rows, deviations] = await Promise.all([
    prisma.contentType.findMany({
      // The whole team shares one vocabulary, so this lists the organization's
      // types rather than the ones the signed-in user created.
      where: {
        organizationId,
        ...(options.includeInactive ? {} : { isActive: true }),
        ...(search ? { slug: { contains: search } } : {}),
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { _count: channelRuleCountSelect(organizationId) },
    }),
    // One grouped read for the whole catalogue, unnarrowed by the filters
    // above: an extra entry in this map for a type the listing excluded costs
    // nothing, whereas threading the same `where` through a second query would
    // be a second place for the two to disagree.
    videoDeviationCounts(organizationId),
  ]);

  return rows.map((row) => toDTO(row, deviations));
}

// There is no separate `listContentTypeCatalogue` any more. It existed because
// the management read grouped by niche and the dataset read did not; both want
// the same flat rows now, and a second exported function returning identical
// data is how the two drift apart.

export async function createContentType(
  input: { name: string; colorIndex?: number },
  request?: Request,
): Promise<ContentTypeDTO> {
  // Both halves of the scope: the organization decides where the row lives and
  // what it collides with, the user is recorded only as its author.
  const { organizationId, userId } = await getScope();

  const name = input.name.trim();
  const slug = toSlug(name);

  // Uniqueness is per ORGANIZATION again. One centralised vocabulary means one
  // "Funny Moment", and a second is a duplicate rather than another team's word
  // for something else.
  const existing = await prisma.contentType.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
  });
  if (existing) {
    // Names the collision including its active state, because the most common
    // way to hit this is trying to re-create something archived — and "already
    // exists" with no such type in the list is baffling.
    throw errors.invalidInput(
      existing.isActive
        ? `There is already a content type called “${existing.name}”.`
        : `There is an archived content type called “${existing.name}”. Restore it instead of creating a duplicate.`,
    );
  }

  const count = await prisma.contentType.count({ where: { organizationId } });

  const created = await prisma.contentType.create({
    data: {
      organizationId,
      // Attribution for the byline. Never read back as a filter.
      createdById: userId,
      name,
      slug,
      // Cycle the accent so consecutively created types are visually distinct
      // without the user having to pick a colour.
      colorIndex: input.colorIndex ?? count % CONTENT_TYPE_COLOR_COUNT,
      sortOrder: count,
    },
  });

  await auditContentType(request, {
    action: "contenttype.created",
    targetType: "contentType",
    summary: `Created content type “${created.name}”`,
    targetId: created.id,
    targetLabel: created.name,
  });

  return toContentTypeDTO(created, {
    manualVideoCount: 0,
    excludedVideoCount: 0,
    channelRuleCount: 0,
  });
}

/**
 * Rename or restyle a content type.
 *
 * Renaming is a live edit: the chip changes everywhere at once, on Shorts
 * classified months ago, because the label is a foreign key and not a copied
 * string. That is the desired behaviour — a team that decides "Funny Moment"
 * should read "Comedy" means it retroactively — but it is exactly why the old
 * name goes into the audit metadata. Without it the log would record that a
 * type changed name and leave nobody able to say what the numbers used to be
 * filed under.
 */
export async function renameContentType(
  contentTypeId: string,
  update: { name?: string; colorIndex?: number; sortOrder?: number },
  request?: Request,
): Promise<ContentTypeDTO> {
  const organizationId = await getCurrentOrgId();

  // Scoped by organization, not by author: any teammate holding the permission
  // may rename or recolour a shared type.
  const contentType = await requireOwnContentType(organizationId, contentTypeId);

  const data: { name?: string; slug?: string; colorIndex?: number; sortOrder?: number } = {};

  if (update.name !== undefined) {
    const name = update.name.trim();
    const slug = toSlug(name);
    if (slug !== contentType.slug) {
      const clash = await prisma.contentType.findUnique({
        where: { organizationId_slug: { organizationId, slug } },
      });
      if (clash) {
        throw errors.invalidInput(
          `There is already a content type called “${clash.name}”.`,
        );
      }
    }
    data.name = name;
    data.slug = slug;
  }

  if (update.colorIndex !== undefined) data.colorIndex = update.colorIndex;
  if (update.sortOrder !== undefined) data.sortOrder = update.sortOrder;

  const updated = await prisma.contentType.update({
    where: { id: contentType.id },
    data,
    include: { _count: channelRuleCountSelect(organizationId) },
  });

  // Only a name change is worth an entry. Nudging a colour or a sort position
  // changes nothing anybody could later dispute, and logging it would bury the
  // renames that matter under a drawer of cosmetics.
  if (data.name !== undefined && data.name !== contentType.name) {
    await auditContentType(request, {
      action: "contenttype.renamed",
      targetType: "contentType",
      summary: `Renamed content type “${contentType.name}” to “${updated.name}”`,
      targetId: updated.id,
      targetLabel: updated.name,
      metadata: { previousName: contentType.name, name: updated.name },
    });
  }

  return toDTO(updated, await videoDeviationCounts(organizationId, [updated.id]));
}

/**
 * Archive or restore a content type.
 *
 * Archiving is the answer to "we stopped making these", and it is deliberately
 * non-destructive: every Short already filed under the type keeps its label and
 * every historical comparison still resolves. What stops is the type being
 * offered on new work — see the active check in `assignContentTypeToVideos`.
 */
export async function setContentTypeActive(
  contentTypeId: string,
  isActive: boolean,
  request?: Request,
): Promise<ContentTypeDTO> {
  const organizationId = await getCurrentOrgId();
  const contentType = await requireOwnContentType(organizationId, contentTypeId);

  // A no-op still returns the current row rather than writing one: re-archiving
  // an archived type should not put a second entry in the audit log saying it
  // happened again.
  if (contentType.isActive === isActive) {
    return loadContentType(organizationId, contentType.id);
  }

  const updated = await prisma.contentType.update({
    where: { id: contentType.id },
    data: { isActive },
    include: { _count: channelRuleCountSelect(organizationId) },
  });

  const deviations = await videoDeviationCounts(organizationId, [updated.id]);
  const counts = deviations.get(updated.id) ?? NO_DEVIATIONS;

  await auditContentType(request, {
    action: isActive ? "contenttype.reactivated" : "contenttype.deactivated",
    targetType: "contentType",
    summary: isActive
      ? `Restored content type “${updated.name}”`
      : `Archived content type “${updated.name}”`,
    targetId: updated.id,
    targetLabel: updated.name,
    // The counts are what make the entry meaningful a year later: archiving a
    // type nothing uses and archiving one that six rules hand to whole back
    // catalogues are very different acts, and the row itself will not remember
    // which this was. The rule count is the one that describes reach — the two
    // video counts describe only the exceptions.
    metadata: {
      channelRuleCount: updated._count.channelRules,
      manualVideoCount: counts.manual,
      excludedVideoCount: counts.excluded,
    },
  });

  return toDTO(updated, deviations);
}

/**
 * Delete a content type — only if nothing is filed under it.
 *
 * THE RULE, AND WHY IT IS NOT A CONFIRMATION DIALOG
 * A content type on a Short is a human judgement that exists nowhere else. The
 * join rows cascade, so a delete would silently take every one of those
 * judgements with it and leave the Shorts looking as though they were never
 * classified — and nobody could reconstruct them by looking. So an in-use type
 * is REFUSED rather than confirmed: the caller is told exactly how much would
 * be lost and pointed at deactivation, which keeps every historical label and
 * achieves what they almost certainly wanted.
 *
 * CHANNEL TAGS ARE NOW THE BIGGEST THING A DELETE WOULD DESTROY. A channel tag
 * is what actually reaches the Shorts — every one the channel has published and
 * every one it will — so deleting a type that six channels carry silently
 * unlabels their entire back catalogue. It is reported first for that reason.
 *
 * AND EXCLUSIONS COUNT AS MUCH AS ASSIGNMENTS. A tombstone is somebody looking
 * at a Short their channel had labelled and saying no. Cascading it away would
 * not merely lose that judgement: re-creating a type of the same name and
 * re-tagging the channel would put the tag back on precisely the Shorts a person
 * had refused it for. So the refusal names all three numbers rather than
 * collapsing the video side into one.
 */
export async function deleteContentType(
  contentTypeId: string,
  request?: Request,
): Promise<{ deleted: true }> {
  const organizationId = await getCurrentOrgId();
  const contentType = await requireOwnContentType(organizationId, contentTypeId);

  // UNFILTERED counts, unlike the ones in the catalogue listing. There the
  // question is "how much of this is live?"; here it is "would this delete
  // destroy anything?", and a classification on a channel the team removed from
  // the tracker is still a classification — the channel can be restored, and it
  // would come back stripped of its labels.
  const [manual, excluded, rules] = await Promise.all([
    prisma.videoContentType.count({
      where: { contentTypeId: contentType.id, state: "manual" },
    }),
    prisma.videoContentType.count({
      where: { contentTypeId: contentType.id, state: "excluded" },
    }),
    // CLOSED AND RETIRED RULES COUNT. A rule that stopped claiming new uploads
    // in March still labels everything the channel published before then, and
    // deleting the type would take that year of history with it — silently, and
    // with no way to tell afterwards that it had ever been labelled.
    prisma.channelContentTypeRule.count({ where: { contentTypeId: contentType.id } }),
  ]);

  if (manual > 0 || excluded > 0 || rules > 0) {
    throw errors.invalidInput(
      describeInUse(contentType.name, { manual, excluded, rules }),
      {
        contentTypeId: contentType.id,
        manualVideoCount: manual,
        excludedVideoCount: excluded,
        channelRuleCount: rules,
        // The client does not have to parse the sentence to offer the button.
        canDeactivate: contentType.isActive,
      },
    );
  }

  await prisma.contentType.delete({ where: { id: contentType.id } });

  await auditContentType(request, {
    action: "contenttype.deleted",
    targetType: "contentType",
    summary: `Deleted unused content type “${contentType.name}”`,
    targetId: contentType.id,
    targetLabel: contentType.name,
  });

  return { deleted: true };
}

/**
 * The refusal message, written as a sentence a person can act on.
 *
 * The rule clause comes first and says what it implies, because "6 channel
 * rules" on its own reads as the smallest of the three numbers when it is by far
 * the largest consequence: each of those rules hands the tag to every Short
 * inside its window.
 */
function describeInUse(
  name: string,
  counts: { manual: number; excluded: number; rules: number },
): string {
  const parts: string[] = [];
  if (counts.rules > 0) {
    parts.push(
      `${counts.rules} channel ${counts.rules === 1 ? "rule" : "rules"} (and every Short ${
        counts.rules === 1 ? "it covers" : "they cover"
      })`,
    );
  }
  if (counts.manual > 0) {
    parts.push(`${counts.manual} individually tagged ${counts.manual === 1 ? "Short" : "Shorts"}`);
  }
  if (counts.excluded > 0) {
    parts.push(
      `${counts.excluded} ${counts.excluded === 1 ? "Short that has" : "Shorts that have"} explicitly refused it`,
    );
  }
  return `“${name}” is still filed against ${parts.join(", ")}. Archive it instead — everything already filed under it keeps its label, every refusal is kept, and it stops being offered on new work.`;
}

/**
 * Reorder the organization's vocabulary.
 *
 * ONE list now, so one order. The niche parameter this took last round named a
 * per-niche sequence that no longer exists.
 *
 * THE COMPLETE SET IS REQUIRED, archived types included. A partial order would
 * have to invent positions for whatever it left out, and the obvious inventions
 * are both wrong: appending them silently drags every archived type to the
 * bottom, and leaving their old values makes positions collide so the list
 * settles somewhere nobody asked for. Refusing instead means a client working
 * from a stale payload is told to refresh rather than quietly writing an order
 * its user did not choose. The management screen already fetches archived types,
 * so it always holds the full set even when it is only showing some of it.
 */
export async function reorderContentTypes(
  orderedIds: readonly string[],
  request?: Request,
): Promise<ContentTypeDTO[]> {
  const organizationId = await getCurrentOrgId();

  const existing = await prisma.contentType.findMany({
    where: { organizationId },
    select: { id: true },
  });

  const wanted = [...new Set(orderedIds)];
  const known = new Set(existing.map((row) => row.id));

  if (wanted.length !== orderedIds.length) {
    throw errors.invalidInput("That ordering lists the same content type twice.");
  }
  if (wanted.length !== known.size || wanted.some((id) => !known.has(id))) {
    throw errors.invalidInput(
      `That ordering is out of date — it lists ${wanted.length} of your ${known.size} content ${
        known.size === 1 ? "type" : "types"
      }. Refresh and try again.`,
    );
  }

  // One transaction: a half-applied order is a list nobody chose, and the
  // positions it leaves behind collide with each other.
  await prisma.$transaction(
    wanted.map((id, index) =>
      prisma.contentType.update({ where: { id }, data: { sortOrder: index } }),
    ),
  );

  await auditContentType(request, {
    action: "contenttype.reordered",
    // No single type is the subject of a reorder, so the one that ended up
    // first stands for the list. There is no niche to point at any more.
    targetType: "contentType",
    summary: `Reordered the ${wanted.length} content ${
      wanted.length === 1 ? "type" : "types"
    }`,
    targetId: wanted[0],
    targetLabel: "Content types",
    metadata: { contentTypeCount: wanted.length },
  });

  return listContentTypes({ includeInactive: true });
}

// ---------------------------------------------------------------------------
// REACHABILITY — the only rule left
//
// There is no niche narrowing of the vocabulary any more, so the sole question
// an assignment has to answer is whether the SUBJECT is one this caller may
// touch. Both helpers below answer it the same way and for the same reason:
// `Video` and `Channel` are global, deduplicated rows with no tenant column, so
// reachability through this organization's `TrackedChannel` is the only thing
// that makes one ours — and the niche filter rides inside the same clause so
// "not ours" and "not yours" produce the identical miss.
// ---------------------------------------------------------------------------

/**
 * A Short this caller may classify, WITH the tags it inherits.
 *
 * The channel travels with the video because no decision in this file can be
 * made without it any more: whether a requested tag needs a manual row, whether
 * removing one needs a tombstone or a delete, and whether an assignment is a
 * no-op are all questions about what the channel already gives this Short.
 * Fetching them separately would be two queries and one more chance to answer
 * from a channel that is not the video's.
 */
export interface TaggableVideo {
  readonly id: string;
  readonly title: string;
  readonly channelId: string;
  /**
   * OUR tracking row for the channel — where the rules hang.
   *
   * Carried rather than re-resolved because the streak bookkeeping below writes
   * to rules on this exact row, and looking it up a second time from
   * `channelId` would be a second chance to write to a different organization's
   * reading of the same YouTube channel.
   */
  readonly trackedChannelId: string;
  /** Epoch ms. What decides which rules reach this Short — see `inheritedIds`. */
  readonly publishedAt: number;
  /**
   * Every rule on this channel, windows included.
   *
   * ALL of them, not the covering ones. Two different questions are asked of
   * this list: which rules give THIS Short its tags (the covering ones), and
   * which rule a removal is evidence against (also the covering ones, but
   * identified by id so the streak can be written back). Filtering in the query
   * would answer the first and lose the second.
   */
  readonly rules: readonly ChannelRuleRow[];
  /**
   * The tags this Short inherits — the rules that cover its publish date.
   *
   * Derived here, once, so nothing downstream has to remember that "the
   * channel's tags" is no longer a thing a Short can be resolved against.
   */
  readonly inheritedIds: readonly string[];
}

/** One rule as the assignment paths read it: a window plus its streak state. */
interface ChannelRuleRow extends RuleStreakState {
  readonly id: string;
}

/**
 * The Shorts, of the ids given, that this caller may classify.
 *
 * Ids that do not come back are simply absent from the map; the callers decide
 * whether that is a 404 or a refusal.
 */
async function loadTaggableVideos(
  organizationId: string,
  videoIds: readonly string[],
): Promise<Map<string, TaggableVideo>> {
  if (videoIds.length === 0) return new Map();

  const visibleNiches = await getVisibleNicheIds();

  const rows = await prisma.video.findMany({
    where: {
      id: { in: [...videoIds] },
      channel: {
        trackedBy: {
          some: {
            organizationId,
            isActive: true,
            ...trackedChannelNicheFilter(visibleNiches),
          },
        },
      },
    },
    select: {
      id: true,
      title: true,
      channelId: true,
      // The instant that decides which of the channel's rules reach this Short.
      // Nothing in this file can be answered without it any more.
      publishedAt: true,
      channel: {
        select: {
          /*
           * OUR tracking row for this channel, and only ours.
           *
           * `Channel` is global and several organizations may track it, so this
           * `where` is not an optimisation — without it a Short would inherit
           * another team's editorial read of the same channel, which is the
           * exact cross-tenant leak `ChannelContentTypeRule` hangs off
           * `TrackedChannel` to prevent.
           *
           * `isActive` is deliberately not required, matching
           * `requireVisibleTrackedChannel`: removing a channel from the tracker
           * is a soft delete that keeps its history, and its Shorts should not
           * silently shed their inherited labels while it is parked.
           */
          trackedBy: {
            where: { organizationId },
            select: {
              id: true,
              contentTypeRules: {
                select: {
                  id: true,
                  contentTypeId: true,
                  effectiveFrom: true,
                  effectiveUntil: true,
                  consecutiveOverrides: true,
                  overrideStreakFrom: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const videos = new Map<string, TaggableVideo>();

  for (const row of rows) {
    // At most one tracking row per (organization, channel). A Short whose
    // channel this organization does not track cannot reach here — the `where`
    // above already required it — so an empty array is unreachable rather than
    // a case; skipping is the narrowing, not a policy.
    const tracked = row.channel.trackedBy[0];
    if (!tracked) continue;

    const publishedAt = row.publishedAt.getTime();
    const rules: ChannelRuleRow[] = tracked.contentTypeRules.map((rule) => ({
      id: rule.id,
      contentTypeId: rule.contentTypeId,
      effectiveFrom: rule.effectiveFrom.getTime(),
      effectiveUntil: rule.effectiveUntil?.getTime() ?? null,
      consecutiveOverrides: rule.consecutiveOverrides,
      overrideStreakFrom: rule.overrideStreakFrom?.getTime() ?? null,
    }));

    videos.set(row.id, {
      id: row.id,
      title: row.title,
      channelId: row.channelId,
      trackedChannelId: tracked.id,
      publishedAt,
      rules,
      inheritedIds: inheritedContentTypeIds(rules, publishedAt),
    });
  }

  return videos;
}

/** One Short's row or a 404, so the endpoints never confirm an id. */
async function requireTaggableVideo(
  organizationId: string,
  videoId: string,
): Promise<TaggableVideo> {
  const found = await loadTaggableVideos(organizationId, [videoId]);
  const video = found.get(videoId);
  if (!video) throw errors.notFound("video");
  return video;
}

/**
 * THE TRACKING ROW FOR A GLOBAL CHANNEL ID, or a 404.
 *
 * Takes the `Channel` id — what `ChannelDTO.id` is, and what every channel URL
 * in the app carries — and resolves this organization's `TrackedChannel` for
 * it. That resolution is the whole point: `ChannelContentTypeRule` hangs off the
 * tracking row precisely so two teams watching the same channel can describe it
 * differently — and disagree about when it changed — and exposing the tracking
 * id in a URL would be a second addressing scheme for an object the client
 * already names one way.
 *
 * Same scope reasoning as the video path, and it deliberately does NOT require
 * `isActive`: removing a channel from the tracker is a soft delete that keeps
 * its history, and re-tagging what the team found there is exactly the kind of
 * tidying that happens afterwards — the same reasoning `assertTargetExists`
 * uses for notes.
 */
async function requireVisibleTrackedChannel(
  organizationId: string,
  channelId: string,
): Promise<{ trackedChannelId: string; channelId: string; name: string }> {
  const visibleNiches = await getVisibleNicheIds();

  const tracked = await prisma.trackedChannel.findFirst({
    where: {
      channelId,
      organizationId,
      ...trackedChannelNicheFilter(visibleNiches),
    },
    select: {
      id: true,
      channelId: true,
      label: true,
      channel: { select: { title: true } },
    },
  });
  if (!tracked) throw errors.notFound("channel");

  return {
    trackedChannelId: tracked.id,
    channelId: tracked.channelId,
    // The team's own label wins, because that is the name they read in the log.
    name: tracked.label ?? tracked.channel.title,
  };
}

/**
 * Verifies every requested id is a content type this organization owns.
 *
 * The entire write-side rule, and all that is left of `assertAssignable`. There
 * is no niche to compare against: any Short may carry any of the organization's
 * tags, which is the change this round makes. With the rule gone, so is the
 * `alreadyAssigned` escape hatch it needed — nothing can be refused for a label
 * a Short already legitimately carries, so there is no deadlock to escape.
 *
 * Archived types are accepted here, and only here. Refusing them would mean
 * adding one new label to an old Short silently strips its historical one,
 * which is precisely the data loss `deleteContentType` refuses to allow. The
 * active check belongs on the bulk path, where the intent is unambiguously new
 * work.
 *
 * Returns the rows so callers that need names for an audit summary do not have
 * to fetch them twice.
 */
async function requireOwnContentTypes(
  organizationId: string,
  contentTypeIds: readonly string[],
): Promise<Array<{ id: string; name: string }>> {
  if (contentTypeIds.length === 0) return [];

  const owned = await prisma.contentType.findMany({
    where: { id: { in: [...contentTypeIds] }, organizationId },
    select: { id: true, name: true },
  });

  if (owned.length !== contentTypeIds.length) {
    // One message for "deleted" and for "belongs to another team". Saying which
    // would confirm that an id exists somewhere, which is not this caller's
    // business — the same collapse `requireOwnContentType` makes with its 404.
    throw errors.invalidInput("One or more of those content types no longer exists.");
  }

  return owned;
}

// ---------------------------------------------------------------------------
// Assignment — Shorts
//
// EVERY WRITE BELOW GOES THROUGH ONE RECONCILER, and that is the point of this
// section. "Set this Short's types", "exclude this one tag" and "file 400
// Shorts under Rankings" are three gestures that must agree about what a row
// means, and the way they agree is by all expressing themselves as a DESIRED
// EFFECTIVE SET and letting one function work out which deviations that implies.
// A second place that decided when to write a "manual" row would be a second
// definition of the rule.
// ---------------------------------------------------------------------------

/** One Short's stored deviations, as read back before reconciling. */
interface CurrentDeviations {
  /** What the Short carries right now, channel included. */
  readonly effectiveIds: readonly string[];
  readonly manualIds: readonly string[];
  readonly excludedIds: readonly string[];
}

/**
 * What the caller wants this Short to end up carrying.
 *
 * A FUNCTION of the current state rather than a fixed list, because two of the
 * three callers cannot name their target without reading the Short first: "add
 * Rankings to these 400 Shorts" means "whatever each already has, plus
 * Rankings". Passing the current state in is what lets that be expressed as a
 * desired set like everything else, instead of as a second, sneakier write path.
 */
type DesiredSet = (current: CurrentDeviations, video: TaggableVideo) => readonly string[];

interface VideoReconcileResult {
  readonly before: CurrentDeviations;
  readonly after: DeviationPlan & { readonly effectiveIds: readonly string[] };
}

interface ReconcileOutcome {
  readonly byVideo: ReadonlyMap<string, VideoReconcileResult>;
  /** Rows written, re-stated and removed — the audit metadata, not the caller's report. */
  readonly created: number;
  readonly restated: number;
  readonly deleted: number;
}

/**
 * TRANSLATE DESIRED SETS INTO DEVIATIONS, AND WRITE ONLY WHAT MOVED.
 *
 * RECONCILED, NOT REWRITTEN. A delete-everything-then-recreate would store the
 * same final state and would be three lines shorter, and it would also stamp
 * `assignedById` and `assignedAt` on every surviving row with whoever happened
 * to press Save. Re-opening a picker and confirming an unchanged selection would
 * then quietly reassign a colleague's decision — including their refusals — to
 * the person who merely looked at it. So a row whose meaning has not changed is
 * not touched at all.
 *
 * A row whose STATE has changed is a different matter and is re-stamped
 * deliberately: flipping "manual" to "excluded" is not an edit of the old
 * judgement, it is the opposite judgement, and the person making it is its
 * author.
 *
 * AT MOST FOUR STATEMENTS, whatever the size of the run. The rows are grouped by
 * what is happening to them rather than iterated per Short, so a 500-Short bulk
 * replace is the same four queries as a one-Short save — and they go in one
 * transaction, because a half-applied relabelling is worse than a failed one:
 * the caller cannot tell which half landed.
 */
async function reconcileVideoDeviations(
  organizationId: string,
  userId: string | null,
  videos: readonly TaggableVideo[],
  desired: DesiredSet,
): Promise<ReconcileOutcome> {
  const videoIds = videos.map((video) => video.id);

  // Scoped to this organization, like every read in this file: `Video` is a
  // global row, so an unfiltered read here would reconcile against another
  // team's deviations and then delete them.
  const existing =
    videoIds.length > 0
      ? await prisma.videoContentType.findMany({
          where: { organizationId, videoId: { in: videoIds } },
          select: { id: true, videoId: true, contentTypeId: true, state: true },
        })
      : [];

  const rowsByVideo = new Map<string, typeof existing>();
  for (const row of existing) {
    const bucket = rowsByVideo.get(row.videoId);
    if (bucket) bucket.push(row);
    else rowsByVideo.set(row.videoId, [row]);
  }

  const toCreate: Array<{
    organizationId: string;
    videoId: string;
    contentTypeId: string;
    state: string;
    assignedById: string | null;
  }> = [];
  const toExclude: string[] = [];
  const toManual: string[] = [];
  const toDelete: string[] = [];
  const byVideo = new Map<string, VideoReconcileResult>();

  for (const video of videos) {
    const rows = rowsByVideo.get(video.id) ?? [];
    const manualIds = rows
      .filter((row) => row.state === "manual")
      .map((row) => row.contentTypeId);
    const excludedIds = rows
      .filter((row) => row.state === "excluded")
      .map((row) => row.contentTypeId);

    const before: CurrentDeviations = {
      effectiveIds: effectiveContentTypeIds({
        inheritedIds: video.inheritedIds,
        manualIds,
        excludedIds,
      }),
      manualIds,
      excludedIds,
    };

    const wanted = planDeviations({
      inheritedIds: video.inheritedIds,
      desiredIds: [...new Set(desired(before, video))],
      existingManualIds: manualIds,
      existingExcludedIds: excludedIds,
    });

    byVideo.set(video.id, {
      before,
      after: {
        ...wanted,
        effectiveIds: effectiveContentTypeIds({
          inheritedIds: video.inheritedIds,
          manualIds: wanted.manualIds,
          excludedIds: wanted.excludedIds,
        }),
      },
    });

    // What each tag's row SHOULD be after this, consumed as the existing rows
    // are walked so whatever is left over is exactly what has to be created.
    const target = new Map<string, "manual" | "excluded">();
    for (const id of wanted.manualIds) target.set(id, "manual");
    for (const id of wanted.excludedIds) target.set(id, "excluded");

    for (const row of rows) {
      const state = target.get(row.contentTypeId);
      if (state === undefined) {
        // No longer a deviation: the Short agrees with its channel about this
        // tag again, so the row is removed rather than kept as a no-op. A row
        // that says nothing is how the table fills up with rows that say
        // nothing.
        toDelete.push(row.id);
        continue;
      }
      target.delete(row.contentTypeId);
      // Unchanged meaning: left completely alone, attribution and all.
      if (row.state === state) continue;
      if (state === "excluded") toExclude.push(row.id);
      else toManual.push(row.id);
    }

    for (const [contentTypeId, state] of target) {
      toCreate.push({
        organizationId,
        videoId: video.id,
        contentTypeId,
        state,
        assignedById: userId,
      });
    }
  }

  const writes: Prisma.PrismaPromise<unknown>[] = [];

  // Deletes first. The unique constraint is per (organization, video, content
  // type) and nothing is ever created for a tag whose row is being deleted, so
  // this is not load-bearing — but ordering the destructive step ahead of the
  // creative one is cheap insurance against that stopping being true.
  if (toDelete.length > 0) {
    writes.push(
      prisma.videoContentType.deleteMany({
        where: { organizationId, id: { in: toDelete } },
      }),
    );
  }

  // One timestamp for the whole run, so a bulk exclusion reads as one act in the
  // data rather than as several hundred that happened to be milliseconds apart.
  const stampedAt = new Date();
  for (const [state, ids] of [
    ["excluded", toExclude],
    ["manual", toManual],
  ] as const) {
    if (ids.length === 0) continue;
    writes.push(
      prisma.videoContentType.updateMany({
        where: { organizationId, id: { in: ids } },
        data: { state, assignedById: userId, assignedAt: stampedAt },
      }),
    );
  }

  if (toCreate.length > 0) {
    writes.push(prisma.videoContentType.createMany({ data: toCreate }));
  }

  // Nothing moved: no write, and — since the callers key their audit entries off
  // this — no log entry claiming something did.
  if (writes.length > 0) await prisma.$transaction(writes);

  return {
    byVideo,
    created: toCreate.length,
    restated: toExclude.length + toManual.length,
    deleted: toDelete.length,
  };
}

/**
 * What a per-Short write hands back.
 *
 * The DEVIATIONS, not the effective set alone, because the client patches its
 * cached dataset with exactly these two arrays — that is what `VideoDTO` now
 * carries, and echoing anything else would make the caller derive the storage
 * shape from a rendering shape. The effective ids come along because the caller
 * has already been told them and would otherwise resolve them a second time.
 */
export interface VideoContentTypeState {
  readonly videoId: string;
  readonly manualContentTypeIds: readonly string[];
  readonly excludedContentTypeIds: readonly string[];
  readonly effectiveContentTypeIds: readonly string[];
  /**
   * Rules this edit RETIRED, if it happened to be the third removal.
   *
   * TRAVELS BACK WITH THE WRITE, and that is the whole reason it exists on this
   * shape rather than being left for the next dataset fetch to reveal. A rule
   * that stops applying itself is a change to hundreds of Shorts, made as a side
   * effect of one click, and a person who is not told about it has no way to
   * distinguish it from a bug. So the click that caused it is the moment they
   * hear about it, and the payload carries everything the toast needs to say
   * which tag, which channel, and from what date — plus the id it needs to offer
   * the undo.
   *
   * Empty on every ordinary edit, which is almost all of them.
   */
  readonly closedRules: readonly ChannelRuleClosure[];
}

function toState(
  videoId: string,
  result: VideoReconcileResult,
  closedRules: readonly ChannelRuleClosure[],
): VideoContentTypeState {
  return {
    videoId,
    manualContentTypeIds: result.after.manualIds,
    excludedContentTypeIds: result.after.excludedIds,
    effectiveContentTypeIds: result.after.effectiveIds,
    closedRules,
  };
}

/**
 * What the deviation write says to the rules above it.
 *
 * ONE GESTURE, TWO CONSEQUENCES, and they are deliberately computed from the
 * SAME before/after pair rather than from the request. "Remove Rankings from
 * this Short" and "set this Short's tags to exactly Memes" are different
 * requests that can both amount to taking Rankings off, and a signal derived
 * from what was asked for would see the first and miss the second.
 *
 * `removed` and `added` are movements in the EFFECTIVE set, not in the stored
 * rows. That is the distinction the whole streak depends on: a Short losing a
 * manual row it never needed is not evidence about the channel, whereas a Short
 * that stops carrying a tag its rule gave it is exactly that.
 */
function effectiveMovement(result: VideoReconcileResult): {
  removed: readonly string[];
  added: readonly string[];
} {
  const before = new Set(result.before.effectiveIds);
  const after = new Set(result.after.effectiveIds);
  return {
    removed: result.before.effectiveIds.filter((id) => !after.has(id)),
    added: result.after.effectiveIds.filter((id) => !before.has(id)),
  };
}

/**
 * Set one Short's content types — ITS DESIRED EFFECTIVE SET, not its rows.
 *
 * THE MEANING OF THIS FUNCTION CHANGED, and the signature deliberately did not.
 * The client sends the complete list it wants the Short to carry, which is the
 * only thing it can honestly send: a person looking at a Short sees its tags,
 * not which of them arrived from the channel. Translating that into deviations
 * is this layer's job:
 *
 *   • a channel tag missing from the desired set  → an "excluded" row
 *   • a desired tag the channel does not give     → a "manual" row
 *   • a desired tag the channel does give         → no row at all
 *
 * So `[]` no longer means "delete this Short's rows". It means "this Short
 * carries nothing", which for a Short on a tagged channel is a set of
 * exclusions — and getting that wrong would leave the tag showing after somebody
 * cleared it.
 *
 * `videoId` is the internal `Video` row id (`VideoDTO.id`), not the YouTube id —
 * the client already holds it, and an internal id is not guessable in the way a
 * public YouTube id is.
 */
export async function setVideoContentTypes(
  videoId: string,
  contentTypeIds: readonly string[],
  request?: Request,
): Promise<VideoContentTypeState> {
  const { organizationId, userId } = await getScope();

  const video = await requireTaggableVideo(organizationId, videoId);
  const unique = [...new Set(contentTypeIds)];
  // Validated BEFORE anything is written, as it always was: this path can now
  // create exclusions as well as delete rows, so a throw halfway through would
  // leave a Short refusing tags to satisfy a set that was rejected.
  const owned = await requireOwnContentTypes(organizationId, unique);

  const outcome = await reconcileVideoDeviations(organizationId, userId, [video], () => unique);
  const result = outcome.byVideo.get(video.id);
  // Unreachable: the map is keyed from the same array. Narrowing beats an
  // assertion.
  if (!result) throw errors.notFound("video");

  if (outcome.created + outcome.restated + outcome.deleted > 0) {
    await auditContentType(request, {
      action: "contenttype.video_assigned",
      targetType: "video",
      summary:
        owned.length > 0
          ? `Set content types on “${video.title}” to ${owned.map((t) => t.name).join(", ")}`
          : `Cleared the content types on “${video.title}”`,
      targetId: videoId,
      targetLabel: video.title,
      // The deviation counts, not just the requested set. "Cleared the content
      // types" on a Short whose channel provides three of them is really three
      // refusals, and an entry that did not say so would describe a deletion
      // where a tombstone was written.
      metadata: {
        videoCount: 1,
        contentTypeCount: owned.length,
        mode: "replace",
        manualCount: result.after.manualIds.length,
        excludedCount: result.after.excludedIds.length,
      },
    });
  }

  // A whole-set write is as much a removal as the single-tag route is, and the
  // rules must hear about it either way — a person who clears a Short's tags in
  // the picker has taken the inherited one off just as deliberately as one who
  // pressed "×" on the chip.
  const movement = effectiveMovement(result);
  const closedRules = await signalChannelRules(
    organizationId,
    video,
    movement.removed,
    movement.added,
    request,
  );

  return toState(video.id, result, closedRules);
}

/**
 * REFUSE ONE TAG ON ONE SHORT — the "remove this label" gesture.
 *
 * A ROUTE OF ITS OWN RATHER THAN A WHOLE-SET PUT, and the reason is what the
 * request would otherwise contain. Removing one inherited chip is a one-click
 * action; expressing it as "here is this Short's complete new state" would make
 * that click send everything the client believes about the Short, so a stale tab
 * would silently revert a colleague's edit to a different tag as a side effect
 * of touching this one. A single-tag override can only ever change that tag.
 *
 * TWO CASES, AND THEY STORE DIFFERENT THINGS:
 *
 *   • the channel gives this tag → write a TOMBSTONE. It is kept even if the
 *     channel later drops the tag, so re-adding it to the channel does not
 *     silently undo this refusal. That survival is the entire reason exclusions
 *     are rows rather than an absence.
 *
 *   • the channel does not → DELETE the manual row, and write nothing. The
 *     person is taking back their own earlier "yes", not refusing the channel;
 *     no row means "agrees with the channel", which is exactly true again. A
 *     tombstone here would be a claim nobody made — that if this channel ever
 *     picks the tag up, this Short is to be exempt from it.
 *
 * Idempotent in both cases: refusing a tag the Short already refuses, or has
 * never carried, writes nothing and logs nothing.
 */
export async function excludeContentTypeFromVideo(
  videoId: string,
  contentTypeId: string,
  request?: Request,
): Promise<VideoContentTypeState> {
  const { organizationId, userId } = await getScope();

  const video = await requireTaggableVideo(organizationId, videoId);
  const [contentType] = await requireOwnContentTypes(organizationId, [contentTypeId]);

  const outcome = await reconcileVideoDeviations(
    organizationId,
    userId,
    [video],
    // Everything it carries except this one. Routed through the same reconciler
    // as the whole-set write so "excluded" cannot come to mean something
    // slightly different here — the difference between the two paths is which
    // set is desired, and nothing else.
    (current) => current.effectiveIds.filter((id) => id !== contentTypeId),
  );

  const result = outcome.byVideo.get(video.id);
  if (!result) throw errors.notFound("video");

  const changed = outcome.created + outcome.restated + outcome.deleted > 0;
  if (changed) {
    const tombstoned = result.after.excludedIds.includes(contentTypeId);
    await auditContentType(request, {
      action: "contenttype.video_excluded",
      targetType: "video",
      summary: tombstoned
        ? `Removed “${contentType.name}” from “${video.title}” — refused despite the channel`
        : `Removed “${contentType.name}” from “${video.title}”`,
      targetId: videoId,
      targetLabel: video.title,
      metadata: {
        contentTypeId: contentType.id,
        contentTypeName: contentType.name,
        // Which of the two cases above this was — the difference between a
        // tombstone somebody has to know about and an ordinary un-tagging.
        inherited: tombstoned,
      },
    });
  }

  /*
   * THE SIGNAL, AT ITS SOURCE.
   *
   * This is the gesture the whole retirement mechanism listens for — a person
   * looking at one upload and saying "not this one". Everything else that feeds
   * the streak feeds it because it amounts to the same act; this is the act.
   */
  const movement = effectiveMovement(result);
  const closedRules = await signalChannelRules(
    organizationId,
    video,
    movement.removed,
    movement.added,
    request,
  );

  return toState(video.id, result, closedRules);
}

/**
 * TAKE THE REFUSAL BACK — the inverse of the above, and its undo.
 *
 * Deletes the tombstone so the channel's tag flows through again. Not "re-add
 * the tag": if the channel has since dropped it, removing the tombstone leaves
 * the Short carrying nothing, which is the honest outcome — putting it back
 * manually would be inventing a decision nobody made, and is what
 * `setVideoContentTypes` is for.
 *
 * Idempotent: no tombstone means nothing to undo, so nothing is written and
 * nothing is logged.
 */
export async function restoreInheritedContentType(
  videoId: string,
  contentTypeId: string,
  request?: Request,
): Promise<VideoContentTypeState> {
  const { organizationId, userId } = await getScope();

  const video = await requireTaggableVideo(organizationId, videoId);
  const [contentType] = await requireOwnContentTypes(organizationId, [contentTypeId]);

  const outcome = await reconcileVideoDeviations(
    organizationId,
    userId,
    [video],
    /*
     * Everything it carries, plus this one — which for a suppressed inherited
     * tag resolves to "drop the tombstone" and for anything else resolves to a
     * manual row.
     *
     * That second behaviour is deliberate rather than incidental: the picker
     * offers this route on a tag the channel provides and the Short refuses,
     * but a stale client that fires it at a tag the channel has since dropped
     * gets the tag on the Short, which is what the person asked for, instead of
     * a silent no-op they would have to diagnose.
     */
    (current) => [...current.effectiveIds, contentTypeId],
  );

  const result = outcome.byVideo.get(video.id);
  if (!result) throw errors.notFound("video");

  if (outcome.created + outcome.restated + outcome.deleted > 0) {
    await auditContentType(request, {
      action: "contenttype.video_restored",
      targetType: "video",
      summary: `Restored “${contentType.name}” on “${video.title}”`,
      targetId: videoId,
      targetLabel: video.title,
      metadata: { contentTypeId: contentType.id, contentTypeName: contentType.name },
    });
  }

  /*
   * THE COUNTER-SIGNAL, and the reason this route feeds the machine at all.
   *
   * Putting a tag back on a Short newer than the streak's start is somebody
   * saying the channel is still doing this — the only evidence that clears an
   * accumulating streak short of re-opening the rule by hand. Without it a rule
   * would inch towards retirement across months and never step back, and the
   * three removals that finally closed it might be a year apart with a hundred
   * confirmations in between.
   *
   * It never re-opens a rule that already closed: see `recordConfirmation`.
   */
  const movement = effectiveMovement(result);
  const closedRules = await signalChannelRules(
    organizationId,
    video,
    movement.removed,
    movement.added,
    request,
  );

  return toState(video.id, result, closedRules);
}

export interface BulkAssignResult {
  /** Shorts that did not carry the type and now do. Zero on a re-run. */
  readonly assigned: number;
  /** Shorts that already carried it — inherited or manual — and were left alone. */
  readonly alreadyAssigned: number;
  /**
   * Shorts whose REFUSAL of this type was lifted.
   *
   * Its own number rather than folded into `assigned` because it is a different
   * event with a different history: somebody had explicitly said no to this tag
   * on this Short, and a bulk run has just overridden them. A director who sees
   * "38 filed, 2 refusals lifted" can go and ask; one who sees "40 filed" cannot
   * know there was anything to ask about.
   */
  readonly restored: number;
  /** Other classifications the Shorts no longer carry, in "replace" mode only. */
  readonly removed: number;
  readonly videoCount: number;
}

/**
 * THE BULK PATH — file many Shorts under one content type at once.
 *
 * IDEMPOTENT BY CONSTRUCTION. Re-running with the same input writes nothing and
 * reports `assigned: 0`. That is not a nicety: this is the endpoint somebody
 * double-clicks, and the one a retry after a timeout hits twice.
 *
 * WHAT INHERITANCE CHANGES HERE, stated because the brief asks for the choice to
 * be named:
 *
 *   • ASSIGNING A TAG THE CHANNEL ALREADY PROVIDES IS A NO-OP for that Short,
 *     counted under `alreadyAssigned`. It does NOT write a manual row. Writing
 *     one would be the exact mistake the whole design avoids — a per-Short copy
 *     of something the channel already says, which then goes stale the moment
 *     the channel changes its mind. The Short already carries the tag; there is
 *     nothing to add.
 *
 *   • A SHORT THAT REFUSES THE TAG HAS ITS REFUSAL LIFTED. Somebody is
 *     explicitly asking for this tag on this selection, and silently skipping
 *     the Shorts that had a tombstone would produce a bulk run that quietly did
 *     not do what it said. It is reported separately (`restored`) precisely
 *     because it overrides an earlier decision.
 *
 * "REPLACE" IS EXPRESSED AS A DESIRED SET, like everything else: each Short's
 * desired set becomes exactly this one tag, so the channel's other tags become
 * exclusions rather than being ignored. A "replace" that left inherited tags in
 * place would be the one mode in the product whose name did not describe it.
 *
 * What still holds unchanged: every selected Short must be REACHABLE by this
 * caller, checked in one query before anything is written.
 */
export async function assignContentTypeToVideos(
  input: { videoIds: readonly string[]; contentTypeId: string; mode: AssignMode },
  request?: Request,
): Promise<BulkAssignResult> {
  const { organizationId, userId } = await getScope();

  const contentType = await prisma.contentType.findFirst({
    where: { id: input.contentTypeId, organizationId },
    select: { id: true, name: true, isActive: true },
  });
  if (!contentType) throw errors.notFound("content type");

  // Unlike the per-Short path, this one is unambiguously new work: nobody
  // bulk-files a back catalogue under a type the team has retired. Refusing is
  // what makes archiving mean something.
  if (!contentType.isActive) {
    throw errors.invalidInput(
      `“${contentType.name}” is archived. Restore it before filing new Shorts under it.`,
    );
  }

  const videoIds = [...new Set(input.videoIds)];

  // Every id verified against what this caller can actually see, in one query,
  // BEFORE anything is written. A video id from another team's tracker must be
  // rejected outright — writing the ones that happen to be valid and dropping
  // the rest would report success for a request that was partly a probe of
  // somebody else's data.
  const reachable = await loadTaggableVideos(organizationId, videoIds);
  if (reachable.size !== videoIds.length) {
    throw errors.invalidInput(
      "Some of those Shorts are not in your tracker. Refresh and try again.",
    );
  }

  const videos = videoIds.map((id) => reachable.get(id)).filter((v) => v !== undefined);

  const outcome = await reconcileVideoDeviations(
    organizationId,
    userId,
    videos,
    (current) =>
      input.mode === "replace"
        ? [contentType.id]
        : [...current.effectiveIds, contentType.id],
  );

  let assigned = 0;
  let alreadyAssigned = 0;
  let restored = 0;
  let removed = 0;

  for (const result of outcome.byVideo.values()) {
    const had = result.before.effectiveIds.includes(contentType.id);
    if (had) alreadyAssigned += 1;
    else assigned += 1;
    // A tombstone that was doing work and no longer exists. Read off the stored
    // deviations rather than inferred from `had`, because a dormant tombstone
    // for a tag the channel does not provide is also lifted here and is also
    // somebody's decision being overridden.
    if (
      result.before.excludedIds.includes(contentType.id) &&
      !result.after.excludedIds.includes(contentType.id)
    ) {
      restored += 1;
    }
    for (const id of result.before.effectiveIds) {
      if (!result.after.effectiveIds.includes(id)) removed += 1;
    }
  }

  const changed = outcome.created + outcome.restated + outcome.deleted > 0;

  if (changed) {
    await auditContentType(request, {
      action: "contenttype.video_assigned",
      // The type, not the videos: a bulk run has no single video to point at, and
      // "everything ever filed under Character Moments" is the useful thread.
      targetType: "contentType",
      /*
       * The summary counts what CHANGED, not what was asked for.
       *
       * Filing the same fifteen Shorts twice is a normal thing to do — the
       * control is fast and repeatable by design — and the second run writes
       * nothing. Reporting it as "Filed 15 Shorts" would put an event in the
       * accountability log describing work that did not happen, and an audit
       * trail that overstates is worse than one that is merely terse: somebody
       * reading it later cannot tell the real relabelling from the echo.
       *
       * "Already filed" now includes Shorts that inherit the tag from their
       * channel and were correctly left alone, which is the common case for a
       * selection drawn from one tagged channel.
       */
      summary: (() => {
        const suffix = input.mode === "replace" ? " (replacing existing types)" : "";
        const shorts = (n: number) => `${n} ${n === 1 ? "Short" : "Shorts"}`;

        if (assigned > 0) {
          return `Filed ${shorts(assigned)} under “${contentType.name}”${suffix}`;
        }
        if (removed > 0) {
          return `Cleared other content types from ${shorts(videoIds.length)} already filed under “${contentType.name}”`;
        }
        return `Lifted ${shorts(restored)} refusal${restored === 1 ? "" : "s"} of “${contentType.name}”`;
      })(),
      targetId: contentType.id,
      targetLabel: contentType.name,
      // Counts, never the id list. `sanitizeMetadata` truncates arrays at 20
      // entries, so a 400-video run would record a misleading fragment.
      metadata: {
        mode: input.mode,
        videoCount: videoIds.length,
        assigned,
        alreadyAssigned,
        restored,
        removed,
      },
    });
  }

  return { assigned, alreadyAssigned, restored, removed, videoCount: videoIds.length };
}

// ---------------------------------------------------------------------------
// CHANNEL RULES
//
// "Everything this channel makes is a Funny Meme" — with an expiry date it
// writes for itself.
//
// WHAT WENT, AND WHY NOTHING REPLACES IT ONE-FOR-ONE. There used to be a
// `setChannelContentTypes` here that took a channel and a complete set of tags
// and stored the difference. It is gone at the owner's instruction, and not
// because a rule is a nicer way to say the same thing: the flat set could not
// express the only fact that matters about a channel's output, which is that it
// CHANGES. A channel that made rankings all last year and switched to cutscenes
// in March had exactly two options under the old model — go on falsely tagging
// every new upload, or untag the channel and strip the label off the year of
// rankings that genuinely were rankings. Neither is a thing anybody wants, and
// no amount of care at the call site could have avoided choosing between them.
//
// So there is no "set this channel's tags" any more. There is APPLYING one tag
// from a Short (`applyContentTypeToChannel`), which is where somebody actually
// forms the opinion, and there is opening and closing a window by hand
// (`setChannelContentTypeRuleWindow`). Removing a tag from a channel wholesale
// is not an operation, because it was never an honest one.
// ---------------------------------------------------------------------------

/**
 * A rule that has just stopped claiming new uploads, described well enough to
 * tell somebody about it.
 *
 * EVERYTHING A TOAST NEEDS AND NOTHING IT DOES NOT. The names travel resolved
 * rather than as ids because the sentence is the point — "Stopped applying Funny
 * Memes to new uploads on this channel from 4 March" — and a client assembling
 * it from three lookups would be one stale cache away from naming the wrong tag.
 * `ruleId` is what makes the undo one action.
 */
export interface ChannelRuleClosure {
  readonly ruleId: string;
  readonly contentTypeId: string;
  readonly contentTypeName: string;
  /** The GLOBAL channel id, so the client can find the channel it already holds. */
  readonly channelId: string;
  readonly channelName: string;
  /** The date the channel actually changed — where the rule now ends. */
  readonly effectiveUntil: number;
  /** True when the streak closed it; false when a person did. Always true here. */
  readonly automatic: boolean;
}

/**
 * TELL THE RULES WHAT JUST HAPPENED TO ONE SHORT.
 *
 * Called by every per-Short write, with the movement in that Short's EFFECTIVE
 * tags. What each movement means to a rule is decided in
 * `src/lib/content-types/rules.ts`; what this function decides is which rules
 * hear about it and what is written when one closes.
 *
 * ONLY RULES THAT COVER THIS SHORT ARE CANDIDATES, which falls out of the state
 * machine's own coverage check rather than being filtered here — a removal on a
 * Short published before a rule began is not evidence about that rule, and the
 * schema's whole reason for windows is that the two cases are now
 * distinguishable.
 *
 * =========================================================================
 * WHAT DELIBERATELY DOES NOT REACH THIS FUNCTION: THE BULK PATH
 * =========================================================================
 *
 * `assignContentTypeToVideos` can strip an inherited tag off five hundred Shorts
 * in one request, and it does not feed a single override in. That is a decision,
 * not an oversight, and it rests on what the streak is evidence OF.
 *
 * The streak is a claim that a channel CHANGED AT A POINT IN TIME: three
 * consecutive uploads that a person looked at and said were no longer this.
 * A bulk run is the opposite shape of act — one statement about a selection
 * somebody assembled, made once, usually while relabelling a back catalogue.
 * Feeding it in would satisfy the threshold instantly and, because the close is
 * dated to the EARLIEST Short in the streak, would date the retirement to the
 * oldest Short in the selection — retiring the rule across the very history the
 * person was in the middle of tidying.
 *
 * The person doing that already has the honest lever: close the rule by hand, at
 * the date they mean. Making the bulk path guess at that date from a selection
 * would be exactly the inference this design refuses to make.
 *
 * ATTRIBUTION: the close is audited against whoever made the removal that
 * completed the streak. They did not ask for it, but they caused it, and an
 * accountability log with an unattributable change to shared data in it is worse
 * than one that names the person who can explain what they were doing.
 */
async function signalChannelRules(
  organizationId: string,
  video: TaggableVideo,
  removedIds: readonly string[],
  addedIds: readonly string[],
  request?: Request,
): Promise<ChannelRuleClosure[]> {
  if (video.rules.length === 0) return NO_CLOSURES;
  if (removedIds.length === 0 && addedIds.length === 0) return NO_CLOSURES;

  const removed = new Set(removedIds);
  const added = new Set(addedIds);

  const pending: Array<{ rule: ChannelRuleRow; change: RuleStreakChange }> = [];
  for (const rule of video.rules) {
    /*
     * A tag cannot be both removed and added by one edit — they are movements
     * in the same set — so the branch is exclusive by construction rather than
     * by precedence. Written as an if/else anyway, because a future caller that
     * passed overlapping arrays should get one signal rather than two
     * contradictory ones applied in whatever order this loop happens to take.
     */
    const change = removed.has(rule.contentTypeId)
      ? recordOverride(rule, video.publishedAt)
      : added.has(rule.contentTypeId)
        ? recordConfirmation(rule, video.publishedAt)
        : null;
    if (change) pending.push({ rule, change });
  }

  if (pending.length === 0) return NO_CLOSURES;

  // One instant for the whole write, so a Short that happens to close two rules
  // records them as the single act it was.
  const noticedAt = new Date();

  /*
   * NO `organizationId` IN THESE `where` CLAUSES, AND NONE NEEDED.
   *
   * Every rule here came out of `loadTaggableVideos`, which read them through
   * `trackedBy: { where: { organizationId } }` — our tracking row, and only
   * ours. They are this organization's by construction, which is the entire
   * reason `ChannelContentTypeRule` hangs off `TrackedChannel` rather than off
   * the globally shared `Channel`. An id filter is the tenancy check here.
   */
  await prisma.$transaction(
    pending.map(({ rule, change }) =>
      prisma.channelContentTypeRule.update({
        where: { id: rule.id },
        data: {
          consecutiveOverrides: change.consecutiveOverrides,
          overrideStreakFrom:
            change.overrideStreakFrom === null ? null : new Date(change.overrideStreakFrom),
          // TWO DATES, KEPT APART. `effectiveUntil` is when the channel changed
          // — the publish date of the first Short in the streak. `autoClosedAt`
          // is when we worked that out. Collapsing them would give a tidy
          // history and a wrong one, and would leave every upload between the
          // switch and the discovery falsely tagged forever.
          ...(change.closesAt === null
            ? {}
            : { effectiveUntil: new Date(change.closesAt), autoClosedAt: noticedAt }),
        },
      }),
    ),
  );

  const closed = pending.filter((entry) => entry.change.closesAt !== null);
  if (closed.length === 0) return NO_CLOSURES;

  // Names, fetched only now: a streak grows on most removals and closes on very
  // few, so the common path pays for no lookups at all.
  const [tracked, contentTypes] = await Promise.all([
    prisma.trackedChannel.findUnique({
      where: { id: video.trackedChannelId },
      select: { label: true, channel: { select: { title: true } } },
    }),
    prisma.contentType.findMany({
      where: {
        id: { in: closed.map((entry) => entry.rule.contentTypeId) },
        organizationId,
      },
      select: { id: true, name: true },
    }),
  ]);

  // The team's own label wins, as it does everywhere else: it is the name they
  // read on the channel page and the one the toast has to match.
  const channelName = tracked?.label ?? tracked?.channel.title ?? "this channel";
  const nameById = new Map(contentTypes.map((type) => [type.id, type.name]));

  const closures: ChannelRuleClosure[] = [];
  for (const { rule, change } of closed) {
    // Narrowing, not a possibility: `closed` is filtered on exactly this.
    if (change.closesAt === null) continue;
    const contentTypeName = nameById.get(rule.contentTypeId) ?? "that content type";

    closures.push({
      ruleId: rule.id,
      contentTypeId: rule.contentTypeId,
      contentTypeName,
      channelId: video.channelId,
      channelName,
      effectiveUntil: change.closesAt,
      automatic: true,
    });

    await auditContentType(request, {
      action: "contenttype.channel_rule_closed",
      targetType: "channel",
      summary: `Stopped applying “${contentTypeName}” to new uploads on “${channelName}” from ${formatRuleDate(
        change.closesAt,
      )} — ${RULE_AUTO_CLOSE_STREAK} Shorts in a row had it removed`,
      targetId: video.channelId,
      targetLabel: channelName,
      metadata: {
        ruleId: rule.id,
        contentTypeId: rule.contentTypeId,
        contentTypeName,
        // WHICH DOOR IT WENT THROUGH. "The app retired this after three
        // corrections" and "Ada closed it" send a reader to entirely different
        // questions, and the summary alone would not survive being skimmed.
        automatic: true,
        effectiveUntil: change.closesAt,
        // The Short whose removal completed the streak. The thread back to the
        // evidence, for anybody who thinks the rule retired wrongly.
        triggeredByVideoId: video.id,
        consecutiveOverrides: change.consecutiveOverrides,
      },
    });
  }

  return closures;
}

/** Shared empty result, so the overwhelmingly common outcome allocates nothing. */
const NO_CLOSURES: ChannelRuleClosure[] = [];

/**
 * A date as it appears in a sentence somebody reads — "4 March 2025".
 *
 * `en-GB` and UTC, both deliberate. The app's dates are epoch milliseconds and
 * every other summary in the audit log is written in the same voice; formatting
 * against the server's local zone would put a different day in the log than the
 * one on the rule for anything published near midnight.
 */
function formatRuleDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * "APPLY TO THIS CHANNEL" — one action that covers the whole back catalogue and
 * everything published next.
 *
 * THE ONLY WAY A TAG REACHES A CHANNEL NOW, and it is reached from a Short
 * rather than from a channel settings screen, because that is where the opinion
 * is actually formed: somebody watches an upload, files it as a Funny Meme, and
 * realises the channel only makes those. Making them navigate to the channel to
 * say so is how the thought gets lost.
 *
 * WHERE THE WINDOW STARTS, and why it is not "the earliest Short we have
 * stored". The library grows BACKWARDS as well as forwards — the lookback window
 * is a setting, and a sync run can import Shorts older than anything currently
 * held. A rule dated to today's earliest Short would silently fail to cover them
 * when they arrived, and nobody would connect the missing labels to a rule
 * written months earlier. So it starts at the earliest instant this channel
 * COULD have published anything: the channel's own YouTube creation date, or the
 * earliest Short we hold if that is older still, or the epoch if we know
 * neither. "At or before the channel's earliest Short" is then true permanently
 * rather than true today.
 *
 * IDEMPOTENT, AND IT ABSORBS THE THREE WAYS IT CAN BE RE-RUN:
 *
 *   • an open rule that already covers the whole history → nothing to write;
 *   • an open rule that starts too late → its start is pulled back, which is the
 *     "back catalogue" half of the promise being kept on a rule that was only
 *     keeping the forward half;
 *   • only closed rules → the one starting at this date is RE-OPENED rather than
 *     duplicated, because a second row for the same tag and the same start would
 *     violate the schema's uniqueness and, more to the point, would say the same
 *     thing twice.
 */
export async function applyContentTypeToChannel(
  channelId: string,
  contentTypeId: string,
  request?: Request,
): Promise<ChannelContentTypeRuleDTO> {
  const { organizationId, userId } = await getScope();

  const channel = await requireVisibleTrackedChannel(organizationId, channelId);
  const [contentType] = await requireOwnContentTypes(organizationId, [contentTypeId]);
  // Unreachable — `requireOwnContentTypes` throws on a miss — but narrowing an
  // array index beats asserting one.
  if (!contentType) throw errors.notFound("content type");

  const effectiveFrom = await earliestPossiblePublish(channel.channelId);

  const existing = await prisma.channelContentTypeRule.findMany({
    where: { trackedChannelId: channel.trackedChannelId, contentTypeId: contentType.id },
    orderBy: { effectiveFrom: "asc" },
  });

  const open = existing.find((rule) => rule.effectiveUntil === null);

  if (open) {
    if (open.effectiveFrom.getTime() <= effectiveFrom.getTime()) {
      // Already says exactly this. No write, and therefore no audit entry
      // claiming a channel was re-characterised when nothing moved.
      return toChannelContentTypeRuleDTO(open);
    }

    // A rule that was claiming new uploads but not the back catalogue. Pulling
    // its start back is the whole of what this action means, so it is an edit
    // rather than a second row — two overlapping rules for one tag would resolve
    // identically and read as a mistake to the next person.
    const widened = await prisma.channelContentTypeRule.update({
      where: { id: open.id },
      data: { effectiveFrom },
    });

    await auditContentType(request, {
      action: "contenttype.channel_rule_applied",
      targetType: "channel",
      summary: `Applied “${contentType.name}” to “${channel.name}” back to ${formatRuleDate(
        effectiveFrom.getTime(),
      )}`,
      targetId: channel.channelId,
      targetLabel: channel.name,
      metadata: {
        ruleId: widened.id,
        contentTypeId: contentType.id,
        contentTypeName: contentType.name,
        effectiveFrom: effectiveFrom.getTime(),
        widenedFrom: open.effectiveFrom.getTime(),
      },
    });

    return toChannelContentTypeRuleDTO(widened);
  }

  const sameStart = existing.find(
    (rule) => rule.effectiveFrom.getTime() === effectiveFrom.getTime(),
  );

  const rule = sameStart
    ? await prisma.channelContentTypeRule.update({
        where: { id: sameStart.id },
        // Re-opening clears the streak AND the auto-close stamp: the evidence
        // that retired it has just been overruled by a person, and leaving it
        // behind would make the rule look retired on every screen that reads
        // `autoClosedAt` to explain itself.
        data: {
          effectiveUntil: null,
          autoClosedAt: null,
          consecutiveOverrides: 0,
          overrideStreakFrom: null,
        },
      })
    : await prisma.channelContentTypeRule.create({
        data: {
          organizationId,
          trackedChannelId: channel.trackedChannelId,
          contentTypeId: contentType.id,
          effectiveFrom,
          createdById: userId,
        },
      });

  await auditContentType(request, {
    action: sameStart
      ? "contenttype.channel_rule_reopened"
      : "contenttype.channel_rule_applied",
    targetType: "channel",
    summary: sameStart
      ? `Re-applied “${contentType.name}” to “${channel.name}” — the rule claims new uploads again`
      : `Applied “${contentType.name}” to “${channel.name}” and everything it publishes next`,
    // The global channel id, so the entry is findable from the same URL the rest
    // of the app uses for this channel.
    targetId: channel.channelId,
    targetLabel: channel.name,
    metadata: {
      ruleId: rule.id,
      contentTypeId: contentType.id,
      contentTypeName: contentType.name,
      effectiveFrom: effectiveFrom.getTime(),
    },
  });

  return toChannelContentTypeRuleDTO(rule);
}

/**
 * The earliest instant this channel could have published anything.
 *
 * Not a guess and not a fudge: a video cannot predate the channel that hosts it,
 * so `channelPublishedAt` is a true lower bound on everything that will ever be
 * imported for it. The stored earliest video is consulted too and wins if it is
 * older, because YouTube's channel creation date is occasionally wrong in ways
 * ours is not.
 *
 * Falls back to the epoch when neither is known — a brand-new channel with no
 * videos fetched yet. That is the honest floor rather than "now": a rule written
 * before the first sync must still cover what the first sync brings back.
 */
async function earliestPossiblePublish(channelId: string): Promise<Date> {
  const [channel, earliest] = await Promise.all([
    prisma.channel.findUnique({
      where: { id: channelId },
      select: { channelPublishedAt: true },
    }),
    prisma.video.findFirst({
      where: { channelId },
      orderBy: { publishedAt: "asc" },
      select: { publishedAt: true },
    }),
  ]);

  const candidates = [channel?.channelPublishedAt, earliest?.publishedAt].filter(
    (value): value is Date => value !== null && value !== undefined,
  );

  if (candidates.length === 0) return new Date(0);
  return new Date(Math.min(...candidates.map((value) => value.getTime())));
}

/**
 * THE MANUAL LEVER — close a rule at a date, or re-open it.
 *
 * The automatic path is a safety net, not the only door, and this is the door.
 * Somebody who KNOWS a channel switched in March should not have to remove the
 * tag from three Shorts to say so, and somebody who thinks the streak got it
 * wrong must be able to undo it in one action — which is the same action, with
 * `effectiveUntil: null`.
 *
 * RE-OPENING CLEARS THE EVIDENCE, all of it: `effectiveUntil`, `autoClosedAt`,
 * and the streak that produced them. Leaving the streak at two would arm the
 * rule to retire itself again on the very next removal, for reasons a person had
 * already rejected — a re-open that lasts one click is not an undo.
 *
 * CLOSING BY HAND NEVER SETS `autoClosedAt`. That column is the difference
 * between "the app decided this" and "Ada decided this", and the UI says which.
 * Stamping it here would make every deliberate close read as something the
 * system did on its own.
 */
export async function setChannelContentTypeRuleWindow(
  channelId: string,
  ruleId: string,
  effectiveUntil: number | null,
  request?: Request,
): Promise<ChannelContentTypeRuleDTO> {
  const organizationId = await getCurrentOrgId();
  const channel = await requireVisibleTrackedChannel(organizationId, channelId);

  /*
   * BOTH IDS IN THE `where`, and the tracking id is the tenancy check.
   *
   * A rule id from another team's channel simply does not match, so it 404s
   * exactly as an id that never existed does — the endpoint never confirms that
   * somebody else's rule is real. The same collapse `requireOwnContentType`
   * makes, for the same reason.
   */
  const rule = await prisma.channelContentTypeRule.findFirst({
    where: { id: ruleId, trackedChannelId: channel.trackedChannelId },
  });
  if (!rule) throw errors.notFound("content type rule");

  const contentType = await prisma.contentType.findFirst({
    where: { id: rule.contentTypeId, organizationId },
    select: { name: true },
  });
  const contentTypeName = contentType?.name ?? "that content type";

  if (effectiveUntil !== null && effectiveUntil <= rule.effectiveFrom.getTime()) {
    // A window that ends before it starts covers nothing, and a rule covering
    // nothing is a delete wearing a close's clothes — it would strip the tag off
    // the whole back catalogue while the UI went on describing it as "closed on
    // the 4th". Refused with the date it would have to beat.
    throw errors.invalidInput(
      `That rule starts on ${formatRuleDate(
        rule.effectiveFrom.getTime(),
      )}. Close it on a later date, or remove the tag from the Shorts instead.`,
    );
  }

  // Already exactly this. Returned rather than re-written, so re-opening an open
  // rule does not put a second entry in the log saying it happened again.
  if ((rule.effectiveUntil?.getTime() ?? null) === effectiveUntil) {
    return toChannelContentTypeRuleDTO(rule);
  }

  const updated = await prisma.channelContentTypeRule.update({
    where: { id: rule.id },
    data: {
      effectiveUntil: effectiveUntil === null ? null : new Date(effectiveUntil),
      autoClosedAt: null,
      consecutiveOverrides: 0,
      overrideStreakFrom: null,
    },
  });

  const reopened = effectiveUntil === null;

  await auditContentType(request, {
    action: reopened
      ? "contenttype.channel_rule_reopened"
      : "contenttype.channel_rule_closed",
    targetType: "channel",
    summary: reopened
      ? `Re-opened “${contentTypeName}” on “${channel.name}” — it claims new uploads again`
      : `Stopped applying “${contentTypeName}” to new uploads on “${channel.name}” from ${formatRuleDate(
          effectiveUntil,
        )}`,
    targetId: channel.channelId,
    targetLabel: channel.name,
    metadata: {
      ruleId: rule.id,
      contentTypeId: rule.contentTypeId,
      contentTypeName,
      automatic: false,
      effectiveUntil,
      // What was undone, when it was a self-retirement. The one fact a reader
      // needs to tell "somebody disagreed with the app" from "somebody changed
      // their own mind".
      ...(reopened && rule.autoClosedAt
        ? { reopenedAutoClose: rule.autoClosedAt.getTime() }
        : {}),
    },
  });

  return toChannelContentTypeRuleDTO(updated);
}
