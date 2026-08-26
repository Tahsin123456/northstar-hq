"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { ADMIN_KEY } from "./use-admin";

/**
 * Connected Google accounts.
 *
 * CONNECTING IS NOT A MUTATION, AND CANNOT BE ONE.
 * /api/youtube/connect answers with a 302 to Google's consent screen. `fetch`
 * would follow that redirect inside the request rather than in the address bar,
 * so the user would never see the consent page and the flow would die on
 * Google's CORS policy. The browser has to navigate — see
 * `YOUTUBE_CONNECT_PATH` below. Disconnecting is an ordinary DELETE, which is
 * why only that half lives here as a mutation.
 */

export const YOUTUBE_CONNECTIONS_KEY = ["youtube", "connections"] as const;

/**
 * Start the consent flow by navigating, e.g.
 * `window.location.assign(YOUTUBE_CONNECT_PATH)` from a click handler, or a
 * plain `<a href>`.
 *
 * Deliberately a path and not a client function: this is the one place in the
 * app where leaving the SPA is the mechanism, and wrapping it in something that
 * looks like the rest of the API client would invite somebody to `fetch` it.
 */
export const YOUTUBE_CONNECT_PATH = "/api/youtube/connect";

/**
 * The connections, plus whether this deployment is configured for OAuth at all.
 *
 * `google.configured` decides which of two entirely different states the screen
 * renders — the connection list, or the environment variables still to be set
 * (`google.missing`, in the order to set them, and `google.redirectUri` to
 * register). Both arrive together so the wrong one is never shown first.
 */
export function useYouTubeConnections() {
  return useQuery({
    queryKey: YOUTUBE_CONNECTIONS_KEY,
    queryFn: api.listYouTubeConnections,
  });
}

export function useInvalidateYouTubeConnections() {
  const queryClient = useQueryClient();
  return React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: YOUTUBE_CONNECTIONS_KEY }),
    [queryClient],
  );
}

/**
 * Revoke the grant at Google and forget the tokens.
 *
 * Invalidates the admin namespace as well as this list, because the overview
 * tiles count connections and the ones needing re-authorisation — the two sit
 * on the same admin screen, and leaving the tile on a number the list below it
 * contradicts is the exact failure that namespace-wide invalidation exists to
 * prevent.
 *
 * The tracked channel is deliberately left alone: disconnecting is about
 * credentials, not about the team's research, so the dataset does not change
 * and is not invalidated. The channel keeps its "own" ownership and stays in
 * every chart it was already in.
 *
 * Read `revokedAtGoogle` on the result. When it is false the local tokens are
 * still gone, but the grant is standing in the user's Google account and only
 * they can remove it — say so rather than reporting a clean disconnection.
 */
export function useDisconnectYouTube() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.disconnectYouTube(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: YOUTUBE_CONNECTIONS_KEY }),
        queryClient.invalidateQueries({ queryKey: ADMIN_KEY }),
      ]);
    },
  });
}
