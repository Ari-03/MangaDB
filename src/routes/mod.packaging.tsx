import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { mutationErrorMessage } from "~/lib/errors";
import { plural } from "~/lib/format";
import { ModGate } from "~/lib/moderation";
import { Explainer, Jacket, ModSubtabs, ModWorkroom, WorklistSkeleton } from "~/lib/modShell";
import { useIsModerator } from "~/lib/viewer";
import { slugParams } from "~/lib/slug";

/**
 * Catalog gaps, two panels kept in the URL. Series without books
 * (CONTEXT.md Bookless Series): backbones whose books never attached,
 * each with the way to add one, its page, and for Moderators its manage
 * page. Unmapped packaging (CONTEXT.md): omnibus/deluxe books whose source
 * never said which Volumes they collect; mapping is a Moderator direct
 * edit (convex/packaging.ts). Both lists are the oldest 100; search and
 * sort act on those loaded rows only. Data-Team-visible; never indexed.
 */
export const Route = createFileRoute("/mod/packaging")({
  head: () => ({ meta: [{ title: "Catalog gaps — MangaDB" }] }),
  validateSearch: (search: Record<string, unknown>): { panel?: "unmapped" } =>
    search.panel === "unmapped" ? { panel: "unmapped" } : {},
  component: PackagingPage,
});

function PackagingPage() {
  return (
    <ModGate
      role="dataTeam"
      refusal="Catalog gaps are visible to Editors, Moderators, and Administrators."
    >
      <CatalogGaps />
    </ModGate>
  );
}

/** A loaded list's size as its tab shows it: "100+" when more follow. */
const loadedCount = (queue: { rows: unknown[]; hasMore: boolean } | undefined) =>
  queue === undefined ? null : `${queue.rows.length}${queue.hasMore ? "+" : ""}`;

function CatalogGaps() {
  const canAct = useIsModerator();
  const panel = Route.useSearch().panel ?? "bookless";
  const navigate = useNavigate({ from: "/mod/packaging" });
  const bookless = useQuery(api.packaging.booklessQueue, {});
  const unmapped = useQuery(api.packaging.unmappedQueue, {});
  return (
    <ModWorkroom
      current="packaging"
      title="Catalog gaps"
      hint="Records the rebuild keeps out of browse until someone decides: series with no books, and packaged books with no stated volumes."
    >
      <ModSubtabs
        label="Catalog gaps panels"
        value={panel}
        onChange={(next) =>
          void navigate({ search: next === "unmapped" ? { panel: next } : {}, replace: true })
        }
        panels={[
          { value: "bookless", label: "Series without books", count: loadedCount(bookless) },
          { value: "unmapped", label: "Unmapped packaging", count: loadedCount(unmapped) },
        ]}
      />
      {panel === "bookless" ? (
        <BooklessSeries queue={bookless} canAct={canAct} />
      ) : (
        <UnmappedPackaging queue={unmapped} canAct={canAct} />
      )}
    </ModWorkroom>
  );
}

type BooklessQueue = FunctionReturnType<typeof api.packaging.booklessQueue>;
type BooklessRow = BooklessQueue["rows"][number];

const SORTS = {
  oldest: {
    label: "Oldest first",
    compare: (a: BooklessRow, b: BooklessRow) => a.publicId - b.publicId,
  },
  title: {
    label: "Title",
    compare: (a: BooklessRow, b: BooklessRow) => a.title.localeCompare(b.title),
  },
  volumes: {
    label: "Most volumes",
    compare: (a: BooklessRow, b: BooklessRow) => b.volumeCount - a.volumeCount,
  },
} as const;

/** The ANN encyclopedia entry a backbone was built from, when it was. */
function annEntry(row: BooklessRow): string | null {
  const source = row.sources.find(
    (entry) => entry.sourceKey === "ann" && entry.recordId.startsWith("manga:"),
  );
  return source
    ? `https://www.animenewsnetwork.com/encyclopedia/manga.php?id=${source.recordId.slice(6)}`
    : null;
}

/**
 * Bookless Series: the rebuild keeps them out of browse and search; this
 * list is where the Data Team adds the missing release or hides the series.
 * The search box and sort act on the rows loaded (the oldest 100).
 */
