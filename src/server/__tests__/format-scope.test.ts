import { describe, expect, it } from "vitest";
import { requireFormat, resolveAllowedFormats } from "@/server/auth/format-scope";
import { AppError } from "@/server/errors";
import type { NicheFormat } from "@/lib/niches/niche-format";

/**
 * Format scoping: the decision, pinned before anything enforces it.
 *
 * Nothing calls `requireFormat` yet — this deploy ships the Long Form
 * plumbing dark — and that is exactly why the table below is written now.
 * The LATER deploy that adds Long Form surfaces will reach for this resolver
 * under deadline, and the moment it does, every role's answer is already a
 * contract rather than whatever the first caller happened to observe.
 *
 * Pinned role by role, from the role brief rather than from the
 * implementation, in the same spirit as `permissions.test.ts`: if somebody
 * widens a role's `contentScope`, the failure names the role that leaked.
 */

/** Every shipped role, with the formats its side of the operation covers. */
const EXPECTED_FORMATS: ReadonlyArray<[string, readonly NicheFormat[]]> = [
  ["admin", ["shorts", "longform"]],
  ["head_of_shorts", ["shorts"]],
  ["head_of_longs", ["longform"]],
  ["short_form_editor", ["shorts"]],
  ["long_form_editor", ["longform"]],
  ["short_form_clip_producer", ["shorts"]],
];

describe("resolveAllowedFormats", () => {
  it.each(EXPECTED_FORMATS)("%s → %j", (role, formats) => {
    expect(resolveAllowedFormats(role)).toEqual(formats);
  });

  it("fails closed for an unknown role — shorts only, via roleDefinition's fallback", () => {
    // A typo, a downgrade, a hand-edited row: `roleDefinition` resolves it to
    // the least-privileged role, whose scope is "shorts". The worst case is
    // somebody seeing only the product every current account already sees —
    // never an extra format.
    expect(resolveAllowedFormats("chief_wizard")).toEqual(["shorts"]);
    expect(resolveAllowedFormats("")).toEqual(["shorts"]);
  });

  it("resolves the retired role aliases like the roles they map to", () => {
    expect(resolveAllowedFormats("channel_director")).toEqual(["shorts"]);
    expect(resolveAllowedFormats("creative_director")).toEqual(["shorts"]);
  });
});

describe("requireFormat", () => {
  it.each(EXPECTED_FORMATS)(
    "defaults %s to its first allowed format when none is requested",
    (role, formats) => {
      expect(requireFormat(role)).toBe(formats[0]);
    },
  );

  it("defaults an all-scope role to shorts — the product that exists today", () => {
    expect(requireFormat("admin")).toBe("shorts");
  });

  it("returns a requested format the role is entitled to", () => {
    expect(requireFormat("admin", "longform")).toBe("longform");
    expect(requireFormat("admin", "shorts")).toBe("shorts");
    expect(requireFormat("head_of_longs", "longform")).toBe("longform");
    expect(requireFormat("short_form_editor", "shorts")).toBe("shorts");
  });

  it("refuses a requested format outside the role's scope rather than substituting", () => {
    // A Long Form Editor asking for Shorts gets a 403, not a quiet redirect
    // to longform: answering with a scope the caller did not ask about is how
    // numbers get misread.
    for (const [role, requested] of [
      ["head_of_shorts", "longform"],
      ["short_form_editor", "longform"],
      ["short_form_clip_producer", "longform"],
      ["head_of_longs", "shorts"],
      ["long_form_editor", "shorts"],
    ] as const) {
      let thrown: unknown;
      try {
        requireFormat(role, requested);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${role} requesting ${requested}`).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("FORBIDDEN");
    }
  });

  it("refuses an unrecognised requested string instead of normalising it", () => {
    // "Shorts", "long", garbage: none of them are in any allowed list, so
    // they are refused — never coerced into a valid format the caller did
    // not actually name.
    for (const requested of ["Shorts", "LONGFORM", "long", "video", ""]) {
      expect(() => requireFormat("admin", requested)).toThrowError(AppError);
    }
  });

  it("fails closed for an unknown role with a longform request", () => {
    let thrown: unknown;
    try {
      requireFormat("chief_wizard", "longform");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("FORBIDDEN");
    // And with no request, the fallback role's own default applies.
    expect(requireFormat("chief_wizard")).toBe("shorts");
  });
});
