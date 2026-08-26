/**
 * Research layer — notes, saved Shorts and collections.
 *
 * Everything here hangs off the same canonical Channel / Video rows the
 * analytics read, so a saved Short and a dashboard row are the same underlying
 * record. There is no second copy of view counts, upload dates or Shorts
 * classification anywhere in this file.
 *
 * SCOPE
 * Research belongs to the ORGANIZATION, not to whoever typed it. A note only a
 * single account can read is a private notebook, and the whole point of the
 * team migration is that a colleague's saved Short shows up on everybody's
 * board. So every read, update and delete here filters on `organizationId`;
 * `createdById` is written on create for the byline and the audit trail and is
 * never used as a filter.
 *
 * Channel and Video rows are *global* and deduplicated across tenants, so
 * "belongs to this organization" is never a column on them — it is the join
 * through TrackedChannel. Every place this file touches a channel or a video
 * goes through that join for exactly that reason.
 */

import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import type {
  CollectionDTO,
  NoteDTO,
  NoteTargetType,
  NoteWithContextDTO,
  SavedShortDTO,
} from "@/lib/dto";
import { getCurrentOrgId, getScope } from "./user-service";

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const noteTargetSchema = z.enum(["channel", "niche", "video"]);

export const createNoteSchema = z.object({
  targetType: noteTargetSchema,
  targetId: z.string().min(1),
  body: z.string().trim().min(1, "Write something first.").max(4000),
});

export const updateNoteSchema = z.object({
  body: z.string().trim().min(1, "Write something first.").max(4000),
});

function noteWhereForTarget(targetType: NoteTargetType, targetId: string) {
  switch (targetType) {
    case "channel":
      return { channelId: targetId };
    case "niche":
      return { nicheId: targetId };
    case "video":
      return { videoId: targetId };
  }
}

function toNoteDTO(note: {
  id: string;
  targetType: string;
  channelId: string | null;
  nicheId: string | null;
  videoId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}): NoteDTO {
  return {
    id: note.id,
    targetType: note.targetType as NoteTargetType,
    targetId: note.channelId ?? note.nicheId ?? note.videoId ?? "",
    body: note.body,
    createdAt: note.createdAt.getTime(),
    updatedAt: note.updatedAt.getTime(),
  };
}

