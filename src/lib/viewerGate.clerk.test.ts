// @vitest-environment happy-dom
// useViewerQuery (lib/viewer.ts) on real Clerk hooks and the real Convex
// client, wired as providers.tsx wires them; only Clerk's resources and the
// socket are faked. An account switch shows loading, never the previous
// account, while the new token is pending; the server render and hydration
// agree on loading and the query goes out behind the token; without a
// ClerkProvider the visitor is anonymous, in StrictMode too; a token fetch
// that fails sends the query anonymously and reads as signed out; a
// sign-out hides the viewer at once. (From the review of the Clerk gate.)
import { act, createElement, StrictMode, type ComponentProps, type ContextType } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ClerkInstanceContext, InitialStateProvider } from "@clerk/shared/react";
import { afterEach, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import { useConvexClerkAuth, useViewerQuery } from "./viewer";

class Socket {
  static sockets: Socket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<{
    type: string;
    tokenType?: string;
    modifications?: Array<{ type: string; udfPath?: string; queryId: number }>;
  }> = [];
  constructor() {
    Socket.sockets.push(this);
  }
  send(message: string) {
    this.sent.push(JSON.parse(message));
  }
  open() {
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  close() {
    this.onclose?.();
  }
}

/** Every state the probe rendered, in order. */
const rendered: string[] = [];

function Probe() {
  const viewer = useViewerQuery(api.users.viewer);
  rendered.push(viewer === undefined ? "loading" : viewer === null ? "signed out" : "signed in");
  return createElement(
    "p",
    {
      "data-viewer": viewer && !viewer.needsUsername ? viewer.username : undefined,
    },
    viewer === undefined ? "loading" : viewer === null ? "signed out" : "signed in",
  );
}

type InitialState = ComponentProps<typeof InitialStateProvider>["initialState"];
function sessionState(signedIn: boolean): InitialState {
  return {
    sessionId: signedIn ? "sess_1" : null,
    userId: signedIn ? "user_1" : null,
    sessionStatus: signedIn ? "active" : null,
    sessionClaims: signedIn
      ? {
          sub: "user_1",
          sid: "sess_1",
          __raw: "raw",
          iss: "https://offline.clerk.accounts.dev",
          nbf: 0,
          iat: 0,
          exp: 9999999999,
          v: 2,
        }
      : null,
    orgId: null,
    orgRole: null,
    orgSlug: null,
    orgPermissions: null,
    user: null,
    session: null,
    organization: null,
    actor: null,
    factorVerificationAge: null,
  } as unknown as InitialState;
}

function clerkResource(fetchToken: () => Promise<string | null>) {
  const listeners = new Set<() => void>();
  const clerk = {
    loaded: false,
    session: { getToken: fetchToken },
    __internal_lastEmittedResources: undefined as unknown,
    addListener(callback: () => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    on(_event: string, callback: (status: string) => void) {
      callback("ready");
    },
    off() {},
  };
  const context = { value: clerk } as unknown as NonNullable<
    ContextType<typeof ClerkInstanceContext>
  >;
  return {
    context,
    switchSession(fetchToken: () => Promise<string | null>) {
      clerk.loaded = true;
      clerk.session = { getToken: fetchToken };
      clerk.__internal_lastEmittedResources = {
        client: {},
        user: { id: "user_2", organizationMemberships: [] },
        organization: null,
        session: {
          id: "sess_2",
          status: "active",
          lastActiveToken: {
            jwt: { claims: { sub: "user_2", sid: "sess_2" } },
          },
        },
      };
      for (const listener of listeners) listener();
    },
    signOut() {
      clerk.loaded = true;
      clerk.__internal_lastEmittedResources = {
        client: {},
        user: null,
        session: null,
        organization: null,
      };
      for (const listener of listeners) listener();
    },
  };
}

let root: ReturnType<typeof createRoot> | undefined;
let client: ConvexReactClient | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  await client?.close();
  root = undefined;
  client = undefined;
  Socket.sockets = [];
  rendered.length = 0;
});

it("an account switch hides the previous viewer while the new token is pending", async () => {
  const s = setup(true, async () => "session-token");
  root = createRoot(s.container);
  await act(async () => root!.render(s.tree));
  const socket = Socket.sockets[0];
  if (!socket) throw new Error("No Convex socket opened");
  socket.open();
  await act(async () =>
    socket.receive({
      type: "Transition",
      startVersion: { querySet: 0, identity: 0, ts: "AAAAAAAAAAA=" },
      endVersion: { querySet: 1, identity: 1, ts: "AQAAAAAAAAA=" },
      modifications: [
        {
          type: "QueryUpdated",
          queryId: 0,
          value: { needsUsername: false, username: "reader" },
          logLines: [],
        },
      ],
    }),
  );
  expect(s.container.textContent).toBe("signed in");
  const pending = new Promise<string>(() => {});
  rendered.length = 0;
  await act(async () => s.clerk.switchSession(() => pending));
  // useAuth now names sess_2/user_2 and the socket waits for its JWT.
  expect(socket.sent.at(-1)?.tokenType).toBe("None");
  expect(s.container.querySelector("p")?.dataset.viewer).toBeUndefined();
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered.every((state) => state === "loading")).toBe(true);
});

