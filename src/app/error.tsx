"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Route-level error boundary.
 *
 * Deliberately does not render `error.message`. An unhandled exception that
 * reaches here is a *programming* error, not a handled application error —
 * anything the user can act on was already converted into a typed message by
 * the API layer. Rendering a raw React or Prisma message here would leak
 * internals and tell the reader nothing useful. The digest is shown instead so
 * a specific incident can be found in the server log.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[boundary] Unhandled error:", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-2xl items-center px-6">
      <div className="w-full rounded-lg border border-border bg-surface">
        <EmptyState
          icon={<AlertTriangle />}
          tone="danger"
          title="Something went wrong"
          description={
            <>
              This page hit an unexpected error. Nothing in your tracker was
              changed.
              {error.digest ? (
                <>
                  <br />
                  <span className="mt-2 inline-block font-mono text-[11px] text-subtle-foreground">
                    Reference: {error.digest}
                  </span>
                </>
              ) : null}
            </>
          }
          action={
            <Button variant="primary" onClick={reset}>
              <RefreshCw />
              Try again
            </Button>
          }
          secondaryAction={
            <Button variant="secondary" asChild>
              <Link href="/">Back to overview</Link>
            </Button>
          }
        />
      </div>
    </div>
  );
}
