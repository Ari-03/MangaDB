// Product analytics with PostHog (README "Analytics (PostHog)").
//
// - `<AnalyticsProvider>` (mounted by AppProviders) loads PostHog in the
//   browser only, from VITE_PUBLIC_POSTHOG_KEY. Without the key it renders
//   its children and nothing else: no init, no network, no console output.
// - posthog-js lives in a lazy chunk (lib/analyticsClient.tsx) fetched after
//   hydration. The SSR build sees `import.meta.env.SSR` as true and drops the
//   import, so the Worker bundle never contains or loads posthog-js.
// - With `identify`, the chunk also ties the session to the signed-in Clerk
//   user; that needs both Clerk and Convex contexts above it.
// - `track()` is the one way app code captures a named event. Event names
//   and their properties are typed below; keep properties free of personal
//   data and free text (lengths and ids, not queries or review bodies).

import type { PostHogInterface } from "posthog-js";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";

import type { CollectionState } from "~/lib/cover";
import type { ReadingStatus } from "~/lib/reading";

const posthogKey = import.meta.env.VITE_PUBLIC_POSTHOG_KEY as string | undefined;

/** Where a follow or reading-status change was made. */
type Source = "series_page" | "prompt" | "library";

/** Every named event and its properties. Pageviews/pageleaves are automatic. */
type AnalyticsEvents = {
  series_followed: { seriesId: string; source: Source };
  series_unfollowed: { seriesId: string; source: Source };
  collection_entry_set: { target: "release" | "bundle"; state: CollectionState | null };
  reading_status_changed: { seriesId: string; status: ReadingStatus | null; source: Source };
  search_performed: { queryLength: number; resultCount: number };
  mature_titles_toggled: { showMature: boolean };
  rating_submitted: { seriesPublicId: number; volumePublicId?: number; rating: number };
  review_submitted: { seriesPublicId: number; volumePublicId?: number; length: number };
  comment_posted: { target: "series" | "volume"; seriesId: string; isReply: boolean; held: boolean };
};

export type AnalyticsEvent = keyof AnalyticsEvents;

// Set by the lazy chunk once posthog.init has finished.
let client: PostHogInterface | null = null;

/** Hands the initialized PostHog instance to `track()`. */
export function attachAnalyticsClient(instance: PostHogInterface): void {
  client = instance;
}

/** Capture a named event; a no-op when analytics is off or not yet loaded. */
export function track<E extends AnalyticsEvent>(event: E, properties: AnalyticsEvents[E]): void {
  client?.capture(event, properties);
}

const PostHogAnalytics =
  import.meta.env.SSR || !posthogKey ? null : lazy(() => import("~/lib/analyticsClient"));

/**
 * Renders `children` and, once mounted in a browser with the project key
 * configured, the lazily loaded PostHog client beside them.
 */
export function AnalyticsProvider({
  identify = false,
  children,
}: {
  identify?: boolean;
  children: ReactNode;
}) {
  // After hydration only: the server rendered nothing here.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <>
      {children}
      {PostHogAnalytics && posthogKey && mounted ? (
        <Suspense fallback={null}>
          <PostHogAnalytics apiKey={posthogKey} identify={identify} />
        </Suspense>
      ) : null}
    </>
  );
}
