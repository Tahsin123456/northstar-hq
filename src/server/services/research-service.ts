/**
 * Research layer — notes, saved Shorts and collections.
 *
 * Everything here hangs off the same canonical Channel / Video rows the
 * analytics read, so a saved Short and a dashboard row are the same underlying
 * record. There is no second copy of view counts, upload dates or Shorts
 * classification anywhere in this file.
 *
 * SCOPE — TWO DIFFERENT QUESTIONS
 * This file used to answer both with `organizationId`, and that was the bug the
 * owner reported: a brand-new Head of Shorts signed in and was looking at the
 * admin's notebook and the admin's shortlist. Everyone in the organization
 * passes an organization filter, so it never narrowed anything down to a
 * person.
 *
 *   • Channels, videos, niches, content types and analytics are GLOBAL. They
 *     describe the operation, everybody compares the same numbers, and they
 *     stay scoped to the organization (and to a member's niches) exactly as
 *     they were. Nothing in this file makes them personal.
 *   • Notes, saved Shorts and collections are PERSONAL. They are one person's
 *     working state — a half-formed observation, a shortlist of things worth a
 *     second look — and the person who wrote them is the person who reads them.
 *
 * Personal rows are visible to their author, and to an admin holding
 * `users.manage` whose job is overseeing the team — and then always with the
 * author's name attached, never anonymously. Everybody else does not see the
 * row at all. `personalScope()` below is the one place that decision is made,
 * and it hands back a `where` fragment so the decision lands in the query
 * rather than in something a caller can forget to apply afterwards.
 *
 * NOTES HAVE A SECOND DIMENSION: SHARING
 * A note can be marked shared, and a shared note is team research rather than
 * working memory. What "shared" does NOT mean is "everybody": it reaches the
 * colleagues who can ALREADY see what the note is about. A shared note on a Red
 * Dead channel reaches whoever holds Red Dead, and stops there — otherwise
 * sharing a note would be a back door for handing somebody a niche they were
 * never assigned, and the niche scoping in `niche-scope.ts` would be one
 * checkbox away from meaningless.
 *
 * So the note predicate is never "shared" on its own. It is "mine, OR (shared
 * AND its subject is in my scope)", and it is built once in `noteScope()` —
 * `personalScope()`'s sibling, and used by every note READ in this file
 * including the counts behind the badges. Saved Shorts and collections have no
 * sharing dimension at all and keep using `personalScope()`; see the comment on
 * `listSavedShorts`.
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
import { actorCan } from "@/server/auth/dal";
import {
  getVisibleNicheIds,
  nicheIdFilter,
  trackedChannelNicheFilter,
  type VisibleNiches,
} from "@/server/auth/niche-scope";
import { AUTHOR_ME, GENERAL_NOTE_LABEL } from "@/lib/dto";
// The one mapper for a niche chip. These three call sites used to inline the
// same three fields; `kind` is a fourth now, and hand-copying it in three
// places is three chances for a chip here to disagree with the same niche
// everywhere else.
import { toNicheRefDTO } from "@/server/mappers";
import {
  canonicalShortUrl,
  parseYouTubeVideoId,
  EXTERNAL_SHORT_URL_HINT,
} from "@/lib/youtube-url";
import {
  canFetchExternalVideoMetadata,
  fetchExternalVideoMetadata,
} from "./youtube";
import type {
  CollectionDTO,
  NoteDTO,
  NoteKind,
  NoteTargetType,
  NoteVisibility,
  NoteWithContextDTO,
  SavedShortDTO,
} from "@/lib/dto";
import { getScope } from "./user-service";

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

interface PersonalScope {
  readonly organizationId: string;
  readonly userId: string;
  /**
   * Spread into a `where` to restrict a read to rows the caller may see.
   *
   * `{ createdById: userId }` for an ordinary member; `{}` — no author
   * condition at all — for an admin who oversees everyone.
   */
  readonly authorFilter: { readonly createdById?: string };
}

/**
 * Who is asking, and whose personal rows they are entitled to read.
 *
 * A `where` fragment rather than a boolean on purpose. A boolean has to be
 * acted on somewhere else, and the somewhere else is what gets forgotten — the
 * brief is explicit that filtering in the frontend is not a fix. Spreading
 * `...authorFilter` into the query means the narrowing is part of the SQL, so
 * the rows a colleague may not see are never loaded, never serialised and
 * never sent.
 *
 * Neither call costs a query: `getScope` and `getActor` are both memoised for
 * the life of the request, so this is the same session lookup the route handler
 * already made.
 */
async function personalScope(): Promise<PersonalScope> {
  const [{ organizationId, userId }, seesEveryone] = await Promise.all([
    getScope(),
    // `users.manage` is the permission that already means "this person
    // administers the team". Reading their research is part of that job, and
    // inventing a second permission for it would be a rule nobody sets.
    actorCan("users.manage"),
  ]);

  return {
    organizationId,
    userId,
    // The whole rule, in one expression. An admin gets no author condition at
    // all, which is why this is a spread-in fragment rather than a value: `{}`
    // widens the query to the team without any caller having to branch.
    authorFilter: seesEveryone ? {} : { createdById: userId },
  };
}

// ---------------------------------------------------------------------------
// Note visibility
// ---------------------------------------------------------------------------

interface NoteScope {
  readonly organizationId: string;
  readonly userId: string;
  /**
   * Spread into a note `where` to restrict a read to notes the caller may read.
   *
   * Empty for an admin. Otherwise a single `OR`, which is why it composes: no
   * other condition in this file writes an `OR` at the top level of a note
   * query, so spreading this beside `organizationId` cannot silently replace
   * anything. The one read that needs more (`listAllNotes`) puts its own
   * conditions under `AND`, where they intersect with this rather than widen it.
   */
  readonly visibilityFilter: Prisma.NoteWhereInput;
}

