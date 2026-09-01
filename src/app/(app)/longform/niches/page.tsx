/**
 * The Long Form niches page IS the niches page, mounted under the /longform
 * layout.
 *
 * The module itself is format-aware through `useDatasetFormat()`: under this
 * segment's `LongformFiltersProvider` the dataset is the Long Form one — so
 * the list is the Long Form niche list, the card figures count long-form
 * videos, the create dialog sends `format: "longform"`, and every link stays
 * inside /longform. Re-exporting the component, rather than copying it, is
 * what makes it impossible for the two management screens to disagree about
 * what a niche card says.
 */
export { default } from "../../niches/page";
