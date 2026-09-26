import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

/** Search params as the router hands them over, before a route validates them. */
export type SearchParams = Record<string, unknown>;

/** Views a page has asked the URL for and not yet seen start, oldest first. */
export type Pending = ReadonlyArray<string>;

/**
 * The page is about to navigate to `key` while the URL shows, or is on its
 * way to, `heading`. Null when `key` is already the latest view asked for
 * (or, with none pending, `heading`), so the page can skip the navigation;
 * otherwise the new pending list.
 */
export function requestView(pending: Pending, heading: string, key: string): Pending | null {
  return key === (pending.at(-1) ?? heading) ? null : [...pending, key];
}

/** A navigation as the router reports it (`onBeforeNavigate`), as far as a draft reads it. */
export type Navigation = {
  fromLocation?: { pathname: string; searchStr: string };
  toLocation: { pathname: string; searchStr: string; search: SearchParams };
  hashChanged: boolean;
};

/** What a starting navigation means to a page (`startView`). */
export type Start<T> =
  | { kind: "ignore" }
  | { kind: "own"; key: string; pending: Pending }
  | { kind: "outside"; key: string; view: T }
  | { kind: "leave" };

/**
 * Sorts a navigation that is starting, given the views the page has asked
 * for (`read` turns search params into the page's view, `keyOf` names one):
 * - ignore: the first load after hydration (there is no location before
 *   it) and a change of hash alone; neither changes the view.
 * - own: a view the page asked for. It and every older request are done;
 *   newer ones stay pending.
 * - outside: any other navigation on this page (a link, back/forward, Clear
 *   all, the header box), even to the URL already shown, which the router
 *   reloads in place. The draft becomes `view`, and nothing stays pending.
 * - leave: a navigation to another page. Nothing stays pending; the draft
 *   stays as it is while the page is still up.
 */
export function startView<T>(
  pending: Pending,
  nav: Navigation,
  read: (search: SearchParams) => T,
  keyOf: (view: T) => string,
): Start<T> {
  const from = nav.fromLocation;
  const to = nav.toLocation;
  if (!from) return { kind: "ignore" };
  if (to.pathname !== from.pathname) return { kind: "leave" };
  if (to.searchStr === from.searchStr && nav.hashChanged) return { kind: "ignore" };
  const view = read(to.search);
  const key = keyOf(view);
  const at = pending.lastIndexOf(key);
  if (at < 0) return { kind: "outside", key, view };
  return { kind: "own", key, pending: pending.slice(at + 1) };
}

/**
 * A page's working copy of what its URL holds (a search box, a filter
 * panel) for controls that navigate in place as they change. `url` is the
 * route's validated search now, `read` the route's validator and `keyOf`
 * one string per view; pass module-level functions and a stable
 * `onOutside`.
 *
 * `request(key)` records a navigation the page is about to make and returns
 * false when it is already the latest one asked for, so the page can skip
 * it. Every other navigation runs `onOutside` (where a page drops its
 * pending timer) and, on this page, replaces the draft with where it goes.
 *
 * Navigations are read as they start, off the router's public
 * `onBeforeNavigate` event, and never as they land. At the start the page
 * can still stop its timer; by the landing, a slow load has given the timer
 * time to fire and supersede the navigation. The router fires the event for
 * a link that reloads the URL already shown too, which no comparison of
 * URLs can see, and resets in each control would miss back/forward and the
 * header box. The page's own navigations are told apart by view key, so a
 * view it asked for, or one a newer request superseded, never touches what
 * is being typed. `startView` has the rules.
 */
export function useUrlDraft<T>(
  url: T,
  read: (search: SearchParams) => T,
  keyOf: (view: T) => string,
  onOutside?: () => void,
) {
  const router = useRouter();
  const [draft, setDraft] = useState(url);
  const pending = useRef<Pending>([]);
  // The view the URL shows, or the one it is on its way to.
  const heading = useRef(keyOf(url));

  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", (nav) => {
        const start = startView(pending.current, nav, read, keyOf);
        if (start.kind === "ignore") return;
        if (start.kind === "own") {
          pending.current = start.pending;
          heading.current = start.key;
          return;
        }
        pending.current = [];
        onOutside?.();
        if (start.kind === "outside") {
          heading.current = start.key;
          setDraft(start.view);
        }
      }),
    [router, read, keyOf, onOutside],
  );

  const request = useCallback((key: string) => {
    const next = requestView(pending.current, heading.current, key);
    if (next) pending.current = next;
    return next !== null;
  }, []);

  return { draft, setDraft, request };
}