function setup(signedIn: boolean, fetchToken: () => Promise<string | null>) {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  client = new ConvexReactClient("https://offline-test.convex.cloud", {
    webSocketConstructor: Socket as unknown as typeof WebSocket,
    unsavedChangesWarning: false,
    logger: false,
  });
  const clerk = clerkResource(fetchToken);
  const container = document.createElement("div");
  const tree = createElement(
    ClerkInstanceContext.Provider,
    { value: clerk.context },
    createElement(InitialStateProvider, {
      initialState: sessionState(signedIn),
      // biome-ignore lint/correctness/noChildrenProp: ConvexProviderWithClerk's and InitialStateProvider's props types require children, so createElement takes it here rather than as a third argument
      children: createElement(ConvexProviderWithClerk, {
        client,
        useAuth: useConvexClerkAuth,
        // biome-ignore lint/correctness/noChildrenProp: ConvexProviderWithClerk's and InitialStateProvider's props types require children, so createElement takes it here rather than as a third argument
        children: createElement(Probe),
      }),
    }),
  );
  return { container, tree, clerk };
}

it("SSR and hydration agree while a signed-in session waits for its token", async () => {
  let resolveToken!: (token: string) => void;
  const token = new Promise<string>((resolve) => {
    resolveToken = resolve;
  });
  const s = setup(true, () => token);
  s.container.innerHTML = renderToString(s.tree);
  expect(s.container.textContent).toBe("loading");
  const errors: unknown[] = [];
  await act(async () => {
    root = hydrateRoot(s.container, s.tree, {
      onRecoverableError: (error) => errors.push(error),
    });
  });
  expect(s.container.textContent).toBe("loading");
  const socket = Socket.sockets[0];
  if (!socket) throw new Error("No Convex socket opened");
  socket.open();
  expect(socket.sent).toEqual([]);
  await act(async () => resolveToken("pending-token"));
  expect(socket.sent.map((message) => message.type)).toEqual([
    "Connect",
    "Authenticate",
    "ModifyQuerySet",
  ]);
  expect(socket.sent[1]?.tokenType).toBe("User");
  expect(socket.sent[2]?.modifications).toEqual([
    expect.objectContaining({ type: "Add", udfPath: "users:viewer" }),
  ]);
  expect(errors).toEqual([]);
});

it("Clerk's hook without its provider survives StrictMode and subscribes to nothing", async () => {
  const s = setup(false, async () => null);
  const tree = createElement(
    StrictMode,
    null,
    createElement(ConvexProvider, { client: client! }, createElement(Probe)),
  );
  root = createRoot(s.container);
  await act(async () => root!.render(tree));
  expect(s.container.textContent).toBe("signed out");
  expect(Socket.sockets).toHaveLength(0);
});

it("a token fetch failure retries, reads as signed out, and sends the query anonymously", async () => {
  let fetches = 0;
  const s = setup(true, async () => {
    fetches++;
    throw new Error("token unavailable");
  });
  root = createRoot(s.container);
  await act(async () => root!.render(s.tree));
  expect(fetches).toBe(2);
  const socket = Socket.sockets[0];
  if (!socket) throw new Error("No Convex socket opened");
  socket.open();
  expect(socket.sent.map((message) => message.type)).toEqual(["Connect", "ModifyQuerySet"]);
  // Convex has given up on the token: signed out, before the anonymous
  // answer arrives (which agrees).
  expect(s.container.textContent).toBe("signed out");
  await act(async () =>
    socket.receive({
      type: "Transition",
      startVersion: { querySet: 0, identity: 0, ts: "AAAAAAAAAAA=" },
      endVersion: { querySet: 1, identity: 0, ts: "AQAAAAAAAAA=" },
      modifications: [{ type: "QueryUpdated", queryId: 0, value: null, logLines: [] }],
    }),
  );
  expect(s.container.textContent).toBe("signed out");
});

it("a sign-out hides the subscribed viewer at once", async () => {
  const s = setup(true, async () => "session-token");
  root = createRoot(s.container);
  await act(async () => root!.render(s.tree));
  const socket = Socket.sockets[0];
  if (!socket) throw new Error("No Convex socket opened");
  socket.open();
  await act(async () =>
    socket.receive({
      type: "Transition",
      startVersion: { querySet: 0, identity: 0, ts: "AAAAAAAAAAA=" },
      endVersion: { querySet: 1, identity: 1, ts: "AQAAAAAAAAA=" },
      modifications: [
        {
          type: "QueryUpdated",
          queryId: 0,
          value: { needsUsername: false, username: "reader" },
          logLines: [],
        },
      ],
    }),
  );
  expect(s.container.textContent).toBe("signed in");
  await act(async () => s.clerk.signOut());
  expect(s.container.textContent).toBe("signed out");
  expect(socket.sent.slice(-2).map((message) => message.type)).toEqual([
    "Authenticate",
    "ModifyQuerySet",
  ]);
  expect(socket.sent.at(-2)?.tokenType).toBe("None");
  expect(socket.sent.at(-1)?.modifications).toEqual([{ type: "Remove", queryId: 0 }]);
});
