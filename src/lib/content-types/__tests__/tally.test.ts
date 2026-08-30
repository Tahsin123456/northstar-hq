import { describe, expect, it } from "vitest";
import { tallyEffectiveShorts, type TallyGroup, type TallyVideo } from "../tally";

/**
 * ==========================================================================
 * THE COUNTS BEHIND THE FILTER MENU
 * ==========================================================================
 *
 * `tallyEffectiveShorts` produces the badges beside each option in the content
 * type filter — "Memes · 412", "Untagged · 38" — on every surface whose rows are
 * Shorts. Those numbers are a PROMISE about what selecting the option will
 * return, so the rule they are counted by has to be the same rule the feed
 * filters by. This file pins that, and with it the consequences the whole
 * inheritance design exists to produce.
 *
 * The reason it is worth a test of its own rather than being trusted to the
 * resolver's: every one of these cases is a number that would look plausible if
 * it were wrong. A badge reading 3 instead of 412 does not throw, does not warn,
 * and is only ever caught by somebody noticing the feed was longer than the menu
 * said it would be.
 */

const MEMES = "ct-memes";
const RANKING = "ct-ranking";

/** A fixed instant every Short below is published at unless it says otherwise. */
const PUBLISHED = Date.UTC(2025, 5, 1);

/** A Short that says nothing of its own — the overwhelmingly common row. */
function short(overrides: Partial<TallyVideo> = {}): TallyVideo {
  return {
    isShort: true,
    publishedAt: PUBLISHED,
    manualContentTypeIds: [],
    excludedContentTypeIds: [],
    ...overrides,
  };
}

/**
 * A channel described by tags rather than by rules.
 *
 * Every tag becomes an epoch-dated, open-ended rule — which is exactly what the
 * migration wrote for the two channels that already carried tags, and exactly
 * what "Apply to this channel" writes today. So the cases below go on asserting
 * the same thing they asserted before rules existed: on a channel that has never
 * changed its mind, a rule IS a flat tag, and the tally must not have noticed the
 * difference. The window's own behaviour is pinned separately, in
 * `channel-content-type-rules.test.ts` and in the windowed case at the foot of
 * this file.
 */
function channel(
  channelTypeIds: readonly string[],
  videos: readonly TallyVideo[],
): TallyGroup {
  return {
    rules: channelTypeIds.map((contentTypeId) => ({
      contentTypeId,
      effectiveFrom: 0,
      effectiveUntil: null,
    })),
    videos,
  };
}

describe("inheritance reaches Shorts that store nothing", () => {
  it("counts every Short of a tagged channel under the channel's tag", () => {
    // The headline case, and the one a row count gets catastrophically wrong:
    // not one of these three Shorts has a row, and all three are Memes.
    const tally = tallyEffectiveShorts([
      channel([MEMES], [short(), short(), short()]),
    ]);

    expect(tally.byType.get(MEMES)).toBe(3);
    expect(tally.untagged).toBe(0);
    expect(tally.total).toBe(3);
  });

  it("moves the moment the channel's tags move, with no per-Short change", () => {
    // "Assign a tag to a channel and every existing Short shows it immediately,
    // no backfill" — expressed as the only thing that differs between these two
    // calls being the channel's array.
    const videos = [short(), short()];

    expect(tallyEffectiveShorts([channel([], videos)]).byType.get(MEMES)).toBeUndefined();
    expect(tallyEffectiveShorts([channel([MEMES], videos)]).byType.get(MEMES)).toBe(2);

    // And removing it leaves nothing behind — no stale rows, because there were
    // never any rows.
    const removed = tallyEffectiveShorts([channel([], videos)]);
    expect(removed.byType.get(MEMES)).toBeUndefined();
    expect(removed.untagged).toBe(2);
  });

  it("counts a newly imported Short with no rows exactly like its siblings", () => {
    const imported = short();
    const tally = tallyEffectiveShorts([channel([MEMES], [short(), imported])]);
    expect(tally.byType.get(MEMES)).toBe(2);
  });
});

describe("deviations", () => {
  it("an exclusion drops that Short and only that Short", () => {
    const tally = tallyEffectiveShorts([
      channel(
        [MEMES],
        [short(), short(), short({ excludedContentTypeIds: [MEMES] })],
      ),
    ]);

    expect(tally.byType.get(MEMES)).toBe(2);
    // The refusing Short is not merely absent from the Memes row — it now has no
    // tag at all, which is what the Untagged option has to find.
    expect(tally.untagged).toBe(1);
    expect(tally.total).toBe(3);
  });

  it("a manual tag adds that Short and only that Short", () => {
    const tally = tallyEffectiveShorts([
      channel([], [short(), short({ manualContentTypeIds: [RANKING] })]),
    ]);

    expect(tally.byType.get(RANKING)).toBe(1);
    expect(tally.untagged).toBe(1);
  });

  it("a tag both inherited and manually filed counts once, not twice", () => {
    // The precedence rule in `resolveContentTypes`, seen from the outside: a
    // redundant manual row must not inflate the badge above the number of Shorts
    // that actually exist.
    const tally = tallyEffectiveShorts([
      channel([MEMES], [short({ manualContentTypeIds: [MEMES] })]),
    ]);

    expect(tally.byType.get(MEMES)).toBe(1);
    expect(tally.total).toBe(1);
  });

  it("a tombstone for a tag the channel no longer gives suppresses nothing", () => {
    // The exclusion survives the channel dropping the tag — that is the whole
    // point of a tombstone — but while the channel is not giving it, there is
    // nothing for it to subtract and the Short is simply untagged.
    const tally = tallyEffectiveShorts([
      channel([], [short({ excludedContentTypeIds: [MEMES] })]),
    ]);

    expect(tally.byType.get(MEMES)).toBeUndefined();
    expect(tally.untagged).toBe(1);
  });
});