/**
 * The subjects a SHARED note may be read through — "can you already see this?".
 *
 * One clause per kind of subject, because each kind is reached differently:
 * a channel and a video through the TrackedChannel join (they are global,
 * deduplicated rows, so the organization is not a column on them), a niche
 * through the note's own `nicheId`. All three narrow by the caller's visible
 * niches using the existing helpers — there is no second scoping mechanism
 * here, and there must not be: the day `trackedChannelNicheFilter` changes,
 * shared notes have to change with it or they become the hole.
 *
 * A member who is not niche-scoped (a Head of Shorts, say) gets `null` from
 * `getVisibleNicheIds`, every filter below collapses to `{}`, and the clause
 * admits everything shared — which is correct, because they can already see
 * every channel. No special case is needed for them, and one would only be a
 * second place to get this wrong.
 */
function sharedNoteSubjectClauses(
  organizationId: string,
  visible: VisibleNiches,
): Prisma.NoteWhereInput[] {
  // The tracking row that makes a channel *ours* AND *theirs to see*. Both
  // narrowings, because they answer different questions and dropping either one
  // is a different leak: without the organization it is another tenant's
  // channel, without the niches it is a colleague's.
  const visibleTracking: Prisma.TrackedChannelWhereInput = {
    organizationId,
    ...trackedChannelNicheFilter(visible),
  };

  return [
    { channel: { trackedBy: { some: visibleTracking } } },
    { video: { channel: { trackedBy: { some: visibleTracking } } } },
    // `nicheId: { not: null }` first, so this clause cannot be satisfied by a
    // note that simply has no niche: for an unscoped caller `nicheIdFilter`
    // returns `{}`, and `{}` alone matches every row in the table.
    { AND: [{ nicheId: { not: null } }, nicheIdFilter(visible)] },
    /**
     * THE DELIBERATE EXCEPTION. A general note is attached to nothing, so there
     * is no subject to scope it by — "shared AND in your scope" has no second
     * half to evaluate. Shared general notes are therefore visible across the
     * organization, which is what the author asked for by writing a note about
     * nothing in particular and then sharing it. It is the only way a note
     * crosses niche lines, and it carries no channel, niche or Short with it.
     */
    { targetType: "general" },
  ];
}

/**
 * Who is asking, and which notes they are entitled to read.
 *
 * The sibling of `personalScope()`, and a `where` fragment for the same reason:
 * a boolean has to be acted on somewhere else, and the somewhere else is what
 * gets forgotten. Every note read in this file spreads this — the per-target
 * panel, the log, and the counts behind the badges. A badge that advertises a
 * note the panel will not show is the same bug wearing a hat.
 *
 * Neither `getScope` nor `actorCan` nor `getVisibleNicheIds` costs a query
 * here: all three are memoised for the life of the request, and the route
 * handler has already made the session lookup.
 */
async function noteScope(): Promise<NoteScope> {
  const [{ organizationId, userId }, seesEveryone] = await Promise.all([
    getScope(),
    actorCan("users.manage"),
  ]);

  // The admin branch returns before asking which niches they hold, because the
  // answer cannot narrow anything: they read the whole workspace's notes. It
  // also keeps a demoted admin's stray MemberNiche rows from meaning anything.
  if (seesEveryone) {
    return { organizationId, userId, visibilityFilter: {} };
  }

  const visible = await getVisibleNicheIds();

  return {
    organizationId,
    userId,
    visibilityFilter: {
      OR: [
        // Yours is yours whatever its visibility and whatever it is about —
        // including a note on a channel that has since left your niches.
        { createdById: userId },
        {
          AND: [
            { visibility: "shared" },
            { OR: sharedNoteSubjectClauses(organizationId, visible) },
          ],
        },
      ],
    },
  };
}

/**
 * The columns a byline needs — and only those.
 *
 * A `select` rather than the whole relation, so `passwordHash` and the rest of
 * the account cannot ride along into a DTO because somebody spread a row.
 */
const authorSelect = { select: { id: true, name: true, email: true } } as const;

type AuthorRow = { id: string; name: string | null; email: string | null } | null;

/**
 * The name to print beside somebody's research.
 *
 * Falls back to the email because an account that has not set a display name is
 * still a person, and "Created by" followed by nothing reads as anonymous —
 * which is the exact thing attribution exists to prevent. Null only when the
 * author's account is gone: `createdById` is `SetNull`, so research outlives
 * the person, and then there is genuinely nobody to name.
 */
