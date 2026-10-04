// The analytics consent gate (lib/analytics.tsx), the PostHog client that
// applies it (lib/analyticsClient.tsx) and the Settings opt-out, driven as
// plain functions (test.react.ts) against convex-test. Clerk's useAuth,
// posthog-js and its React provider are fakes. The provider calls `loaded`
// on its first render and then captures the initial pageview, as posthog-js
// does at the end of init. The fake posthog keeps its distinct id across
// reloads, records the calls made on it, and logs each event that passes
// its opt-out and the client's before_send in `sent`, under the id of the
// moment, as posthog-js would queue it.

import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../convex/_generated/api";
import { makeT, reader, withUser, type Accessor } from "../../convex/test.helpers";
import { harness, mount, mountAside, resetHarness, setQuery, settle, text, type Host } from "./test.react";

const fakes = vi.hoisted(() => {
  const state = { distinctId: "anon-1", anonymousIds: 1, identified: false, optedOut: false, inited: false };
  const calls: string[] = [];
  const sent: Array<{ event: string; id: string }> = [];
  const fakes = {
    auth: { isLoaded: false, isSignedIn: undefined as boolean | undefined, userId: null as string | null },
    state,
    calls,
    sent,
    // What the client handed posthog.init, for its before_send.
    options: null as { before_send?: unknown; loaded?: (instance: unknown) => void } | null,
    posthog: {
      capture: (event: string) => {
        const beforeSend = fakes.options?.before_send;
        if (state.optedOut || (typeof beforeSend === "function" && beforeSend({ event }) === null)) return;
        sent.push({ event, id: state.distinctId });
      },
      get_distinct_id: () => state.distinctId,
      _isIdentified: () => state.identified,
      // posthog-js's stored consent, which the client must leave alone.
      has_opted_out_capturing: () => state.optedOut,
      opt_out_capturing: () => {
        calls.push("opt_out_capturing");
        state.optedOut = true;
      },
      opt_in_capturing: () => {
        calls.push("opt_in_capturing");
        state.optedOut = false;
        fakes.posthog.capture("$opt_in");
      },
      // reset() forgets the id, and the stored consent with it.
      reset: () => {
        calls.push("reset");
        Object.assign(state, { distinctId: `anon-${++state.anonymousIds}`, identified: false, optedOut: false });
      },
      // Moving off an anonymous id sends $identify; off another identified
      // id it switches silently.
      identify: (id: string) => {
        calls.push(`identify ${id}`);
        const fromAnonymous = !state.identified && id !== state.distinctId;
        Object.assign(state, { distinctId: id, identified: true });
        if (fromAnonymous) fakes.posthog.capture("$identify");
      },
    },
  };
  return fakes;
});

vi.mock("convex/react", async () => (await import("./test.react")).backendHooks);
vi.mock("~/providers", () => ({ convexClient: {} }));
vi.mock("@clerk/tanstack-react-start", () => ({ useAuth: () => fakes.auth }));
vi.mock("posthog-js", () => ({ default: fakes.posthog }));
vi.mock("@posthog/react", () => ({
  PostHogProvider: ({ options, children }: { options: typeof fakes.options; children: unknown }) => {
    fakes.options = options;
    if (!fakes.state.inited) {
      fakes.state.inited = true;
      options?.loaded?.(fakes.posthog);
      fakes.posthog.capture("$pageview");
    }
    return children;
  },
}));

const { AnalyticsSettings, ViewerAnalytics, track } = await import("./analytics");
const { default: PostHogAnalytics } = await import("./analyticsClient");
type AnalyticsConsent = import("./analytics").AnalyticsConsent;

/** A named event from app code. */
function search() {
  track("search_performed", { queryLength: 4, resultCount: 2 });
}

function identified(userId: string): AnalyticsConsent {
  return { status: "identified", userId, username: "reader", role: null };
}

/**
 * Render the gate; the consent it hands the client, or null when it loads
 * no client at all.
 */
