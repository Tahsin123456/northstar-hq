"use client";

import * as React from "react";

/**
 * The current time, as a React-legal external store.
 *
 * Several parts of this UI depend on "now": relative timestamps ("updated 12
 * minutes ago"), the anchor for trailing periods, and the maximum date a picker
 * will accept. Calling `Date.now()` during render is impure — React may render
 * a component twice and get two different answers — and assigning it from an
 * effect body causes a cascading re-render on mount.
 *
 * The clock is genuinely an *external* mutable source, so `useSyncExternalStore`
 * is the right primitive: one shared ticker updates a module-level snapshot and
 * every subscriber re-renders together, on the same value.
 *
 * Two details that matter:
 *   • `getSnapshot` returns the cached `currentNow`, not a fresh `Date.now()`.
 *     A fresh call would return a different number every time React checked for
 *     changes, and spin it into an infinite render loop.
 *   • `getServerSnapshot` returns 0, so server markup carries no timestamp and
 *     hydration matches exactly. The real time arrives on the first tick.
 *     Callers treat 0 as "not known yet".
 *
 * One ticker at 30s serves the whole app; nothing here needs finer resolution
 * than that, and a single shared interval beats one per component.
 */

const TICK_MS = 30_000;

let currentNow = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  currentNow = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  if (timer === null) {
    currentNow = Date.now();
    timer = setInterval(tick, TICK_MS);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return currentNow;
}

function getServerSnapshot(): number {
  return 0;
}

/** @returns epoch milliseconds, or `0` during server render and first hydration. */
export function useNow(): number {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
