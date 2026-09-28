/// <reference types="vite/client" />
import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AppProviders, BrandMark, SiteHeader } from "~/providers";
import stylesUrl from "../styles.css?url";

// Dark is the default shelf: <html> ships with data-theme="dark" and the OS
// preference is deliberately ignored. A saved choice wins, applied before
// first paint so there is no flash; ?theme= is an escape hatch for previews.
const THEME_BOOT = `(function(){var p=null;try{p=localStorage.getItem("mangadb-theme")}catch(e){}var q=/[?&]theme=(light|dark)/.exec(location.search);if(q){p=q[1]}if(p==="light"||p==="dark"){document.documentElement.dataset.theme=p}})();`;

const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,400..800,0..100,0..1&family=Nunito+Sans:opsz,wght@6..12,300..900&display=swap";

// No root beforeLoad: it would run on every navigation and preload, holding
// up each one behind a server round trip. Gated routes (/me, /claim-username)
// check auth in their own beforeLoad.
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "dark light" },
      { name: "theme-color", content: "#15110c" },
      { title: "MangaDB" },
      {
        name: "description",
        content:
          "Track English manga volume releases: what volumes exist, when each edition comes out, and which ones you own, want, or have read.",
      },
    ],
    links: [
      // The header's brand mark (public/): SVG for browsers that take it, the
      // ICO for the rest, a full-bleed PNG for iOS home screens.
      { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: FONTS_URL },
      { rel: "stylesheet", href: stylesUrl },
    ],
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
      <div className="container footer-inner">
        <div>
          <Link to="/" className="brand">
            <BrandMark />
            MangaDB
          </Link>
          <p className="footer-blurb">
            An open database of English manga volume releases. Every edition,
            every release date, and the shelf you keep at home.
          </p>
        </div>
        <div className="footer-cols">
          <div className="footer-col">
            <h4>Browse</h4>
            <Link to="/series">Series</Link>
            <Link to="/releases">Release calendar</Link>
            <Link to="/authors">Authors</Link>
            <Link to="/publishers">Publishers</Link>
            <Link to="/search" search={{ q: "" }}>Search</Link>
          </div>
          <div className="footer-col">
            <h4>The data</h4>
            <Link to="/about-the-data">About the data</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the boot script may flip data-theme to
    // "light" before React hydrates, which is intended.
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
