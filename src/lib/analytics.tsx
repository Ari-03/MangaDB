// Product analytics with PostHog (docs/configuration.md "Analytics (PostHog)").
//
// - `<AnalyticsProvider>` (mounted by AppProviders) loads PostHog in the
//   browser only, from VITE_PUBLIC_POSTHOG_KEY. Without the key it renders
//   its children and nothing else: no init, no network, no console output.
// - posthog-js lives in a lazy chunk (lib/analyticsClient.tsx) fetched after
//   hydration. The SSR build sees `import.meta.env.SSR` as true and drops the
//   import, so the Worker bundle never contains or loads posthog-js.
// - With `identify` (Clerk and Convex contexts above it), what the client
//   may do follows the session's `AnalyticsConsent`: nothing until Clerk and
//   the viewer's stored preference have answered, nothing for a viewer who
//   opted out (`users.analyticsOptOut`), and the chunk is fetched only once
//   capture is allowed. A browser sending Do Not Track (`doNotTrack()`) opts
//   a signed-in account out once, if it has never chosen, so server events
//   stop too; it never opts one back in.
// - `<AnalyticsSettings>` is the opt-out on /me's Settings tab.
// - `track()` is the one way app code captures a named event. Event names
//   and their properties are typed below; keep properties free of personal
//   data and free text (lengths and ids, not queries or review bodies).

import { useAuth } from "@clerk/tanstack-react-start";
import { useMutation, useQuery } from "convex/react";
import type { PostHogInterface } from "posthog-js";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";

import { api } from "../../convex/_generated/api";
import type { CollectionState } from "~/lib/cover";
import type { ReadingStatus } from "~/lib/reading";
import { useReadyViewer, type ReadyViewer } from "~/lib/viewer";
import { convexClient } from "~/providers";

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
  rating_submitted: { seriesPublicId: number; volumePublicId?: number; editionPublicId?: number; score: number };
  review_submitted: { seriesPublicId: number; volumePublicId?: number; editionPublicId?: number; length: number };
  comment_posted: { target: "series" | "volume"; seriesId: string; isReply: boolean; held: boolean };
  favorite_toggled: { target: "series" | "volume" | "edition"; publicId: number; favorite: boolean };
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

/**
 * What the PostHog client may do for this session:
 * - `pending`: Clerk or the signed-in viewer's preference has not answered.
 * - `off`: a signed-in viewer who opted out, or whose account is being deleted.
 * - `anonymous`: signed out; captured without a person (Do Not Track applies).
 * - `identified`: a signed-in viewer who has not opted out, captured as them.
 * Nothing is sent while `pending` or `off`.
 */
export type AnalyticsConsent =
  | { status: "pending" | "off" | "anonymous" }
  | { status: "identified"; userId: string; username?: string; role?: ReadyViewer["role"] };

const ANONYMOUS: AnalyticsConsent = { status: "anonymous" };

// The values posthog-js's `respect_dnt` reads as "yes".
const YES_LIKE = new Set<unknown>([true, "true", 1, "1", "yes"]);

/**
 * Whether this browser asks not to be tracked, in every form posthog-js's
 * `respect_dnt` honours: Do Not Track (standard, legacy IE and on window)
 * and Global Privacy Control.
 */
export function doNotTrack(): boolean {
  return [
    navigator.doNotTrack,
    "msDoNotTrack" in navigator ? navigator.msDoNotTrack : undefined,
    "globalPrivacyControl" in navigator ? navigator.globalPrivacyControl : undefined,
    "doNotTrack" in window ? window.doNotTrack : undefined,
  ].some((signal) => YES_LIKE.has(signal));
}

const PostHogAnalytics =
  import.meta.env.SSR || !posthogKey ? null : lazy(() => import("~/lib/analyticsClient"));

/**
 * Renders `children` and, once mounted in a browser, the analytics beside
 * them: with `identify`, the signed-in viewer's consent gate; without it,
 * the PostHog client for anonymous visitors.
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
      {mounted ? identify ? <ViewerAnalytics /> : <PostHogClient consent={ANONYMOUS} /> : null}
    </>
  );
}

/** The lazily loaded PostHog client, when the project key is configured. */
function PostHogClient({ consent }: { consent: AnalyticsConsent }) {
  return PostHogAnalytics && posthogKey ? (
    <Suspense fallback={null}>
      <PostHogAnalytics apiKey={posthogKey} consent={consent} />
    </Suspense>
  ) : null;
}

