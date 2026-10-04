// The signed-in viewer as components read it (convex/users.ts `viewer`), and
// the gate every viewer-only query subscribes through (useViewerQuery).

import { useAuth } from "@clerk/tanstack-react-start";
import { useConvexAuth, useQuery, type OptionalRestArgsOrSkip } from "convex/react";
import type { FunctionReference, FunctionReturnType, OptionalRestArgs } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";

/** users.viewer for a signed-in viewer whose username claim is complete. */
export type ReadyViewer = Extract<
  NonNullable<FunctionReturnType<typeof api.users.viewer>>,
  { needsUsername: false }
>;

/**
 * Clerk's useAuth as providers.tsx hands it to ConvexProviderWithClerk.
 * That provider's auth state (useConvexAuth) goes back to loading only
 * while Clerk loads: after a sign-in on the page it keeps the signed-out
 * "not authenticated" until Convex rules on the new token (and, should
 * Convex refuse it, never re-renders), and after an account switch it
 * keeps the old account's "authenticated" for a render. So in the render
 * where Clerk's session changes this reports Clerk as loading, which sends
 * that state back to loading before anything below reads it. The state
 * update made here has React redo the render at once, so the loading is
 * never committed and the token handover is unchanged.
 */
export function useConvexClerkAuth() {
  const auth = useAuth();
  const [sessionId, setSessionId] = useState(auth.sessionId);
  if (sessionId === auth.sessionId) return auth;
  setSessionId(auth.sessionId);
  return { ...auth, isLoaded: false };
}

/**
 * Where the visitor stands for viewer-only queries: whether to subscribe
 * (Clerk has a session) and what to answer meanwhile, "loading" until
 * Convex has ruled on that session's token, "signedOut" without a session
 * or once Convex refuses the token, "viewer" once it accepts it.
 *
 * providers.tsx mounts no ClerkProvider (nor ConvexProviderWithClerk) when
 * Clerk is not configured, and Clerk's useAuth throws without one (from its
 * first hook, so every render calls the same hooks). Nobody can sign in
 * then: the visitor is anonymous.
 */
function useSession(): { isSignedIn: boolean; status: "loading" | "signedOut" | "viewer" } {
  let clerk: ReturnType<typeof useAuth>;
  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: Clerk's presence is fixed at build time and useAuth throws from its first hook without it, so every render calls the same hooks
    clerk = useAuth();
  } catch {
    return { isSignedIn: false, status: "signedOut" };
  }
  // biome-ignore lint/correctness/useHookAtTopLevel: reached on every render when Clerk is configured and on none when it is not (above)
  const convex = useConvexAuth();
  if (!clerk.isLoaded) return { isSignedIn: false, status: "loading" };
  if (!clerk.isSignedIn) return { isSignedIn: false, status: "signedOut" };
  if (convex.isLoading) return { isSignedIn: true, status: "loading" };
  return { isSignedIn: true, status: convex.isAuthenticated ? "viewer" : "signedOut" };
}

/**
 * useQuery for a query that answers only a signed-in viewer (null signed
 * out), gated on Clerk's session, which the server-rendered auth state
 * settles before the first render. An anonymous visitor gets null at once
 * and never subscribes; while Clerk is still loading the answer is
 * undefined (loading), so no signed-out UI flashes by. A signed-in visitor
 * subscribes at once: the subscription waits in the Convex client for the
 * token ConvexProviderWithClerk is fetching (it pauses the socket before
 * any query below it subscribes) and goes out right behind it. Its answer
 * is held back as undefined until Convex accepts this session's token
 * (useConvexClerkAuth), so neither an anonymous answer cached before a
 * sign-in nor the previous account's after a switch is ever shown. Should
 * Convex refuse the token, or Clerk fail to give one, the answer is null,
 * as for anyone signed out.
 */
export function useViewerQuery<Query extends FunctionReference<"query">>(
  query: Query,
  ...args: OptionalRestArgs<Query>
): FunctionReturnType<Query> | null | undefined {
  const { isSignedIn, status } = useSession();
  // Both shapes of useQuery's argument tuple take "skip"; TypeScript cannot
  // pick the shape through the generic, so the tuple is named outright.
  const skip = ["skip"] as OptionalRestArgsOrSkip<Query>;
  const result = useQuery(query, ...(isSignedIn ? args : skip));
  if (status === "viewer") return result;
  return status === "loading" ? undefined : null;
}

/**
 * The signed-in viewer with a claimed username; null while loading, signed
 * out, or username pending. Components that tell those states apart read
 * useViewerQuery(api.users.viewer) directly.
 */
export function useReadyViewer(): ReadyViewer | null {
  const viewer = useViewerQuery(api.users.viewer);
  return viewer && !viewer.needsUsername ? viewer : null;
}

/** True when the viewer holds the Moderator or Administrator role. */
export function useIsModerator(): boolean {
  const role = useReadyViewer()?.role;
  return role === "moderator" || role === "administrator";
}

/** True when the viewer holds any data-team role (Editor and up). */
export function useIsDataTeam(): boolean {
  const role = useReadyViewer()?.role;
  return role === "editor" || role === "moderator" || role === "administrator";
}
