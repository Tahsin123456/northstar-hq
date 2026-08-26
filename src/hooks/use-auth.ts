"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * Sign out.
 *
 * WHY THIS HARD-NAVIGATES INSTEAD OF `router.push`
 * The session is an httpOnly cookie the *server* reads while rendering
 * `(app)/layout.tsx`. A client-side navigation would clear the cookie and then
 * leave everything the cookie authorised sitting in the tab: the React tree,
 * the query cache with the team's dataset and finance figures in it, and Next's
 * router cache holding already-rendered server payloads for the signed-in user
 * — which the Back button would happily serve. Assigning `window.location`
 * throws the whole document away and starts a fresh load with no cookie.
 *
 * `replace` rather than `assign` so the dashboard is not left one Back press
 * behind the login form.
 *
 * The cache is cleared first for the moment between the response landing and
 * the browser actually leaving the page.
 *
 * Navigation happens on success only. The server's logout always succeeds, so
 * reaching `onError` means the request never arrived — the cookie is still
 * valid, and redirecting would bounce straight back into the app having told
 * the user they were signed out. Render the error instead.
 */
export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.clear();
      window.location.replace("/login");
    },
  });
}
