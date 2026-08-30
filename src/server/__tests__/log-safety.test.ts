import { describe, expect, it } from "vitest";
import { describeCauseForLog, redactSecrets, REDACTED } from "@/server/log-safety";

/**
 * THE ONE WAY AN ENCRYPTED GOOGLE TOKEN CAN REACH A LOG FILE.
 *
 * `jsonError` logs `appError.cause` for every 5xx, and a Prisma validation error
 * puts the failing query's SERIALISED ARGUMENTS in its message. On the
 * token-writing paths in `youtube-oauth-service` those arguments are
 * `accessTokenEnc` and `refreshTokenEnc` — so a schema mistake in one of those
 * writes would print encrypted credentials into the application log, which is a
 * far easier thing to read than the database it came from.
 *
 * The callback route already guarded this exact case by hand, by logging only
 * `error.message` and saying why. These tests pin the generalised version, and
 * the two properties that make it worth having: the credential goes, and enough
 * of the error survives to still be worth logging.
 */

describe("redactSecrets", () => {
  it("strips the ciphertext out of a Prisma argument dump", () => {
    const dump =
      "Invalid `prisma.youTubeConnection.update()` invocation: { " +
      "where: { id: 'conn_1' }, data: { accessTokenEnc: 'v1.abcdefghij.klmnopqrst.uvwxyz012345', " +
      "refreshTokenEnc: 'v1.zyxwvutsrq.ponmlkjihg.fedcba987654', status: 'connected' } }";

    const safe = redactSecrets(dump);

    expect(safe).not.toContain("uvwxyz012345");
    expect(safe).not.toContain("fedcba987654");
    // And still says which query failed and why somebody should look.
    expect(safe).toContain("prisma.youTubeConnection.update()");
    expect(safe).toContain("conn_1");
    expect(safe).toContain(REDACTED);
  });

  it("strips Google's own spellings, in JSON and in a query string", () => {
    expect(redactSecrets('{"access_token":"ya29.a0ARrd","expires_in":3599}')).not.toContain(
      "ya29.a0ARrd",
    );
    expect(redactSecrets("client_secret=GOCSPX-abc123&grant_type=refresh_token")).not.toContain(
      "GOCSPX-abc123",
    );
    // The refresh_token here is a VALUE ("grant_type=refresh_token"), not a
    // credential, and losing it costs nothing — over-redacting a log line is
    // cheap and under-redacting one is not.
    expect(redactSecrets('{"expires_in":3599}')).toContain("3599");
  });

  it("strips a bare ciphertext envelope even where no key names it", () => {
    const orphan = "failed writing v1.AAAAAAAAAAAA.BBBBBBBBBBBB.CCCCCCCCCCCC to the row";

    expect(redactSecrets(orphan)).not.toContain("CCCCCCCCCCCC");
    expect(redactSecrets(orphan)).toContain("failed writing");
  });

  it("leaves an ordinary message alone", () => {
    const plain = "connect ETIMEDOUT 142.250.185.10:443";

    expect(redactSecrets(plain)).toBe(plain);
  });
});

describe("describeCauseForLog", () => {
  it("keeps the stack, which is the reason for logging a cause at all", () => {
    const error = new Error("boom");

    const described = describeCauseForLog(error);

    expect(described).toContain("boom");
    expect(described).toContain("log-safety.test");
  });

  it("redacts the stack too, because it begins with the message", () => {
    const error = new Error("update failed: accessTokenEnc: 'v1.aaaaaaaa.bbbbbbbb.cccccccc'");

    expect(describeCauseForLog(error)).not.toContain("cccccccc");
  });

  it("says nothing for no cause, rather than printing 'undefined'", () => {
    expect(describeCauseForLog(undefined)).toBe("");
    expect(describeCauseForLog(null)).toBe("");
  });

  it("survives a value that cannot be serialised", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(describeCauseForLog(circular)).toBe("[uninspectable object]");
  });
});
