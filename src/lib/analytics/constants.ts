import type { PeriodPresetId, ViewBucket } from "./types";

/**
 * The default bar the dashboard's view-count control opens on.
 *
 * NO LONGER "the default definition of a hit". A hit is a bar reached inside a
 * niche's window, both halves set by an admin per niche, and neither half has
 * an organization-wide fallback — see `resolveHitRule`, which refuses to build
 * half a rule. This number survives as the starting point of a LENS: it shades
 * the Shorts table, scales the "relative to bar" column and marks where the
 * line falls on the distribution. Moving it changes what is highlighted and
 * changes no verdict.
 */
export const DEFAULT_THRESHOLD = 1_000_000;

export const DEFAULT_PERIOD_PRESET: PeriodPresetId = "30d";

/** Presets offered by the threshold control, in ascending order. */
export const THRESHOLD_PRESETS = [
  100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000,
] as const;

export const MIN_THRESHOLD = 1;
/** Above the most-viewed video ever, with room to spare. */
export const MAX_THRESHOLD = 100_000_000_000;

/**
 * ==========================================================================
 * WHEN THERE IS NO RULE
 * ==========================================================================
 *
 * A niche needs BOTH a threshold and a hit window before anything filed under
 * it can be scored, and either one missing leaves it unconfigured. The app used
 * to quietly borrow the organization default for the threshold and print a hit
 * rate — a figure that looks exactly like a measurement and is nobody's
 * decision. For the window there is no default at all to borrow, which is the
 * same principle with the loophole closed.
 *
 * These strings are the replacement, kept here rather than typed into each
 * screen so that every surface says the same words. "Not configured" is a
 * state, not an error: nothing is broken, a decision is simply missing and
 * somebody has to make it.
 *
 * NOTE WHAT IS ALSO UNCONFIGURED NOW: "All niches". Under the old rule, no
 * niche selected meant the organization default threshold applied and rates
 * were reported against it. Both halves of a hit are per-niche now, so the
 * all-niches view falls back to nothing — it reports the rate over what each
 * Short's OWN niche decided, and Shorts in unconfigured niches land in the
 * exclusions, where they are visible and fixable rather than silently scored
 * against a number nobody chose.
 */
export const UNCONFIGURED_RULE_LABEL = "Hit rule: Not configured";

/** The headline when a set of Shorts has a rule but nothing decided in it yet. */
export const NOTHING_DECIDED_SHORT = "Nothing decided yet";

/** Why a rate is missing when Shorts exist but none has a verdict. */
export const NOTHING_DECIDED_EXPLANATION =
  "These Shorts have no decided outcome yet — every one is either still inside its hit window or was published with no view history recorded during it. A rate over none of them would be a number about nothing.";

/** The short form, for a table cell or a stat where the label is already there. */
export const UNCONFIGURED_RULE_SHORT = "Not configured";

/** Why the figure is missing, for a tooltip or a caption. */
export const UNCONFIGURED_RULE_EXPLANATION =
  "A hit is a number of views reached within a set time of publishing. This niche is missing at least one of the two, so there is no definition of a hit to measure against. An Admin can set both; until then no hit rate is reported for it.";

/** What an employee is told when they create a niche they cannot configure. */
export const EMPLOYEE_HIT_RULE_NOTICE =
  "The hit rule — the view threshold, the hit window, and what one hit pays — is set by an Admin. Your niche will be created without one, and nothing filed under it is scored or paid until an Admin fills them in.";

/** The marker on an admin's list of niches that still need a decision. */
export const NEEDS_RULE_LABEL = "Needs hit rule configuration";

export interface PeriodPreset {
  readonly id: PeriodPresetId;
  readonly label: string;
  readonly shortLabel: string;
  /** `null` for the custom range, which carries its own bounds. */
  readonly days: number | null;
}

export const PERIOD_PRESETS: readonly PeriodPreset[] = [
  { id: "7d", label: "Last 7 days", shortLabel: "7D", days: 7 },
  { id: "30d", label: "Last 30 days", shortLabel: "30D", days: 30 },
  { id: "90d", label: "Last 90 days", shortLabel: "90D", days: 90 },
  { id: "180d", label: "Last 180 days", shortLabel: "180D", days: 180 },
  { id: "custom", label: "Custom range", shortLabel: "Custom", days: null },
];

export const PERIOD_PRESET_BY_ID: Readonly<Record<PeriodPresetId, PeriodPreset>> =
  Object.fromEntries(PERIOD_PRESETS.map((p) => [p.id, p])) as Readonly<
    Record<PeriodPresetId, PeriodPreset>
  >;

/**
 * Histogram buckets for the performance distribution.
 *
 * These exist because two channels can share a 20% hit rate while having
 * completely different shapes — one clustered just under the line, one carried
 * by a couple of outliers. The distribution is what exposes that.
 */
export const VIEW_BUCKETS: readonly ViewBucket[] = [
  { id: "lt10k", label: "<10K", min: 0, max: 10_000 },
  { id: "10k-50k", label: "10K–50K", min: 10_000, max: 50_000 },
  { id: "50k-100k", label: "50K–100K", min: 50_000, max: 100_000 },
  { id: "100k-250k", label: "100K–250K", min: 100_000, max: 250_000 },
  { id: "250k-500k", label: "250K–500K", min: 250_000, max: 500_000 },
  { id: "500k-1m", label: "500K–1M", min: 500_000, max: 1_000_000 },
  { id: "1m-2m", label: "1M–2M", min: 1_000_000, max: 2_000_000 },
  { id: "2m-5m", label: "2M–5M", min: 2_000_000, max: 5_000_000 },
  { id: "5m-10m", label: "5M–10M", min: 5_000_000, max: 10_000_000 },
  { id: "10m+", label: "10M+", min: 10_000_000, max: null },
];