describe("shape of the answer", () => {
  it("overlaps rather than partitions — the rows do not sum to the total", () => {
    const tally = tallyEffectiveShorts([
      channel([MEMES, RANKING], [short(), short()]),
    ]);

    expect(tally.byType.get(MEMES)).toBe(2);
    expect(tally.byType.get(RANKING)).toBe(2);
    // Four across the rows, two Shorts. Anything that adds these up is wrong.
    expect(tally.total).toBe(2);
  });

  it("counts Shorts only — long-form never reaches any number here", () => {
    const tally = tallyEffectiveShorts([
      channel([MEMES], [short(), short({ isShort: false })]),
    ]);

    expect(tally.byType.get(MEMES)).toBe(1);
    expect(tally.total).toBe(1);
  });

  it("spans channels, so one tag totals across every channel that gives it", () => {
    const tally = tallyEffectiveShorts([
      channel([MEMES], [short(), short()]),
      channel([MEMES], [short()]),
      channel([RANKING], [short()]),
    ]);

    expect(tally.byType.get(MEMES)).toBe(3);
    expect(tally.byType.get(RANKING)).toBe(1);
    expect(tally.total).toBe(4);
  });

  it("omits a tag nothing carries rather than reporting zero", () => {
    const tally = tallyEffectiveShorts([channel([MEMES], [short()])]);
    expect(tally.byType.has(RANKING)).toBe(false);
  });

  it("is empty, not undefined, for a tracker with no channels", () => {
    const tally = tallyEffectiveShorts([]);
    expect(tally.total).toBe(0);
    expect(tally.untagged).toBe(0);
    expect(tally.byType.size).toBe(0);
  });
});

describe("the badge agrees with the filter it labels", () => {
  /**
   * The invariant the whole module exists for, stated directly.
   *
   * `untagged` and the per-type counts have to be two readings of ONE pass, or
   * the menu can offer an option and then render a different number of rows.
   * Here that is checked the only way it can be: every Short lands in the
   * untagged bucket or in at least one tag's, and never in neither.
   */
  it("every Short is either untagged or counted under at least one tag", () => {
    const groups = [
      channel([MEMES], [short(), short({ excludedContentTypeIds: [MEMES] })]),
      channel([], [short(), short({ manualContentTypeIds: [RANKING] })]),
      channel([MEMES, RANKING], [short()]),
    ];

    const tally = tallyEffectiveShorts(groups);

    // Distinct Shorts carrying at least one tag, counted independently of the
    // overlapping rows above.
    const tagged = groups.reduce(
      (count, group) =>
        count +
        group.videos.filter((video) => {
          if (!video.isShort) return false;
          const excluded = new Set(video.excludedContentTypeIds);
          const inherited = group.rules
            .filter(
              (rule) =>
                video.publishedAt >= rule.effectiveFrom &&
                (rule.effectiveUntil === null || video.publishedAt < rule.effectiveUntil),
            )
            .map((rule) => rule.contentTypeId)
            .filter((id) => !excluded.has(id));
          const manual = video.manualContentTypeIds.filter((id) => !excluded.has(id));
          return inherited.length + manual.length > 0;
        }).length,
      0,
    );

    expect(tagged + tally.untagged).toBe(tally.total);
  });
});

/**
 * ==========================================================================
 * THE WINDOW, IN THE UNIT THE BADGES ARE COUNTED IN
 * ==========================================================================
 *
 * The rule itself is pinned in `channel-content-type-rules.test.ts`. What is
 * pinned here is that the TALLY honours it — because this is the number the
 * filter menus print beside each tag, and a tally that ignored windows would
 * offer "Memes · 412" on a channel that stopped making memes in March and then
 * deliver the eighty that are still tagged.
 */
describe("a rule's window narrows the tally", () => {
  const MARCH = Date.UTC(2025, 2, 4);

  it("counts only the Shorts published inside the rule", () => {
    const tally = tallyEffectiveShorts([
      {
        rules: [{ contentTypeId: MEMES, effectiveFrom: 0, effectiveUntil: MARCH }],
        videos: [
          short({ publishedAt: MARCH - DAY }),
          short({ publishedAt: MARCH - 2 * DAY }),
          // The switch itself and everything after it: outside the window, so
          // untagged rather than mislabelled.
          short({ publishedAt: MARCH }),
          short({ publishedAt: MARCH + DAY }),
        ],
      },
    ]);

    expect(tally.byType.get(MEMES)).toBe(2);
    // AND THE OTHER HALF OF THE SAME FACT. Under a flat channel tag this was
    // always zero on a tagged channel — every Short inherited — which made the
    // "Untagged" option useless the moment anybody characterised a channel. A
    // window gives it something true to point at again.
    expect(tally.untagged).toBe(2);
    expect(tally.total).toBe(4);
  });

  it("hands two Shorts on one channel different tags, with no rows on either", () => {
    // The case the flat model could not express at all, and the reason for the
    // whole round: one channel, two eras, both correctly labelled, and not a
    // single `VideoContentType` row involved.
    const tally = tallyEffectiveShorts([
      {
        rules: [
          { contentTypeId: MEMES, effectiveFrom: 0, effectiveUntil: MARCH },
          { contentTypeId: RANKING, effectiveFrom: MARCH, effectiveUntil: null },
        ],
        videos: [short({ publishedAt: MARCH - DAY }), short({ publishedAt: MARCH })],
      },
    ]);

    expect(tally.byType.get(MEMES)).toBe(1);
    expect(tally.byType.get(RANKING)).toBe(1);
    expect(tally.untagged).toBe(0);
  });
});

const DAY = 86_400_000;
