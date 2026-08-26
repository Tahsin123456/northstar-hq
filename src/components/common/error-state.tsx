"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, KeyRound, RefreshCw, WifiOff } from "lucide-react";
import { ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Turns a thrown error into something a person can act on.
 *
 * Errors are grouped by *what the user should do next* rather than by HTTP
 * status: a missing API key needs a settings visit, an exhausted quota needs
 * patience, a network failure needs a retry. Raw messages and stack traces
 * never reach here — the server stripped them at the boundary.
 */
export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const apiError = error instanceof ApiError ? error : null;
  const message =
    error instanceof Error ? error.message : "Something went wrong. Try again in a moment.";

  if (apiError?.isConfiguration) {
    return (
      <EmptyState
        className={className}
        icon={<KeyRound />}
        title="YouTube API key required"
        description={
          <>
            {message}
            <br />
            <br />
            Add <code className="rounded bg-surface-hover px-1 py-0.5 text-[11px]">
              YOUTUBE_API_KEY
            </code>{" "}
            to your <code className="rounded bg-surface-hover px-1 py-0.5 text-[11px]">
              .env.local
            </code>{" "}
            file and restart the dev server.
          </>
        }
        action={
          <Button variant="primary" asChild>
            <Link href="/settings">Open setup guide</Link>
          </Button>
        }
      />
    );
  }

  if (apiError?.code === "QUOTA_EXCEEDED") {
    return (
      <EmptyState
        className={className}
        icon={<AlertTriangle />}
        tone="danger"
        title="YouTube API quota exhausted"
        description={`${message} Everything already stored is still available — only new fetches are blocked.`}
        action={onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined}
      />
    );
  }

  if (apiError?.code === "NETWORK_ERROR" || apiError?.status === 0) {
    return (
      <EmptyState
        className={className}
        icon={<WifiOff />}
        tone="danger"
        title="Can't reach the server"
        description={message}
        action={
          onRetry ? (
            <Button variant="primary" onClick={onRetry}>
              <RefreshCw />
              Retry
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <EmptyState
      className={className}
      icon={<AlertTriangle />}
      tone="danger"
      title="Something went wrong"
      description={message}
      action={
        onRetry ? (
          <Button variant="primary" onClick={onRetry}>
            <RefreshCw />
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * Persistent banner shown when no API key is configured but the app is
 * otherwise working. Non-blocking on purpose: stored data still renders, and
 * only *fetching* is unavailable.
 */
export function ApiKeyNotice() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning/25 bg-warning-subtle px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-warning" />
        <div>
          <p className="text-[13px] font-medium text-foreground">
            No YouTube API key configured
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
            Channels can&rsquo;t be added or refreshed until a key is set. Any
            data already collected still works.
          </p>
        </div>
      </div>
      <Button variant="secondary" size="sm" asChild className="shrink-0">
        <Link href="/settings">Set up</Link>
      </Button>
    </div>
  );
}
