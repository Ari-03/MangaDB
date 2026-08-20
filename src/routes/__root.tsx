/// <reference types="vite/client" />
import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";

import { AppProviders, SiteHeader } from "~/providers";
import { ssrAuth } from "~/server/auth";
import stylesUrl from "../styles.css?url";

// Runs on the server for SSR and on every client navigation (server-fn RPC),
// so gated routes see fresh auth state both ways (spec §9).
const fetchSsrAuth = createServerFn({ method: "GET" }).handler(async () => {
  return await ssrAuth();
});

export const Route = createRootRoute({
  // Merged into router context: `userId` (Clerk subject, null signed out) and
  // `convexToken` for authed SSR reads via convexServerClient(token).
  beforeLoad: async () => await fetchSsrAuth(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "MangaDB" },
      {
        name: "description",
        content:
          "Track English manga volume releases: what volumes exist, when each edition comes out, and which ones you own, want, or have read.",
      },
    ],
    links: [{ rel: "stylesheet", href: stylesUrl }],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
});

function RootComponent() {
  return (
    <AppProviders>
      <SiteHeader />
      <Outlet />
      <SiteFooter />
    </AppProviders>
  );
}

// Site-wide footer: the source-attribution / "about the data" page (spec §7,
// §11) must be reachable from everywhere the data is shown.
function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link to="/about-the-data">About the data</Link>
      <span aria-hidden="true">·</span>
      <Link to="/releases">Release calendar</Link>
    </footer>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
