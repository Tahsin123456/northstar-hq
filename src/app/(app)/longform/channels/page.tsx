/**
 * The Long Form channels page IS the channels page, mounted under the
 * /longform layout.
 *
 * The same arrangement as `../niches/page.tsx`: the module reads its format
 * from `useDatasetFormat()`, so under this segment's `LongformFiltersProvider`
 * the roster is the Long Form dataset's, the copy speaks of videos rather
 * than Shorts, and every card links to /longform/channels/[id] rather than to
 * the Shorts page for the same channel. Re-exporting the component, rather
 * than copying it, is what makes it impossible for the two rosters to
 * disagree about what a channel card says.
 *
 * Before this route existed the Long Form sidebar had no Channels row, and
 * a Long Form channel page lit nothing in the nav — the reader had arrived
 * somewhere the sidebar could not name.
 */
export { default } from "../../channels/page";