function gate(): AnalyticsConsent | null {
  const rendered: Array<ReturnType<typeof ViewerAnalytics>> = [];
  mount(() => {
    rendered.push(ViewerAnalytics());
    return rendered[0];
  });
  const element = rendered[0];
  return isValidElement<{ consent: AnalyticsConsent }>(element) ? element.props.consent : null;
}

/** Render the client with `consent` on its own hook slots, as the gate would. */
const clientSlots: unknown[][] = [];
function client(consent: AnalyticsConsent) {
  if (clientSlots.length === 0) clientSlots.push([]);
  mountAside(clientSlots[0]!, () => PostHogAnalytics({ apiKey: "phc_test", consent }));
}

/** A new page load: the next client() inits again; posthog-js's stored id stays. */
function reload() {
  clientSlots.length = 0;
  fakes.state.inited = false;
}

function signIn(userId: string | null) {
  fakes.auth.isLoaded = true;
  fakes.auth.isSignedIn = userId !== null;
  fakes.auth.userId = userId;
}

/** Answer users.viewer from the backend as it stands. */
async function refreshViewer(as: Accessor) {
  setQuery(api.users.viewer, await as.query(api.users.viewer, {}));
}

/** Count users.setAnalyticsOptOut calls from now on. */
function countOptOutCalls() {
  const calls: unknown[] = [];
  harness.intercept = async (name, run) => {
    if (name === "users:setAnalyticsOptOut") calls.push(name);
    return await run();
  };
  return calls;
}

async function storedOptOut(as: Accessor) {
  const viewer = await as.query(api.users.viewer, {});
  return viewer && !viewer.needsUsername ? viewer.analyticsOptOut : undefined;
}

/** The Settings radio reading `label`, by its onChange. */
function choose(tree: Host[], label: "On" | "Off") {
  const option = tree.find((host) => host.type === "label" && text(host.props.children).endsWith(label));
  const children = option?.props.children;
  const input = Array.isArray(children) ? children[0] : undefined;
  if (!isValidElement<{ onChange: () => void }>(input)) throw new Error(`No option "${label}"`);
  input.props.onChange();
}

beforeEach(() => {
  resetHarness();
  clientSlots.length = 0;
  fakes.auth.isLoaded = false;
  fakes.auth.isSignedIn = undefined;
  fakes.auth.userId = null;
  Object.assign(fakes.state, { distinctId: "anon-1", anonymousIds: 1, identified: false, optedOut: false, inited: false });
  fakes.calls.length = 0;
  fakes.sent.length = 0;
  fakes.options = null;
  vi.stubGlobal("navigator", { doNotTrack: null });
  vi.stubGlobal("window", {});
  return () => vi.unstubAllGlobals();
});

