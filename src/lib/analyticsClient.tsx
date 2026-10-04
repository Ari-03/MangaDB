// The browser-only half of lib/analytics.tsx, loaded lazily after
// hydration: PostHogProvider inits posthog-js, and ConsentSync applies the
// session's AnalyticsConsent to it (opt-out, opt-in, reset, identify).
// Never imported statically, so neither posthog-js nor @posthog/react ends
// up in the Worker bundle.

import { PostHogProvider } from "@posthog/react";
import posthog, { type PostHogConfig } from "posthog-js";
import { useEffect, useMemo, useRef, useState } from "react";

import { attachAnalyticsClient, type AnalyticsConsent } from "~/lib/analytics";
import { POSTHOG_PROXY_PATH, POSTHOG_UI_HOST } from "~/server/posthogProxy";

const baseOptions: Partial<PostHogConfig> = {
  // Same-origin proxy (src/server/posthogProxy.ts) unless overridden.
  api_host: (import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string | undefined) || POSTHOG_PROXY_PATH,
  ui_host: POSTHOG_UI_HOST,
  // Pageviews on History API navigation ('history_change') and pageleave.
  defaults: "2026-05-30",
  person_profiles: "identified_only",
  respect_dnt: true,
  // The named events in lib/analytics.tsx are the source of truth.
  autocapture: false,
  disable_session_recording: true,
  // No feature flags in use: skip the /flags request entirely. This is also
  // what keeps remote config off.
  advanced_disable_flags: true,
  // Nothing leaves while the consent last applied withholds it. posthog-js
  // stores its opt-out in localStorage, shared by every tab, so another tab
  // opting in turns capturing back on here while this account is Off. It
  // runs last in capture(), after posthog-js has updated its session and
  // pageview state.
  before_send: (event) => (sending ? event : null),
};

// Whether the consent last applied (applyConsent) lets events out.
let sending = false;
// Whether this tab's posthog-js still needs opt_in_capturing(): it opted out
// or found a denial, and has not opted in since. The stored opt-out cannot
// say, since another tab's reset() or opt-in changes it for every tab.
let needsOptIn = false;
// Whether `loaded` has run. The posthog-js singleton outlives the component
// and calls `loaded` once, so a remounted component starts from this.
let clientLoaded = false;

/**
 * posthog.init's options: `loaded` hands the instance to track() and applies
 * the consent `current()` returns at that moment, then calls `onLoaded`.
 */
export function clientOptions(current: () => AnalyticsConsent, onLoaded: () => void): Partial<PostHogConfig> {
  return {
    ...baseOptions,
    loaded: (instance) => {
      clientLoaded = true;
      attachAnalyticsClient(instance);
      applyConsent(current());
      onLoaded();
    },
  };
}

export default function PostHogAnalytics({
  apiKey,
  consent,
}: {
  apiKey: string;
  consent: AnalyticsConsent;
}) {
  // The provider inits posthog-js's default instance (`posthog`) in its own
  // effect, after its children's effects, so the consent sync mounts on
  // `loaded` instead of racing init. `loaded` runs before posthog-js sends
  // its first pageview, so the consent of that moment is applied there. A
  // remount finds posthog-js already loaded and mounts the sync at once.
  const [loaded, setLoaded] = useState(clientLoaded);
  const latest = useRef(consent);
  latest.current = consent;
  const options = useMemo(() => clientOptions(() => latest.current, () => setLoaded(true)), []);
  return (
    <PostHogProvider apiKey={apiKey} options={options}>
      {loaded ? <ConsentSync consent={consent} /> : null}
    </PostHogProvider>
  );
}

/**
 * Apply a consent to posthog-js. `pending` and `off` opt out of capturing,
 * so posthog-js drops every event before it records anything (its session,
 * the page it was on); the denial is stored, under the distinct id it
 * holds. `anonymous` and `identified` resume in this order: reset() when
 * posthog-js holds an identified user other than this one, so two accounts
 * are never merged and no event carries the other's id (reset() clears the
 * stored denial and keeps `$device_id`); then opt back in, with no `$opt_in`
 * event, if this tab opted out and has not opted in since, or a denial was
 * stored before the reset (one left by an earlier page load); then
 * `identified` identifies with username and role (never email). Opting in
 * starts the send queue and sends the initial `$pageview` if this page load
 * has not sent it, under the id of that moment; reset() does neither, so a
 * client that loaded opted out needs the opt-in after it. Applying the same
 * consent twice changes nothing.
 */
export function applyConsent(consent: AnalyticsConsent) {
  sending = consent.status === "anonymous" || consent.status === "identified";
  if (!sending) {
    posthog.opt_out_capturing();
    needsOptIn = true;
    return;
  }
  const userId = consent.status === "identified" ? consent.userId : null;
  // A denial stored by an earlier page load. Read before reset(), which clears it.
  needsOptIn ||= posthog.has_opted_out_capturing();
  // identify() records itself in posthog-js's persisted `$user_state`.
  if (posthog.get_property("$user_state") === "identified" && posthog.get_distinct_id() !== userId) {
    posthog.reset();
  }
  if (needsOptIn) {
    posthog.opt_in_capturing({ captureEventName: false });
    // Still denied under Do Not Track, so the next resume tries again.
    needsOptIn = posthog.has_opted_out_capturing();
  }
  if (consent.status === "identified") {
    const { username, role } = consent;
    // The second argument is the $set payload.
    posthog.identify(consent.userId, username ? { username, role } : undefined);
  }
}

// Reapplies the consent whenever it changes: a sign-in or sign-out, the
// viewer's preference answering, the toggle on /me, a username or role
// change. A sign-out that reloaded the page lands in `loaded` instead.
function ConsentSync({ consent }: { consent: AnalyticsConsent }) {
  const { status } = consent;
  const userId = consent.status === "identified" ? consent.userId : null;
  const username = consent.status === "identified" ? consent.username : undefined;
  const role = consent.status === "identified" ? consent.role : undefined;

  useEffect(() => {
    applyConsent(consent);
    // Unmounted (the router's error screen replaced the app), nothing reads
    // the session's consent, so nothing leaves until a remount applies it.
    return () => {
      sending = false;
    };
    // `consent` is a new object each render; its fields are the dependencies.
  }, [status, userId, username, role]);

  return null;
}