export async function listNotes(
  targetType: NoteTargetType,
  targetId: string,
): Promise<NoteDTO[]> {
  // Notes on a channel are the team's discussion of that channel, so the thread
  // is the same one for everyone in the organization.
  const organizationId = await getCurrentOrgId();
  const rows = await prisma.note.findMany({
    where: { organizationId, targetType, ...noteWhereForTarget(targetType, targetId) },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toNoteDTO);
}

export async function createNote(input: {
  targetType: NoteTargetType;
  targetId: string;
  body: string;
}): Promise<NoteDTO> {
  const { organizationId, userId } = await getScope();

  // Verify the target exists *and is in scope* before writing, so a note can
  // never dangle and can never be attached to another tenant's research.
  await assertTargetExists(input.targetType, input.targetId, organizationId);

  const note = await prisma.note.create({
    data: {
      organizationId,
      // Byline only. The note belongs to the team; `createdById` just records
      // who wrote it so the log reads like a conversation.
      createdById: userId,
      targetType: input.targetType,
      body: input.body.trim(),
      ...noteWhereForTarget(input.targetType, input.targetId),
    },
  });
  return toNoteDTO(note);
}

/**
 * Confirms the note's target exists *and* is visible to this organization.
 *
 * Existence alone is not enough. An unscoped lookup by id turns note creation
 * into an enumeration oracle: POST an id and the difference between 404 and 201
 * reveals whether some other tenant tracks that channel or Short. Scoping the
 * check makes an out-of-scope id indistinguishable from one that was never
 * real.
 *
 * Channels and videos are global deduplicated rows, so scope for them is the
 * TrackedChannel join rather than a column. The join deliberately does not
 * require `isActive`: removing a channel from the tracker is a soft delete that
 * keeps its history, and the team must still be able to annotate what it found.
 */
async function assertTargetExists(
  targetType: NoteTargetType,
  targetId: string,
  organizationId: string,
): Promise<void> {
  const exists =
    targetType === "channel"
      ? await prisma.channel.findFirst({
          where: { id: targetId, trackedBy: { some: { organizationId } } },
          select: { id: true },
        })
      : targetType === "niche"
        ? await prisma.niche.findFirst({
            where: { id: targetId, organizationId },
            select: { id: true },
          })
        : await prisma.video.findFirst({
            where: {
              id: targetId,
              channel: { trackedBy: { some: { organizationId } } },
            },
            select: { id: true },
          });

  if (!exists) throw errors.notFound(targetType);
}

export async function updateNote(noteId: string, body: string): Promise<NoteDTO> {
  // Scoped to the organization, not to the author: shared research has to be
  // correctable by whoever is looking at it, and it must outlive the person who
  // wrote it. Who edited last is an audit question, not an access question.
  const organizationId = await getCurrentOrgId();
  const existing = await prisma.note.findFirst({ where: { id: noteId, organizationId } });
  if (!existing) throw errors.notFound("note");

  const note = await prisma.note.update({
    where: { id: existing.id },
    data: { body: body.trim() },
  });
  return toNoteDTO(note);
}

export async function deleteNote(noteId: string): Promise<void> {
  const organizationId = await getCurrentOrgId();
  const existing = await prisma.note.findFirst({ where: { id: noteId, organizationId } });
  if (!existing) throw errors.notFound("note");
  await prisma.note.delete({ where: { id: existing.id } });
}

/** Note counts per target, so the UI can badge things without N queries. */
export async function getNoteCounts(): Promise<{
  channels: Record<string, number>;
  niches: Record<string, number>;
  videos: Record<string, number>;
}> {
  // The badge counts what the team has written, so a Director sees "3 notes"
  // on a channel even when all three were written by someone else — otherwise
  // the badge would quietly hide the discussion it exists to advertise.
  const organizationId = await getCurrentOrgId();
  const rows = await prisma.note.findMany({
    where: { organizationId },
    select: { channelId: true, nicheId: true, videoId: true },
  });

  const channels: Record<string, number> = {};
  const niches: Record<string, number> = {};
  const videos: Record<string, number> = {};

  for (const row of rows) {
    if (row.channelId) channels[row.channelId] = (channels[row.channelId] ?? 0) + 1;
    if (row.nicheId) niches[row.nicheId] = (niches[row.nicheId] ?? 0) + 1;
    if (row.videoId) videos[row.videoId] = (videos[row.videoId] ?? 0) + 1;
  }

  return { channels, niches, videos };
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export const collectionNameSchema = z
  .string()
  .trim()
  .min(1, "Give the collection a name.")
  .max(60, "Collection names must be 60 characters or fewer.");

export const createCollectionSchema = z.object({ name: collectionNameSchema });
export const updateCollectionSchema = z.object({ name: collectionNameSchema });

function toSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

const COLLECTION_COLOR_COUNT = 6;

export async function listCollections(): Promise<CollectionDTO[]> {
  // Collections are shared folders. "GTA Hooks" has to mean the same folder to
  // everyone, or two people filing into it would be filing into two places.
  const organizationId = await getCurrentOrgId();
  const rows = await prisma.collection.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { items: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    colorIndex: row.colorIndex,
    itemCount: row._count.items,
    createdAt: row.createdAt.getTime(),
  }));
}

export async function createCollection(name: string): Promise<CollectionDTO> {
  const { organizationId, userId } = await getScope();
  const slug = toSlug(name);

  // Name collisions are now a team-wide question: if a colleague already made
  // "GTA Hooks", the answer is to use theirs, not to create a second folder
  // with the same name that only one person can see.
  const clash = await prisma.collection.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
  });
  if (clash) throw errors.invalidInput(`A collection called "${clash.name}" already exists.`);

  const count = await prisma.collection.count({ where: { organizationId } });
  const row = await prisma.collection.create({
    data: {
      organizationId,
      createdById: userId,
      name: name.trim(),
      slug,
      colorIndex: count % COLLECTION_COLOR_COUNT,
      sortOrder: count,
    },
  });

  return {
    id: row.id,
    name: row.name,
    colorIndex: row.colorIndex,
    itemCount: 0,
    createdAt: row.createdAt.getTime(),
  };
}

