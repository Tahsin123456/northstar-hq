/**
 * =========================================================================
 * WHAT CONNECTING AN ACCOUNT ACTUALLY BRINGS IN — AND WHAT IT DOES NOT
 * =========================================================================
 *
 * THE SENTENCE THIS FILE EXISTS TO MAKE THE PRODUCT SAY:
 * connecting changes WHO asks, not WHAT is asked for. An own channel's field set
 * is the same one a competitor's has, plus revenue. The connection is what makes
 * those figures authoritative and what unlocks money; it does not widen the
 * columns.
 *
 * That is not obvious, and the gap between it and what people assume is where
 * the disappointment lives. "Connect your channel" reads like "get your YouTube
 * Studio numbers", and Studio's headline metrics — watch time, average view
 * duration, impressions, click-through rate, subscribers gained — are not in the
 * Data API at all. They are YouTube ANALYTICS API metrics. This app's only
 * Analytics caller is the revenue service.
 *
 * So the unavailable list is stated in the product, at the moment somebody is
 * deciding whether to connect, rather than discovered later as a missing chart.
 * Every entry names WHY it is missing, because the three reasons have three
 * different futures: a permission that was never asked for, an endpoint nobody
 * calls, and a table that does not exist can each be fixed, and saying which is
 * the difference between a limitation and a bug report.
 *
 * NOTHING HERE IS ESTIMATED OR INVENTED TO FILL A GAP. A field that cannot be
 * read is reported as unavailable and left empty. Pure data, no imports, so both
 * the server and the browser can render the same list.
 */

export interface ImportedFieldGroup {
  readonly label: string;
  readonly fields: string;
}

/** What a sync genuinely writes, grouped the way somebody would ask about it. */
export const IMPORTED_FIELD_GROUPS: readonly ImportedFieldGroup[] = [
  {
    label: "Each video",
    fields:
      "title, description, upload date, duration, thumbnail, view count, likes, comments, and " +
      "whether YouTube still returns it",
  },
  {
    label: "Shorts",
    fields:
      "whether each video is a Short, with the evidence for the verdict — duration, aspect ratio " +
      "and confidence — rather than a bare flag",
  },
  {
    label: "The channel",
    fields:
      "title, handle, description, avatar, banner, country, subscriber count, total views and " +
      "video count, as they stand right now",
  },
  {
    label: "History",
    fields:
      "a repeated reading of every video's views, likes and comments, taken more often while a " +
      "Short is inside its hit window — which is what makes \"views after 24 hours\" answerable",
  },
  {
    label: "Money",
    fields:
      "estimated daily revenue per channel, if the revenue permission was granted, rolled up " +
      "into Finance as one entry per channel per month",
  },
];

/** Why a field cannot be read — three different futures, not one excuse. */
export type UnavailableReasonKind =
  /** The API this app calls does not return it to anyone. */
  | "different_api"
  /** Nothing stores it over time, so only the current value exists. */
  | "not_stored"
  /** The request does not ask for that part of the response. */
  | "not_requested";

export interface UnavailableField {
  readonly label: string;
  readonly reason: string;
  readonly kind: UnavailableReasonKind;
}

/**
 * Fields people expect from "connect your channel" that do not arrive.
 *
 * Listed rather than quietly absent, and never approximated: an estimated watch
 * time derived from views would be a number nobody could check against Studio,
 * which is the one thing these figures exist to be checkable against.
 */
export const UNAVAILABLE_FIELDS: readonly UnavailableField[] = [
  {
    label: "Watch time, average view duration, impressions and click-through rate",
    kind: "different_api",
    reason:
      "These are YouTube Analytics metrics, not YouTube Data API ones. The connection does carry " +
      "read-only Analytics permission, but the only Analytics report this app runs is the revenue " +
      "one, so none of these is imported. They are not estimated from views either — a number " +
      "that cannot be checked against YouTube Studio would be worse than none.",
  },
  {
    label: "Subscribers gained or lost, traffic sources, audience retention and demographics",
    kind: "different_api",
    reason:
      "Also YouTube Analytics rather than the Data API, and for the same reason not imported. " +
      "Read them in YouTube Studio.",
  },
  {
    label: "Subscriber count over time",
    kind: "not_stored",
    reason:
      "The current subscriber count is imported and kept up to date, but nothing records it " +
      "day by day, so no growth trend can be drawn — not even retroactively. Only the videos have " +
      "a history table.",
  },
  {
    label: "Whether one of your own videos is private or unlisted",
    kind: "not_requested",
    reason:
      "The video request does not ask YouTube for the privacy field, so a private upload on your " +
      "own channel is not distinguished from a public one — it simply does not appear, exactly as " +
      "it would not for a competitor.",
  },
];

/** One line for a surface that has room for a sentence and not a list. */
export const IMPORT_COVERAGE_SUMMARY =
  "Connecting changes who asks, not what is asked for: your channels are read with your own " +
  "authorisation — which is what makes the figures yours and what unlocks revenue — but the same " +
  "fields arrive as for any tracked channel. Studio metrics like watch time and click-through " +
  "rate are not among them.";
