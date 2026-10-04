// The browser-only half of lib/analytics.tsx, loaded lazily after
// hydration: PostHogProvider inits posthog-js, and ConsentSync applies the
// session's AnalyticsConsent to it (whether events go out, identify, reset).
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
  // Nothing leaves while the consent last applied withholds it. This gates
  // only what goes through capture(): posthog-js's logs and metrics check
  // is_capturing() and send with the distinct id without it, so keep them off.
  before_send: (event) => (sending ? event : null),
};

// Whether the consent last applied (applyConsent) lets events out.
let sending = false;
// Whether `off` has been applied since events last went out. posthog-js
// updates its session and pageview state before before_send drops an
// event, so what it gathered while off would ride on the next event.
let offSinceSending = false;

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
  // its first pageview, so the consent of that moment is applied there.
  const [loaded, setLoaded] = useState(false);
  const latest = useRef(consent);
  latest.current = consent;
  const options = useMemo<Partial<PostHogConfig>>(
    () => ({
      ...baseOptions,
      loaded: (instance) => {
        attachAnalyticsClient(instance);
        applyConsent(latest.current);
        setLoaded(true);
      },
    }),
    [],
  );
  return (
    <PostHogProvider apiKey={apiKey} options={options}>
      {loaded ? <ConsentSync consent={consent} /> : null}
    </PostHogProvider>
  );
}

/**
 * Apply a consent to posthog-js. `before_send` is the only gate: `pending`
 * and `off` drop every event and change nothing else. `anonymous` and
 * `identified` let events out, first calling reset() when `off` was applied
 * since events last went out, so nothing gathered while off survives, or
 * when posthog-js holds an identified user other than this one, so two
 * accounts are never merged into one person and no event carries the other
 * account's id (reset() keeps posthog-js's `$device_id`, which both share).
 * Then `identified` identifies with username and role (never email).
 * Applying the same consent twice changes nothing.
 */
function applyConsent(consent: AnalyticsConsent) {
  sending = consent.status === "anonymous" || consent.status === "identified";
  if (consent.status === "off") offSinceSending = true;
  if (!sending) return;
  const userId = consent.status === "identified" ? consent.userId : null;
  // posthog-js keeps an identified id across reloads. `_isIdentified` is
  // internal to posthog-js, with no public equivalent; it may change on upgrade.
  if (offSinceSending || (posthog._isIdentified() && posthog.get_distinct_id() !== userId)) {
    posthog.reset();
  }
  offSinceSending = false;
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
    // `consent` is a new object each render; its fields are the dependencies.
  }, [status, userId, username, role]);

  return null;
}
