/**
 * ISO 8601 duration parsing for `contentDetails.duration`.
 *
 * YouTube emits durations like `PT59S`, `PT1M2S`, `PT1H2M10S`, and — for live
 * streams that never had a duration — the literal `P0D`. The week designator
 * (`P2W`) never appears for videos but is handled so the parser is total.
 */

const ISO_DURATION =
  /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

const SECONDS_PER = {
  year: 365 * 24 * 60 * 60,
  month: 30 * 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  day: 24 * 60 * 60,
  hour: 60 * 60,
  minute: 60,
  second: 1,
} as const;

/**
 * @returns whole seconds, or `null` when the string is absent or unparseable.
 *
 * `null` is meaningful and is *not* coerced to 0: a duration of zero would let
 * a video sail through the "≤ 180s" Shorts gate, whereas an unknown duration
 * must leave the classifier uncertain.
 */
export function parseIsoDuration(iso: string | null | undefined): number | null {
  if (!iso || typeof iso !== "string") return null;

  const match = ISO_DURATION.exec(iso.trim());
  if (!match) return null;

  const [, years, months, weeks, days, hours, minutes, seconds] = match;

  // `P0D` — a live stream or an unprocessed upload. Real, but not a duration
  // we can classify on.
  if (
    !years && !months && !weeks && !days && !hours && !minutes && !seconds
  ) {
    return null;
  }

  const total =
    num(years) * SECONDS_PER.year +
    num(months) * SECONDS_PER.month +
    num(weeks) * SECONDS_PER.week +
    num(days) * SECONDS_PER.day +
    num(hours) * SECONDS_PER.hour +
    num(minutes) * SECONDS_PER.minute +
    num(seconds) * SECONDS_PER.second;

  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.round(total);
}

function num(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `PT1M5S` -> `1:05`, `PT1H2M3S` -> `1:02:03`. */
export function formatDurationSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  const secs = Math.round(totalSeconds);
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  const seconds = secs % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}
