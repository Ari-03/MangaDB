import { useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

/** Views a page has asked the URL for and not yet seen land, oldest first. */
export type Pending = ReadonlyArray<string>;

/**
 * The page is about to navigate to `key` while the URL shows `shown`. Null
 * when `key` is already the latest view asked for (or, with none pending,
 * the one shown), so the page can skip the navigation; otherwise the new
 * pending list.
 */
export function requestView(pending: Pending, shown: string, key: string): Pending | null {
  return key === (pending.at(-1) ?? shown) ? null : [...pending, key];
}

/**
 * A navigation to `key` landed. One the page asked for is its own arriving:
 * it and every older request are done, newer ones stay pending, so a
 * superseded view landing after a newer was asked for touches nothing.
 * Anything else came from outside (a link, back/forward, Clear all), even
 * when it lands on the view already shown; `outside` says to replace the
 * draft, and nothing stays pending.
 */
export function landView(pending: Pending, key: string): { pending: Pending; outside: boolean } {
  const at = pending.lastIndexOf(key);
  return at < 0 ? { pending: [], outside: true } : { pending: pending.slice(at + 1), outside: false };
}

/**
 * A page's working copy of what its URL holds (a search box, a filter
 * panel) for controls that navigate in place as they change. `url` is the
 * URL's value now and `urlKey` one string per value.
 *
 * `request(key)` records a navigation the page is about to make and returns
 * false when it is already the latest one asked for, so the page can skip
 * it. Views the page asked for landing never touch the draft (`landView`);
 * any other navigation replaces it, after `onOutside` (pass a stable
 * function) has run. Landings are read off the router, which marks each
 * finished navigation with a fresh history key, so one that lands on the
 * view already shown counts too.
 */
export function useUrlDraft<T>(url: T, urlKey: string, onOutside?: () => void) {
  const [draft, setDraft] = useState(url);
  const pending = useRef<Pending>([]);
  const shown = useRef(urlKey);
  const landing = useRouterState({ select: (s) => s.resolvedLocation?.state.__TSR_key });
  const seen = useRef(landing);

  useEffect(() => {
    if (landing === seen.current) return;
    seen.current = landing;
    shown.current = urlKey;
    const next = landView(pending.current, urlKey);
    pending.current = next.pending;
    if (next.outside) {
      onOutside?.();
      setDraft(url);
    }
  }, [landing, urlKey, url, onOutside]);

  const request = useCallback((key: string) => {
    const next = requestView(pending.current, shown.current, key);
    if (next) pending.current = next;
    return next !== null;
  }, []);

  return { draft, setDraft, request };
}
