/**
 * Application error taxonomy.
 *
 * Every error that can reach a route handler carries three things:
 *   • a stable machine `code` the client can branch on,
 *   • an HTTP `status`,
 *   • a `userMessage` written for a human being.
 *
 * Route handlers serialise *only* those three. Stack traces and raw upstream
 * payloads stay on the server and go to the log — the UI never shows them.
 */

export type AppErrorCode =
  | "MISSING_API_KEY"
  | "NOT_CONFIGURED"
  | "INVALID_INPUT"
  | "CHANNEL_NOT_FOUND"
  | "CHANNEL_ALREADY_TRACKED"
  | "NOT_FOUND"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "UNAUTHENTICATED"
  | "TOO_MANY_ATTEMPTS"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR"
  | "FORBIDDEN"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly userMessage: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AppErrorCode,
    userMessage: string,
    options: {
      status?: number;
      cause?: unknown;
      details?: Record<string, unknown>;
      /** Internal-only text for the server log. Never serialised. */
      internalMessage?: string;
    } = {},
  ) {
    super(options.internalMessage ?? userMessage, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.userMessage = userMessage;
    this.status = options.status ?? defaultStatusForCode(code);
    this.details = options.details;
  }
}

function defaultStatusForCode(code: AppErrorCode): number {
  switch (code) {
    case "INVALID_INPUT":
      return 400;
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "CHANNEL_NOT_FOUND":
    case "NOT_FOUND":
      return 404;
    case "CHANNEL_ALREADY_TRACKED":
      return 409;
    case "RATE_LIMITED":
    case "TOO_MANY_ATTEMPTS":
      return 429;
    case "MISSING_API_KEY":
    case "NOT_CONFIGURED":
      // 503: the server is correctly built but not yet configured to serve
      // this. Distinguishing it from a 500 lets the UI show a setup prompt
      // rather than an error state.
      return 503;
    case "QUOTA_EXCEEDED":
      return 503;
    case "UPSTREAM_ERROR":
      return 502;
    case "NETWORK_ERROR":
      return 504;
    case "INTERNAL_ERROR":
    default:
      return 500;
  }
}

// --- Convenience constructors ---------------------------------------------

export const errors = {
  invalidInput(message: string, details?: Record<string, unknown>): AppError {
    return new AppError("INVALID_INPUT", message, { details });
  },

  channelNotFound(input: string): AppError {
    return new AppError(
      "CHANNEL_NOT_FOUND",
      `No YouTube channel matched “${input}”. Check the URL or @handle and try again.`,
      { details: { input } },
    );
  },

  alreadyTracked(title: string): AppError {
    return new AppError(
      "CHANNEL_ALREADY_TRACKED",
      `${title} is already in your tracker.`,
      { details: { title } },
    );
  },

  /**
   * 401 — no valid session. The client's correct response is to send the
   * person to /login, which is why this is distinct from `forbidden`.
   */
  unauthenticated(): AppError {
    return new AppError("UNAUTHENTICATED", "Your session has ended. Sign in to continue.");
  },

  /**
   * 403 — authenticated, but not allowed.
   *
   * The message deliberately names the missing capability rather than the
   * resource. Saying "you cannot view finance" is useful; enumerating what
   * exists behind the wall is not.
   */
  forbidden(what = "do that"): AppError {
    return new AppError(
      "FORBIDDEN",
      `You do not have permission to ${what}. Ask an admin if you need access.`,
    );
  },

  tooManyAttempts(retryAfterSeconds: number): AppError {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    return new AppError(
      "TOO_MANY_ATTEMPTS",
      `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      { details: { retryAfterSeconds } },
    );
  },

  notFound(what = "resource"): AppError {
    return new AppError("NOT_FOUND", `That ${what} could not be found.`);
  },

  missingApiKey(): AppError {
    return new AppError(
      "MISSING_API_KEY",
      "No YouTube API key is configured yet. Add YOUTUBE_API_KEY to .env.local and restart the server.",
    );
  },

  /**
   * 503 — a required environment variable is not set.
   *
   * Names the variable on purpose. This is a message for whoever deploys the
   * app, not for an end user, and "not configured" without saying *what* turns
   * a thirty-second fix into an afternoon. Naming an environment variable
   * discloses nothing: an attacker who can read our public documentation
   * already knows it exists, and the value is never included.
   */
  notConfigured(variable: string, what: string): AppError {
    return new AppError(
      "NOT_CONFIGURED",
      `${what} is not configured: set the ${variable} environment variable and restart the server.`,
      { details: { variable } },
    );
  },

  quotaExceeded(): AppError {
    return new AppError(
      "QUOTA_EXCEEDED",
      "The YouTube API daily quota for this key is used up. Quota resets at midnight Pacific Time. Existing data is unaffected and the dashboard still works.",
    );
  },

  rateLimited(): AppError {
    return new AppError(
      "RATE_LIMITED",
      "YouTube is rate-limiting requests right now. Wait a moment and try again.",
    );
  },

  upstream(message: string, cause?: unknown): AppError {
    return new AppError("UPSTREAM_ERROR", message, { cause });
  },

  network(cause?: unknown): AppError {
    return new AppError(
      "NETWORK_ERROR",
      "Could not reach YouTube. Check your internet connection and try again.",
      { cause },
    );
  },

  internal(cause?: unknown): AppError {
    return new AppError(
      "INTERNAL_ERROR",
      "Something went wrong on our side. Try again in a moment.",
      { cause },
    );
  },
};

/** Coerces anything thrown into an AppError without leaking internals. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof Error) {
    if (error.name === "MissingApiKeyError") return errors.missingApiKey();
    // Undici/Node fetch failures surface as a generic TypeError.
    if (error.name === "TypeError" && /fetch failed/i.test(error.message)) {
      return errors.network(error);
    }
    if (error.name === "AbortError" || /timeout/i.test(error.message)) {
      return new AppError(
        "NETWORK_ERROR",
        "The request to YouTube timed out. Try again in a moment.",
        { cause: error },
      );
    }
    return errors.internal(error);
  }

  return errors.internal(error);
}

export interface SerializedError {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export function serializeError(error: AppError): SerializedError {
  return {
    code: error.code,
    message: error.userMessage,
    ...(error.details ? { details: error.details } : {}),
  };
}
