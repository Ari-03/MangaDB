import { createFileRoute, Link } from "@tanstack/react-router";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { mutationErrorMessage } from "~/lib/errors";
import { CommentsQueueLink, useIsModerator } from "~/lib/moderation";
import { slugParams } from "~/lib/slug";

/**
 * Unmapped Packaging (CONTEXT.md): omnibus/deluxe books whose source never
 * said which Volumes they collect. Data-Team-visible; mapping is a
 * Moderator direct edit (convex/packaging.ts).
 */
export const Route = createFileRoute("/mod/packaging")({
  component: PackagingPage,
});

function PackagingPage() {
  const viewer = useQuery(api.users.viewer, {});
  const isModerator = useIsModerator();
  if (viewer === undefined) {
    return (
      <main className="mod-page">
        <p className="notice">Loading…</p>
      </main>
    );
  }
  const isDataTeam = Boolean(viewer && !viewer.needsUsername && viewer.role !== null);
  if (!isDataTeam) {
    return (
      <main className="mod-page">
        <h1>Data team only</h1>
        <p className="notice">
          Unmapped packaging is visible to Editors, Moderators, and Administrators.{" "}
          {viewer === null ? <a href="/sign-in">Sign in</a> : null}
        </p>
      </main>
    );
  }
  return <UnmappedQueue canAct={isModerator} />;
}

function UnmappedQueue({ canAct }: { canAct: boolean }) {
  const queue = useQuery(api.packaging.unmappedQueue, {});
  return (
    <main className="mod-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span> <span>Catalog gaps</span>
      </nav>
      <h1>Catalog gaps</h1>
      <BooklessSeries />
      <h2>Unmapped packaging</h2>
      <p className="section-hint">
        Omnibus, deluxe and collector's books whose publisher never stated which volumes they
        collect. They already show under their line in the publisher's own numbering; mapping
        them lets reading progress and ownership follow the volumes inside. Check the
        publisher's page for the collected range, then map.
      </p>
      <nav className="mod-tools" aria-label="Data team tools">
        <Link to="/mod/queue">Review queue</Link>
        <Link to="/mod/imports">Imports</Link>
        <Link to="/mod/launch">Launch</Link>
        <CommentsQueueLink />
      </nav>
      {queue === undefined ? (
        <p className="notice">Loading…</p>
      ) : queue.rows.length === 0 ? (
        <p className="notice">Every packaged book is mapped.</p>
      ) : (
        <>
          <ul className="duplicate-queue packaging-queue">
            {queue.rows.map((row) => (
              <UnmappedRow key={row.editionId} row={row} canAct={canAct} />
            ))}
          </ul>
          {queue.hasMore ? (
            <p className="section-hint">More follow — map these first.</p>
          ) : null}
        </>
      )}
    </main>
  );
}

type Row = FunctionReturnType<typeof api.packaging.unmappedQueue>["rows"][number];

function UnmappedRow({ row, canAct }: { row: Row; canAct: boolean }) {
  const map = useMutation(api.packaging.mapEditionCoverage);
  const [from, setFrom] = useState(row.volumeLabels[0] ?? "");
  const [to, setTo] = useState(row.volumeLabels[0] ?? "");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li>
      <div>
        <Link
          to="/edition/$publicId/$slug"
          params={slugParams(row.editionPublicId, row.title)}
        >
          {row.title}
        </Link>{" "}
        <em>
          {row.publisher ?? "unknown publisher"}
          {row.isbns.length > 0 ? ` · ${row.isbns.join(", ")}` : ""}
        </em>{" "}
        — in{" "}
        <Link to="/series/$publicId/$slug" params={slugParams(row.series.publicId, row.series.title)}>
          {row.series.title}
        </Link>
      </div>
      {canAct ? (
        <form
          className="qa-actions packaging-map"
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
            Volumes{" "}
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
          <input
            type="text"
            placeholder="Why (e.g. publisher page: collects vols. 4–6)"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            required
          />
          <button type="submit" className="btn btn-sm" disabled={busy || row.volumeLabels.length === 0}>
            {busy ? "Mapping…" : "Map"}
          </button>
          {error ? <span className="form-error">{error}</span> : null}
        </form>
      ) : null}
    </li>
  );
}

/**
 * Bookless Series: backbones (usually ANN's) whose books never attached. The
 * rebuild keeps them out of browse and search; this list is where the Data
 * Team decides between rescuing the source gap and hiding the series.
 */
function BooklessSeries() {
  const queue = useQuery(api.packaging.booklessQueue, {});
  return (
    <section>
      <h2>Series without books</h2>
      <p className="section-hint">
        Volumes are known but no English release ever attached, so these stay out of browse,
        search and the sitemap. Common causes: the distributor has no publisher row, the only
        releases are omnibus packaging, or ANN lists no ISBN. Fix the cause and the next rebuild
        restores the series; hide it from its manage page if it does not belong.
      </p>
      {queue === undefined ? (
        <p className="notice">Loading…</p>
      ) : queue.rows.length === 0 ? (
        <p className="notice">Every active series has at least one book.</p>
      ) : (
        <>
          <ul className="duplicate-queue">
            {queue.rows.map((row) => (
              <li key={row.seriesId}>
                <Link to="/series/$publicId/$slug" params={slugParams(row.publicId, row.title)}>
                  {row.title}
                </Link>{" "}
                <em>
                  {row.volumeCount} {row.volumeCount === 1 ? "volume" : "volumes"}
                  {row.sources.map((source) =>
                    source.sourceKey === "ann" && source.recordId.startsWith("manga:") ? (
                      <>
                        {" · "}
                        <a
                          href={`https://www.animenewsnetwork.com/encyclopedia/manga.php?id=${source.recordId.slice(6)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          ANN entry
                        </a>
                      </>
                    ) : null,
                  )}
                </em>{" "}
                <Link to="/mod/manage/$type/$key" params={{ type: "series", key: String(row.publicId) }}>
                  Manage…
                </Link>
              </li>
            ))}
          </ul>
          {queue.hasMore ? <p className="section-hint">More follow — review these first.</p> : null}
        </>
      )}
    </section>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof ConvexError) return mutationErrorMessage(err, "That did not work.");
  return err instanceof Error ? err.message : "That did not work.";
}