function BooklessSeries({ queue, canAct }: { queue: BooklessQueue | undefined; canAct: boolean }) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<keyof typeof SORTS>("oldest");
  const needle = filter.trim().toLowerCase();
  const rows = (queue?.rows ?? [])
    .filter((row) => needle === "" || row.title.toLowerCase().includes(needle))
    .sort(SORTS[sort].compare);
  return (
    <section className="mod-section" aria-labelledby="bookless-title">
      <h2 id="bookless-title" className="visually-hidden">
        Series without books
      </h2>
      <Explainer summary="Why these are here">
        <p>
          Volumes are known but no English release ever attached, so these stay out of browse,
          search and the sitemap. Common causes: the distributor has no publisher row, the only
          releases are omnibus packaging, or ANN lists no ISBN. Add the missing release and the next
          rebuild restores the series; hide it from its manage page if it does not belong.
        </p>
      </Explainer>
      {queue === undefined ? (
        <WorklistSkeleton />
      ) : queue.rows.length === 0 ? (
        <p className="notice">Every active series has at least one book.</p>
      ) : (
        <>
          <div className="gap-tools">
            <label>
              <span className="visually-hidden">Filter these series</span>
              <input
                type="search"
                value={filter}
                placeholder="Filter these series"
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <label>
              <span className="visually-hidden">Sort</span>
              <select
                value={sort}
                onChange={(event) => {
                  const next = event.target.value;
                  if (next === "oldest" || next === "title" || next === "volumes") setSort(next);
                }}
              >
                {Object.entries(SORTS).map(([value, entry]) => (
                  <option key={value} value={value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="gap-count" aria-live="polite">
              {rows.length === queue.rows.length
                ? `${queue.rows.length} loaded`
                : `${rows.length} of ${queue.rows.length} loaded`}
              {queue.hasMore ? `; the oldest ${queue.rows.length}, more follow` : ""}
            </span>
          </div>
          {rows.length === 0 ? (
            <p className="notice">No loaded series matches "{filter.trim()}".</p>
          ) : (
            <ol className="worklist">
              {rows.map((row) => {
                const ann = annEntry(row);
                return (
                  <li key={row.seriesId} className="work-row">
                    <Jacket title={row.title} mature={false} />
                    <div className="work-body">
                      <div className="work-head">
                        <strong className="work-title">{row.title}</strong>
                        <span className="work-aside">
                          {plural(row.volumeCount, "volume")}
                          {ann ? (
                            <>
                              {" · "}
                              <a href={ann} target="_blank" rel="noreferrer">
                                ANN entry
                              </a>
                            </>
                          ) : null}
                        </span>
                      </div>
                      <div className="work-actions">
                        <Link
                          to="/mod/propose-new/$seriesPublicId"
                          params={{ seriesPublicId: String(row.publicId) }}
                        >
                          Add a release
                        </Link>
                        <Link
                          to="/series/$publicId/$slug"
                          params={slugParams(row.publicId, row.title)}
                        >
                          Open series
                        </Link>
                        {canAct ? (
                          <Link
                            to="/mod/manage/$type/$key"
                            params={{ type: "series", key: String(row.publicId) }}
                          >
                            Hide or merge…
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {queue.hasMore ? (
            <p className="section-hint">
              The oldest {queue.rows.length} are shown. Resolve these to see the rest.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

type UnmappedQueue = FunctionReturnType<typeof api.packaging.unmappedQueue>;
type Row = UnmappedQueue["rows"][number];

function UnmappedPackaging({
  queue,
  canAct,
}: {
  queue: UnmappedQueue | undefined;
  canAct: boolean;
}) {
  return (
    <section className="mod-section" aria-labelledby="unmapped-title">
      <h2 id="unmapped-title" className="visually-hidden">
        Unmapped packaging
      </h2>
      <p className="section-hint">
        Omnibus, deluxe and collector's books whose publisher never stated which volumes they
        collect. Check the publisher's page for the collected range, then map; the reason becomes
        the Revision's rationale.{canAct ? "" : " Moderators map these."}
      </p>
      <Explainer>
        <p>
          These already show under their line in the publisher's own numbering. Mapping them lets
          reading progress and ownership follow the volumes inside.
        </p>
      </Explainer>
      {queue === undefined ? (
        <WorklistSkeleton />
      ) : queue.rows.length === 0 ? (
        <p className="notice">Every packaged book is mapped.</p>
      ) : (
        <>
          <ol className="worklist packaging-queue">
            {queue.rows.map((row) => (
              <UnmappedRow key={row.editionId} row={row} canAct={canAct} />
            ))}
          </ol>
          {queue.hasMore ? (
            <p className="section-hint">
              The oldest {queue.rows.length} are shown. Map these to see the rest.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function UnmappedRow({ row, canAct }: { row: Row; canAct: boolean }) {
  const map = useMutation(api.packaging.mapEditionCoverage);
  const [from, setFrom] = useState(row.volumeLabels[0] ?? "");
  const [to, setTo] = useState(row.volumeLabels[0] ?? "");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="work-row">
      <Jacket title={row.title} isbn13={row.isbns[0]} mature={row.mature} />
      <div className="work-body">
        <div className="work-head">
          <Link
            className="work-title"
            to="/edition/$publicId/$slug"
            params={slugParams(row.editionPublicId, row.title)}
          >
            {row.title}
          </Link>
        </div>
        <p className="work-meta">
          <span>{row.publisher ?? "unknown publisher"}</span>
          {row.isbns.length > 0 ? <span>{row.isbns.join(", ")}</span> : null}
          <span>
            in{" "}
            <Link
              to="/series/$publicId/$slug"
              params={slugParams(row.series.publicId, row.series.title)}
            >
              {row.series.title}
            </Link>
          </span>
        </p>
        {canAct ? (
          <form
            className="map-form"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              setBusy(true);
              map({ editionId: row.editionId as Id<"editions">, from, to, comment })
                .catch((err: unknown) => setError(errorMessage(err)))
                .finally(() => setBusy(false));
            }}
          >
            <label>
              Collects volumes{" "}
              <select value={from} onChange={(event) => setFrom(event.target.value)}>
                {row.volumeLabels.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              to{" "}
              <select value={to} onChange={(event) => setTo(event.target.value)}>
                {row.volumeLabels.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="map-why">
              Why{" "}
              <input
                type="text"
                placeholder="publisher page: collects vols. 4–6"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                required
              />
            </label>
            <button
              type="submit"
              className="btn btn-sm"
              disabled={busy || row.volumeLabels.length === 0}
            >
              {busy ? "Mapping…" : "Map"}
            </button>
            {error ? <p className="form-error">{error}</p> : null}
          </form>
        ) : null}
      </div>
    </li>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof ConvexError) return mutationErrorMessage(err, "That did not work.");
  return err instanceof Error ? err.message : "That did not work.";
}
