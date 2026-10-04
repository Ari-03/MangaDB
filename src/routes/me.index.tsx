import { useClerk } from "@clerk/tanstack-react-start";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import { api } from "../../convex/_generated/api";
import { AnalyticsSettings } from "~/lib/analytics";
import { countLibrary, LibraryCollection } from "~/lib/collection";
import { mutationErrorMessage } from "~/lib/errors";
import { LibraryFavorites } from "~/lib/favorites";
import { LibraryUpcoming } from "~/lib/follows";
import { todaySortKey } from "~/lib/month";
import type { EntryState } from "~/lib/quickActions";
import { LibraryReading } from "~/lib/reading";
import { MatureSettings } from "~/lib/mature";
import { ScoreFormatSettings } from "~/lib/ratings";
import { SharingSettings } from "~/lib/sharing";
import { clerkEnabled } from "~/providers";

const TABS = [
  { key: "collection", label: "Collection" },
  { key: "reading", label: "Reading" },
  { key: "upcoming", label: "Upcoming" },
  { key: "favorites", label: "Favorites" },
  { key: "settings", label: "Settings" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const SHELVES: Array<{ key: EntryState; label: string }> = [
  { key: "owned", label: "Owned" },
  { key: "ordered", label: "Ordered" },
  { key: "wanted", label: "Wanted" },
];

function isTab(value: unknown): value is Tab {
  return TABS.some((tab) => tab.key === value);
}
function isShelf(value: unknown): value is EntryState {
  return SHELVES.some((shelf) => shelf.key === value);
}

/** The URL for a library view, so every tab and shelf is a plain link. */
function viewHref(tab: Tab, shelf: EntryState): string {
  const params = new URLSearchParams({ tab });
  if (tab === "collection" && shelf !== "owned") params.set("shelf", shelf);
  return `/me?${params.toString()}`;
}

/**
 * /me — the viewer's own library, in tabs: what you have (one shelf per
 * collection state), what you are reading, what is coming, your Favorites,
 * and the account, sharing, and rating settings. The tab and shelf are read from the URL on arrival
 * (linkable, right before hydration) and then switched in place: a click
 * only changes local state and rewrites the address, never navigates, so
 * the /me auth gate is not re-run for every shelf. Each tab mounts the
 * slice that owns it; this page only frames them. Only the open tab's label
 * shows a count, read from the query its panel already runs.
 */
export const Route = createFileRoute("/me/")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: Tab; shelf?: EntryState } => ({
    ...(isTab(search.tab) ? { tab: search.tab } : {}),
    ...(isShelf(search.shelf) ? { shelf: search.shelf } : {}),
  }),
  component: MePage,
});

