// @vitest-environment happy-dom
// useViewerQuery (lib/viewer.ts) under the real providers.tsx wiring: the
// real React, ConvexProviderWithClerk reading useConvexClerkAuth, and
// useQuery, with a fake Clerk session and a fake Convex client that logs
// what it is asked, in order. Through each session state: an anonymous
// visitor and one whose Clerk session is loading subscribe to nothing; a
// signed-in visitor subscribes in the same commit that hands the client its
// token (after setAuth, which pauses the socket, so the query goes out
// behind the token, not a round trip after the token is confirmed) and is
// shown its answer once Convex accepts the token, never an answer cached
// before (anonymous, or another account's); a token Convex refuses reads
// as signed out, after a sign-in on the page too; a sign-out reads as
// signed out at once and drops the subscription; without Clerk the visitor
// is anonymous. viewerGate.wire.test.ts and viewerGate.clerk.test.ts run
// the real Convex client, and real Clerk hooks, the same way.

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { api } from "../../convex/_generated/api";

type Session = { isLoaded: boolean; isSignedIn: boolean | undefined; sessionId?: string };

// The Clerk session both the provider and lib/viewer.ts read; null is Clerk
// off, where Clerk's useAuth throws for want of a ClerkProvider.
const clerk = vi.hoisted(() => ({ session: null as Session | null }));
function useAuth() {
  if (!clerk.session) throw new Error("useAuth can only be used within the <ClerkProvider /> component.");
  return {
    ...clerk.session,
    getToken: async () => (clerk.session?.isSignedIn ? "token" : null),
    orgId: undefined,
    orgRole: undefined,
    sessionId: clerk.session.isSignedIn ? (clerk.session.sessionId ?? "sess_1") : undefined,
    sessionClaims: undefined,
  };
}
vi.mock("@clerk/tanstack-react-start", () => ({ useAuth }));

const { useConvexClerkAuth, useViewerQuery } = await import("./viewer");

/**
 * The Convex client surface the providers and useQuery touch. `log` holds
 * setAuth, clearAuth, and each subscribe and unsubscribe by query name;
 * `answer` delivers a server result; `confirm` is the server's verdict on
 * the token.
 */
function fakeClient() {
  const log: string[] = [];
  const results = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  let onAuthChange: (authenticated: boolean) => void = () => {
    throw new Error("no token handed over");
  };
  const client = {
    setAuth(_fetchToken: unknown, onChange: (authenticated: boolean) => void) {
      log.push("setAuth");
      onAuthChange = onChange;
    },
    clearAuth() {
      log.push("clearAuth");
    },
    watchQuery(query: FunctionReference<"query">) {
      const name = getFunctionName(query);
      return {
        localQueryResult: () => results.get(name),
        onUpdate(callback: () => void) {
          log.push(`subscribe ${name}`);
          const set = listeners.get(name) ?? new Set();
          set.add(callback);
          listeners.set(name, set);
          return () => {
            log.push(`unsubscribe ${name}`);
            set.delete(callback);
          };
        },
      };
    },
  };
  return {
    // Only the methods above are reached; the rest of the class is not.
    client: client as unknown as ConvexReactClient,
    log,
    answer(query: FunctionReference<"query">, value: unknown) {
      const name = getFunctionName(query);
      results.set(name, value);
      for (const listener of listeners.get(name) ?? []) listener();
    },
    confirm: (authenticated: boolean) => onAuthChange(authenticated),
  };
}

/** Every state the probe rendered, committed or not, in order. */
const rendered: string[] = [];

/** What a viewer-only control would show: its users.viewer answer, named. */
function Probe() {
  const viewer = useViewerQuery(api.users.viewer);
  const name = viewer && !viewer.needsUsername ? ` as ${viewer.username}` : "";
  const shown = viewer === undefined ? "loading" : viewer === null ? "signed out" : `signed in${name}`;
  rendered.push(shown);
  return createElement("p", null, shown);
}

let root: ReturnType<typeof createRoot>;
let container: HTMLElement;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  rendered.length = 0;
});
afterEach(async () => {
  await act(async () => root.unmount());
  clerk.session = null;
});

/** Render the probe as providers.tsx wires it with Clerk on. */
async function render(fake: ReturnType<typeof fakeClient>) {
  await act(async () =>
    root.render(
      createElement(ConvexProviderWithClerk, { client: fake.client, useAuth: useConvexClerkAuth, children: createElement(Probe) }),
    ),
  );
}

const VIEWER = { needsUsername: false, username: "reader" };

it("an anonymous visitor reads as signed out and subscribes to nothing", async () => {
  const fake = fakeClient();
  clerk.session = { isLoaded: true, isSignedIn: false };
  await render(fake);
  expect(container.textContent).toBe("signed out");
  expect(fake.log).toEqual([]);
});

