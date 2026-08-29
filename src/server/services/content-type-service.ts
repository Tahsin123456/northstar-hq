import "server-only";

import { z } from "zod";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import { recordAudit } from "@/server/audit/audit-service";
import type { AuditAction } from "@/lib/audit/actions";
import {
  getVisibleNicheIds,
  trackedChannelNicheFilter,
} from "@/server/auth/niche-scope";
import { toContentTypeDTO } from "@/server/mappers";
import type { ContentTypeDTO } from "@/lib/dto";
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
 * A TAG ATTACHES TO TWO THINGS
 *
 *   • `ChannelContentType` — the team's editorial read on a channel it watches.
 *     Hangs off `TrackedChannel` rather than `Channel` because the same YouTube
 *     channel is one global row that two organizations would describe
 *     differently.
 *   • `VideoContentType` — what one Short actually was.
 *
 * They are independent on purpose. The channel tag says what the team expects;
 * the Short tags record what it delivered, and the gap between them is often
 * the finding.
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

export const contentTypeIdsSchema = z.array(z.string().min(1)).max(20);

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
 * The two filtered relation counts every catalogue read reports.
 *
 * `VideoContentType` carries a tenant column precisely because `Video` does
 * not, so its filter is what stops the count including another team's
 * classifications of the same globally-shared Short. `ChannelContentType`
 * reaches the tenant through `TrackedChannel`, so its filter is a join —
 * different mechanism, same requirement.
 */
function usageCountSelect(organizationId: string) {
  return {
    select: {
      videos: { where: { organizationId } },
      channels: { where: { trackedChannel: { organizationId } } },
    },
  } as const;
}

type CountedContentType = Parameters<typeof toContentTypeDTO>[0] & {
  _count: { videos: number; channels: number };
};

function toDTO(row: CountedContentType): ContentTypeDTO {
  return toContentTypeDTO(row, {
    videoCount: row._count.videos,
    channelCount: row._count.channels,
  });
}

/** Re-reads one type with its counts, so every mutation returns the same shape. */
async function loadContentType(
  organizationId: string,
  contentTypeId: string,
): Promise<ContentTypeDTO> {
  const row = await prisma.contentType.findFirstOrThrow({
    where: { id: contentTypeId, organizationId },
    include: { _count: usageCountSelect(organizationId) },
  });
  return toDTO(row);
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

  const rows = await prisma.contentType.findMany({
    // The whole team shares one vocabulary, so this lists the organization's
    // types rather than the ones the signed-in user created.
    where: {
      organizationId,
      ...(options.includeInactive ? {} : { isActive: true }),
      ...(search ? { slug: { contains: search } } : {}),
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: usageCountSelect(organizationId) },
  });

  return rows.map(toDTO);
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

  return toContentTypeDTO(created, { videoCount: 0, channelCount: 0 });
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
    include: { _count: usageCountSelect(organizationId) },
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

  return toDTO(updated);
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
    include: { _count: usageCountSelect(organizationId) },
  });

  await auditContentType(request, {
    action: isActive ? "contenttype.reactivated" : "contenttype.deactivated",
    targetType: "contentType",
    summary: isActive
      ? `Restored content type “${updated.name}”`
      : `Archived content type “${updated.name}”`,
    targetId: updated.id,
    targetLabel: updated.name,
    // The counts are what make the entry meaningful a year later: archiving a
    // type nothing uses and archiving one carrying 400 classifications are very
    // different acts, and the row itself will not remember which this was.
    metadata: {
      videoCount: updated._count.videos,
      channelCount: updated._count.channels,
    },
  });

  return toDTO(updated);
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
 * CHANNEL TAGS COUNT TOO, and are reported separately. A channel tag is a
 * cheaper judgement than a Short's — you can re-derive it by looking at the
 * channel — but it is still somebody's filing, and a delete that silently
 * stripped six channels while calling the type unused would be a lie.
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
  const [videos, channels] = await Promise.all([
    prisma.videoContentType.count({ where: { contentTypeId: contentType.id } }),
    prisma.channelContentType.count({ where: { contentTypeId: contentType.id } }),
  ]);

  if (videos > 0 || channels > 0) {
    throw errors.invalidInput(describeInUse(contentType.name, videos, channels), {
      contentTypeId: contentType.id,
      videoCount: videos,
      channelCount: channels,
      // The client does not have to parse the sentence to offer the button.
      canDeactivate: contentType.isActive,
    });
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

/** The refusal message, written as a sentence a person can act on. */
function describeInUse(name: string, videos: number, channels: number): string {
  const parts: string[] = [];
  if (videos > 0) parts.push(`${videos} ${videos === 1 ? "Short" : "Shorts"}`);
  if (channels > 0) {
    parts.push(`${channels} ${channels === 1 ? "channel" : "channels"}`);
  }
  return `“${name}” is still filed against ${parts.join(" and ")}. Archive it instead — everything already filed under it keeps its label, and it stops being offered on new work.`;
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
 * The Shorts, of the ids given, that this caller may classify.
 *
 * Ids that do not come back are simply absent from the map; the callers decide
 * whether that is a 404 or a refusal.
 */
async function loadTaggableVideos(
  organizationId: string,
  videoIds: readonly string[],
): Promise<Map<string, { id: string; title: string }>> {
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
    select: { id: true, title: true },
  });

  return new Map(rows.map((row) => [row.id, row]));
}

