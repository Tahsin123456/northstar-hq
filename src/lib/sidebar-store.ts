/**
 * Which sidebar sections the viewer has folded away, modelled as an external
 * store.
 *
 * The same shape as `theme-provider.tsx`: the value lives in `localStorage`
 * so a fold survives a reload, `useSyncExternalStore` reads it, and the
 * SERVER SNAPSHOT IS "NOTHING COLLAPSED" — the markup the server renders
 * shows every section open, the first client render agrees, and the stored
 * folds are adopted immediately afterwards without a hydration mismatch.
 * Reading storage in an effect after mount is the usual approach and is
 * exactly what React 19 flags: a synchronous set on mount and a cascaded
 * second render.
 *
 * EVERY STORAGE ACCESS IS WRAPPED. `localStorage` throws outright in some
 * privacy modes, and a stored value can be anything a previous version — or a
 * hand edit — left there. An unreadable store means "nothing collapsed", the
 * same answer the server gives, so the worst case of a broken store is a
 * sidebar that forgets a preference rather than one that fails to render.
 *
 * The key is versioned so a future change to the shape can move to `:v2`
 * and leave the old value orphaned instead of misread.
 */

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "northstar-hq:sidebar:collapsed:v1";

/**
 * One frozen empty array, shared. `useSyncExternalStore` compares snapshots
 * by reference, so "nothing collapsed" must be the SAME array every time it
 * is returned — a fresh `[]` on each read would be a new value on every
 * render and an infinite update loop.
 */
const NONE: readonly string[] = Object.freeze([]);

const listeners = new Set<() => void>();
let cached: readonly string[] = NONE;

/**
 * The stored value, narrowed to what this module wrote: a JSON array of
 * strings. Anything else — `null`, malformed JSON, a number, an array with a
 * non-string in it — reads as nothing collapsed. Exported so the pin on that
 * fail-open rule does not need a storage stub.
 */
export function parseCollapsedIds(raw: string | null): readonly string[] {
  if (raw === null) return NONE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return NONE;
    if (!parsed.every((entry): entry is string => typeof entry === "string")) return NONE;
    return parsed.length === 0 ? NONE : Object.freeze([...parsed]);
  } catch {
    return NONE;
  }
}

function readStorage(): readonly string[] {
  try {
    return parseCollapsedIds(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY));
  } catch {
    /* private mode, or no window at all — nothing is collapsed */
    return NONE;
  }
}

function writeStorage(ids: readonly string[]): void {
  try {
    if (ids.length === 0) {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    } else {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, JSON.stringify(ids));
    }
  } catch {
    /* private mode — the fold simply will not persist */
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Adopt a value read from storage, keeping the existing reference when the
 * contents are unchanged so subscribers are not re-rendered for nothing.
 */
function adopt(next: readonly string[]): void {
  if (sameIds(cached, next)) return;
  cached = next;
}

export function subscribeToSidebar(listener: () => void): () => void {
  // Read what storage holds now, exactly as the theme provider reads the
  // class the pre-paint script applied: the subscription is the first
  // moment the client is allowed to disagree with the server snapshot.
  adopt(readStorage());
  listeners.add(listener);

  // Keep multiple tabs in step.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SIDEBAR_COLLAPSED_STORAGE_KEY) return;
    const before = cached;
    adopt(parseCollapsedIds(event.newValue));
    if (cached !== before) notify();
  };
  try {
    window.addEventListener("storage", onStorage);
  } catch {
    /* no window — nothing to keep in step with */
  }

  return () => {
    listeners.delete(listener);
    try {
      window.removeEventListener("storage", onStorage);
    } catch {
      /* mirrors the guard above */
    }
  };
}

/** Must return a stable value between changes, so it reads the cache. */
export function getSidebarSnapshot(): readonly string[] {
  return cached;
}

/** Nothing collapsed — what the server rendered, so hydration agrees. */
export function getSidebarServerSnapshot(): readonly string[] {
  return NONE;
}

export function setSectionCollapsed(sectionId: string, collapsed: boolean): void {
  const already = cached.includes(sectionId);
  if (collapsed === already) return;

  const next = collapsed
    ? Object.freeze([...cached, sectionId])
    : cached.filter((id) => id !== sectionId);
  cached = next.length === 0 ? NONE : next;
  writeStorage(cached);
  notify();
}

export function toggleSection(sectionId: string): void {
  setSectionCollapsed(sectionId, !cached.includes(sectionId));
}

/** Idempotent: the section that holds the current page is never folded. */
export function expandSection(sectionId: string): void {
  setSectionCollapsed(sectionId, false);
}
