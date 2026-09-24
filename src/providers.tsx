import { ClerkProvider, UserButton, useAuth } from "@clerk/tanstack-react-start";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ConvexProvider, ConvexReactClient, useQuery } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useState, type ReactNode } from "react";

import { api } from "../convex/_generated/api";

// Client-side wiring (spec §9): <ClerkProvider> owns the session,
// ConvexProviderWithClerk feeds its "convex"-template JWT to the reactive
// Convex client so every mutation/query authorizes via
// ctx.auth.getUserIdentity(). Both are optional at runtime: without the
// publishable key or a Convex URL the public catalog still renders.

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
export const convexClient: ConvexReactClient | null = convexUrl
  ? new ConvexReactClient(convexUrl)
  : null;

// ClerkProvider resolves the key from VITE_CLERK_PUBLISHABLE_KEY itself; this
// flag only decides whether the Clerk tree is mounted at all.
export const clerkEnabled = Boolean(
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

export function AppProviders({ children }: { children: ReactNode }) {
  if (!clerkEnabled) {
    return convexClient ? (
      <ConvexProvider client={convexClient}>{children}</ConvexProvider>
    ) : (
      <>{children}</>
    );
  }
  return (
    <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up">
      {convexClient ? (
        <ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
          {children}
        </ConvexProviderWithClerk>
      ) : (
        children
      )}
    </ClerkProvider>
  );
}

/** The brand mark: three shelved spines on a ledge. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <rect x="2.5" y="3" width="4.6" height="14" rx="1.1" fill="currentColor" />
      <rect x="8.6" y="6" width="4.6" height="11" rx="1.1" fill="currentColor" opacity=".72" />
      <rect x="14.8" y="4.4" width="4.2" height="12.6" rx="1.1" fill="currentColor" opacity=".46" transform="rotate(8 16.9 10.7)" />
      <rect x="1" y="18.6" width="24" height="3.1" rx="1.2" fill="currentColor" />
    </svg>
  );
}

/**
 * The sticky site header of the Bookshelf look (styles/shell.css): brand,
 * primary nav, search, theme toggle, and the account controls. Under 960px
 * the nav and search fold into a drawer behind the menu button.
 */
export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const releasesCurrent = pathname.startsWith("/releases");
  const seriesCurrent = pathname.startsWith("/series");
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link to="/" className="brand">
          <BrandMark />
          MangaDB
        </Link>
        <nav className="nav" aria-label="Main">
          {/* The Releases browser (#24) is the main public browse surface. */}
          <Link
            to="/releases"
            className={releasesCurrent ? "nav-link is-current" : "nav-link"}
            aria-current={releasesCurrent ? "page" : undefined}
          >
            Releases
          </Link>
          {/* The Series library; a Series page counts as being in it. */}
          <Link
            to="/series"
            className={seriesCurrent ? "nav-link is-current" : "nav-link"}
            aria-current={seriesCurrent ? "page" : undefined}
          >
            Series
          </Link>
        </nav>
        <HeaderSearch />
        <div className="header-actions">
          <ThemeToggle />
          <button
            className="icon-btn menu-toggle"
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((v) => !v)}
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
              <path d="M3 5.5h14M3 10h14M3 14.5h14" />
            </svg>
          </button>
          {clerkEnabled ? <AuthNav /> : null}
        </div>
      </div>
      <div className={open ? "mobile-nav is-open" : "mobile-nav"} id="mobile-nav">
        <div className="container mobile-nav-inner">
          <HeaderSearch mobile />
          <Link to="/" className="nav-link" onClick={() => setOpen(false)}>
            Home
          </Link>
          <Link to="/releases" className="nav-link" onClick={() => setOpen(false)}>
            Releases
          </Link>
          <Link to="/series" className="nav-link" onClick={() => setOpen(false)}>
            Series
          </Link>
          {clerkEnabled ? <AuthNav mobile /> : null}
        </div>
      </div>
    </header>
  );
}