function MePage() {
  const { viewerState } = Route.useRouteContext();
  const search = Route.useSearch();
  const [view, setView] = useState({
    tab: search.tab ?? "collection",
    shelf: search.shelf ?? "owned",
  });
  const { tab, shelf } = view;
  // Today's key for the Upcoming panel and its count, once per mount so the
  // shared query key stays stable.
  const [todaySort] = useState(() => todaySortKey());
  const show = (next: typeof view) => (event: MouseEvent<HTMLAnchorElement>) => {
    // Plain clicks switch in place; modified clicks keep their link meaning.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setView(next);
    window.history.replaceState(window.history.state, "", viewHref(next.tab, next.shelf));
  };

  if (viewerState.status === "deleting") {
    // A session still signed in to an account being deleted (from another
    // device, say): say so and end it.
    return (
      <main>
        {clerkEnabled ? <SignOutDeleted /> : <p className="notice">Your account is being deleted.</p>}
      </main>
    );
  }
  if (viewerState.status !== "ready") {
    // Only "unconfigured" is left; the /me gate redirects the signed-out
    // and username-pending states.
    return (
      <main>
        <p className="notice">
          Accounts are not configured. Set the Clerk environment variables (see
          the README) to enable sign-in and personal tracking.
        </p>
      </main>
    );
  }

  const { viewer } = viewerState;
  return (
    <main className="me-page">
      <header className="lib-head">
        <div className="lib-ident">
          <h1 className="lib-title">Library</h1>
          <Link
            className="lib-handle"
            to="/u/$username"
            params={{ username: viewer.username }}
            title="Your public profile"
          >
            @{viewer.username}
          </Link>
        </div>
        <p className="lib-kicker">Private until you choose to share it.</p>
      </header>

      <nav className="lib-tabs" aria-label="Library sections">
        {TABS.map((entry) => (
          <a
            key={entry.key}
            className="lib-tab"
            href={viewHref(entry.key, shelf)}
            aria-current={tab === entry.key ? "page" : undefined}
            onClick={show({ tab: entry.key, shelf })}
          >
            {entry.label}
            {tab === entry.key ? <TabCount tab={tab} todaySort={todaySort} /> : null}
          </a>
        ))}
      </nav>

      {tab === "collection" ? (
        <section className="lib-panel" aria-label="Collection">
          <nav className="lib-subtabs" aria-label="Collection shelves">
            {SHELVES.map((entry) => (
              <a
                key={entry.key}
                className="lib-subtab"
                href={viewHref("collection", entry.key)}
                aria-current={shelf === entry.key ? "page" : undefined}
                onClick={show({ tab: "collection", shelf: entry.key })}
              >
                {entry.label}
                <ShelfCount shelf={entry.key} />
              </a>
            ))}
          </nav>
          {/* Keyed by shelf so a switch re-enters with the fade; the query
              behind it is already warm, so the new shelf is there at once. */}
          <div key={shelf} className="lib-view">
            {/* Personal collection, shelved by Series and reading path. */}
            <LibraryCollection shelf={shelf} />
          </div>
        </section>
      ) : tab === "reading" ? (
        <section className="lib-panel lib-view" aria-label="Reading">
          {/* Reading tracking: statuses, progress and active passes. */}
          <LibraryReading />
        </section>
      ) : tab === "upcoming" ? (
        <section className="lib-panel lib-view" aria-label="Upcoming">
          {/* Series Follows + My Upcoming Releases. */}
          <LibraryUpcoming todaySort={todaySort} />
        </section>
      ) : tab === "favorites" ? (
        <section className="lib-panel lib-view" aria-label="Favorites">
          {/* Favorited Series and Volumes, newest first; always private. */}
          <LibraryFavorites />
        </section>
      ) : (
        <section className="lib-panel lib-settings lib-view" aria-label="Settings">
          <div className="acct-panel">
            <h2 className="lib-group-title">Sharing</h2>
            {/* Tracking visibility: separate Ownership/Reading defaults,
                private until explicitly opened, plus the public-profile link. */}
            <SharingSettings />
          </div>
          <div className="acct-panel">
            <h2 className="lib-group-title">Mature titles</h2>
            <MatureSettings />
          </div>
          <div className="acct-panel">
            <h2 className="lib-group-title">Rating format</h2>
            {/* Rating Format: the control and display for scores; stored
                ratings are 1-100 whatever is chosen here. */}
            <ScoreFormatSettings />
          </div>
          <div className="acct-panel">
            <h2 className="lib-group-title">Analytics</h2>
            {/* The account's analytics opt-out: the browser client and every
                server event under the viewer's id. */}
            <AnalyticsSettings />
          </div>
          <div className="acct-panel">
            <h2 className="lib-group-title">Account</h2>
            <p className="acct-account-row">
              Signed in as{" "}
              <span className="acct-handle">@{viewer.username}</span>
              <Link to="/claim-username">Change username</Link>
            </p>
            <DeleteAccount />
          </div>
        </section>
      )}
    </main>
  );
}

/**
 * The count in the open tab's label (Settings has none); nothing until the
 * slice's query answers. The arguments match the open panel's own query, so
 * the two share one subscription.
 */
function TabCount({ tab, todaySort }: { tab: Tab; todaySort: number }) {
  if (tab === "settings") return null;
  return <TabCountInner tab={tab} todaySort={todaySort} />;
}

