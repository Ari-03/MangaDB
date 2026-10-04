// Personal collection UI (spec §3), rendered as a signed-in
// overlay on the public catalog pages: Wanted / Ordered / Owned toggles on
// every Release row and Bundle page, the pinned-Variant picker, Derived
// Ownership badges, the Volume ownership summary, and the library's
// Collection tab — every entry shelved under its Series and reading path,
// with each path openable to mark the rest of it. Everything fetches
// through the reactive Convex client; signed-out viewers get null from the
// collection queries, so the public pages render identically without the
// controls.
//
// The state model from the glossary holds throughout: exactly one state per
// entry — picking a state replaces the previous one, picking the current
// state again removes the entry — and every transition is an explicit click.

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { track } from "~/lib/analytics";
import { Cover } from "~/lib/cover";
import { FollowPrompt, type FollowSuggestion } from "~/lib/follows";
import {
  bookBadges,
  BookQuickActions,
  ENTRY_LABELS,
  ENTRY_STATES,
  NO_PROMPTS,
  ShelfPrompts,
  useRunLock,
  type EntryState,
  type ShelfPromptState,
} from "~/lib/quickActions";
import { plural } from "~/lib/format";
import { bookLabel, PathShelf } from "~/lib/seriesShelf";
import { slugParams } from "~/lib/slug";

/**
 * The three-state segmented control. Exactly one state can be active;
 * clicking the active state removes the entry (state -> null), clicking
 * another replaces it — the exactly-one-state invariant rendered as
 * controls. Styling keys off `aria-pressed`, so the pressed look and the
 * announced state can never drift apart. `disabled` locks all three.
 */
function StateButtons({
  current,
  onPick,
  disabled = false,
}: {
  current: EntryState | null;
  onPick: (state: EntryState | null) => void;
  disabled?: boolean;
}) {
  return (
    <span className="collection-states" role="group" aria-label="Collection state">
      {ENTRY_STATES.map((state) => (
        <button
          key={state}
          type="button"
          aria-pressed={current === state}
          className={current === state ? "state-active" : undefined}
          disabled={disabled}
          title={
            current === state
              ? "Remove this from your collection"
              : `Mark as ${ENTRY_LABELS[state].toLowerCase()}`
          }
          onClick={() => onPick(current === state ? null : state)}
        >
          {ENTRY_LABELS[state]}
        </button>
      ))}
    </span>
  );
}

// ---------- Release row controls ----------

/**
 * Collection controls on a Release row: the state toggles, the owned-Variant
 * picker when the Release has Variants, and Derived Ownership badges from
 * Owned Bundles. Mounts anywhere a Release row renders — Series, Volume, and
 * Edition pages; renders nothing signed out. Locked while a whole run still
 * has this Release to write (useRunLock), so its later batch cannot
 * overwrite a choice made here meanwhile.
 */
