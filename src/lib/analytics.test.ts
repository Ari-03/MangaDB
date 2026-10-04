// The analytics consent gate (lib/analytics.tsx) and the Settings opt-out,
// driven as plain functions (test.react.ts) against convex-test, with a
// fake Clerk useAuth. The gate's answer is the consent it hands the PostHog
// client; what the client does with each consent is pinned against the
// real posthog-js in analyticsClient.test.ts.

import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../convex/_generated/api";
import { makeT, reader, withUser, type Accessor } from "../../convex/test.helpers";
import { harness, mount, mountAside, resetHarness, setQuery, settle, text, type Host } from "./test.react";

const auth = vi.hoisted(() => ({
  isLoaded: false,
  isSignedIn: undefined as boolean | undefined,
  userId: null as string | null,
}));

vi.mock("convex/react", async () => (await import("./test.react")).backendHooks);
vi.mock("@clerk/tanstack-react-start", () => ({ useAuth: () => auth }));

const { AnalyticsSettings, ViewerAnalytics } = await import("./analytics");
type AnalyticsConsent = import("./analytics").AnalyticsConsent;

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

function signIn(userId: string | null) {
  auth.isLoaded = true;
  auth.isSignedIn = userId !== null;
  auth.userId = userId;
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
  auth.isLoaded = false;
  auth.isSignedIn = undefined;
  auth.userId = null;
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

describe("Signing in and out on one page", () => {
  it("holds the client until a sign-in's preference is known, then identifies", async () => {
    const t = makeT();
    const as = await withUser(t, reader);
    signIn(null);
    expect(gate()).toEqual({ status: "anonymous" });
    signIn(reader.subject);
    expect(gate()).toEqual({ status: "pending" });
    // Convex has not seen the new session yet: no viewer.
    setQuery(api.users.viewer, null);
    expect(gate()).toEqual({ status: "pending" });
    await refreshViewer(as);
    expect(gate()).toEqual({ status: "identified", userId: reader.subject, username: "reader", role: null });
  });

  it("keeps the client for an opted-out viewer's sign-out, which captures anonymously again", async () => {
    const t = makeT();
    const as = await withUser(t, reader);
    await as.mutation(api.users.setAnalyticsOptOut, { optOut: true });
    signIn(null);
    expect(gate()).toEqual({ status: "anonymous" });
    signIn(reader.subject);
    await refreshViewer(as);
    // The client already loaded on this page stays, told it is off.
    expect(gate()).toEqual({ status: "off" });
    signIn(null);
    expect(gate()).toEqual({ status: "anonymous" });
  });
});

describe("AnalyticsSettings", () => {
  it("switches the account, and the gate follows", async () => {
    const t = makeT();
    const as = await withUser(t, reader);
    harness.backend = as;
    signIn(reader.subject);
    await refreshViewer(as);
    const settingsSlots: unknown[] = [];
    const settings = () => mountAside(settingsSlots, () => AnalyticsSettings());
    expect(gate()).toMatchObject({ status: "identified" });

    choose(settings(), "Off");
    await settle();
    expect(await storedOptOut(as)).toBe(true);
    await refreshViewer(as);
    // The client already loaded on this page stays, told it is off.
    expect(gate()).toEqual({ status: "off" });

    choose(settings(), "On");
    await settle();
    expect(await storedOptOut(as)).toBe(false);
    await refreshViewer(as);
    expect(gate()).toEqual({ status: "identified", userId: reader.subject, username: "reader", role: null });
  });

  it("says that PostHog receives the IP address and that earlier events may still be delivered", async () => {
    const t = makeT();
    signIn(reader.subject);
    const as = await withUser(t, reader);
    await refreshViewer(as);
    const panel = mount(() => AnalyticsSettings()).map((host) => text(host.props.children)).join(" ");
    expect(panel).toContain("PostHog also receives your IP address and browser details.");
    expect(panel).toContain("may still be delivered later, including after a lost connection is restored");
    expect(panel).not.toContain("few seconds");
  });

  it("says when this browser sends Do Not Track", async () => {
    const t = makeT();
    signIn(reader.subject);
    const as = await withUser(t, reader);
    await refreshViewer(as);
    const panel = () => mount(() => AnalyticsSettings()).map((host) => text(host.props.children)).join(" ");
    expect(panel()).toContain("If a browser you sign in with sends Do Not Track");
    expect(panel()).not.toContain("This browser asks not to be tracked");
    vi.stubGlobal("navigator", { doNotTrack: "1" });
    expect(panel()).toContain("This browser asks not to be tracked");
  });
});
