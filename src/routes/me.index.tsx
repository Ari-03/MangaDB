import { useClerk } from "@clerk/tanstack-react-start";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAction, useQuery } from "convex/react";
import { useState, type MouseEvent } from "react";

import { api } from "../../convex/_generated/api";
import { countLibrary, LibraryCollection } from "~/lib/collection";
import { LibraryFavorites } from "~/lib/favorites";
import { LibraryUpcoming } from "~/lib/follows";
import { todaySortKey } from "~/lib/month";
import type { EntryState } from "~/lib/quickActions";
import { LibraryReading } from "~/lib/reading";
import { MatureSettings } from "~/lib/mature";
import { ScoreFormatSettings } from "~/lib/ratings";
import { SharingSettings } from "~/lib/sharing";
import { convexClient } from "~/providers";

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
 * slice that owns it; this page only frames them.
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
  const show = (next: typeof view) => (event: MouseEvent<HTMLAnchorElement>) => {
    // Plain clicks switch in place; modified clicks keep their link meaning.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setView(next);
    window.history.replaceState(window.history.state, "", viewHref(next.tab, next.shelf));
  };

  if (viewerState.status !== "ready") {
    // Only "unconfigured" reaches the component; the /me gate redirects the
    // signed-out and username-pending states.
    return (
      <main>
        <p className="notice">
          Accounts are not configured. Set the Clerk and Convex environment
          variables (see the README) to enable sign-in and personal tracking.
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
            <TabCount tab={entry.key} />
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
            {/* Personal collection (#27), shelved by Series and reading path. */}
            <LibraryCollection shelf={shelf} />
          </div>
        </section>
      ) : tab === "reading" ? (
        <section className="lib-panel lib-view" aria-label="Reading">
          {/* Reading tracking (#28): statuses, progress and active passes. */}
          <LibraryReading />
        </section>
      ) : tab === "upcoming" ? (
        <section className="lib-panel lib-view" aria-label="Upcoming">
          {/* Series Follows + My Upcoming Releases (#29). */}
          <LibraryUpcoming />
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
            {/* Tracking visibility (#30): separate Ownership/Reading defaults,
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

/** The count in a tab label; nothing until the slice's query answers. */
function TabCount({ tab }: { tab: Tab }) {
  if (!convexClient || tab === "settings") return null;
  return <TabCountInner tab={tab} />;
}

function TabCountInner({ tab }: { tab: Tab }) {
  // Each tab's own query, so the counts stay live and switching tabs is
  // instant — the subscriptions are already warm.
  const library = useQuery(api.collection.myLibrary, tab === "collection" ? {} : "skip");
  const reading = useQuery(api.reading.myReading, tab === "reading" ? {} : "skip");
  // Today's key like the Upcoming tab itself; once per mount so the query
  // key stays stable.
  const [todaySort] = useState(() => todaySortKey());
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
  if (!convexClient) return null;
  return <ShelfCountInner shelf={shelf} />;
}

function ShelfCountInner({ shelf }: { shelf: EntryState }) {
  const library = useQuery(api.collection.myLibrary, {});
  if (!library) return null;
  return <span className="lib-tab-count">{countLibrary(library)[shelf]}</span>;
}

/**
 * MangaDB-initiated account deletion (spec §9): one Convex action removes the
 * Clerk identity and every MangaDB record, then the local session is dropped.
 */
function DeleteAccount() {
  if (!convexClient) return null;
  return <DeleteAccountInner />;
}

function DeleteAccountInner() {
  const clerk = useClerk();
  const navigate = useNavigate();
  const deleteAccount = useAction(api.users.deleteAccount);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount({});
      // The Clerk user is gone; clear the local session and leave.
      await clerk.signOut();
      await navigate({ to: "/" });
    } catch {
      setError("Account deletion failed. Nothing was removed — try again.");
      setBusy(false);
    }
  };

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
