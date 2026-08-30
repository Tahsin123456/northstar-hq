import { describe, expect, it } from "vitest";
import {
  buildInheritanceTimeline,
  effectiveContentTypeIds,
  inheritedContentTypeIds,
  resolveContentTypes,
  ruleCoversPublishDate,
  type ChannelContentTypeRuleWindow,
} from "@/lib/content-types/resolve";
import {
  RULE_AUTO_CLOSE_STREAK,
  recordConfirmation,
  recordOverride,
  type RuleStreakState,
} from "@/lib/content-types/rules";

/**
 * ==========================================================================
 * A CHANNEL RULE, PINNED
 * ==========================================================================
 *
 * Two claims, tested together because neither is worth much alone:
 *
 *   1. A rule is a claim about a STRETCH OF TIME. It labels the Shorts published
 *      inside its window and none outside it, with nothing written per Short.
 *   2. It RETIRES ITSELF when the channel changes, on the only reliable signal
 *      there is — a person taking the tag off — and it retires dated to when the
 *      channel changed rather than to when somebody noticed.
 *
 * TESTED AGAINST THE PURE FUNCTIONS, not through Prisma. Every property below is
 * a property of the two modules in `src/lib/content-types/`; the storage layer's
 * only job is to feed them the right inputs and write back what they say, and
 * that half is pinned in `src/server/services/__tests__/content-type-assignment.test.ts`.
 * Driving a three-step streak through five database stubs would test the stubs.
 *
 * WHAT "NO ROWS WERE WRITTEN" LOOKS LIKE HERE. Every inheritance case passes
 * EMPTY deviation arrays. That is not a convenience, it is the assertion: if a
 * window required a row per Short, none of these inputs could produce a tag.
 */

const MEMES = "ct_memes";
const RANKING = "ct_ranking";

const DAY = 86_400_000;
/** The day the channel switched formats, in every case below. */
const MARCH = Date.UTC(2025, 2, 4);
const JANUARY = Date.UTC(2025, 0, 1);
const APRIL = Date.UTC(2025, 3, 10);
const MAY = Date.UTC(2025, 4, 20);

/** No deviations at all — the overwhelmingly common Short. */
const NOTHING = { manualIds: [] as string[], excludedIds: [] as string[] };

function rule(
  contentTypeId: string,
  effectiveFrom: number,
  effectiveUntil: number | null = null,
): ChannelContentTypeRuleWindow {
  return { contentTypeId, effectiveFrom, effectiveUntil };
}

/** An open rule with a clean slate — the state every streak starts from. */
function openRule(overrides: Partial<RuleStreakState> = {}): RuleStreakState {
  return {
    contentTypeId: MEMES,
    effectiveFrom: 0,
    effectiveUntil: null,
    consecutiveOverrides: 0,
    overrideStreakFrom: null,
    ...overrides,
  };
}