export function ReleaseCollectionControls({ releaseId }: { releaseId: Id<"releases"> }) {
  const data = useQuery(api.collection.entryForRelease, { releaseId });
  const setEntry = useMutation(api.collection.setReleaseEntry);
  // The post-first-entry follow suggestion the last mutation returned;
  // ephemeral — following and permanent dismissal go through FollowPrompt.
  const [suggestFollow, setSuggestFollow] = useState<FollowSuggestion[]>([]);
  const lock = useRunLock(
    (claims) => claims.entries.has(releaseId) || (!!data && claims.entries.has(data.releaseId)),
  );
  if (!data) return null; // loading, signed out, or username pending
  const entry = data.entry;

  return (
    <div className="collection-controls">
      <StateButtons
        current={entry?.state ?? null}
        disabled={lock.locked}
        onPick={(state) => {
          if (lock.held()) return;
          void setEntry({
            releaseId: data.releaseId,
            state: state ?? undefined,
            // Keep the pinned Variant across state changes; removal clears it
            // with the entry.
            variantId: state ? (entry?.variantId ?? undefined) : undefined,
          }).then((result) => {
            track("collection_entry_set", { target: "release", state });
            setSuggestFollow(result.suggestFollow);
          });
        }}
      />
      <FollowPrompt suggestions={suggestFollow} onDone={() => setSuggestFollow([])} />
      {entry && data.variants.length > 0 ? (
        <label className="variant-pick">
          <span className="variant-pick-label">Variant</span>
          <select
            className="select"
            value={entry.variantId ?? ""}
            disabled={lock.locked}
            onChange={(event) => {
              if (lock.held()) return;
              const value = event.currentTarget.value;
              void setEntry({
                releaseId: data.releaseId,
                state: entry.state,
                variantId: value === "" ? undefined : (value as Id<"releaseVariants">),
              });
            }}
          >
            <option value="">Standard cover</option>
            {data.variants.map((variant) => (
              <option key={variant.variantId} value={variant.variantId}>
                {variant.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {/* Derived Ownership (computed, never stored) coexists with the direct
          entry above — an Owned bundle shows here without occupying a state. */}
      {data.derived.map((bundle) => (
        <span key={bundle.bundlePublicId} className="derived-ownership">
          Owned via{" "}
          <Link
            to="/bundle/$publicId/$slug"
            params={slugParams(bundle.bundlePublicId, bundle.bundleName)}
          >
            {bundle.bundleName}
          </Link>
          {bundle.pinnedVariantName ? ` (${bundle.pinnedVariantName} variant)` : ""}
        </span>
      ))}
    </div>
  );
}

// ---------- Bundle page controls ----------

/** Collection controls on the Bundle page; renders nothing signed out. */
export function BundleCollectionControls({ bundleId }: { bundleId: Id<"releaseBundles"> }) {
  const data = useQuery(api.collection.entryForBundle, { bundleId });
  const setEntry = useMutation(api.collection.setBundleEntry);
  // Follow suggestions for the member Releases' Series.
  const [suggestFollow, setSuggestFollow] = useState<FollowSuggestion[]>([]);
  if (!data) return null;
  return (
    <div className="collection-controls">
      <StateButtons
        current={data.entry?.state ?? null}
        onPick={(state) =>
          void setEntry({
            bundleId: data.bundleId,
            state: state ?? undefined,
          }).then((result) => {
            track("collection_entry_set", { target: "bundle", state });
            setSuggestFollow(result.suggestFollow);
          })
        }
      />
      <FollowPrompt suggestions={suggestFollow} onDone={() => setSuggestFollow([])} />
      {data.entry?.state === "owned" ? (
        <span className="derived-ownership">
          Owning this box set marks every book inside as owned.
        </span>
      ) : null}
    </div>
  );
}

// ---------- Volume ownership summary ----------

/**
 * How the viewer owns this Volume — purely through owned covering Releases
 * (direct or via an Owned Bundle), since no Volume-ownership state exists.
 * Renders nothing signed out or when nothing covering it is owned.
 */
export function VolumeOwnership({ volumePublicId }: { volumePublicId: number }) {
  const data = useQuery(api.collection.volumeOwnership, { volumePublicId });
  if (!data || data.owned.length === 0) return null;
  return (
    <div className="volume-ownership" role="status">
      <p className="volume-ownership-lede">On your shelf through</p>
      <ul>
        {data.owned.map((item, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: known defect, left for its own fix: a row removed above a focused link moves that focus to the next row's link (docs/known-issues.md, Interface)
            key={i}
          >
            <Link
              to="/edition/$publicId/$slug"
              params={slugParams(item.editionPublicId, item.editionTitle)}
              hash={item.anchor}
            >
              {item.editionTitle}
            </Link>{" "}
            <span className="pass-facts">
              {item.format === "physical"
                ? `Physical${item.binding ? ` · ${item.binding}` : ""}`
                : "Digital"}
              {item.extent === "partial" ? " · partial coverage" : ""}
              {item.variantName ? ` · ${item.variantName} variant` : ""}
            </span>
            {item.via ? (
              <span className="pass-facts">
                {" "}
                — via{" "}
                <Link
                  to="/bundle/$publicId/$slug"
                  params={slugParams(item.via.bundlePublicId, item.via.bundleName)}
                >
                  {item.via.bundleName}
                </Link>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- library: the Collection tab ----------

type Library = NonNullable<FunctionReturnType<typeof api.collection.myLibrary>>;
type LibrarySeries = Library["series"][number];
type LibraryPath = LibrarySeries["paths"][number];
type LibraryBook = LibraryPath["books"][number];

/** How many entries the viewer holds in each state, for the shelf tabs. */
export function countLibrary(library: Library): Record<EntryState, number> {
  const counts = { wanted: 0, ordered: 0, owned: 0 };
  for (const series of library.series) {
    for (const path of series.paths) {
      for (const book of path.books) if (book.direct) counts[book.state] += 1;
    }
  }
  for (const bundle of library.bundles) counts[bundle.state] += 1;
  return counts;
}

/**
 * The Collection tab: one shelf per state (Owned / Ordered / Wanted), each
 * listing the viewer's Series with the reading paths they hold books in —
 * "Deluxe Edition · 2 of 14 owned" — and the books as covers. A path opens
 * into the full run, unmarked books faded, so the rest can be marked from
 * their covers or all at once.
 */
export function LibraryCollection({ shelf }: { shelf: EntryState }) {
  const library = useQuery(api.collection.myLibrary, {});
  if (library === undefined) return <p className="placeholder">Loading…</p>;
  if (library === null) return null;

  const series = library.series
    .map((entry) => ({
      ...entry,
      paths: entry.paths
        .map((path) => ({
          ...path,
          books: path.books.filter((book) => book.state === shelf),
        }))
        .filter((path) => path.books.length > 0),
    }))
    .filter((entry) => entry.paths.length > 0);
  const bundles = library.bundles.filter((bundle) => bundle.state === shelf);

  if (series.length === 0 && bundles.length === 0) {
    return (
      <p className="placeholder">
        {shelf === "owned"
          ? "Nothing owned yet. Hover any book on a series page and press Own, or mark a release on its edition page."
          : shelf === "ordered"
            ? "Nothing on order. Mark a release Ordered — preorders count — and it lands here until it arrives."
            : "No wishlist yet. Mark a release Wanted and its announced date shows in your Upcoming too."}
      </p>
    );
  }

  return (
    <div className="lib-collection">
      {series.map((entry) => (
        <SeriesShelfCard key={entry.seriesPublicId} series={entry} shelf={shelf} />
      ))}
      {bundles.length > 0 ? (
        <section className="lib-bundles">
          <h3 className="lib-group-title">Box sets</h3>
          <div className="rail lib-rail">
            {bundles.map((bundle) => (
              <div key={bundle.bundleId} className="shelf-item">
                <div className="cover-wrap">
                  <Link
                    className="cover-link"
                    to="/bundle/$publicId/$slug"
                    params={slugParams(bundle.bundlePublicId, bundle.title)}
                    aria-label={bundle.title}
                  >
                    <Cover
                      isbn13={bundle.coverIsbn}
                      title={bundle.title}
                      foot={["Box set", plural(bundle.memberCount, "book", "books")]}
                      badges={
                        <span className={`badge badge--${bundle.state}`}>
                          {ENTRY_LABELS[bundle.state]}
                        </span>
                      }
                    />
                  </Link>
                </div>
                <div className="caption">
                  <Link
                    className="caption-title"
                    to="/bundle/$publicId/$slug"
                    params={slugParams(bundle.bundlePublicId, bundle.title)}
                  >
                    {bundle.title}
                  </Link>
                  <div className="caption-meta">
                    <span>{plural(bundle.memberCount, "book", "books")}</span>
                    {bundle.state === "owned" ? (
                      <>
                        <span className="dot" />
                        <span>Members shelved above</span>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** One Series on the shelf: its cover and title, then each reading path. */
function SeriesShelfCard({ series, shelf }: { series: LibrarySeries; shelf: EntryState }) {
  return (
    <article className="lib-series">
      <Link
        className="lib-series-cover"
        to="/series/$publicId/$slug"
        params={slugParams(series.seriesPublicId, series.title)}
        aria-label={series.title}
      >
        <Cover src={series.coverUrl} isbn13={series.coverIsbn} title={series.title} />
      </Link>
      <div className="lib-series-body">
        <h3 className="lib-series-title">
          <Link
            to="/series/$publicId/$slug"
            params={slugParams(series.seriesPublicId, series.title)}
          >
            {series.title}
          </Link>
        </h3>
        {series.paths.map((path) => (
          <PathRow
            key={path.key}
            path={path}
            shelf={shelf}
            seriesPublicId={series.seriesPublicId}
            seriesTitle={series.title}
          />
        ))}
      </div>
    </article>
  );
}

/**
 * A reading path the viewer holds books in: its name, how much of it is on
 * this shelf, the books as covers, and the toggle that opens the full run.
 */
function PathRow({
  path,
  shelf,
  seriesPublicId,
  seriesTitle,
}: {
  path: LibraryPath;
  shelf: EntryState;
  seriesPublicId: number;
  seriesTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<ShelfPromptState>(NO_PROMPTS);
  const held = path.books.length;
  const total = path.bookCount;
  const rest = total !== null ? Math.max(0, total - held) : null;
  const word = ENTRY_LABELS[shelf].toLowerCase();
  return (
    <div className="lib-path">
      <div className="lib-path-head">
        <span className="lib-path-name">{path.name}</span>
        <span className="lib-path-meta">
          {path.publisher ? `${path.publisher.name} · ` : ""}
          {total !== null
            ? `${held} of ${plural(total, path.kind === "line" ? "book" : "volume", path.kind === "line" ? "books" : "volumes")} ${word}`
            : `${plural(held, "book", "books")} ${word}`}
        </span>
        <button
          type="button"
          className="lib-path-more"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? "Close" : rest !== null && rest > 0 ? `Add the other ${rest}` : "Open the run"}
        </button>
      </div>
      {open ? (
        <PathExpansion pathKey={path.key} seriesPublicId={seriesPublicId} />
      ) : (
        <>
          <ShelfPrompts prompts={prompts} onChange={setPrompts} />
          <div className="rail lib-rail">
            {path.books.map((book) => (
              <LibraryBookItem
                key={book.releaseId}
                book={book}
                seriesTitle={seriesTitle}
                onPrompt={(next) => setPrompts((prev) => ({ ...prev, ...next }))}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** A book on the library shelf: cover, badges, quick actions, and its label. */
function LibraryBookItem({
  book,
  seriesTitle,
  onPrompt,
}: {
  book: LibraryBook;
  seriesTitle: string;
  onPrompt: (prompts: Partial<ShelfPromptState>) => void;
}) {
  const number = book.lineName !== null ? book.linePosition : (book.coverage[0]?.label ?? null);
  const quick = {
    editionPublicId: book.editionPublicId,
    targetReleaseId: book.releaseId,
    state: book.direct ? book.state : null,
    derivedOwned: book.via !== null,
    read: book.read,
    completeVolumes: book.coverage.flatMap((cov) =>
      cov.extent === "complete" ? [cov.volumePublicId] : [],
    ),
  };
  return (
    <div className="shelf-item">
      <div className="cover-wrap">
        <Link
          className="cover-link"
          to="/edition/$publicId/$slug"
          params={slugParams(book.editionPublicId, book.title)}
          hash={book.anchor}
          aria-label={book.title}
        >
          <Cover
            src={book.coverUrl}
            isbn13={book.coverIsbns}
            title={book.title}
            numbered={number !== null ? { series: seriesTitle, number } : undefined}
            badges={bookBadges(quick)}
          />
        </Link>
        <BookQuickActions book={quick} onPrompt={onPrompt} />
      </div>
      <div className="caption">
        <Link
          className="caption-title"
          to="/edition/$publicId/$slug"
          params={slugParams(book.editionPublicId, book.title)}
          hash={book.anchor}
        >
          {bookLabel(book)}
        </Link>
        <div className="caption-meta">
          <span>{book.format === "physical" ? (book.binding ?? "Print") : "Digital"}</span>
          {book.variantName ? (
            <>
              <span className="dot" />
              <span>{book.variantName}</span>
            </>
          ) : null}
          {book.via ? (
            <>
              <span className="dot" />
              <span title={`Owned through ${book.via.bundleName}`}>Box set</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The full run behind a path, loaded from the public Series page query when
 * opened: every book in reading order with the unmarked ones faded, the
 * whole-run buttons above it and the quick actions on each cover — the same
 * shelf the Series page shows.
 */
function PathExpansion({ pathKey, seriesPublicId }: { pathKey: string; seriesPublicId: number }) {
  const page = useQuery(api.catalog.seriesPage, { publicId: seriesPublicId });
  if (page === undefined) return <p className="placeholder">Loading the run…</p>;
  const group = page?.editionGroups.find((candidate) => candidate.key === pathKey);
  if (!page || !group) {
    return <p className="placeholder">This run is no longer on file.</p>;
  }
  return (
    <div className="lib-expand">
      <PathShelf
        group={group}
        volumes={page.volumes}
        seriesTitle={page.series.title}
        seriesPublicId={seriesPublicId}
        dimUnmarked
      />
    </div>
  );
}
