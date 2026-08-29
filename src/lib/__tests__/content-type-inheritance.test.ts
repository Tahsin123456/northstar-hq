import { describe, expect, it } from "vitest";
import {
  planDeviations,
  resolveContentTypes,
  effectiveContentTypeIds,
} from "@/lib/content-types/resolve";

/**
 * ==========================================================================
 * THE RULE, PINNED
 * ==========================================================================
 *
 *     effective(short) = (channel's tags − short's exclusions) ∪ short's manual tags
 *
 * These tests are deliberately about the RULE and not about the database. Every
 * consequence the design claims — a channel tag reaching Shorts nobody touched,
 * a new import inheriting for free, a refusal outliving the tag it refused — is
 * a property of this function, and the storage layer only has to avoid writing
 * rows that contradict it. Testing it here rather than through Prisma is what
 * makes these assertions readable as the specification they are.
 *
 * WHAT "NO ROWS WERE WRITTEN" LOOKS LIKE IN A TEST. Every case below that talks
 * about inheritance passes EMPTY deviation arrays. That is not a convenience: it
 * is the assertion. If inheritance required a row, these inputs could not
 * produce a tag, and every one of them would fail.
 */

const RANKING = "ct_ranking";
const FUNNY = "ct_funny";
const CUTSCENE = "ct_cutscene";

/** No deviations at all — the overwhelmingly common Short. */
const NOTHING = { manualIds: [] as string[], excludedIds: [] as string[] };

describe("inheritance", () => {
  it("gives a Short its channel's tags with nothing written against the Short", () => {
    const resolution = resolveContentTypes({
      channelTypeIds: [RANKING, FUNNY],
      ...NOTHING,
    });

    expect(resolution.effectiveIds).toEqual([FUNNY, RANKING].sort());
    // And every one of them says where it came from, because the UI has to be
    // able to say "this is from the channel" rather than implying somebody
    // classified this Short.
    expect(resolution.effective.every((entry) => entry.origin === "inherited")).toBe(true);
  });

  it("reaches a Short imported later, because nothing was written per Short", () => {
    // A brand new Short is exactly the input above: no rows, no history. There
    // is no backfill step that could have been missed, which is the whole
    // argument for not copying the channel's tags down.
    const freshlyImported = resolveContentTypes({
      channelTypeIds: [RANKING],
      ...NOTHING,
    });

    expect(freshlyImported.effectiveIds).toEqual([RANKING]);
  });

  it("stops giving a tag the moment the channel drops it, leaving nothing stale", () => {
    const before = effectiveContentTypeIds({ channelTypeIds: [RANKING, FUNNY], ...NOTHING });
    const after = effectiveContentTypeIds({ channelTypeIds: [FUNNY], ...NOTHING });

    expect(before).toContain(RANKING);
    expect(after).not.toContain(RANKING);
    // The Short's own state never changed — it could not have, there is none.
    // A copied-down design would have needed 400 deletes here and would have
    // left 400 rows behind if any of them failed.
  });

  it("yields only the manual tags when the channel has none", () => {
    const resolution = resolveContentTypes({
      channelTypeIds: [],
      manualIds: [CUTSCENE],
      excludedIds: [],
    });

    expect(resolution.effectiveIds).toEqual([CUTSCENE]);
    expect(resolution.effective[0]?.origin).toBe("manual");
  });

  it("yields nothing when neither side offers anything", () => {
    expect(effectiveContentTypeIds({ channelTypeIds: [], ...NOTHING })).toEqual([]);
  });
});

describe("exclusions", () => {
  it("hides an inherited tag", () => {
    const resolution = resolveContentTypes({
      channelTypeIds: [RANKING, FUNNY],
      manualIds: [],
      excludedIds: [RANKING],
    });

    expect(resolution.effectiveIds).toEqual([FUNNY]);
    // And the refusal is reported as currently doing work, which is what lets
    // the picker offer the undo on the right row.
    expect(resolution.suppressedIds).toEqual([RANKING]);
  });

  it("SURVIVES the channel dropping and re-adding the tag", () => {
    // The property the whole tombstone design exists for. Somebody said no to
    // Ranking on this Short. The channel then stops making rankings, and later
    // starts again — two edits to a different object, months apart, by somebody
    // else. Neither may quietly reverse the "no".
    const excludedIds = [RANKING];

    const whileChannelHasIt = resolveContentTypes({
      channelTypeIds: [RANKING],
      manualIds: [],
      excludedIds,
    });
    expect(whileChannelHasIt.effectiveIds).toEqual([]);

    const whileChannelDropsIt = resolveContentTypes({
      channelTypeIds: [],
      manualIds: [],
      excludedIds,
    });
    expect(whileChannelDropsIt.effectiveIds).toEqual([]);
    // Dormant: nothing to suppress right now, but the row is still there.
    expect(whileChannelDropsIt.suppressedIds).toEqual([]);

    const whenChannelReAddsIt = resolveContentTypes({
      channelTypeIds: [RANKING],
      manualIds: [],
      excludedIds,
    });
    expect(whenChannelReAddsIt.effectiveIds).toEqual([]);
    expect(whenChannelReAddsIt.suppressedIds).toEqual([RANKING]);
  });

  it("does not suppress a tag the Short never inherited", () => {
    // An exclusion is only ever ABOUT the channel. One for a tag the channel
    // does not provide suppresses nothing and must not be reported as though a
    // person could undo something visible.
    const resolution = resolveContentTypes({
      channelTypeIds: [FUNNY],
      manualIds: [],
      excludedIds: [RANKING],
    });

    expect(resolution.effectiveIds).toEqual([FUNNY]);
    expect(resolution.suppressedIds).toEqual([]);
  });
});