describe("a rule covers its window and nothing else", () => {
  it("labels the Shorts inside its dates, with nothing stored against them", () => {
    const rules = [rule(MEMES, JANUARY, MARCH)];

    expect(inheritedContentTypeIds(rules, JANUARY + DAY)).toEqual([MEMES]);
    expect(inheritedContentTypeIds(rules, MARCH - DAY)).toEqual([MEMES]);
    // Before it began, and after it ended.
    expect(inheritedContentTypeIds(rules, JANUARY - DAY)).toEqual([]);
    expect(inheritedContentTypeIds(rules, MARCH + DAY)).toEqual([]);
  });

  it("is half-open, so the closing date itself comes out from under the rule", () => {
    /*
     * NOT A DETAIL. Closing a rule sets `effectiveUntil` to the publish date of
     * the Short somebody first said no to — so that Short must stop inheriting
     * the tag. An inclusive end would leave the rule still claiming the very
     * upload that proved it wrong, and the person who removed the tag would
     * watch it come straight back.
     */
    const rules = [rule(MEMES, JANUARY, MARCH)];

    expect(ruleCoversPublishDate(rules[0], JANUARY)).toBe(true);
    expect(ruleCoversPublishDate(rules[0], MARCH)).toBe(false);
  });

  it("lets one channel be two things at two times, with no rows either", () => {
    // The case the flat channel tag could not express at all, and the reason for
    // the whole round. Both halves of the history stay true at once.
    const rules = [rule(MEMES, JANUARY, MARCH), rule(RANKING, MARCH)];

    expect(inheritedContentTypeIds(rules, JANUARY + DAY)).toEqual([MEMES]);
    expect(inheritedContentTypeIds(rules, APRIL)).toEqual([RANKING]);
  });

  it("collapses two windows of the same tag to one id", () => {
    // "Ranking until March" and "Ranking again from September" is a legitimate
    // pair. A Short covered by both — impossible for these two, but not in
    // general — carries the tag once, because a tag either applies or it does
    // not.
    const rules = [rule(MEMES, JANUARY, APRIL), rule(MEMES, MARCH)];
    expect(inheritedContentTypeIds(rules, MARCH + DAY)).toEqual([MEMES]);
  });

  it("still composes with the Short's own deviations", () => {
    // `(inherited − exclusions) ∪ manual` is untouched by any of this. Only the
    // definition of the first term moved.
    const inheritedIds = inheritedContentTypeIds([rule(MEMES, JANUARY)], APRIL);

    expect(
      effectiveContentTypeIds({ inheritedIds, manualIds: [], excludedIds: [MEMES] }),
    ).toEqual([]);
    expect(
      effectiveContentTypeIds({ inheritedIds, manualIds: [RANKING], excludedIds: [] }),
    ).toEqual([MEMES, RANKING].sort());
  });

  it("marks a windowed tag as inherited, not manual", () => {
    // The UI's whole vocabulary for "the channel said so, not you" hangs off
    // this, including what the "×" on the chip means.
    const resolution = resolveContentTypes({
      inheritedIds: inheritedContentTypeIds([rule(MEMES, JANUARY)], APRIL),
      ...NOTHING,
    });

    expect(resolution.effective).toEqual([{ id: MEMES, origin: "inherited" }]);
  });
});

describe("the timeline answers the same question, arranged for a whole library", () => {
  it("agrees with the definition at every point", () => {
    const rules = [rule(MEMES, JANUARY, MARCH), rule(RANKING, MARCH)];
    const timeline = buildInheritanceTimeline(rules);

    for (const at of [JANUARY - DAY, JANUARY, MARCH - DAY, MARCH, APRIL, MAY]) {
      expect(timeline.at(at)).toEqual(inheritedContentTypeIds(rules, at));
    }
  });

  it("hands every Short in one segment the SAME array, not an equal one", () => {
    /*
     * Object identity, asserted deliberately.
     *
     * Non-deviating Shorts are the overwhelming majority of rows — the whole
     * point of storing nothing per Short — and several things downstream depend
     * on their resolutions being shared: the client index hands one object to a
     * whole segment, and the React memos beneath it compare by reference. A
     * fresh array per row would allocate thousands of identical objects per
     * payload and quietly defeat all of it.
     */
    const timeline = buildInheritanceTimeline([rule(MEMES, JANUARY)]);
    expect(timeline.at(APRIL)).toBe(timeline.at(MAY));
  });

  it("reports every tag the channel has ever been characterised by", () => {
    /*
     * The CHANNEL-level reading, for the dashboard's row filter — where the unit
     * is a channel and its metrics describe everything it published. A rule that
     * retired in March still means the channel spent a year making memes, so
     * dropping it from "channels that make Memes" the day the rule closed would
     * shrink the set every time somebody corrected a tag.
     */
    const timeline = buildInheritanceTimeline([
      rule(MEMES, JANUARY, MARCH),
      rule(RANKING, MARCH),
    ]);

    expect(timeline.everClaimed).toEqual([MEMES, RANKING].sort());
    // And at this instant only one of them is actually inherited.
    expect(timeline.at(APRIL)).toEqual([RANKING]);
  });

  it("gives an unruled channel nothing, at any date", () => {
    const timeline = buildInheritanceTimeline([]);
    expect(timeline.at(APRIL)).toEqual([]);
    expect(timeline.everClaimed).toEqual([]);
  });
});

