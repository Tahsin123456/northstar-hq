"use client";

import * as React from "react";

type Theme = "dark" | "light";

/**
 * Theme state.
 *
 * Dark is the default — this is a dense analytics surface people keep open for
 * long stretches — but light is fully supported rather than an afterthought.
 *
 * The class is applied by a blocking inline script (`ThemeScript`) before the
 * first paint, so there is no flash of the wrong palette. That makes the DOM,
 * not React, the source of truth at startup, which is exactly the situation
 * `useSyncExternalStore` exists for: reading it in an effect instead would set
 * state on mount and cascade an extra render.
 */

const STORAGE_KEY = "shorts-hitrate:theme";

const listeners = new Set<() => void>();
let cachedTheme: Theme = "dark";

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  // Read the class the pre-paint script already applied.
  cachedTheme = document.documentElement.classList.contains("dark") ? "dark" : "light";
  listeners.add(listener);

  // Keep multiple tabs in step.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    const next: Theme = event.newValue === "light" ? "light" : "dark";
    if (next === cachedTheme) return;
    cachedTheme = next;
    document.documentElement.classList.toggle("dark", next === "dark");
    notify();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Must return a stable value between changes, so it reads the cache. */
function getSnapshot(): Theme {
  return cachedTheme;
}

/** Matches the class the server renders, so hydration agrees. */
function getServerSnapshot(): Theme {
  return "dark";
}

function applyTheme(next: Theme): void {
  cachedTheme = next;
  document.documentElement.classList.toggle("dark", next === "dark");
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode — the theme simply will not persist */
  }
  notify();
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
  /** False during SSR and first hydration, when the real theme is not yet known. */
  ready: boolean;
}

const ThemeContext = React.createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    // Deferred to a microtask so this is not a synchronous set during the
    // effect body, which would cascade a render.
    const id = setTimeout(() => setReady(true), 0);
    return () => clearTimeout(id);
  }, []);

  const value = React.useMemo<ThemeState>(
    () => ({
      theme,
      ready,
      setTheme: applyTheme,
      toggle: () => applyTheme(theme === "dark" ? "light" : "dark"),
    }),
    [theme, ready],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const context = React.useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside a <ThemeProvider>.");
  return context;
}

/**
 * Blocking script that sets the theme class before first paint.
 *
 * Runs synchronously in <head>, so the page is never rendered with the wrong
 * palette. The try/catch matters: `localStorage` throws outright in some
 * privacy modes, and an uncaught exception here would leave the page unstyled.
 */
export function ThemeScript() {
  const script = `
(function () {
  try {
    var stored = window.localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    var theme = stored === "light" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", theme === "dark");
  } catch (e) {
    document.documentElement.classList.add("dark");
  }
})();
`.trim();

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
