import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { api } from "../../convex/_generated/api";
import { clerkConfigured, ssrAuth } from "~/server/auth";
import { convexServerClient } from "~/server/convex";

export type ReadyViewer = {
  username: string;
  formatPreference: "physical" | "digital" | "both";
  ownershipVisibility: "public" | "private";
  readingVisibility: "public" | "private";
  suspended: boolean;
};

export type ViewerState =
  | { status: "unconfigured" }
  | { status: "signedOut" }
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
    if (!viewer) return { status: "signedOut" };
    if (viewer.needsUsername) return { status: "needsUsername" };
    return { status: "ready", viewer };
  },
);

/**
 * Gated /me shell (ticket #26): the catalog stays fully public; everything
 * under /me requires a signed-in viewer whose username claim is complete.
 * First sign-in is bounced to /claim-username before anything personal renders.
 * The tracking slices (#7) mount their pages under this layout.
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
