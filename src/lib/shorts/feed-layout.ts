/**
 * The grid a feed of Shorts is laid out on.
 *
 * A constant in `lib` rather than a string in the component, for one reason:
 * this is now the THIRD copy of the same class list — the research log and the
 * saved board each declare their own — and the three are meant to be the same
 * grid. They drifted apart once already. Somewhere to import it from is what
 * turns "we intended these to match" into something a test can hold.
 *
 * WHY THESE EXACT COLUMNS
 * They come off Tailwind's own scale rather than invented breakpoints, and they
 * are counted against the MAIN COLUMN, not the window: the shell keeps a 212px
 * sidebar from `lg` up, so at `xl` three cards share roughly 1000px. That is
 * about 325px each, which is enough for a portrait thumbnail and a two-line
 * title without either one being squeezed.
 *
 * `grid-cols-1` AT THE BOTTOM END IS THE LOAD-BEARING PART. It is what makes
 * "the page never scrolls sideways" a structural property rather than a hope:
 * on the narrowest phone a card is one full-width column, so there is nothing
 * for the body to overflow with. The rule that keeps it true is that no card in
 * this grid may carry a `min-w-` of its own — a minimum width on a cell wider
 * than the viewport reintroduces exactly the horizontal scroll this avoids, and
 * that is why the old feed's fixed right-hand columns could not simply be
 * dropped into a grid.
 *
 * One string, shared by the rows and by the skeleton that stands in for them,
 * so the loading state cannot settle into a different shape than the thing it
 * was predicting.
 */
export const SHORTS_CARD_GRID =
  "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4";

/**
 * The poster box at the top of a card: 9:16, centred, and capped.
 *
 * SHARED FOR THE SAME REASON THE GRID IS. The card draws this and the loading
 * skeleton draws a Skeleton in its place, and a skeleton that predicts a
 * different shape than the thing it stands in for makes the page settle by
 * jumping — which is precisely the moment a reader loses their place. One
 * string means the prediction cannot drift from the answer.
 *
 * `aspect-[9/16]` IN BOTH BRANCHES OF THE CARD. A Short is portrait and the
 * owner asked to see it that way; the box keeps that shape even when the
 * portrait source is missing and the 16:9 fallback has to be letterboxed into
 * it, because a box that changes shape on load reflows the whole grid.
 *
 * `max-w-` AND NEVER `w-`. The cap is what keeps the tile a readable height: a
 * card is roughly 325px wide at `xl`, and an uncapped 9:16 poster on it would
 * be 578px tall, three to a row, taller than most laptop viewports. A `w-` here
 * would instead force the grid column wider than a phone and hand the whole
 * page a horizontal scrollbar — the exact bug the grid above is shaped to make
 * impossible. 208px is a Shorts tile at about the size YouTube's own shelf uses,
 * and on a narrower card `w-full` wins and the cap never applies.
 */
export const SHORTS_POSTER_FRAME = "mx-auto aspect-[9/16] w-full max-w-[208px]";