/**
 * The session's consent from Clerk and the viewer's stored preference. A
 * viewer who has never chosen follows this browser's Do Not Track until
 * that is saved; one still claiming a username has no account to store a
 * choice on and is identified unless the browser sends it.
 */
export function ViewerAnalytics() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const viewer = useQuery(api.users.viewer, isSignedIn ? {} : "skip");
  const setOptOut = useMutation(api.users.setAnalyticsOptOut);
  const dnt = doNotTrack();

  // Do Not Track opts an account that never chose out, once per page load.
  const unchosen = viewer?.needsUsername === false && viewer.analyticsOptOut === null;
  const [optedOutForDnt, setOptedOutForDnt] = useState(false);
  useEffect(() => {
    if (!dnt || !unchosen || optedOutForDnt) return;
    setOptedOutForDnt(true);
    void setOptOut({ optOut: true });
  }, [dnt, unchosen, optedOutForDnt, setOptOut]);

  let consent: AnalyticsConsent;
  if (!isLoaded) consent = { status: "pending" };
  else if (!isSignedIn || !userId) consent = ANONYMOUS;
  else if (viewer === undefined) consent = { status: "pending" };
  else if (viewer === null) consent = { status: "off" };
  else if (viewer.needsUsername) consent = dnt ? { status: "off" } : { status: "identified", userId };
  else if (viewer.analyticsOptOut ?? dnt) consent = { status: "off" };
  else consent = { status: "identified", userId, username: viewer.username, role: viewer.role };

  // Fetched the first time capture is allowed, then kept: the client
  // itself stops sending when consent is withdrawn.
  const allowed = consent.status === "anonymous" || consent.status === "identified";
  const [fetched, setFetched] = useState(false);
  if (allowed && !fetched) setFetched(true);
  return allowed || fetched ? <PostHogClient consent={consent} /> : null;
}

/**
 * The Analytics section of /me's Settings: what is collected, and On or
 * Off for the account, in the same pill as the Sharing defaults. Off stops
 * the browser client and every server event under the viewer's id.
 */
export function AnalyticsSettings() {
  if (!convexClient) return null;
  return <AnalyticsSettingsInner />;
}

function AnalyticsSettingsInner() {
  const viewer = useReadyViewer();
  const setOptOut = useMutation(api.users.setAnalyticsOptOut);
  if (!viewer) return null;
  const optedOut = viewer.analyticsOptOut ?? false;
  return (
    <div className="sharing-settings">
      <p className="sharing-lede">
        We send page views and actions such as follows, collection and reading changes, ratings,
        reviews, comments, favorites and searches to PostHog, to see how the site is used. While
        you are signed in they carry your account id, username and any data-team role. They never
        carry your email or the text of your reviews and comments. Page addresses and titles are
        included, so a search is sent as part of the search page's address and title.
      </p>
      <div className="vis-field">
        <span className="vis-legend" id="analytics-label">
          Analytics
        </span>
        <span className="seg-pill" role="radiogroup" aria-labelledby="analytics-label">
          {([false, true] as const).map((value) => (
            <label className="seg-opt" key={String(value)}>
              <input
                type="radio"
                name="analytics"
                checked={optedOut === value}
                onChange={() => void setOptOut({ optOut: value })}
              />
              <span>{value ? "Off" : "On"}</span>
            </label>
          ))}
        </span>
        <p className="vis-hint">
          Off stops new events about your account, from our server and from any browser you are
          signed in on. Events from before the switch, including any this browser still sends in
          the next few seconds, are not deleted.
        </p>
        <p className="vis-hint">
          {doNotTrack()
            ? "This browser asks not to be tracked (Do Not Track or Global Privacy Control), so it sends no analytics whatever you choose here. If you had not chosen before, we switched your account to Off when we first saw that."
            : "If a browser you sign in with sends Do Not Track or Global Privacy Control and you have not chosen yet, we switch your account to Off."}
        </p>
      </div>
    </div>
  );
}