describe("the streak retires the rule", () => {
  it("grows on a removal inside the window, and remembers where it began", () => {
    const change = recordOverride(openRule(), MARCH);

    expect(change).toEqual({
      consecutiveOverrides: 1,
      overrideStreakFrom: MARCH,
      closesAt: null,
    });
  });

  it("needs three in a row, and closes at the FIRST of them", () => {
    /*
     * THE CENTRAL PROPERTY OF THE WHOLE MECHANISM.
     *
     * The rule closes at March — the start of the streak — not at May, when the
     * third correction was made. Dating it to the day somebody noticed would
     * leave every upload between the switch and the discovery falsely tagged
     * forever, which is precisely the bug the owner asked to have removed.
     */
    let state = openRule();

    const first = recordOverride(state, MARCH);
    expect(first?.closesAt).toBeNull();
    state = { ...state, ...first! };

    const second = recordOverride(state, APRIL);
    expect(second?.closesAt).toBeNull();
    state = { ...state, ...second! };

    const third = recordOverride(state, MAY);
    expect(third?.consecutiveOverrides).toBe(RULE_AUTO_CLOSE_STREAK);
    expect(third?.closesAt).toBe(MARCH);
  });

  it("a confirmation on a newer Short resets it to zero", () => {
    // Somebody has looked at an upload newer than the point the rule was
    // supposedly wrong from and said the rule is right about it. That is exactly
    // the claim the streak was accumulating against.
    const running = openRule({ consecutiveOverrides: 2, overrideStreakFrom: MARCH });

    expect(recordConfirmation(running, APRIL)).toEqual({
      consecutiveOverrides: 0,
      overrideStreakFrom: null,
      closesAt: null,
    });
  });

  it("and the reset is real — three more removals are needed after it", () => {
    let state = openRule({ consecutiveOverrides: 2, overrideStreakFrom: MARCH });
    state = { ...state, ...recordConfirmation(state, APRIL)! };

    const next = recordOverride(state, MAY);
    expect(next?.consecutiveOverrides).toBe(1);
    expect(next?.closesAt).toBeNull();
    // The streak restarts where the NEW evidence starts, not where the discarded
    // one did.
    expect(next?.overrideStreakFrom).toBe(MAY);
  });

  it("a confirmation with no streak running writes nothing at all", () => {
    // No write means no audit entry either — confirming a rule nobody has argued
    // with is not an event.
    expect(recordConfirmation(openRule(), APRIL)).toBeNull();
  });
});

