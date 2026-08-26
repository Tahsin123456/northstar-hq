/**
 * Product and company identity.
 *
 * Centralised so the name appears in exactly one place: the browser title, the
 * sidebar, empty states, the PDF cover and the export filename all read from
 * here. Renaming the product should never be a search-and-replace across
 * dozens of files.
 */
export const BRAND = {
  /** The application / product. */
  product: "Northstar HQ",
  /** The company the product belongs to. */
  company: "Northstar Studios",
  /** Short descriptor used under the wordmark and in metadata. */
  tagline: "Shorts Intelligence",
  /** Used in report titles and filenames. */
  reportName: "Shorts Performance Report",
  /** Filename-safe product slug. */
  slug: "Northstar-HQ",
} as const;

/**
 * Filename for an exported report.
 *
 * Northstar-HQ-Shorts-Report-2026-08-26.pdf
 * Northstar-HQ-GTA-Report-2026-08-26.pdf
 */
export function reportFilename(nicheName: string | null, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  // Strip anything that would be awkward in a filename or a shell.
  const nichePart = nicheName
    ? `${nicheName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-`
    : "Shorts-";
  return `${BRAND.slug}-${nichePart}Report-${stamp}.pdf`;
}