/** One Short's row or a 404, so the endpoints never confirm an id. */
async function requireTaggableVideo(
  organizationId: string,
  videoId: string,
): Promise<{ id: string; title: string }> {
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
 * it. That resolution is the whole point: `ChannelContentType` hangs off the
 * tracking row precisely so two teams watching the same channel can describe it
 * differently, and exposing the tracking id in a URL would be a second
 * addressing scheme for an object the client already names one way.
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
// ---------------------------------------------------------------------------

/**
 * Replace one Short's content types wholesale.
 *
 * Set semantics: the client sends the complete desired list and the server
 * reconciles, which makes the call idempotent and removes a class of drift
 * bugs. An empty array clears the Short's classification.
 *
 * `videoId` is the internal `Video` row id (`VideoDTO.id`), not the YouTube id —
 * the client already holds it, and an internal id is not guessable in the way a
 * public YouTube id is.
 */
export async function setVideoContentTypes(
  videoId: string,
  contentTypeIds: readonly string[],
  request?: Request,
): Promise<void> {
  const { organizationId, userId } = await getScope();

  const video = await requireTaggableVideo(organizationId, videoId);
  const unique = [...new Set(contentTypeIds)];
  const owned = await requireOwnContentTypes(organizationId, unique);

  await prisma.$transaction([
    // Scoped to this organization, so replacing our labels cannot delete
    // another team's classification of the same global Video row.
    prisma.videoContentType.deleteMany({ where: { organizationId, videoId } }),
    ...(unique.length > 0
      ? [
          prisma.videoContentType.createMany({
            data: unique.map((contentTypeId) => ({
              organizationId,
              videoId,
              contentTypeId,
              assignedById: userId,
            })),
          }),
        ]
      : []),
  ]);

  await auditContentType(request, {
    action: "contenttype.video_assigned",
    targetType: "video",
    summary:
      owned.length > 0
        ? `Set content types on “${video.title}” to ${owned.map((t) => t.name).join(", ")}`
        : `Cleared the content types on “${video.title}”`,
    targetId: videoId,
    targetLabel: video.title,
    metadata: { videoCount: 1, contentTypeCount: owned.length, mode: "replace" },
  });
}

export interface BulkAssignResult {
  /** Join rows actually written. Zero on a re-run — see the idempotency note. */
  readonly assigned: number;
  /** Videos that already carried the type and were left alone. */
  readonly alreadyAssigned: number;
  /** Other classifications removed, in "replace" mode only. */
  readonly removed: number;
  readonly videoCount: number;
}

/**
 * THE BULK PATH — file many Shorts under one content type at once.
 *
 * IDEMPOTENT BY CONSTRUCTION. Re-running with the same input writes nothing and
 * reports `assigned: 0`. That is not a nicety: this is the endpoint somebody
 * double-clicks, and the one a retry after a timeout hits twice. The unique
 * constraint `(organizationId, videoId, contentTypeId)` is the backstop, but the
 * existing rows are read and subtracted first rather than relying on it —
 * `createMany({ skipDuplicates })` is unavailable on SQLite, which this schema
 * must still run on, and catching a constraint violation would lose the count
 * the caller is told.
 *
 * THE NICHE-MISMATCH REFUSAL IS GONE. A selection spanning channels in different
 * niches is now an ordinary bulk run — that is what an org-wide tag is for, and
 * it is the gesture that makes "Funny Memes across the whole operation" a row on
 * the performance table. What still holds is that every selected Short must be
 * REACHABLE by this caller, checked in one query before anything is written.
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

  // Unlike the replace path above, this one is unambiguously new work: nobody
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

  const existing = await prisma.videoContentType.findMany({
    where: { organizationId, contentTypeId: contentType.id, videoId: { in: videoIds } },
    select: { videoId: true },
  });
  const alreadyAssigned = new Set(existing.map((row) => row.videoId));
  const toCreate = videoIds.filter((id) => !alreadyAssigned.has(id));

  // "replace" clears every OTHER type off these Shorts. Scoped to this
  // organization and to these videos, and deliberately excluding the type being
  // assigned so a re-run does not delete and rewrite the rows it just made —
  // which would churn `assignedAt` and lose the original attribution.
  const removals =
    input.mode === "replace"
      ? [
          prisma.videoContentType.deleteMany({
            where: {
              organizationId,
              videoId: { in: videoIds },
              contentTypeId: { not: contentType.id },
            },
          }),
        ]
      : [];

  const writes =
    toCreate.length > 0
      ? [
          prisma.videoContentType.createMany({
            data: toCreate.map((videoId) => ({
              organizationId,
              videoId,
              contentTypeId: contentType.id,
              // Attribution, so a 400-Short relabelling can be traced to
              // whoever ran it long after the audit entry scrolls away.
              assignedById: userId,
            })),
          }),
        ]
      : [];

  // One transaction: a partial bulk assignment is worse than a failed one,
  // because the caller cannot tell which half landed.
  const results = await prisma.$transaction([...removals, ...writes]);
  const removed = input.mode === "replace" ? (results[0]?.count ?? 0) : 0;

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
     * A run that removed other labels is still a change even when it added
     * nothing, so "replace" is reported on the removals it actually made.
     */
    summary: (() => {
      const suffix = input.mode === "replace" ? " (replacing existing types)" : "";
      const shorts = (n: number) => `${n} ${n === 1 ? "Short" : "Shorts"}`;

      if (toCreate.length > 0) {
        return `Filed ${shorts(toCreate.length)} under “${contentType.name}”${suffix}`;
      }
      if (removed > 0) {
        return `Cleared other content types from ${shorts(videoIds.length)} already filed under “${contentType.name}”`;
      }
      return `No change — ${shorts(videoIds.length)} were already filed under “${contentType.name}”`;
    })(),
    targetId: contentType.id,
    targetLabel: contentType.name,
    // Counts, never the id list. `sanitizeMetadata` truncates arrays at 20
    // entries, so a 400-video run would record a misleading fragment.
    metadata: {
      mode: input.mode,
      videoCount: videoIds.length,
      assigned: toCreate.length,
      alreadyAssigned: alreadyAssigned.size,
      removed,
    },
  });

  return {
    assigned: toCreate.length,
    alreadyAssigned: alreadyAssigned.size,
    removed,
    videoCount: videoIds.length,
  };
}