describe("manual tags", () => {
  it("SURVIVE the channel gaining and then dropping the same tag", () => {
    // The mirror of the tombstone case, and it matters for the same reason:
    // somebody explicitly said this Short is Funny. The channel picking Funny up
    // for a while must not consume that judgement, so that dropping it again
    // leaves the Short bare.
    const manualIds = [FUNNY];

    const channelSilent = resolveContentTypes({ channelTypeIds: [], manualIds, excludedIds: [] });
    expect(channelSilent.effectiveIds).toEqual([FUNNY]);
    expect(channelSilent.effective[0]?.origin).toBe("manual");

    const channelAlsoHasIt = resolveContentTypes({
      channelTypeIds: [FUNNY],
      manualIds,
      excludedIds: [],
    });
    expect(channelAlsoHasIt.effectiveIds).toEqual([FUNNY]);

    const channelDropsItAgain = resolveContentTypes({
      channelTypeIds: [],
      manualIds,
      excludedIds: [],
    });
    expect(channelDropsItAgain.effectiveIds).toEqual([FUNNY]);
  });

  it("reads as inherited while the channel also provides it", () => {
    // The precedence decision, stated as a test. The channel giving a tag to
    // everything is the more useful fact about it, and it is what makes
    // "Remove" on that chip mean "exclude it from this Short" rather than
    // "delete a row and watch the tag come straight back".
    const resolution = resolveContentTypes({
      channelTypeIds: [FUNNY],
      manualIds: [FUNNY],
      excludedIds: [],
    });

    expect(resolution.effective).toEqual([{ id: FUNNY, origin: "inherited" }]);
  });
});

describe("no id ever appears twice", () => {
  it("collapses a tag the channel and the Short both provide", () => {
    const resolution = resolveContentTypes({
      channelTypeIds: [RANKING, FUNNY],
      manualIds: [FUNNY, CUTSCENE],
      excludedIds: [],
    });

    expect(resolution.effectiveIds).toEqual([CUTSCENE, FUNNY, RANKING].sort());
    expect(new Set(resolution.effectiveIds).size).toBe(resolution.effectiveIds.length);
  });

  it("collapses duplicates inside a single input array", () => {
    // The database cannot produce this — one row per (organization, video,
    // content type) — but an optimistically patched client cache can, and a
    // double entry here would inflate a performance row silently.
    const resolution = resolveContentTypes({
      channelTypeIds: [RANKING, RANKING],
      manualIds: [FUNNY, FUNNY],
      excludedIds: [],
    });

    expect(resolution.effectiveIds).toEqual([FUNNY, RANKING].sort());
  });

  it("lets a refusal win over a contradictory manual row", () => {
    // Also unreachable through the schema, for the same reason: it is one row
    // with one state. If a cache ever presents both, refusing is the safer of
    // the two readings — it shows less than somebody asked for rather than
    // re-applying a tag they explicitly removed.
    const resolution = resolveContentTypes({
      channelTypeIds: [],
      manualIds: [RANKING],
      excludedIds: [RANKING],
    });

    expect(resolution.effectiveIds).toEqual([]);
  });
});

/**
 * The other direction: a desired effective set becomes deviations.
 *
 * This is what `setVideoContentTypes` writes through, so these cases are the
 * storage rule — "inherited tags are never stored" — expressed as assertions
 * about what a save would put in the table.
 */
