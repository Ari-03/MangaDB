import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A page's working copy of what its URL holds (a search box, a filter
 * panel) for controls that navigate in place as they change. `url` is the
 * URL's value now and `urlKey` one string per value.
 *
 * `request(key)` records a navigation the page is about to make; it returns
 * false when that view is already the latest one asked for, so the page can
 * skip it. Every view asked for is remembered until the URL reaches the
 * latest, so none of them landing touches the draft, not even an older one
 * committing after a newer was asked for. Only a view the page never asked
 * for (a link, back/forward, another search box) replaces the draft, after
 * `onOutside` (pass a stable function) has run.
 */
export function useUrlDraft<T>(url: T, urlKey: string, onOutside?: () => void) {
  const [draft, setDraft] = useState(url);
  // Views asked for and not yet superseded by the URL, oldest first.
  const requested = useRef([urlKey]);

  useEffect(() => {
    const keys = requested.current;
    if (urlKey === keys[keys.length - 1]) {
      requested.current = [urlKey];
    } else if (!keys.includes(urlKey)) {
      requested.current = [urlKey];
      onOutside?.();
      setDraft(url);
    }
  }, [urlKey, url, onOutside]);

  const request = useCallback((key: string) => {
    const keys = requested.current;
    if (key === keys[keys.length - 1]) return false;
    keys.push(key);
    return true;
  }, []);

  return { draft, setDraft, request };
}