/**
 * The single source of truth for what "hit rate" means, surfaced in the UI as
 * a tooltip.
 *
 * REWRITTEN WHEN THE CLOCK ARRIVED. The old wording — "Shorts uploaded during
 * the period that currently have at least the selected number of views" — is a
 * precise description of the bug: it measured lifetime views, so the same
 * channels scored 5.9% under seven days old and 18.8% at 30–90 days, and
 * publishing more made the number fall. Every word of the replacement is
 * load-bearing, including the sentence about what is left out: on this account
 * the excluded population is large, and a rate quoted without it is a different
 * claim from the one the data supports.
 */
export const HIT_RATE_DEFINITION =
  "A hit is a Short that reached its niche's view threshold within that niche's hit window of publishing — for example 1,000,000 views within 7 days. Hit rate is the share of DECIDED Shorts uploaded in the selected period that managed it. Shorts still inside their window are not counted in either half: they are unfinished, not failures. Shorts whose window closed with no view history recorded inside it are excluded too, and counted separately, because they did eventually pass the bar and nobody can say whether that took two days or two years.";

export const HIT_RATE_FORMULA = "hits ÷ decided Shorts × 100";

/** What the two excluded populations are, for a caption under a rate. */
export const HIT_RATE_PENDING_EXPLANATION =
  "Still inside its hit window. Not a hit and not a miss yet — the verdict lands on its own when the window closes.";

export const HIT_RATE_UNKNOWN_EXPLANATION =
  "The window closed with no view count recorded inside it, and the Short has since passed the bar. It cleared at some point and there is no honest way to say whether that took two days or two years, so it is excluded — and counted, because these are disproportionately the winners and dropping them silently biases every rate downward.";

export const HIT_RATE_UNSCOREABLE_EXPLANATION =
  "No rule to judge these by. Either the Short's channel sits in no niche with both a threshold and a hit window, or it has not been evaluated yet. Either way it is not a potential hit and does not count against anything.";

/** How the bounds are meant to be read. */
export const HIT_RATE_BOUNDS_EXPLANATION =
  "Every unrecorded Short did eventually pass the bar, so each one is a potential hit whose timing nobody captured. The low end counts them all as too slow; the high end counts them all as hits. The truth is somewhere between.";

/**
 * What the view-count control now does, said plainly.
 *
 * It used to define a hit. It cannot any more — a hit needs a window and the
 * window is a niche setting — so the control is a lens over the distribution
 * and the label has to say so, or somebody will move it and wait for the hit
 * rate to change.
 */
export const THRESHOLD_LENS_EXPLANATION =
  "This bar highlights Shorts at or above a view count. It does NOT define a hit: a hit is a niche's threshold reached within that niche's hit window, decided per Short and stored. Moving this changes what is highlighted and sorted, and changes no hit rate on the page.";

/**
 * What "Total Shorts views" means here — stated because the natural assumption
 * (that it matches YouTube Studio) is wrong, and silently differing numbers
 * destroy trust in every other figure on the page.
 */
export const TOTAL_VIEWS_DEFINITION =
  "Total Shorts views is the sum of the current view counts of Shorts uploaded during the selected period. It is not views earned during the period: a Short uploaded three days ago contributes all of its lifetime views, and a Short uploaded before the period contributes none. Unlike hit rate, this figure is deliberately a LIFETIME total and has no window — it describes reach, not whether the work met a bar in time.";

/** Why this will not match the number in YouTube Studio. */
export const TOTAL_VIEWS_VS_STUDIO =
  "YouTube Studio measures something different — views earned in the last N days across a channel's entire back catalogue, including videos uploaded years ago. The two figures answer different questions and will not agree.";

/**
 * ==========================================================================
 * THE OTHER HALF OF THE RULE: THE WINDOW
 * ==========================================================================
 *
 * A niche needs a threshold AND a window before anything in it can be scored.
 * These bounds exist for the same reason the threshold's do — to keep a typo
 * out of the definition of a hit — and are deliberately wide, because the right
 * window is a judgement about how fast a niche's audience moves and not
 * something this file should be opinionated about.
 */
export const MIN_HIT_WINDOW_HOURS = 1;
/** A year. Past this the window stops meaning anything a person would recognise. */
export const MAX_HIT_WINDOW_HOURS = 8_760;

/** Offered by the window control, in ascending order. Hours, shown as days. */
export const HIT_WINDOW_PRESETS = [24, 48, 72, 168, 336, 720] as const;

/**
 * There is NO DEFAULT WINDOW, and that is deliberate.
 *
 * A default threshold exists because the organization genuinely has one — "a
 * million views" is a number somebody chose. Nobody has ever chosen a default
 * window, and inventing one would mean every unconfigured niche silently
 * started reporting rates against a rule no human wrote. Unconfigured stays
 * unconfigured until an admin says otherwise.
 */
export const UNCONFIGURED_WINDOW_SHORT = "No hit window";

/** Why a niche with a threshold still reports nothing. */
export const UNCONFIGURED_WINDOW_EXPLANATION =
  "This niche has a hit threshold but no hit window, so there is no definition of a hit to measure against. A hit is a number of views reached within a set time of publishing; both halves are needed. An Admin can set the window.";
