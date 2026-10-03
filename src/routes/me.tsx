import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { api } from "../../convex/_generated/api";
import type { ReadyViewer } from "~/lib/viewer";
import { clerkConfigured, ssrAuth } from "~/server/auth";
import { convexServerClient } from "~/server/convex";

export type ViewerState =
  | { status: "unconfigured" }
  | { status: "signedOut" }
  | { status: "deleting" }
  | { status: "needsUsername" }
  | { status: "ready"; viewer: ReadyViewer };

// The SSR-token flow from spec §9: Clerk session → "convex"-template JWT →
// ConvexHttpClient.setAuth → users.viewer authorizes via
// ctx.auth.getUserIdentity(). Runs on the server for SSR and as an RPC on
// client navigations, so the gate holds both ways.
const fetchViewerState = createServerFn({ method: "GET" }).handler(
  async (): Promise<ViewerState> => {
    if (!clerkConfigured()) return { status: "unconfigured" };
    const { userId, convexToken } = await ssrAuth();
    if (!userId || !convexToken) return { status: "signedOut" };
    const convex = convexServerClient(convexToken);
    if (!convex) return { status: "unconfigured" };
    const viewer = await convex.query(api.users.viewer, {});
    if (!viewer) {
      // users.viewer reads an account being deleted as signed out; this
      // session is still signed in to Clerk, so /sign-in would send it back.
      const deleting = await convex.query(api.users.deletionPending, {});
      return { status: deleting ? "deleting" : "signedOut" };
    }
    if (viewer.needsUsername) return { status: "needsUsername" };
    return { status: "ready", viewer };
  },
);

/**
 * Gated /me shell: the catalog stays fully public; everything
 * under /me requires a signed-in viewer whose username claim is complete.
 * First sign-in is bounced to /claim-username before anything personal renders.
 * A session whose account is being deleted stays, so the page can say so
 * and sign it out. The tracking slices mount their pages under this layout.
 */
export const Route = createFileRoute("/me")({
  beforeLoad: async () => {
    const viewerState = await fetchViewerState();
    if (viewerState.status === "signedOut") {
      throw redirect({ href: "/sign-in" });
    }
    if (viewerState.status === "needsUsername") {
      throw redirect({ to: "/claim-username" });
    }
    return { viewerState };
  },
  head: () => ({
    meta: [
      { title: "My library — MangaDB" },
      // Personal pages are never indexed (spec §11).
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Outlet,
});