describe("planDeviations", () => {
  const plan = (
    channelTypeIds: string[],
    desiredIds: string[],
    existingManualIds: string[] = [],
    existingExcludedIds: string[] = [],
  ) =>
    planDeviations({ channelTypeIds, desiredIds, existingManualIds, existingExcludedIds });

  /**
   * THE DORMANT TOMBSTONE — the case that was broken.
   *
   * A refusal recorded while the channel provided the tag, kept after the
   * channel dropped it. It changes nothing about what the Short currently is,
   * which is exactly why an earlier version of this function left it out of the
   * plan — and the reconciler, seeing a row nothing accounted for, deleted it.
   *
   * The consequence was invisible until much later: the override survived only
   * until the next unrelated edit to that Short, after which re-adding the tag
   * to the channel put it straight back on a Short whose owner had refused it.
   * Two edits, days apart, that nobody would connect.
   */
  it("keeps a refusal for a tag the channel has since dropped", () => {
    // Channel no longer gives RANKING. The Short refused it back when it did.
    expect(plan([FUNNY], [FUNNY], [], [RANKING])).toEqual({
      manualIds: [],
      excludedIds: [RANKING],
    });
  });

  it("lets the refusal go when the tag is explicitly wanted again", () => {
    // Asking for it back IS the undo, and it becomes this Short's own tag
    // because the channel is not providing it.
    expect(plan([FUNNY], [FUNNY, RANKING], [], [RANKING])).toEqual({
      manualIds: [RANKING],
      excludedIds: [],
    });
  });

  it("keeps a live refusal and a dormant one side by side", () => {
    // FUNNY is refused and the channel still gives it; RANKING is refused and
    // the channel does not. Both rows survive, for different reasons.
    expect(plan([FUNNY], [], [], [RANKING])).toEqual({
      manualIds: [],
      excludedIds: [FUNNY, RANKING].sort(),
    });
  });

  it("writes NOTHING for a tag the channel already provides", () => {
    // The single most important line in this file. A row here would be a copy
    // of the channel's decision, which is the stale-row problem the whole design
    // exists to avoid.
    expect(plan([RANKING], [RANKING])).toEqual({ manualIds: [], excludedIds: [] });
  });

  it("writes a manual row for a tag the channel does not provide", () => {
    expect(plan([], [CUTSCENE])).toEqual({ manualIds: [CUTSCENE], excludedIds: [] });
  });

  it("writes an exclusion for a channel tag left out of the desired set", () => {
    expect(plan([RANKING, FUNNY], [FUNNY])).toEqual({
      manualIds: [],
      excludedIds: [RANKING],
    });
  });

  it("turns 'clear everything' on a tagged channel into refusals, not deletions", () => {
    // An empty desired set used to mean "delete this Short's rows". On an
    // inheriting Short that would leave every channel tag showing, so clearing
    // the field has to write the refusals that make it true.
    expect(plan([RANKING, FUNNY], [])).toEqual({
      manualIds: [],
      excludedIds: [FUNNY, RANKING].sort(),
    });
  });

  it("keeps an existing manual row for a tag the channel has since picked up", () => {
    // The redundant-manual rule. Dropping the row would be correct for exactly
    // as long as the channel keeps the tag, and would silently destroy somebody's
    // explicit "yes" the moment it did not — an edit to the channel would take
    // the Short's own classification with it and nobody would connect the two.
    expect(plan([FUNNY], [FUNNY], [FUNNY])).toEqual({
      manualIds: [FUNNY],
      excludedIds: [],
    });
  });

  it("still never CREATES a redundant manual row", () => {
    // The other half of that rule: preserving one that exists is not the same as
    // writing one. Nothing here scales row count with the size of the catalogue.
    expect(plan([FUNNY], [FUNNY], [])).toEqual({ manualIds: [], excludedIds: [] });
  });
});

describe("the two directions round-trip", () => {
  /**
   * Resolving a plan against the channel it was planned for returns exactly the
   * set that was asked for.
   *
   * This is the contract between the two halves of the module, and it is what
   * lets the client patch its cache with `planDeviations` and be certain it
   * matches what the server stored. A case where it did not hold would be a save
   * that silently changed what somebody selected.
   */
  const cases: Array<{ name: string; channel: string[]; desired: string[] }> = [
    { name: "nothing on either side", channel: [], desired: [] },
    { name: "pure inheritance", channel: [RANKING], desired: [RANKING] },
    { name: "a pure addition", channel: [], desired: [CUTSCENE] },
    { name: "a pure refusal", channel: [RANKING], desired: [] },
    { name: "one of each", channel: [RANKING, FUNNY], desired: [FUNNY, CUTSCENE] },
    { name: "refusing everything a busy channel gives", channel: [RANKING, FUNNY, CUTSCENE], desired: [] },
  ];

  for (const { name, channel, desired } of cases) {
    it(name, () => {
      const stored = planDeviations({
        channelTypeIds: channel,
        desiredIds: desired,
        existingManualIds: [],
        existingExcludedIds: [],
      });

      expect(
        effectiveContentTypeIds({
          channelTypeIds: channel,
          manualIds: stored.manualIds,
          excludedIds: stored.excludedIds,
        }),
      ).toEqual([...desired].sort());
    });
  }
});