describe("ViewerAnalytics", () => {
  it("loads no client until Clerk and a signed-in viewer's preference have answered", async () => {
    const t = makeT();
    const as = await withUser(t, reader);
    expect(gate()).toBeNull();
    signIn(reader.subject);
    expect(gate()).toBeNull();

    await refreshViewer(as);
    expect(gate()).toEqual({ status: "identified", userId: reader.subject, username: "reader", role: null });
  });

  it("never loads the client for a viewer who opted out", async () => {
    const t = makeT();
    const as = await withUser(t, reader);
    await as.mutation(api.users.setAnalyticsOptOut, { optOut: true });
    signIn(reader.subject);
    await refreshViewer(as);
    expect(gate()).toBeNull();
  });

  it("captures signed-out visitors anonymously, and holds the loaded client while a sign-in's preference loads", async () => {
    signIn(null);
    expect(gate()).toEqual({ status: "anonymous" });
    // Signed in on the same page: the client stays, told to wait.
    signIn(reader.subject);
    expect(gate()).toEqual({ status: "pending" });
  });

  it("Do Not Track opts an account that never chose out once, and never opts one back in", async () => {
    const t = makeT();
    const as = await withUser(t, reader);
    harness.backend = as;
    vi.stubGlobal("navigator", { doNotTrack: "1" });
    signIn(reader.subject);
    await refreshViewer(as);
    const calls = countOptOutCalls();

    // Off from the first render, before the account has stored it.
    expect(gate()).toBeNull();
    expect(gate()).toBeNull();
    await settle();
    expect(calls).toHaveLength(1);
    expect(await storedOptOut(as)).toBe(true);

    // A choice already made is left alone, either way.
    await as.mutation(api.users.setAnalyticsOptOut, { optOut: false });
    resetHarness();
    harness.backend = as;
    const later = countOptOutCalls();
    await refreshViewer(as);
    expect(gate()).toMatchObject({ status: "identified" });
    await settle();
    expect(later).toHaveLength(0);
    expect(await storedOptOut(as)).toBe(false);

    // A browser without Do Not Track never clears an opt-out.
    await as.mutation(api.users.setAnalyticsOptOut, { optOut: true });
    vi.stubGlobal("navigator", { doNotTrack: "0", globalPrivacyControl: false });
    resetHarness();
    harness.backend = as;
    const clean = countOptOutCalls();
    await refreshViewer(as);
    expect(gate()).toBeNull();
    await settle();
    expect(clean).toHaveLength(0);
    expect(await storedOptOut(as)).toBe(true);
  });

  it("reads Global Privacy Control and window.doNotTrack as Do Not Track", async () => {
    const t = makeT();
    for (const [nav, win] of [
      [{ globalPrivacyControl: true }, {}],
      [{ msDoNotTrack: "1" }, {}],
      [{}, { doNotTrack: "yes" }],
    ] as const) {
      resetHarness();
      const as = await withUser(t, reader);
      await as.mutation(api.users.setAnalyticsOptOut, { optOut: false });
      await t.run(async (ctx) => {
        const user = await ctx.db.query("users").first();
        await ctx.db.patch(user!._id, { analyticsOptOut: undefined });
      });
      harness.backend = as;
      vi.stubGlobal("navigator", nav);
      vi.stubGlobal("window", win);
      signIn(reader.subject);
      await refreshViewer(as);
      expect(gate()).toBeNull();
      await settle();
      expect(await storedOptOut(as)).toBe(true);
    }
  });
});

describe("PostHogAnalytics", () => {
  it("sends nothing and identifies no one while consent is pending or off, leaving posthog-js's consent alone", () => {
    client({ status: "pending" });
    search();
    client({ status: "pending" });
    client({ status: "off" });
    search();
    expect(fakes.sent).toEqual([]);
    expect(fakes.calls).toEqual([]);
  });

  it("applies the consent of the moment it loads, before posthog-js's first pageview", () => {
    client(identified(reader.subject));
    expect(fakes.calls).toEqual([`identify ${reader.subject}`]);
    expect(fakes.sent).toEqual([
      { event: "$identify", id: reader.subject },
      { event: "$pageview", id: reader.subject },
    ]);
  });

  it("drops events once the viewer turns analytics off, and identifies again without $opt_in when they turn it on", () => {
    client(identified(reader.subject));
    client(identified(reader.subject));
    fakes.calls.length = 0;
    fakes.sent.length = 0;

    client({ status: "off" });
    search();
    expect(fakes.sent).toEqual([]);
    expect(fakes.calls).toEqual([]);

    client(identified(reader.subject));
    search();
    expect(fakes.calls).toEqual([`identify ${reader.subject}`]);
    expect(fakes.sent).toEqual([{ event: "search_performed", id: reader.subject }]);
  });

  it("forgets an identified user on sign-out before anything else is sent", () => {
    // posthog-js remembers an earlier session's identified user across reloads.
    Object.assign(fakes.state, { distinctId: "user_earlier", identified: true });
    client({ status: "anonymous" });
    expect(fakes.calls).toEqual(["reset"]);
    expect(fakes.sent).toEqual([{ event: "$pageview", id: "anon-2" }]);

    // Mid-session: a viewer turns analytics off, then signs out.
    fakes.calls.length = 0;
    fakes.sent.length = 0;
    client(identified(reader.subject));
    client({ status: "off" });
    client({ status: "anonymous" });
    search();
    expect(fakes.calls).toEqual([`identify ${reader.subject}`, "reset"]);
    expect(fakes.sent).toEqual([
      { event: "$identify", id: reader.subject },
      { event: "search_performed", id: "anon-3" },
    ]);
  });

  it("forgets another account before identifying, so no event goes out under the earlier id", () => {
    // A browser that remembers the first account, now signed in as a second.
    Object.assign(fakes.state, { distinctId: "user_first", identified: true });
    client(identified("user_second"));
    expect(fakes.calls).toEqual(["reset", "identify user_second"]);

    // Switching accounts on the page, with no signed-out render between.
    client({ status: "pending" });
    search();
    client(identified(reader.subject));
    search();
    expect(fakes.calls).toEqual(["reset", "identify user_second", "reset", `identify ${reader.subject}`]);
    expect(fakes.sent).toEqual([
      { event: "$identify", id: "user_second" },
      { event: "$pageview", id: "user_second" },
      { event: "$identify", id: reader.subject },
      { event: "search_performed", id: reader.subject },
    ]);
  });
});

