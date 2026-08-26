"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";

/**
 * React Query configuration.
 *
 * The important choice is what a query key contains — and specifically what it
 * does *not*. The dataset key is `["dataset"]` with no period and no threshold
 * in it, so changing either of those controls cannot invalidate the cache and
 * cannot trigger a fetch. The filter requirement is enforced by the cache key
 * itself rather than by everyone remembering to be careful.
 */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The data changes only when a refresh runs, which explicitly
        // invalidates. Until then, treat it as fresh.
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          // Retrying a missing API key or a spent quota just delays a message
          // the user needs to read now.
          if (error instanceof ApiError) {
            if (error.isConfiguration || error.code === "QUOTA_EXCEEDED") return false;
            if (error.status >= 400 && error.status < 500) return false;
          }
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient(): QueryClient {
  if (typeof window === "undefined") return makeQueryClient();
  // One client for the browser session, created lazily so a Fast Refresh does
  // not discard the cache on every edit.
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(getQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