it("while Clerk loads, nothing is shown as signed out and nothing subscribes", async () => {
  const fake = fakeClient();
  clerk.session = { isLoaded: false, isSignedIn: undefined };
  await render(fake);
  expect(container.textContent).toBe("loading");
  expect(fake.log).toEqual([]);
});

it("a signed-in visitor subscribes behind the token, before Convex confirms it", async () => {
  const fake = fakeClient();
  clerk.session = { isLoaded: true, isSignedIn: true };
  await render(fake);
  // One commit: the token is handed over (the socket paused), then the
  // query subscribes, so it is sent right behind the token.
  expect(fake.log).toEqual(["setAuth", "subscribe users:viewer"]);
  expect(container.textContent).toBe("loading");
  await act(async () => {
    fake.confirm(true);
    fake.answer(api.users.viewer, VIEWER);
  });
  expect(container.textContent).toBe("signed in as reader");
  // The confirmation changes nothing about the subscription.
  expect(fake.log).toEqual(["setAuth", "subscribe users:viewer"]);
});

it("a token Convex refuses reads as signed out", async () => {
  const fake = fakeClient();
  clerk.session = { isLoaded: true, isSignedIn: true };
  await render(fake);
  // Refused, the client runs its queries without identity: null.
  await act(async () => {
    fake.confirm(false);
    fake.answer(api.users.viewer, null);
  });
  expect(container.textContent).toBe("signed out");
});

it("a sign-out reads as signed out at once and drops the subscription", async () => {
  const fake = fakeClient();
  clerk.session = { isLoaded: true, isSignedIn: true };
  await render(fake);
  await act(async () => {
    fake.confirm(true);
    fake.answer(api.users.viewer, VIEWER);
  });
  clerk.session = { isLoaded: true, isSignedIn: false };
  await render(fake);
  expect(container.textContent).toBe("signed out");
  // Both in the sign-out's commit: the provider clears the token, then the
  // skipped query is removed. Nothing reads whatever it answers between.
  expect(fake.log.slice(2)).toEqual(["clearAuth", "unsubscribe users:viewer"]);
});

it("a sign-in on the page subscribes in the commit that hands over the token", async () => {
  const fake = fakeClient();
  clerk.session = { isLoaded: true, isSignedIn: false };
  await render(fake);
  // Another control read users.viewer anonymously before the sign-in: the
  // client holds that null until Convex reruns it with the token.
  fake.answer(api.users.viewer, null);
  rendered.length = 0;
  clerk.session = { isLoaded: true, isSignedIn: true };
  await render(fake);
  expect(rendered.every((shown) => shown === "loading")).toBe(true);
  expect(fake.log).toEqual(["setAuth", "subscribe users:viewer"]);
  await act(async () => {
    fake.confirm(true);
    fake.answer(api.users.viewer, VIEWER);
  });
  expect(container.textContent).toBe("signed in as reader");
});

it("a sign-in on the page whose token Convex refuses reads as signed out", async () => {
  const fake = fakeClient();
  clerk.session = { isLoaded: true, isSignedIn: false };
  await render(fake);
  rendered.length = 0;
  clerk.session = { isLoaded: true, isSignedIn: true };
  await render(fake);
  expect(rendered.every((shown) => shown === "loading")).toBe(true);
  // Refused (or no token from Clerk): Convex reports false, as it already
  // did signed out, and the gate must still settle.
  await act(async () => fake.confirm(false));
  expect(container.textContent).toBe("signed out");
});

it("an account switch shows nothing of the previous account while the new token is pending", async () => {
  const fake = fakeClient();
  clerk.session = { isLoaded: true, isSignedIn: true, sessionId: "sess_1" };
  await render(fake);
  await act(async () => {
    fake.confirm(true);
    fake.answer(api.users.viewer, VIEWER);
  });
  expect(container.textContent).toBe("signed in as reader");
  rendered.length = 0;
  clerk.session = { isLoaded: true, isSignedIn: true, sessionId: "sess_2" };
  await render(fake);
  // The client still holds reader's answer, never rendered again; the new
  // token is handed over and the subscription stays.
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered.every((shown) => shown === "loading")).toBe(true);
  expect(fake.log).toEqual(["setAuth", "subscribe users:viewer", "clearAuth", "setAuth"]);
  await act(async () => {
    fake.confirm(true);
    fake.answer(api.users.viewer, { needsUsername: false, username: "other" });
  });
  expect(container.textContent).toBe("signed in as other");
});

it("without Clerk (a plain ConvexProvider) the visitor reads as signed out", async () => {
  const fake = fakeClient();
  clerk.session = null;
  await act(async () => root.render(createElement(ConvexProvider, { client: fake.client }, createElement(Probe))));
  expect(container.textContent).toBe("signed out");
  expect(fake.log).toEqual([]);
});