export async function renameCollection(id: string, name: string): Promise<CollectionDTO> {
  const organizationId = await getCurrentOrgId();
  const existing = await prisma.collection.findFirst({ where: { id, organizationId } });
  if (!existing) throw errors.notFound("collection");

  const slug = toSlug(name);
  if (slug !== existing.slug) {
    const clash = await prisma.collection.findUnique({
      where: { organizationId_slug: { organizationId, slug } },
    });
    if (clash) throw errors.invalidInput(`A collection called "${clash.name}" already exists.`);
  }

  const row = await prisma.collection.update({
    where: { id: existing.id },
    data: { name: name.trim(), slug },
    include: { _count: { select: { items: true } } },
  });

  return {
    id: row.id,
    name: row.name,
    colorIndex: row.colorIndex,
    itemCount: row._count.items,
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * Deleting a collection removes the folder, never the saved Shorts inside it.
 * The join rows cascade; the SavedShort records survive and simply become
 * uncollected. Same principle as deleting a niche.
 */
export async function deleteCollection(id: string): Promise<{ removedItems: number }> {
  const organizationId = await getCurrentOrgId();
  const existing = await prisma.collection.findFirst({
    where: { id, organizationId },
    include: { _count: { select: { items: true } } },
  });
  if (!existing) throw errors.notFound("collection");

  await prisma.collection.delete({ where: { id: existing.id } });
  return { removedItems: existing._count.items };
}

// ---------------------------------------------------------------------------
// Saved Shorts
// ---------------------------------------------------------------------------

export const saveShortSchema = z.object({
  /** Internal Video row id. */
  videoId: z.string().min(1),
  /** Captured at save time so later growth is measurable. */
  channelMedianAtSave: z.number().nonnegative().nullable().optional(),
  outlierMultipleAtSave: z.number().nonnegative().nullable().optional(),
  collectionIds: z.array(z.string().min(1)).max(20).optional(),
});

/**
 * Saves a Short, capturing its current view count.
 *
 * `viewsAtSave` is read from the database rather than accepted from the client:
 * the point-in-time record has to be trustworthy, and a client-supplied number
 * could be stale or wrong. Re-saving an already-saved Short updates its
 * collections but deliberately leaves the original capture untouched — that
 * first number is the whole value of the feature.
 */
export async function saveShort(input: {
  videoId: string;
  channelMedianAtSave?: number | null;
  outlierMultipleAtSave?: number | null;
  collectionIds?: readonly string[];
}): Promise<SavedShortDTO> {
  const { organizationId, userId } = await getScope();

  // The Short must live on a channel this organization tracks. `Video` is a
  // global, deduplicated table, so an id-only lookup would let any video row in
  // the deployment be bookmarked — and because the saved card then renders that
  // channel's title, avatar and niches, saving would become a way to read
  // another tenant's tracker one id at a time. Inactive tracking rows still
  // count: un-tracking is a soft delete, and the Shorts already found there
  // remain part of this team's research.
  const video = await prisma.video.findFirst({
    where: {
      id: input.videoId,
      channel: { trackedBy: { some: { organizationId } } },
    },
    select: { id: true, viewCount: true },
  });
  if (!video) throw errors.notFound("video");

  // Saving is idempotent per organization, not per person: if a colleague saved
  // this Short last week, the second save must attach to their row so the
  // original `viewsAtSave` capture — the entire point of the feature — survives
  // instead of being replaced by today's number under a different owner.
  const existing = await prisma.savedShort.findUnique({
    where: { organizationId_videoId: { organizationId, videoId: video.id } },
  });

  const saved =
    existing ??
    (await prisma.savedShort.create({
      data: {
        organizationId,
        createdById: userId,
        videoId: video.id,
        viewsAtSave: video.viewCount,
        channelMedianAtSave:
          input.channelMedianAtSave != null
            ? BigInt(Math.round(input.channelMedianAtSave))
            : null,
        outlierMultipleAtSave: input.outlierMultipleAtSave ?? null,
      },
    }));

  if (input.collectionIds) {
    await setSavedShortCollections(saved.id, input.collectionIds, organizationId);
  }

  return getSavedShortById(saved.id, organizationId);
}

export async function unsaveShort(videoId: string): Promise<void> {
  const organizationId = await getCurrentOrgId();
  const existing = await prisma.savedShort.findUnique({
    where: { organizationId_videoId: { organizationId, videoId } },
  });
  if (!existing) return; // idempotent — unsaving something absent is a no-op
  await prisma.savedShort.delete({ where: { id: existing.id } });
}

async function setSavedShortCollections(
  savedShortId: string,
  collectionIds: readonly string[],
  organizationId: string,
): Promise<void> {
  const unique = [...new Set(collectionIds)];

  if (unique.length > 0) {
    // Still a membership check, just a team-wide one: the ids must name folders
    // in *this* organization, so a client cannot file a Short into another
    // tenant's collection by guessing an id.
    const owned = await prisma.collection.findMany({
      where: { id: { in: unique }, organizationId },
      select: { id: true },
    });
    if (owned.length !== unique.length) {
      throw errors.invalidInput("One or more of those collections no longer exists.");
    }
  }

  await prisma.$transaction([
    prisma.savedShortCollection.deleteMany({ where: { savedShortId } }),
    ...(unique.length > 0
      ? [
          prisma.savedShortCollection.createMany({
            data: unique.map((collectionId) => ({ savedShortId, collectionId })),
          }),
        ]
      : []),
  ]);
}

export async function updateSavedShortCollections(
  videoId: string,
  collectionIds: readonly string[],
): Promise<SavedShortDTO> {
  const organizationId = await getCurrentOrgId();
  const saved = await prisma.savedShort.findUnique({
    where: { organizationId_videoId: { organizationId, videoId } },
  });
  if (!saved) throw errors.notFound("saved Short");

  await setSavedShortCollections(saved.id, collectionIds, organizationId);
  return getSavedShortById(saved.id, organizationId);
}

/**
 * The joins a saved-Short card needs, scoped to one organization.
 *
 * A function rather than a module constant, because the `trackedBy` filter has
 * to close over the caller's organization and a constant cannot. `Channel` is a
 * global deduplicated row that any number of tenants may track, so an
 * unfiltered include returns *every* tenant's tracking row and the `[0]` read
 * below then picks an arbitrary one — labelling the card with another team's
 * custom name, ownership flag and niches. Filtering makes that array at most one
 * element long, and that element is ours.
 */
const savedInclude = (organizationId: string) =>
  ({
    video: {
      include: {
        channel: {
          include: {
            trackedBy: {
              where: { organizationId },
              include: { niches: { include: { niche: true } } },
            },
          },
        },
      },
    },
    collections: { include: { collection: true } },
  }) as const satisfies Prisma.SavedShortInclude;

type SavedRow = Awaited<
  ReturnType<
    typeof prisma.savedShort.findFirstOrThrow<{ include: ReturnType<typeof savedInclude> }>
  >
>;

function toSavedShortDTO(row: SavedRow): SavedShortDTO {
  // Safe to take the first element only because `savedInclude` filtered
  // `trackedBy` to this organization, and organizationId_channelId is unique —
  // so there is either one row or none.
  const tracking = row.video.channel.trackedBy[0] ?? null;

  return {
    id: row.id,
    videoId: row.video.id,
    youtubeVideoId: row.video.youtubeVideoId,
    title: row.video.title,
    publishedAt: row.video.publishedAt.getTime(),
    durationSeconds: row.video.durationSeconds,

    channelId: row.video.channelId,
    channelName: tracking?.label ?? row.video.channel.title,
    channelHandle: row.video.channel.handle,
    channelAvatarUrl: row.video.channel.avatarUrl,
    ownershipType:
      tracking?.ownershipType === "own" ? "own" : "competitor",
    niches: (tracking?.niches ?? []).map((a) => ({
      id: a.niche.id,
      name: a.niche.name,
      colorIndex: a.niche.colorIndex,
    })),

    viewsAtSave: Number(row.viewsAtSave),
    currentViews: Number(row.video.viewCount),
    channelMedianAtSave:
      row.channelMedianAtSave === null ? null : Number(row.channelMedianAtSave),
    outlierMultipleAtSave: row.outlierMultipleAtSave,

    savedAt: row.savedAt.getTime(),
    collectionIds: row.collections.map((c) => c.collectionId),
  };
}

async function getSavedShortById(
  id: string,
  organizationId: string,
): Promise<SavedShortDTO> {
  // `findFirst` with the organization in the where clause rather than a lookup
  // by primary key: callers already resolved this row in scope, and repeating
  // the filter means a future caller cannot turn this into a read-any-row
  // helper by accident.
  const row = await prisma.savedShort.findFirstOrThrow({
    where: { id, organizationId },
    include: savedInclude(organizationId),
  });
  return toSavedShortDTO(row);
}

export async function listSavedShorts(): Promise<SavedShortDTO[]> {
  // One shared board. A Short somebody else spotted is exactly the thing the
  // rest of the team needs to see.
  const organizationId = await getCurrentOrgId();
  const rows = await prisma.savedShort.findMany({
    where: { organizationId },
    include: savedInclude(organizationId),
    orderBy: { savedAt: "desc" },
  });
  return rows.map(toSavedShortDTO);
}

// ---------------------------------------------------------------------------
// Aggregated notes
// ---------------------------------------------------------------------------

/**
 * Context joins for the notes log, scoped to one organization.
 *
 * Same reason `savedInclude` is a function: the `trackedBy` includes feed
 * `trackedBy[0]` reads below, and an unfiltered join would let another tenant's
 * tracking row supply the channel label and niche chips on our own note.
 */
const noteContextInclude = (organizationId: string) =>
  ({
    channel: {
      include: {
        trackedBy: {
          where: { organizationId },
          include: { niches: { include: { niche: true } } },
        },
      },
    },
    niche: true,
    video: {
      include: {
        channel: {
          include: {
            trackedBy: {
              where: { organizationId },
              include: { niches: { include: { niche: true } } },
            },
          },
        },
      },
    },
  }) as const satisfies Prisma.NoteInclude;

/**
 * Every note the team has written, with its context resolved.
 *
 * Joins the channel / niche / video in one query rather than letting the
 * client fetch each target separately: a research log is only useful if you
 * can scan it, and scanning means every row already says what it was about.
 */
export async function listAllNotes(): Promise<NoteWithContextDTO[]> {
  const organizationId = await getCurrentOrgId();

  const rows = await prisma.note.findMany({
    where: { organizationId },
    include: noteContextInclude(organizationId),
    orderBy: { createdAt: "desc" },
  });

  return rows.map((row) => {
    const base = toNoteDTO(row);

    if (row.niche) {
      return {
        ...base,
        targetLabel: row.niche.name,
        channelId: null,
        channelName: null,
        channelAvatarUrl: null,
        niches: [
          { id: row.niche.id, name: row.niche.name, colorIndex: row.niche.colorIndex },
        ],
        videoId: null,
        youtubeVideoId: null,
      };
    }

    if (row.video) {
      const channel = row.video.channel;
      // At most one element: `noteContextInclude` filtered this to our
      // organization, and organizationId_channelId is unique.
      const tracking = channel.trackedBy[0] ?? null;
      return {
        ...base,
        targetLabel: row.video.title,
        channelId: channel.id,
        channelName: tracking?.label ?? channel.title,
        channelAvatarUrl: channel.avatarUrl,
        niches: (tracking?.niches ?? []).map((a) => ({
          id: a.niche.id,
          name: a.niche.name,
          colorIndex: a.niche.colorIndex,
        })),
        videoId: row.video.id,
        youtubeVideoId: row.video.youtubeVideoId,
      };
    }

    if (row.channel) {
      // Same one-row-or-none guarantee as above.
      const tracking = row.channel.trackedBy[0] ?? null;
      return {
        ...base,
        targetLabel: tracking?.label ?? row.channel.title,
        channelId: row.channel.id,
        channelName: tracking?.label ?? row.channel.title,
        channelAvatarUrl: row.channel.avatarUrl,
        niches: (tracking?.niches ?? []).map((a) => ({
          id: a.niche.id,
          name: a.niche.name,
          colorIndex: a.niche.colorIndex,
        })),
        videoId: null,
        youtubeVideoId: null,
      };
    }

    // Should be unreachable: every note has exactly one target by construction.
    return {
      ...base,
      targetLabel: "Unknown",
      channelId: null,
      channelName: null,
      channelAvatarUrl: null,
      niches: [],
      videoId: null,
      youtubeVideoId: null,
    };
  });
}