function TabCountInner({ tab, todaySort }: { tab: Tab; todaySort: number }) {
  const library = useQuery(api.collection.myLibrary, tab === "collection" ? {} : "skip");
  const reading = useQuery(api.reading.myReading, tab === "reading" ? {} : "skip");
  const upcoming = useQuery(
    api.follows.myUpcoming,
    tab === "upcoming" ? { todaySort } : "skip",
  );
  const favorites = useQuery(api.favorites.mine, tab === "favorites" ? {} : "skip");
  const count =
    tab === "collection" && library
      ? Object.values(countLibrary(library)).reduce((sum, n) => sum + n, 0)
      : tab === "reading" && reading
        ? reading.series.length
        : tab === "upcoming" && upcoming
          ? upcoming.items.length
          : tab === "favorites" && favorites
            ? favorites.items.length
            : null;
  if (count === null) return null;
  return <span className="lib-tab-count">{count}</span>;
}

function ShelfCount({ shelf }: { shelf: EntryState }) {
  const library = useQuery(api.collection.myLibrary, {});
  if (!library) return null;
  return <span className="lib-tab-count">{countLibrary(library)[shelf]}</span>;
}

/**
 * MangaDB-initiated account deletion (spec §9): one Convex mutation records
 * the request and schedules the removal of every MangaDB record, then of
 * the Clerk identity, then the local session is dropped (SignOutDeleted).
 * A refusal (the last Administrator, say) changes nothing; asking twice is
 * harmless.
 */
function DeleteAccount() {
  const deleteAccount = useMutation(api.users.deleteAccount);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount({});
    } catch (err) {
      // A ConvexError is a refusal, made before anything changed. Anything
      // else may have failed before or after the request was recorded.
      const refusal = mutationErrorMessage(err, "");
      setError(
        refusal
          ? `Your account was not deleted. ${refusal}`
          : "The deletion request could not be confirmed. Check your connection and try again.",
      );
      setBusy(false);
      return;
    }
    // The account now counts as gone; clear the local session and leave.
    setDeleting(true);
  };

  if (deleting) return <SignOutDeleted />;

  return (
    <div className="danger-zone">
      {confirming ? (
        <>
          <p>
            This permanently deletes your sign-in and everything MangaDB knows
            about you — collection, reading history, follows. There is no undo.
          </p>
          <div className="danger-actions">
            <button type="button" disabled={busy} onClick={() => void run()}>
              {busy ? "Deleting…" : "Yes, delete everything"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep my account
            </button>
          </div>
        </>
      ) : (
        <button type="button" onClick={() => setConfirming(true)}>
          Delete account…
        </button>
      )}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

/**
 * Signs out a session whose account deletion is under way, then goes home.
 * The first try waits for clerk-js to load: before then clerk.signOut()
 * only queues the call and resolves at once, so the page would leave
 * before any sign-out. (useAuth's isLoaded is no signal here: the server's
 * auth state makes it true before clerk-js has loaded.) The deletion goes
 * ahead whether or not this works, so a failed sign-out says both, with
 * another try and a way off the page. If clerk-js fails to load, that is
 * a failed sign-out with only the way off; the wait offers the way off
 * too, in case clerk-js never loads.
 */
function SignOutDeleted() {
  // useClerk re-renders on every Clerk status change, so `loaded` and `status` are live.
  const clerk = useClerk();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  const signOut = useCallback(async () => {
    setFailed(false);
    try {
      await clerk.signOut();
    } catch {
      setFailed(true);
      return;
    }
    await navigate({ to: "/" });
  }, [clerk, navigate]);

  // Once Clerk has loaded; the button retries.
  useEffect(() => {
    if (started.current || !clerk.loaded) return;
    started.current = true;
    void signOut();
  }, [clerk.loaded, signOut]);

  // Hotloading clerk-js failed: signOut() would only queue again.
  const clerkFailed = clerk.status === "error";

  if (!failed && !clerkFailed) {
    return (
      <div className="danger-zone">
        <p>Your account is being deleted. Signing you out…</p>
        <div className="danger-actions">
          <Link to="/">Leave this page</Link>
        </div>
      </div>
    );
  }
  return (
    <div className="danger-zone">
      <p>
        Your account is being deleted; that goes ahead on its own. Signing you
        out of this browser failed, though. Check your connection and try
        again, or leave this page.
      </p>
      <div className="danger-actions">
        {clerkFailed ? null : (
          <button type="button" onClick={() => void signOut()}>
            Try signing out again
          </button>
        )}
        <Link to="/">Leave this page</Link>
      </div>
    </div>
  );
}