function authorName(author: AuthorRow): string | null {
  if (!author) return null;
  return author.name ?? author.email ?? null;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * The targets a note can be attached to — and therefore the only values the
 * per-target read endpoint accepts. "general" is deliberately absent: there is
 * no id to list general notes against, so `GET /api/notes?targetType=general`
 * is a question with no subject rather than an empty answer. General notes are
 * read from the log, `listAllNotes`.
 */
export const noteTargetSchema = z.enum(["channel", "niche", "video"]);

/** Everything a note can be, including attached to nothing. */
export const noteKindSchema = z.enum(["channel", "niche", "video", "general"]);

const noteBodySchema = z.string().trim().min(1, "Write something first.").max(4000);

/**
 * A pasted link to a Short from outside the tracker.
 *
 * Validated here so the caller gets `EXTERNAL_SHORT_URL_HINT` back as the
 * message — the same sentence the field in the composer shows — rather than a
 * generic parse failure. It deliberately does NOT transform to the id: the
 * service parses again on the way to the database, so the "never persist what
 * was pasted" rule holds for any caller, not only for one that came through
 * this schema. See `externalShortColumns`.
 *
 * The length cap is a lower bound on absurdity, not a real constraint — a valid
 * YouTube link is under a hundred characters, and the point is that a megabyte
 * of text is refused before the regex ever runs on it.
 */
const externalShortUrlSchema = z
  .string()
  .trim()
  .max(2048, EXTERNAL_SHORT_URL_HINT)
  .refine((value) => parseYouTubeVideoId(value) !== null, {
    message: EXTERNAL_SHORT_URL_HINT,
  });

/**
 * Personal or shared — the column is a plain String, this is what constrains it.
 *
 * Typed against the DTO union so the two cannot drift: adding a third value to
 * `NoteVisibility` without adding it here is a compile error, which is the
 * failure we want rather than a value that parses and then matches no filter.
 */
export const noteVisibilitySchema: z.ZodType<NoteVisibility> = z.enum([
  "personal",
  "shared",
]);

/**
 * Creating a note: a body, and either a target or nothing.
 *
 * A discriminated union rather than an object with an optional `targetId`,
 * because the two shapes are genuinely different requests and the pairing has
 * to hold. An optional id would let `{ targetType: "channel" }` past the parse
 * and leave `createNote` to decide what a channel note with no channel means —
 * and the honest answers are all bad: a dangling note, a silent downgrade to
 * general, or a crash. Here the union simply rejects it, and the branch in
 * `createNote` is exhaustive because the type says so.
 */
export const createNoteSchema = z.discriminatedUnion("targetType", [
  z.object({
    targetType: noteTargetSchema,
    targetId: z.string().min(1),
    body: noteBodySchema,
    // Optional, and absent means personal — see `createNote`. Sharing is a
    // decision somebody takes; it must never be what happens by default.
    visibility: noteVisibilitySchema.optional(),
    // `nullish` rather than `optional`: on a create, "absent" and "explicitly
    // nothing" are the same request, and a composer that clears its field
    // should not have to remember to omit the key.
    externalShortUrl: externalShortUrlSchema.nullish(),
  }),
  z.object({
    targetType: z.literal("general"),
    body: noteBodySchema,
    visibility: noteVisibilitySchema.optional(),
    externalShortUrl: externalShortUrlSchema.nullish(),
  }),
]);

export type CreateNoteInput = z.infer<typeof createNoteSchema>;

/**
 * Editing a note: its text, who it is for, the Short it quotes, or any of them.
 *
 * Every field optional, with a refinement rejecting the empty patch — a PATCH
 * that says nothing would otherwise touch `updatedAt` and make the log claim
 * the note was edited when nothing about it changed.
 *
 * `externalShortUrl` is `nullable().optional()`, and the difference between the
 * two carries meaning that `nullish()` would erase. Absent means "leave the
 * attached Short alone"; an explicit `null` means REMOVE it. The brief asks for
 * the link to be removable, so "remove" has to be a thing the request can say —
 * and it cannot be said by omission, because omission already means the
 * opposite in a PATCH.
 */
export const updateNoteSchema = z
  .object({
    body: noteBodySchema.optional(),
    visibility: noteVisibilitySchema.optional(),
    externalShortUrl: externalShortUrlSchema.nullable().optional(),
  })
  .refine(
    (patch) =>
      patch.body !== undefined ||
      patch.visibility !== undefined ||
      patch.externalShortUrl !== undefined,
    { message: "Nothing to change." },
  );

export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;

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

/** The author join every note read carries, so no DTO is built anonymously. */
const noteAuthorInclude = { createdBy: authorSelect } as const;

/** The four external-Short columns, always written and cleared as one group. */
interface ExternalShortColumns {
  externalVideoId: string | null;
  externalUrl: string | null;
  externalTitle: string | null;
  externalChannelTitle: string | null;
}

/**
 * Turns a pasted link into the columns to write — or into the four nulls that
 * remove one.
 *
 * ==========================================================================
 * THIS IS WHERE THE PASTED STRING STOPS
 * ==========================================================================
 * The input is parsed to an eleven-character video id and the stored URL is
 * COMPOSED from that id. The string somebody typed is never assigned to
 * `externalUrl`, and there is no branch here in which it could be. That is the
 * reason `Note.externalUrl` exists as its own column in that shape: the value
 * is rendered as an `href`, so a stored value that came from the request body
 * would be an attacker-chosen scheme (`javascript:`, `data:`) one hop away from
 * a click. Composing `https://www.youtube.com/shorts/<id>` makes that
 * impossible by construction rather than by remembering to escape.
 *
 * The re-parse is deliberate belt-and-braces. `externalShortUrlSchema` already
 * rejected anything unparseable at the route, but this function is the one that
 * touches the database, so it does not depend on a caller having validated
 * first — a future server action calling `createNote` directly inherits the
 * property rather than having to know about it.
 *
 * `undefined` in, `undefined` out: an update patch that says nothing about the
 * link leaves all four columns untouched.
 */
async function externalShortColumns(
  input: string | null | undefined,
): Promise<ExternalShortColumns | undefined> {
  if (input === undefined) return undefined;

  // Explicit removal. All four together, because a title left behind after its
  // URL is gone is a note claiming to quote a Short it no longer links to.
  if (input === null || input.trim() === "") {
    return {
      externalVideoId: null,
      externalUrl: null,
      externalTitle: null,
      externalChannelTitle: null,
    };
  }

  const videoId = parseYouTubeVideoId(input);
  if (!videoId) throw errors.invalidInput(EXTERNAL_SHORT_URL_HINT);

  return {
    externalVideoId: videoId,
    externalUrl: canonicalShortUrl(videoId),
    ...(await lookupExternalShortMetadata(videoId)),
  };
}

/**
 * Title and channel, if they are cheap and if they are there.
 *
 * ==========================================================================
 * WHY A NETWORK CALL IS ACCEPTABLE ON THIS PARTICULAR WRITE
 * ==========================================================================
 * The objection to fetching inside `createNote` is latency on the most common
 * write in the app — and it would be decisive if this ran on every note. It
 * does not. It runs only when a link was actually attached, which is the
 * minority case by a wide margin, and it is skipped outright when no Data API
 * key is configured, which is the default deployment. A note with no link is
 * exactly as fast as it was yesterday.
 *
 * What remains is bounded by `fetchExternalVideoMetadata`: one attempt, a
 * 2.5-second hard timeout, no retry ladder, and `null` for every failure. The
 * shared `youtubeClient` was deliberately not used for this — see the header of
 * `external-video.ts`; its three-attempt backoff is right for a sync job and
 * would be a forty-five-second worst case here.
 *
 * The alternative — write first, enrich after — needs a second UPDATE and a
 * second render, and buys nothing: the thumbnail, which is the part that makes
 * an attached Short look attached, is derived from the id and needs no request
 * at all.
 */
async function lookupExternalShortMetadata(
  videoId: string,
): Promise<Pick<ExternalShortColumns, "externalTitle" | "externalChannelTitle">> {
  // Checked rather than awaited-and-discarded: with no key the answer is
  // already known, and this keeps the no-key deployment free of an async hop.
  if (!canFetchExternalVideoMetadata()) {
    return { externalTitle: null, externalChannelTitle: null };
  }

  // `fetchExternalVideoMetadata` swallows its own failures and resolves to
  // null; there is no rejection to catch. That is a property of that function
  // rather than something enforced here, and it is the property that lets the
  // note save whatever YouTube does.
  const metadata = await fetchExternalVideoMetadata(videoId);
  return {
    externalTitle: metadata?.title ?? null,
    externalChannelTitle: metadata?.channelTitle ?? null,
  };
}

function toNoteDTO(note: {
  id: string;
  targetType: string;
  channelId: string | null;
  nicheId: string | null;
  videoId: string | null;
  body: string;
  visibility: string;
  externalVideoId: string | null;
  externalUrl: string | null;
  externalTitle: string | null;
  externalChannelTitle: string | null;
  createdById: string | null;
  createdBy: AuthorRow;
  createdAt: Date;
  updatedAt: Date;
}): NoteDTO {
  return {
    id: note.id,
    // `targetType` is a plain String column, so the cast is unavoidable; the
    // parse on the way in is what keeps it to the four values. A general note
    // has no foreign key, which is why `targetId` falls through to "" — the
    // fallback is not defensive, it is that row's actual answer.
    targetType: note.targetType as NoteKind,
    targetId: note.channelId ?? note.nicheId ?? note.videoId ?? "",
    body: note.body,
    // Another plain String column, cast for the same reason `targetType` is —
    // the parse on the way in is what keeps it to the two values. Anything
    // else in the column would be a row this application did not write, and
    // reading it as-is is more honest than silently relabelling it "personal".
    visibility: note.visibility as NoteVisibility,
    // Passed through as stored, with no composition happening here. `externalUrl`
    // was built from the id by `externalShortColumns` on the way IN, which is
    // the single place that decision is made — rebuilding it on the way out
    // would be a second place for it to be got wrong, and reading the column
    // is what proves the stored value is the safe one.
    externalVideoId: note.externalVideoId,
    externalUrl: note.externalUrl,
    externalTitle: note.externalTitle,
    externalChannelTitle: note.externalChannelTitle,
    // Read off the row, never from the session. Who wrote a note is a fact
    // recorded when it was written; deriving it from whoever happens to be
    // looking would relabel every note in the log as the reader's own.
    createdById: note.createdById,
    createdByName: authorName(note.createdBy),
    createdAt: note.createdAt.getTime(),
    updatedAt: note.updatedAt.getTime(),
  };
}

export async function listNotes(
  targetType: NoteTargetType,
  targetId: string,
): Promise<NoteDTO[]> {
  // Two people looking at the same channel see their own notes on it, plus any
  // a colleague deliberately shared — and, for an admin, everyone's, each under
  // its author's name. The narrowing is `noteScope`'s, not this function's, so
  // the panel and the badge over it cannot disagree.
  const { organizationId, visibilityFilter } = await noteScope();
  const rows = await prisma.note.findMany({
    where: {
      organizationId,
      ...visibilityFilter,
      targetType,
      ...noteWhereForTarget(targetType, targetId),
    },
    include: noteAuthorInclude,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toNoteDTO);
}

export async function createNote(input: CreateNoteInput): Promise<NoteDTO> {
  const { organizationId, userId } = await getScope();

  // Verify the target exists *and is in scope* before writing, so a note can
  // never dangle and can never be attached to another tenant's research. A
  // general note has nothing to verify — that is the whole of the difference,
  // and the check lives here rather than inside `assertTargetExists` so that
  // helper is never handed the no-target case it has no id to answer for.
  let targetColumns: ReturnType<typeof noteWhereForTarget> | Record<string, never> = {};
  if (input.targetType !== "general") {
    await assertTargetExists(input.targetType, input.targetId, organizationId);
    targetColumns = noteWhereForTarget(input.targetType, input.targetId);
  }

  // Resolved before the insert so the note is written once and the response
  // already carries the title. Absent or empty gives the four nulls, which is
  // what an unattached note stores — `createNote` has no "leave alone" case,
  // because there is nothing yet to leave alone.
  const externalColumns = await externalShortColumns(input.externalShortUrl ?? null);

  const note = await prisma.note.create({
    data: {
      organizationId,
      // Ownership, not decoration. This column is what every read below filters
      // on, and it is written once and never rewritten: a note stays the work
      // of whoever wrote it even after an admin edits a typo in it.
      createdById: userId,
      targetType: input.targetType,
      body: input.body.trim(),
      // Personal unless the writer said otherwise. The column defaults to the
      // same value, and it is spelled out here as well because "what happens
      // when the client omits the field" is a rule about the feature, not an
      // implementation detail of the schema.
      visibility: input.visibility ?? "personal",
      ...targetColumns,
      // A DIFFERENT THING FROM `targetColumns` ABOVE, and they can both be
      // present. `targetColumns` may set `videoId`, the relation to a Short
      // this organization tracks; these four describe a Short that is not in
      // the database and must not be added to it. A note comparing ours to
      // theirs carries both.
      ...externalColumns,
    },
    include: noteAuthorInclude,
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

/**
 * Editing and deleting a note: the author, or an admin overseeing the team.
 *
 * `personalScope()`, NOT `noteScope()` — and the difference is the whole rule.
 * Reading a note and rewriting it are different authorities: sharing a note
 * widens who may READ it, and it must not quietly widen who may change it.
 * `authorFilter` names the author (or nobody, for an admin), so a colleague
 * reading a shared note finds no row here and cannot edit its text, delete it,
 * or — the case the brief singles out — flip its visibility. Un-sharing
 * somebody else's note, or re-sharing a note they made personal again, stays
 * theirs to do.
 *
 * A non-author gets `notFound`, not `forbidden`. They may well be able to see
 * this note now, so unlike the reads below this is not literally true from
 * where they stand — but it is still the right answer: the alternative is a 403
 * that confirms which of the ids they hold name notes somebody else wrote,
 * turning the endpoint into the enumeration oracle `assertTargetExists` avoids.
 */
export async function updateNote(noteId: string, patch: UpdateNoteInput): Promise<NoteDTO> {
  const { organizationId, authorFilter } = await personalScope();
  const existing = await prisma.note.findFirst({
    where: { id: noteId, organizationId, ...authorFilter },
    select: { id: true },
  });
  if (!existing) throw errors.notFound("note");

  // AFTER the ownership check, never before. This is the only step in the patch
  // that can reach the network, and doing it first would let anybody holding a
  // note id make this server fetch from YouTube on their behalf regardless of
  // whether they may edit that note. The 404 above costs one indexed lookup;
  // the lookup below is the expensive half, and it happens only for a caller
  // who has already been established as the author or an admin.
  //
  // `undefined` when the patch said nothing about the link, which is what keeps
  // a body-only edit from clearing an attached Short.
  const externalColumns = await externalShortColumns(patch.externalShortUrl);

  const note = await prisma.note.update({
    where: { id: existing.id },
    // Built from what the patch actually carried, so a body-only edit leaves
    // the visibility alone and vice versa. `createdById` is deliberately absent
    // from this payload: an edit records nothing about authorship, and the
    // person who wrote the note still wrote it.
    data: {
      ...(patch.body !== undefined ? { body: patch.body.trim() } : {}),
      ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
      // Spread, so `undefined` contributes no keys at all rather than writing
      // four nulls. Removal is the explicit `null` case inside the helper.
      ...externalColumns,
    },
    include: noteAuthorInclude,
  });
  return toNoteDTO(note);
}

export async function deleteNote(noteId: string): Promise<void> {
  const { organizationId, authorFilter } = await personalScope();
  const existing = await prisma.note.findFirst({
    where: { id: noteId, organizationId, ...authorFilter },
    select: { id: true },
  });
  if (!existing) throw errors.notFound("note");
  await prisma.note.delete({ where: { id: existing.id } });
}

/** Note counts per target, so the UI can badge things without N queries. */
export async function getNoteCounts(): Promise<{
  channels: Record<string, number>;
  niches: Record<string, number>;
  videos: Record<string, number>;
}> {
  // Counts only what the caller can actually open. A badge reading "3 notes"
  // over a panel that then renders empty is worse than no badge: it advertises
  // a colleague's private observations and leaves the reader hunting for
  // something they were never going to be shown. THE SAME `noteScope()` as the
  // list — which now has to include shared notes too, because a badge that
  // counts only your own over a panel that shows the team's is the same
  // disagreement pointing the other way.
  const { organizationId, visibilityFilter } = await noteScope();
  const rows = await prisma.note.findMany({
    where: { organizationId, ...visibilityFilter },
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

/** The joins a collection card needs: its size, and whose folder it is. */
const collectionInclude = {
  _count: { select: { items: true } },
  createdBy: authorSelect,
} as const;

function toCollectionDTO(row: {
  id: string;
  name: string;
  colorIndex: number;
  createdById: string | null;
  createdBy: AuthorRow;
  createdAt: Date;
  _count: { items: number };
}): CollectionDTO {
  return {
    id: row.id,
    name: row.name,
    colorIndex: row.colorIndex,
    itemCount: row._count.items,
    createdById: row.createdById,
    createdByName: authorName(row.createdBy),
    createdAt: row.createdAt.getTime(),
  };
}

export async function listCollections(): Promise<CollectionDTO[]> {
  // A collection is how one person files their own shortlist. Only saved Shorts
  // can go in one, saved Shorts are personal, so a folder full of somebody
  // else's saves would render as an empty folder on everybody else's screen.
  const { organizationId, authorFilter } = await personalScope();
  const rows = await prisma.collection.findMany({
    where: { organizationId, ...authorFilter },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: collectionInclude,
  });

  return rows.map(toCollectionDTO);
}

export async function createCollection(name: string): Promise<CollectionDTO> {
  const { organizationId, userId } = await getScope();
  const slug = toSlug(name);

  // The uniqueness check stays ORGANIZATION-wide even though the folder is
  // personal, because the constraint backing it is `@@unique([organizationId,
  // slug])` and the schema is fixed for this round. Checking per person would
  // simply move the failure: the insert would still be rejected, as an
  // unhandled P2002 and a 500 instead of a sentence somebody can act on.
  const clash = await prisma.collection.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
    select: { name: true, createdById: true },
  });
  if (clash) {
    // Two different situations, and telling them apart is the whole value of
    // the message. "A collection called X already exists" is a plain
    // contradiction to somebody whose own list does not contain one — the
    // clashing folder belongs to a colleague and they cannot see it. Say that
    // the name is taken instead, and echo back what they typed rather than the
    // other person's stored casing.
    throw errors.invalidInput(
      clash.createdById === userId
        ? `You already have a collection called "${clash.name}".`
        : `The name "${name.trim()}" is already taken in this workspace. Pick another.`,
    );
  }

  // Counted over this person's own folders. Both numbers position the new
  // folder on the creator's board — its place in the list and which of the six
  // colours it gets — and an organization-wide count would have the first
  // folder a new starter makes come out fifteenth and in an arbitrary colour.
  const count = await prisma.collection.count({
    where: { organizationId, createdById: userId },
  });
  const row = await prisma.collection.create({
    data: {
      organizationId,
      createdById: userId,
      name: name.trim(),
      slug,
      colorIndex: count % COLLECTION_COLOR_COUNT,
      sortOrder: count,
    },
    include: collectionInclude,
  });

  return toCollectionDTO(row);
}

export async function renameCollection(id: string, name: string): Promise<CollectionDTO> {
  const { organizationId, userId, authorFilter } = await personalScope();
  const existing = await prisma.collection.findFirst({
    where: { id, organizationId, ...authorFilter },
    select: { id: true, slug: true },
  });
  if (!existing) throw errors.notFound("collection");

  const slug = toSlug(name);
  if (slug !== existing.slug) {
    // Organization-wide for the same reason as `createCollection`: this is the
    // constraint the database will enforce whatever we would prefer.
    const clash = await prisma.collection.findUnique({
      where: { organizationId_slug: { organizationId, slug } },
      select: { name: true, createdById: true },
    });
    if (clash) {
      throw errors.invalidInput(
        clash.createdById === userId
          ? `You already have a collection called "${clash.name}".`
          : `The name "${name.trim()}" is already taken in this workspace. Pick another.`,
      );
    }
  }

  const row = await prisma.collection.update({
    where: { id: existing.id },
    data: { name: name.trim(), slug },
    include: collectionInclude,
  });

  return toCollectionDTO(row);
}

/**
 * Deleting a collection removes the folder, never the saved Shorts inside it.
 * The join rows cascade; the SavedShort records survive and simply become
 * uncollected. Same principle as deleting a niche.
 */
export async function deleteCollection(id: string): Promise<{ removedItems: number }> {
  const { organizationId, authorFilter } = await personalScope();
  const existing = await prisma.collection.findFirst({
    where: { id, organizationId, ...authorFilter },
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

  // Idempotent PER PERSON. The unique key is `[organizationId, createdById,
  // videoId]`, so this finds the caller's own save and cannot see a colleague's.
  //
  // Two people saving the same Short is now the normal case, and each gets
  // their own row with their own `viewsAtSave`. That capture is the point of
  // the feature — "I spotted this at 1.2M" is a claim about one person's
  // judgement, so it has to be dated from when *they* saved it, not inherited
  // from whoever got there first.
  const existing = await prisma.savedShort.findUnique({
    where: {
      organizationId_createdById_videoId: {
        organizationId,
        createdById: userId,
        videoId: video.id,
      },
    },
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
    await setSavedShortCollections(saved.id, input.collectionIds, organizationId, userId);
  }

  return getSavedShortById(saved.id, organizationId, userId);
}

/**
 * Un-saves a Short — the caller's own save, and only ever theirs.
 *
 * Deliberately `getScope()` rather than `personalScope()`. An admin may *read*
 * the team's shortlists, but clicking the bookmark on their own feed must
 * remove their own save, not a colleague's: reading somebody's research and
 * throwing it away are not the same authority, and one bookmark toggle should
 * not quietly be the second one.
 *
 * `deleteMany` rather than the old find-then-delete: one round trip, naturally
 * idempotent when there is nothing to remove, and — the part that matters now
 * the key carries the owner — it can only match the caller's row. The previous
 * lookup keyed on `[organizationId, videoId]` and would delete whichever
 * colleague happened to have saved the Short first.
 */
export async function unsaveShort(videoId: string): Promise<void> {
  const { organizationId, userId } = await getScope();
  await prisma.savedShort.deleteMany({
    where: { organizationId, createdById: userId, videoId },
  });
}

/**
 * Clears a saved Short whose owner's account no longer exists.
 *
 * `unsaveShort` cannot reach these rows, and should not: it removes the
 * CALLER's save, and an orphan has no caller to be. But `createdById` is
 * `SetNull`, so a departed colleague's shortlist stays on the admin's board
 * with nobody able to take it off — and a row nobody can act on is not a
 * record, it is litter that makes the board harder to read every month.
 *
 * ADDRESSED BY ROW ID, not by `videoId`. The key that makes a save personal is
 * `[organizationId, createdById, videoId]`, and NULLs do not collide on either
 * connector — so two people who have both left can each leave an orphan for the
 * same Short, and a `videoId` would name both of them.
 *
 * `createdById: null` is part of the WHERE rather than a check on a row already
 * fetched, so no id can ever turn this into "delete a colleague's live save".
 * The empty author filter is required for the same reason `updateNote` requires
 * it: only a reader who sees the whole team's board can see an orphan at all,
 * so anyone else is told the row is not there — which, from where they stand,
 * is true.
 */
export async function removeOrphanedSavedShort(savedShortId: string): Promise<void> {
  const { organizationId, authorFilter } = await personalScope();
  if (authorFilter.createdById !== undefined) throw errors.notFound("saved Short");

  const { count } = await prisma.savedShort.deleteMany({
    where: { id: savedShortId, organizationId, createdById: null },
  });
  // A live save, another workspace's row, or an id that never existed all land
  // here as the same answer, for the same reason the note guards give one.
  if (count === 0) throw errors.notFound("saved Short");
}

async function setSavedShortCollections(
  savedShortId: string,
  collectionIds: readonly string[],
  organizationId: string,
  ownerId: string,
): Promise<void> {
  const unique = [...new Set(collectionIds)];

  if (unique.length > 0) {
    // Scoped to the owner's own folders, not merely to the organization. You
    // file your saves into your filing cabinet: a colleague's collection is
    // invisible to you, so an id naming one can only have been guessed, and
    // honouring it would put a row in a folder whose owner never asked for it
    // — and, because `listCollections` counts items, silently change the size
    // they see on their own board.
    const owned = await prisma.collection.findMany({
      where: { id: { in: unique }, organizationId, createdById: ownerId },
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

/**
 * Re-files a saved Short into a different set of collections.
 *
 * Addressed by `videoId` because that is what the client holds, and resolved
 * against the caller's own save for the same reason `unsaveShort` is: an admin
 * looking at a colleague's shortlist must not be able to reorganise it by
 * clicking a folder on their own screen.
 */
export async function updateSavedShortCollections(
  videoId: string,
  collectionIds: readonly string[],
): Promise<SavedShortDTO> {
  const { organizationId, userId } = await getScope();
  const saved = await prisma.savedShort.findUnique({
    where: {
      organizationId_createdById_videoId: { organizationId, createdById: userId, videoId },
    },
    select: { id: true },
  });
  if (!saved) throw errors.notFound("saved Short");

  await setSavedShortCollections(saved.id, collectionIds, organizationId, userId);
  return getSavedShortById(saved.id, organizationId, userId);
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
    // Attribution travels with the row, so no caller can render a saved Short
    // without being able to say whose it is.
    createdBy: authorSelect,
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
    niches: (tracking?.niches ?? []).map((a) => toNicheRefDTO(a.niche)),

    viewsAtSave: Number(row.viewsAtSave),
    currentViews: Number(row.video.viewCount),
    channelMedianAtSave:
      row.channelMedianAtSave === null ? null : Number(row.channelMedianAtSave),
    outlierMultipleAtSave: row.outlierMultipleAtSave,

    savedAt: row.savedAt.getTime(),
    collectionIds: row.collections.map((c) => c.collectionId),

    // Off the row, never from the session. An admin's board mixes their saves
    // with the team's, and a card that cannot say which is which is how a
    // colleague's shortlist gets mistaken for your own.
    savedById: row.createdById,
    savedByName: authorName(row.createdBy),
  };
}

async function getSavedShortById(
  id: string,
  organizationId: string,
  ownerId: string,
): Promise<SavedShortDTO> {
  // `findFirst` with the full scope in the where clause rather than a lookup by
  // primary key. Both callers have already resolved this row as the caller's
  // own, so the conditions are redundant today — and that is the point:
  // repeating them means a future caller cannot turn this into a
  // read-anybody's-row helper by accident. The owner joined the organization
  // here for the same reason the organization was already here.
  const row = await prisma.savedShort.findFirstOrThrow({
    where: { id, organizationId, createdById: ownerId },
    include: savedInclude(organizationId),
  });
  return toSavedShortDTO(row);
}

/**
 * How an admin narrows and orders the team's board.
 *
 * The counterpart of `noteLogQuerySchema`, and deliberately WITHOUT a
 * visibility field. Saved Shorts stay personal: there is no shared mode for
 * them, because a save is a bookmark on somebody's own shortlist rather than a
 * statement to colleagues, and the thing a reader would want from a shared one
 * — "look at this Short" — is what a note on the Short already does. The
 * asymmetry with notes is deliberate; if that ever changes it needs a column,
 * not a flag invented here.
 */
export const savedShortsQuerySchema = z.object({
  /** A user id, or `AUTHOR_ME`. */
  savedById: z.string().min(1).optional(),
  savedAfter: z.coerce.number().int().nonnegative().optional(),
  savedBefore: z.coerce.number().int().nonnegative().optional(),
  sort: z.enum(["saved", "saver"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});

export type SavedShortsQuery = z.infer<typeof savedShortsQuerySchema>;

export async function listSavedShorts(
  query: SavedShortsQuery = {},
): Promise<SavedShortDTO[]> {
  // Your shortlist, not the org's. This is the read behind the reported bug:
  // a new Head of Shorts opened Saved and found the admin's library waiting
  // for them. An admin still sees everything, each row carrying its owner, and
  // the filters below are what make that board usable rather than a wall —
  // who saved it, when, and in what order.
  const { organizationId, userId, authorFilter } = await personalScope();

  // AND, not a spread. `authorFilter` and a requested `savedById` are both
  // conditions on `createdById`, and spreading them into one object would let
  // the request's value overwrite the one that decides whose rows these are —
  // an ordinary member could then read a colleague's board by naming them.
  // Under `AND` the request can only ever narrow: ask for somebody else's saves
  // without `users.manage` and the two conditions contradict, which is the
  // empty answer it should be.
  const conditions: Prisma.SavedShortWhereInput[] = [authorFilter];

  if (query.savedById) {
    conditions.push({
      createdById: query.savedById === AUTHOR_ME ? userId : query.savedById,
    });
  }

  if (query.savedAfter !== undefined || query.savedBefore !== undefined) {
    conditions.push({
      savedAt: {
        ...(query.savedAfter !== undefined ? { gte: new Date(query.savedAfter) } : {}),
        ...(query.savedBefore !== undefined ? { lte: new Date(query.savedBefore) } : {}),
      },
    });
  }

  const direction = query.direction ?? "desc";

  const rows = await prisma.savedShort.findMany({
    where: { organizationId, AND: conditions },
    include: savedInclude(organizationId),
    orderBy:
      query.sort === "saver"
        ? // By the saver's name, through the relation, for the same reason the
          // notes log sorts that way: grouping a mixed board by colleague is a
          // question about all the rows, so the database answers it.
          [{ createdBy: { name: direction } }, { savedAt: "desc" }]
        : { savedAt: direction },
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
    ...noteAuthorInclude,
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
 * What the log may be narrowed and ordered by.
 *
 * Every field is optional and every one is a FILTER, never a widening: they are
 * intersected with `noteScope()`'s predicate under `AND`, so the worst a
 * hand-written query string can do is show its author fewer notes. Asking for a
 * colleague's notes is allowed and answers with the ones they shared into your
 * scope — which is the point of sharing them.
 *
 * Dates cross the wire as epoch ms, like every other timestamp in the app.
 */
export const noteLogQuerySchema = z.object({
  /** A user id, or `AUTHOR_ME`. */
  authorId: z.string().min(1).optional(),
  targetType: noteKindSchema.optional(),
  channelId: z.string().min(1).optional(),
  nicheId: z.string().min(1).optional(),
  createdAfter: z.coerce.number().int().nonnegative().optional(),
  createdBefore: z.coerce.number().int().nonnegative().optional(),
  sort: z.enum(["created", "author"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});

export type NoteLogQuery = z.infer<typeof noteLogQuerySchema>;

/**
 * The notes log — every note the caller may read, with its context resolved.
 *
 * Joins the channel / niche / video in one query rather than letting the
 * client fetch each target separately: a research log is only useful if you
 * can scan it, and scanning means every row already says what it was about.
 *
 * The same `noteScope()` as every other note read. This page is the widest one
 * — one screen, no target to narrow it — so an unscoped read here would hand
 * the whole organization's notebook to anyone with `analytics.view` and make
 * the filtering above pointless.
 *
 * FILTERING AND SORTING HAPPEN HERE, IN THE QUERY. Not in the client: a filter
 * applied in the browser has already been served, which is how the personal
 * rows leaked in the first place, and "the admin's log, filtered to one
 * employee" is precisely a request about rows the browser should not be holding
 * all of.
 */
export async function listAllNotes(
  query: NoteLogQuery = {},
): Promise<NoteWithContextDTO[]> {
  const { organizationId, userId, visibilityFilter } = await noteScope();

  // Under `AND`, one clause per answered question, so each narrowing composes
  // with the visibility predicate instead of replacing it. Spreading them
  // beside `...visibilityFilter` would be the bug: `channelId` and `nicheId`
  // below are themselves `OR`s, and a second `OR` key would overwrite the one
  // that decides who may read what.
  const conditions: Prisma.NoteWhereInput[] = [];

  if (query.authorId) {
    conditions.push({
      createdById: query.authorId === AUTHOR_ME ? userId : query.authorId,
    });
  }

  if (query.targetType) conditions.push({ targetType: query.targetType });

  if (query.channelId) {
    // A note ON the channel, or on one of its Shorts. The log's context column
    // resolves a Short's channel and renders it, so a channel filter that
    // matched only `channelId` would hide rows the reader can plainly see
    // labelled with that channel.
    conditions.push({
      OR: [{ channelId: query.channelId }, { video: { channelId: query.channelId } }],
    });
  }

  if (query.nicheId) {
    // Same reasoning: the niche of a note is either its own, or the niches of
    // the channel it hangs off — which is what the row displays.
    const taggedWithNiche: Prisma.TrackedChannelWhereInput = {
      organizationId,
      niches: { some: { nicheId: query.nicheId } },
    };
    conditions.push({
      OR: [
        { nicheId: query.nicheId },
        { channel: { trackedBy: { some: taggedWithNiche } } },
        { video: { channel: { trackedBy: { some: taggedWithNiche } } } },
      ],
    });
  }

  if (query.createdAfter !== undefined || query.createdBefore !== undefined) {
    conditions.push({
      createdAt: {
        ...(query.createdAfter !== undefined
          ? { gte: new Date(query.createdAfter) }
          : {}),
        ...(query.createdBefore !== undefined
          ? { lte: new Date(query.createdBefore) }
          : {}),
      },
    });
  }

  const direction = query.direction ?? "desc";

  const rows = await prisma.note.findMany({
    where: {
      organizationId,
      ...visibilityFilter,
      ...(conditions.length > 0 ? { AND: conditions } : {}),
    },
    include: noteContextInclude(organizationId),
    orderBy:
      query.sort === "author"
        ? [
            // Ordered by the AUTHOR'S name through the relation, so the sort is
            // the database's and not a page of rows re-sorted in the browser.
            // Notes whose author has been deleted have no name to sort by and
            // land wherever the connector puts NULLs; the created-date tiebreak
            // keeps the rest of the ordering stable and readable.
            { createdBy: { name: direction } },
            { createdAt: "desc" },
          ]
        : { createdAt: direction },
  });

  return rows.map((row) => {
    const base = toNoteDTO(row);

    // Branch on the recorded kind, not on which relation came back null. A
    // general note and a note whose target somehow vanished look identical from
    // the joins, and only one of them is fine — labelling the second "General"
    // would quietly file a broken row under a legitimate heading.
    if (base.targetType === "general") {
      return {
        ...base,
        targetLabel: GENERAL_NOTE_LABEL,
        channelId: null,
        channelName: null,
        channelAvatarUrl: null,
        niches: [],
        videoId: null,
        youtubeVideoId: null,
      };
    }

    if (row.niche) {
      return {
        ...base,
        targetLabel: row.niche.name,
        channelId: null,
        channelName: null,
        channelAvatarUrl: null,
        niches: [toNicheRefDTO(row.niche)],
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
        niches: (tracking?.niches ?? []).map((a) => toNicheRefDTO(a.niche)),
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
        niches: (tracking?.niches ?? []).map((a) => toNicheRefDTO(a.niche)),
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