describe("Signing in and out on one page", () => {
  const run = () => client(gate()!);

  it("sends nothing until a sign-in's preference is known, then identifies once", async () => {
    const t = makeT();
    const as = await withUser(t, reader);
    signIn(null);
    run();
    signIn(reader.subject);
    run();
    search();
    // Convex has not seen the new session yet: no viewer.
    setQuery(api.users.viewer, null);
    expect(gate()).toEqual({ status: "off" });
    run();
    search();

    await refreshViewer(as);
    run();
    run();
    expect(fakes.calls).toEqual([`identify ${reader.subject}`]);
    expect(fakes.sent).toEqual([
      { event: "$pageview", id: "anon-1" },
      { event: "$identify", id: reader.subject },
    ]);
  });

  it("captures signed-out visits again after an opted-out viewer signs out", async () => {
    const t = makeT();
    const as = await withUser(t, reader);
    await as.mutation(api.users.setAnalyticsOptOut, { optOut: true });
    signIn(null);
    run();
    signIn(reader.subject);
    await refreshViewer(as);
    expect(gate()).toEqual({ status: "off" });
    run();
    signIn(null);
    run();
    fakes.sent.length = 0;

    search();
    reload();
    run();
    expect(fakes.sent).toEqual([
      { event: "search_performed", id: "anon-1" },
      { event: "$pageview", id: "anon-1" },
    ]);
  });
});

describe("AnalyticsSettings", () => {
  it("switches the account, and the running client follows", async () => {
    const t = makeT();
    const as = await withUser(t, reader);
    harness.backend = as;
    signIn(reader.subject);
    await refreshViewer(as);
    const settingsSlots: unknown[] = [];
    const settings = () => mountAside(settingsSlots, () => AnalyticsSettings());
    const run = () => client(gate()!);
    run();
    run();
    fakes.calls.length = 0;
    fakes.sent.length = 0;

    choose(settings(), "Off");
    await settle();
    expect(await storedOptOut(as)).toBe(true);
    await refreshViewer(as);
    expect(gate()).toEqual({ status: "off" });
    run();
    search();
    expect(fakes.calls).toEqual([]);
    expect(fakes.sent).toEqual([]);

    choose(settings(), "On");
    await settle();
    expect(await storedOptOut(as)).toBe(false);
    await refreshViewer(as);
    run();
    search();
    expect(fakes.calls).toEqual([`identify ${reader.subject}`]);
    expect(fakes.sent).toEqual([{ event: "search_performed", id: reader.subject }]);
  });

  it("says when this browser sends Do Not Track", async () => {
    const t = makeT();
    const as = await withUser(t, reader);
    await refreshViewer(as);
    const panel = () => mount(() => AnalyticsSettings()).map((host) => text(host.props.children)).join(" ");
    expect(panel()).toContain("If a browser you sign in with sends Do Not Track");
    expect(panel()).not.toContain("This browser asks not to be tracked");
    vi.stubGlobal("navigator", { doNotTrack: "1" });
    expect(panel()).toContain("This browser asks not to be tracked");
  });
});
