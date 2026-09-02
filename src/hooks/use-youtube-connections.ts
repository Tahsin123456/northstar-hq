"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { ADMIN_KEY } from "./use-admin";
import { DATASET_KEY } from "./use-dataset";
import { VIEWS_GAINED_KEY } from "./use-views-gained";
import { FINANCE_KEY } from "./use-finance";

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
export function useYouTubeConnections(enabled = true) {
  return useQuery({
    queryKey: YOUTUBE_CONNECTIONS_KEY,
    queryFn: api.listYouTubeConnections,
    // Defaults to on, so the admin screen — which has already checked the
    // permission before mounting the component that calls this — is unchanged.
    // The surfaces that render the connect panel beside ordinary analytics pass
    // `can("youtube.manage")`, so an editor never fires a request that could
    // only return 403.
    enabled,
  });
}

export const OWN_YOUTUBE_CHANNELS_KEY = ["youtube", "own-channels"] as const;

/**
 * The channels the connected accounts own, offered for adding.
 *
 * `enabled` rather than an unconditional fetch, and every caller passes
 * `can("youtube.manage")`. The endpoint is permission-gated server-side, so this
 * is not the boundary — it exists so the three surfaces that render this panel
 * do not fire a request that can only come back 403 for an editor who was never
 * going to see the list.
 *
 * Each read costs one live Data API call per connection, which is why it is not
 * folded into the dataset: the dataset is fetched on every session and this is
 * needed only when somebody is actually looking at the connect panel.
 * `staleTime` keeps navigating between the two surfaces that show it from
 * spending that twice in a minute.
 */
export function useOwnYouTubeChannels(enabled: boolean) {
  return useQuery({
    queryKey: OWN_YOUTUBE_CHANNELS_KEY,
    queryFn: api.listOwnYouTubeChannels,
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Track one of the connected account's own channels.
 *
 * Invalidates three things, and all three are load-bearing. The dataset, because
 * a channel has appeared in the tracker and every screen reads that array. This
 * list, because the channel that was just added must stop offering an "Add"
 * button. And the connection list, because linking a channel is exactly when a
 * connection's own summary changes.
 *
 * Resolves with the server's result rather than a bare ok: `created`, `restored`
 * and `reclassified` are three different things that can have happened, and a
 * toast saying "added" over a channel that was already there under the wrong
 * label would describe the wrong event.
 */
export function useAddOwnYouTubeChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { connectionId: string; youtubeChannelId: string }) =>
      api.addOwnYouTubeChannel(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: DATASET_KEY }),
        // Adopting a channel as "own" moves its gains from the competitor sum
        // to Northstar's on every niche money figure.
        queryClient.invalidateQueries({ queryKey: VIEWS_GAINED_KEY }),
        queryClient.invalidateQueries({ queryKey: OWN_YOUTUBE_CHANNELS_KEY }),
        queryClient.invalidateQueries({ queryKey: YOUTUBE_CONNECTIONS_KEY }),
      ]);
    },
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

/**
 * Read YouTube revenue now instead of waiting for the scheduler.
 *
 * Invalidates the connection list because the run rewrites the very fields the
 * screen is showing — revenue status, monetisation, the error and the next-sync
 * time — so leaving the cached copy would show yesterday's verdict beside a
 * toast describing today's.
 *
 * The finance namespace goes with it: a successful run writes monthly entries
 * into the ledger, and an admin who syncs and then opens Finance should not
 * find the month missing because the cache predates the import. Invalidating
 * one and not the other is how two screens end up disagreeing about the same
 * month.
 *
 * Resolves with the run's summary rather than throwing on a partial failure —
 * a connection outside the Partner Programme is a normal outcome, not an error
 * — so the caller has to read `errors` to report honestly.
 *
 * The variable is the connection to read, or `null` for all of them. It is a
 * mutation VARIABLE rather than a hook argument on purpose: each card mounts
 * its own instance, so `isPending` belongs to the button that was pressed and a
 * shared hook cannot leave every other card spinning.
 */
export function useSyncYouTubeRevenue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId?: string | null) => api.syncYouTubeRevenue(connectionId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: YOUTUBE_CONNECTIONS_KEY }),
        queryClient.invalidateQueries({ queryKey: FINANCE_KEY }),
      ]);
    },
  });
}
