// The browser-only half of lib/analytics.tsx, loaded lazily after
// hydration: PostHogProvider inits posthog-js, and IdentitySync links the
// session to the Clerk user. Never imported statically, so neither
// posthog-js nor @posthog/react ends up in the Worker bundle.

import { useAuth } from "@clerk/tanstack-react-start";
import { PostHogProvider, usePostHog } from "@posthog/react";
import { useQuery } from "convex/react";
import type { PostHogConfig } from "posthog-js";
import { useEffect, useMemo, useState } from "react";

import { api } from "../../convex/_generated/api";
import { attachAnalyticsClient } from "~/lib/analytics";
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
  // No feature flags in use: skip the /flags request entirely.
  advanced_disable_flags: true,
};

export default function PostHogAnalytics({
  apiKey,
  identify,
}: {
  apiKey: string;
  identify: boolean;
}) {
  // The provider inits in its own effect, after its children's effects, so
  // the identity sync mounts on `loaded` instead of racing init.
  const [loaded, setLoaded] = useState(false);
  const options = useMemo<Partial<PostHogConfig>>(
    () => ({
      ...baseOptions,
      loaded: (instance) => {
        attachAnalyticsClient(instance);
        setLoaded(true);
      },
    }),
    [],
  );
  return (
    <PostHogProvider apiKey={apiKey} options={options}>
      {identify && loaded ? <IdentitySync /> : null}
    </PostHogProvider>
  );
}

// Identify once the viewer query answers, so username and role come along
// (never email). Reset whenever Clerk reports signed out while PostHog still
// holds an identified user, which also covers a sign-out that reloaded the
// page.
function IdentitySync() {
  const posthog = usePostHog();
  const { isLoaded, isSignedIn, userId } = useAuth();
  const viewer = useQuery(api.users.viewer, isSignedIn ? {} : "skip");
  const profile = viewer && !viewer.needsUsername ? viewer : null;
  const username = profile?.username;
  const role = profile?.role ?? null;
  const viewerPending = viewer === undefined;

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn && userId) {
      if (viewerPending) return;
      // The second argument is the $set payload.
      posthog.identify(userId, username ? { username, role } : undefined);
    } else if (posthog._isIdentified()) {
      posthog.reset();
    }
  }, [posthog, isLoaded, isSignedIn, userId, viewerPending, username, role]);

  return null;
}