// Dark is the default shelf; a saved choice wins (see the boot script in
// __root.tsx). The two icons are both rendered and CSS shows the right one
// for the current html[data-theme], so this needs no client state.
function ThemeToggle() {
  return (
    <button
      className="icon-btn theme-toggle"
      type="button"
      aria-label="Switch between light and dark"
      onClick={() => {
        const root = document.documentElement;
        const next = root.dataset.theme === "light" ? "dark" : "light";
        root.dataset.theme = next;
        try {
          localStorage.setItem("mangadb-theme", next);
        } catch {
          // private mode: the choice just doesn't persist
        }
      }}
    >
      <svg className="sun" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
        <circle cx="10" cy="10" r="3.6" />
        <path d="M10 1.6v2M10 16.4v2M1.6 10h2M16.4 10h2M4.1 4.1l1.4 1.4M14.5 14.5l1.4 1.4M15.9 4.1l-1.4 1.4M5.5 14.5l-1.4 1.4" />
      </svg>
      <svg className="moon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
        <path d="M16.5 12.2A7 7 0 0 1 7.8 3.5a7 7 0 1 0 8.7 8.7z" />
      </svg>
    </button>
  );
}

// Site-wide entry into /search (ticket #38). A real GET form so it works
// before hydration; with JS the submit becomes a client-side navigation.
function HeaderSearch({ mobile = false }: { mobile?: boolean }) {
  const navigate = useNavigate();
  return (
    <form
      className={mobile ? "search search--mobile" : "search"}
      role="search"
      action="/search"
      method="get"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("q");
        void navigate({
          to: "/search",
          search: { q: typeof value === "string" ? value : "" },
        });
      }}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="7.2" cy="7.2" r="4.4" />
        <path d="m10.6 10.6 3 3" />
      </svg>
      <input
        className="search-input"
        type="search"
        name="q"
        placeholder="Search series, publishers, ISBN"
        aria-label="Search series, publishers, or an ISBN"
      />
    </form>
  );
}

function AuthNav({ mobile = false }: { mobile?: boolean }) {
  // Inside <ClerkProvider> whenever clerkEnabled; SSR state comes from
  // clerkMiddleware via the provider.
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return null;
  if (!isSignedIn) {
    return mobile ? (
      <>
        <a className="nav-link" href="/sign-in">Sign in</a>
        <a className="nav-link" href="/sign-up">Create account</a>
      </>
    ) : (
      <>
        <a className="btn btn-sm" href="/sign-in">Sign in</a>
        <a className="btn btn-primary btn-sm" href="/sign-up">Create account</a>
      </>
    );
  }
  return convexClient ? <SignedInNav mobile={mobile} /> : <UserButton />;
}

// The viewer query runs only when signed in: it drives the avatar initial,
// the /me link, and the review-queue entry point (#32) for data-team members.
function SignedInNav({ mobile }: { mobile: boolean }) {
  const viewer = useQuery(api.users.viewer, {});
  const username = viewer && !viewer.needsUsername ? viewer.username : null;
  const isDataTeam = Boolean(
    viewer &&
      !viewer.needsUsername &&
      (viewer.role === "editor" ||
        viewer.role === "moderator" ||
        viewer.role === "administrator"),
  );
  if (mobile) {
    return (
      <>
        <Link to="/me" className="nav-link">My library</Link>
        {isDataTeam ? <Link to="/mod/queue" className="nav-link">Review queue</Link> : null}
      </>
    );
  }
  return (
    <>
      {isDataTeam ? (
        <Link to="/mod/queue" className="nav-link">Queue</Link>
      ) : null}
      <Link to="/me" className="account">
        <span className="avatar" aria-hidden="true">
          {username ? username.slice(0, 2).toUpperCase() : "…"}
        </span>
        <span>My library</span>
      </Link>
      <UserButton />
    </>
  );
}
