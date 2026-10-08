// @vitest-environment happy-dom
// useViewerQuery (lib/viewer.ts) on the real React and the real Convex
// client, wired as providers.tsx wires them, with a controlled socket and a
// fake Clerk session whose token fetch a test holds or fails: what goes out
// on the wire, in order, and what a viewer-only control shows meanwhile. A
// slow token holds the query behind Authenticate; a sign-in on the page
// shows loading, never the anonymous answer the client already holds; a
// token Clerk cannot give reads as signed out, on a cold load and after a
// sign-in on the page alike. (From the review of the Clerk gate.)

import { act, createElement, Fragment, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient, useQuery } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { api } from "../../convex/_generated/api";

const clerk = vi.hoisted(() => ({
  isSignedIn: false,
  token: (): Promise<string | null> => Promise.resolve(null),
}));
function useAuth() {
  return {
    isLoaded: true,
    isSignedIn: clerk.isSignedIn,
    getToken: () => clerk.token(),
    orgId: undefined,
    orgRole: undefined,
    sessionId: clerk.isSignedIn ? "session" : undefined,
    sessionClaims: undefined,
  };
}
vi.mock("@clerk/tanstack-react-start", () => ({ useAuth }));
const { useConvexClerkAuth, useViewerQuery } = await import("./viewer");

type Message = {
  type: string;
  tokenType?: string;
  newVersion?: number;
  modifications?: Array<{ type: string; queryId: number; udfPath?: string }>;
};

/** The client's WebSocket: opens at once, keeps what is sent, answers on request. */
class Wire {
  static latest: Wire;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  messages: Message[] = [];
  constructor() {
    Wire.latest = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.messages.push(JSON.parse(data) as Message);
  }
  close() {
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: "test done" }));
  }
  /** The server's anonymous answer to the users:viewer subscription: null. */
  answerViewerNull() {
    const update = this.messages.find(
      (message) =>
        message.type === "ModifyQuerySet" &&
        message.modifications?.some((change) => change.udfPath === "users:viewer"),
    );
    const queryId = update?.modifications?.find(
      (change) => change.udfPath === "users:viewer",
    )?.queryId;
    if (queryId === undefined) throw new Error("no users:viewer subscription");
    this.onmessage?.({
      data: JSON.stringify({
        type: "Transition",
        startVersion: { querySet: 0, identity: 0, ts: "AAAAAAAAAAA=" },
        endVersion: { querySet: update?.newVersion, identity: 0, ts: "AQAAAAAAAAA=" },
        modifications: [{ type: "QueryUpdated", queryId, value: null, logLines: [] }],
      }),
    });
  }
}

let client: ConvexReactClient;
let root: ReturnType<typeof createRoot>;
let container: HTMLElement;
/** Every state the probe rendered, in order. */
const states: string[] = [];

function Probe() {
  const viewer = useViewerQuery(api.users.viewer);
  const state = viewer === undefined ? "loading" : viewer === null ? "signed out" : "signed in";
  states.push(state);
  return createElement("p", { "data-probe": true }, state);
}

/** A control that, once opened, reads users.viewer with a plain useQuery, signed in or not. */
function ViewerReader() {
  const [open, setOpen] = useState(false);
  return open
    ? createElement(ViewerRead)
    : createElement("button", { type: "button", onClick: () => setOpen(true) }, "Open");
}
function ViewerRead() {
  useQuery(api.users.viewer, {});
  return null;
}

/**
 * Render the probe under the providers.tsx wiring, beside a ViewerReader
 * when `anonymousReader` (it reads users.viewer whether signed in or not,
 * so the client holds an anonymous answer before a sign-in).
 */
async function render(anonymousReader = false) {
  await act(async () => {
    root.render(
      createElement(ConvexProviderWithClerk, {
        client,
        useAuth: useConvexClerkAuth,
        // biome-ignore lint/correctness/noChildrenProp: ConvexProviderWithClerk's and InitialStateProvider's props types require children, so createElement takes it here rather than as a third argument
        children: createElement(
          Fragment,
          null,
          anonymousReader ? createElement(ViewerReader) : null,
          createElement(Probe),
        ),
      }),
    );
  });
}

const shown = () => container.querySelector("[data-probe]")?.textContent;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  clerk.isSignedIn = false;
  clerk.token = () => Promise.resolve(null);
  states.length = 0;
  client = new ConvexReactClient("https://example.convex.cloud", {
    webSocketConstructor: Wire as unknown as typeof WebSocket,
    unsavedChangesWarning: false,
    logger: false,
  });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await client.close();
});

/** Sign in on the page after a ViewerReader read users.viewer anonymously. */
async function signInAfterAnonymousAnswer(token: () => Promise<string | null>) {
  await render(true);
  await act(async () => container.querySelector("button")!.click());
  await act(async () => Wire.latest.answerViewerNull());
  expect(shown()).toBe("signed out");
  clerk.isSignedIn = true;
  clerk.token = token;
  states.length = 0;
  await render(true);
}

it("a slow token holds the private query until Authenticate", async () => {
  clerk.isSignedIn = true;
  let resolveToken!: (token: string) => void;
  clerk.token = () => new Promise<string>((resolve) => (resolveToken = resolve));
  await render();
  expect(shown()).toBe("loading");
  expect(Wire.latest.messages).toEqual([]);
  await act(async () => resolveToken("test-token"));
  expect(Wire.latest.messages.map((message) => message.type)).toEqual([
    "Connect",
    "Authenticate",
    "ModifyQuerySet",
  ]);
});

it("a sign-in on the page shows loading, not the anonymous answer, while the token loads", async () => {
  await signInAfterAnonymousAnswer(() => new Promise<string>(() => {}));
  expect(states.length).toBeGreaterThan(0);
  expect(states.every((state) => state === "loading")).toBe(true);
});

it("a sign-in on the page whose token Clerk cannot give settles as signed out", async () => {
  await signInAfterAnonymousAnswer(async () => {
    throw new Error("Clerk request failed");
  });
  expect(states[0]).toBe("loading");
  expect(shown()).toBe("signed out");
});

it("a failed token fetch on load sends the query anonymously and reads as signed out", async () => {
  clerk.isSignedIn = true;
  clerk.token = async () => {
    throw new Error("Clerk request failed");
  };
  await render();
  const messages = Wire.latest.messages;
  expect(messages.some((message) => message.type === "Authenticate")).toBe(false);
  expect(messages.some((message) => message.type === "ModifyQuerySet")).toBe(true);
  await act(async () => Wire.latest.answerViewerNull());
  expect(shown()).toBe("signed out");
});