// ---------------------------------------------------------------------------
// Assignment — channels
// ---------------------------------------------------------------------------

/**
 * Replace one tracked channel's content types wholesale.
 *
 * The restored half of the taxonomy, and worth having back for a reason the
 * video side cannot cover: "this channel makes Rankings" is a statement of what
 * the team watches it FOR, made once when the channel is added, and it is what
 * lets somebody find the competitors in a format before a single Short of
 * theirs has been classified.
 *
 * Same set semantics as the video path — the client sends the complete desired
 * list — and the same reachability rule. `channelId` is the GLOBAL channel id,
 * matching every other channel endpoint; the tracking row the join hangs off is
 * resolved from it, which is what makes the tag ours rather than a fact about
 * the channel that every other tenant would inherit.
 */
export async function setChannelContentTypes(
  channelId: string,
  contentTypeIds: readonly string[],
  request?: Request,
): Promise<void> {
  const { organizationId, userId } = await getScope();

  const channel = await requireVisibleTrackedChannel(organizationId, channelId);
  const unique = [...new Set(contentTypeIds)];
  const owned = await requireOwnContentTypes(organizationId, unique);

  /*
   * RECONCILED, NOT REWRITTEN, and the difference is attribution.
   *
   * A delete-everything-then-recreate would be simpler and would store the same
   * final set — but it would stamp `assignedById` and `createdAt` on every
   * surviving row with whoever happened to press Save. Re-opening this dialog
   * and confirming an unchanged selection would then quietly reassign a
   * colleague's decision to the person who looked at it, which is precisely the
   * kind of silent authorship change the stored-column rule exists to prevent.
   *
   * Reading first and subtracting is also what makes the write idempotent
   * without `createMany({ skipDuplicates })` — unavailable on SQLite, which
   * this schema must still run on.
   *
   * No `organizationId` filter on any of these queries, and none needed: the
   * join rows hang off OUR tracking row, so they are ours by construction —
   * which is exactly why the tag lives on `TrackedChannel` and not on
   * `Channel`.
   */
  const existing = await prisma.channelContentType.findMany({
    where: { trackedChannelId: channel.trackedChannelId },
    select: { contentTypeId: true },
  });
  const before = new Set(existing.map((row) => row.contentTypeId));

  const toRemove = [...before].filter((id) => !unique.includes(id));
  const toCreate = unique.filter((id) => !before.has(id));

  // Nothing moved: no write, and no audit entry claiming one happened.
  if (toRemove.length === 0 && toCreate.length === 0) return;

  await prisma.$transaction([
    ...(toRemove.length > 0
      ? [
          prisma.channelContentType.deleteMany({
            where: {
              trackedChannelId: channel.trackedChannelId,
              contentTypeId: { in: toRemove },
            },
          }),
        ]
      : []),
    ...(toCreate.length > 0
      ? [
          prisma.channelContentType.createMany({
            data: toCreate.map((contentTypeId) => ({
              trackedChannelId: channel.trackedChannelId,
              contentTypeId,
              assignedById: userId,
            })),
          }),
        ]
      : []),
  ]);

  await auditContentType(request, {
    action: "contenttype.channel_assigned",
    targetType: "channel",
    summary:
      owned.length > 0
        ? `Set content types on “${channel.name}” to ${owned.map((t) => t.name).join(", ")}`
        : `Cleared the content types on “${channel.name}”`,
    // The global channel id, so the entry is findable from the same URL the
    // rest of the app uses for this channel.
    targetId: channel.channelId,
    targetLabel: channel.name,
    metadata: {
      contentTypeCount: owned.length,
      added: toCreate.length,
      removed: toRemove.length,
    },
  });
}
