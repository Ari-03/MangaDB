import { createFileRoute, notFound, Outlet, rootRouteId } from "@tanstack/react-router";

/**
 * The /mod/* layout: data-team tools are never indexed. Each page keeps its
 * own access gate (lib/moderation.tsx ModGate), since the pages differ in
 * the role they need and in what a refused visitor reads. A URL with no
 * mod page under it (the bare /mod, or a mistyped /mod/…) is handed to the
 * root's 404, exactly as before this layout existed.
 */
export const Route = createFileRoute("/mod")({
  beforeLoad: ({ matches }) => {
    if (matches.at(-1)?.routeId === "/mod") throw notFound({ routeId: rootRouteId });
  },
  head: () => ({
    meta: [{ name: "robots", content: "noindex" }],
  }),
  component: Outlet,
});