describe("removals that are not evidence about the channel", () => {
  it("a Short published BEFORE the rule counts for nothing", () => {
    /*
     * THE CASE THE FLAT MODEL COULD NOT SEE.
     *
     * Correcting the label on an old upload is tidying the back catalogue; it
     * says nothing whatever about what the channel is publishing now. Under a
     * flat channel tag there was no way to tell that apart from "the channel has
     * changed", because there were no dates to tell it apart by.
     */
    const rule = openRule({ effectiveFrom: MARCH });
    expect(recordOverride(rule, MARCH - DAY)).toBeNull();
  });

  it("a Short published after the rule closed counts for nothing", () => {
    const rule = openRule({ effectiveFrom: JANUARY, effectiveUntil: MARCH });
    expect(recordOverride(rule, APRIL)).toBeNull();
  });

  it("a Short older than the streak's start neither grows it nor resets it", () => {
    /*
     * The streak reads FORWARD from where it began: it is evidence that the
     * channel changed at a point in time and has stayed changed. Three removals
     * walking backwards through the back catalogue are three separate
     * corrections, not a run.
     *
     * It does not RESET either, and that asymmetry is deliberate: an old
     * correction is no more evidence against the switch than for it, and
     * treating it as a confirmation would let routine tidying keep a dead rule
     * alive indefinitely.
     */
    const running = openRule({ consecutiveOverrides: 2, overrideStreakFrom: APRIL });

    expect(recordOverride(running, MARCH)).toBeNull();
    expect(recordConfirmation(running, MARCH)).toBeNull();
  });

  it("removing the same Short twice cannot count twice", () => {
    // Remove, restore, remove again on one upload. Neither the second removal
    // nor the restore is NEWER than the streak's start, so a single Short cannot
    // walk a rule towards retirement on its own.
    const running = openRule({ consecutiveOverrides: 1, overrideStreakFrom: MARCH });

    expect(recordOverride(running, MARCH)).toBeNull();
    expect(recordConfirmation(running, MARCH)).toBeNull();
  });
});

describe("a closed rule, and putting it back", () => {
  it("stops claiming new uploads while still labelling the back catalogue", () => {
    const rules = [rule(MEMES, JANUARY, MARCH)];

    // The uploads that prompted the retirement: no longer tagged, and no rows
    // were written to achieve that on any of them.
    expect(inheritedContentTypeIds(rules, APRIL)).toEqual([]);
    expect(inheritedContentTypeIds(rules, MAY)).toEqual([]);
    // The year that genuinely was memes keeps its label. Untagging the channel —
    // the only fix the flat model offered — would have taken this with it.
    expect(inheritedContentTypeIds(rules, JANUARY + DAY)).toEqual([MEMES]);
  });

  it("accumulates no further streak while it is closed", () => {
    // Nothing to retire, so nothing to arm. Letting a streak build on a closed
    // rule would mean re-opening it and watching it close again on the next
    // removal, for reasons dated before the re-opening.
    const closed = openRule({ effectiveUntil: MARCH });
    expect(recordOverride(closed, JANUARY + DAY)).toBeNull();
  });

  it("is not re-opened by somebody tagging one Short", () => {
    /*
     * Tagging a Short after the rule retired writes a manual row on that Short
     * and means what it says — THIS Short is a meme — whereas re-opening means
     * "and so is everything the channel publishes from here". Inferring the
     * second from the first would undo a retirement the team was told about,
     * without telling them. Re-opening is its own action.
     */
    const closed = openRule({ effectiveUntil: MARCH });
    expect(recordConfirmation(closed, JANUARY + DAY)).toBeNull();
  });

  it("resumes the moment it is re-opened, covering everything since", () => {
    // Re-opening clears `effectiveUntil`; the window is the same one it always
    // was, so the uploads it stopped claiming are claimed again — and the back
    // catalogue never stopped.
    const reopened = [rule(MEMES, JANUARY)];

    expect(inheritedContentTypeIds(reopened, APRIL)).toEqual([MEMES]);
    expect(inheritedContentTypeIds(reopened, MAY)).toEqual([MEMES]);
    expect(inheritedContentTypeIds(reopened, JANUARY + DAY)).toEqual([MEMES]);
  });

  it("comes back with a clean slate, not one removal from retiring again", () => {
    /*
     * Re-opening is a person overruling the evidence. Carrying the streak across
     * it would arm the rule to retire itself on the very next removal, for
     * exactly the reasons that were just rejected — a re-open that lasts one
     * click is not an undo. The service clears all four columns; this pins what
     * the cleared state then does.
     */
    const reopened = openRule();
    const next = recordOverride(reopened, MAY);

    expect(next?.consecutiveOverrides).toBe(1);
    expect(next?.closesAt).toBeNull();
  });
});
