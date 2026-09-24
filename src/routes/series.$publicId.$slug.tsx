import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import type { CSSProperties } from "react";

import { editionTitle, volumeTitle } from "../../convex/lib/titles";
import { ReleaseCollectionControls } from "~/lib/collection";
import { Cover, clothColor } from "~/lib/cover";
import { SeriesFollowControls } from "~/lib/follows";
import { formatPartialDate, formatPrice } from "~/lib/format";
import {
  ModEditLink,
  ProposeNewRecordsLink,
  RecordHistory,
} from "~/lib/moderation";
import {
  ReleasePassControls,
  SeriesReadingControls,
  SeriesReadingProgress,
  VolumeReadCount,
} from "~/lib/reading";
import { SeriesReportAffordance } from "~/lib/report";
import {
  bookSeriesJsonLd,
  breadcrumbListJsonLd,
  jsonLdScript,
  pageHead,
  seriesTitleTag,
} from "~/lib/seo";
import { SeriesVisibilityControls } from "~/lib/sharing";
import { parsePublicId, seriesPath, slugParams } from "~/lib/slug";
import { fetchSeriesPage, type SeriesPageData } from "~/server/seriesPage";

/**
 * The Series page (ticket #22): `/series/{id}/{slug}`, server-rendered from
 * Convex in the Reading Path hierarchy validated by prototype #16 (spec §10).
 * The canonical Volume sequence leads — as a wall of covers on a shelf —
 * and publisher packaging (Editions, Edition Lines, Releases, Variants,
 * Bundles) is inspected beneath it, one expandable panel per Volume.
 *
 * The public ID is identity; the slug is cosmetic and computed from the
 * current title (spec §8/§11). A stale or wrong slug — including the old ID
 * of a merged Series, which resolves to its survivor — 301s to the canonical
 * URL.
 */
export const Route = createFileRoute("/series/$publicId/$slug")({
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    const page = await fetchSeriesPage({ data: publicId });
    if (!page) throw notFound();
    const canonical = seriesPath(page.series.publicId, page.series.title);
    if (`/series/${params.publicId}/${params.slug}` !== canonical) {
      throw redirect({ href: canonical, statusCode: 301 });
    }
    return page;
  },
  // Title/description formulas, cover-led social card, canonical link, and
  // BreadcrumbList + BookSeries JSON-LD (spec §11, ticket #39).
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { series, volumes, coverUrl } = loaderData;
    const path = seriesPath(series.publicId, series.title);
    const volumeCount =
      volumes.length === 1 ? "1 volume" : `${volumes.length} volumes`;
    return {
      ...pageHead({
        title: seriesTitleTag(series.title),
        description: `English releases of ${series.title}: ${volumeCount} in the canonical reading order, with every edition, format, and release date.`,
        path,
        image: coverUrl,
      }),
      scripts: [
        jsonLdScript(
          breadcrumbListJsonLd([
            { name: "MangaDB", path: "/" },
            { name: series.title },
          ]),
        ),
        jsonLdScript(
          bookSeriesJsonLd({
            title: series.title,
            altTitles: series.altTitles,
            path,
          }),
        ),
      ],
    };
  },
  component: SeriesPage,
  notFoundComponent: SeriesNotFound,
});

function SeriesNotFound() {
  return (
    <main className="series-page">
      <h1 className="series-title">Series not found</h1>
      <p className="notice">
        No series lives at this address. <Link to="/">Browse the catalog</Link>.
      </p>
    </main>
  );
}

const SOURCE_STATUS_LABELS = {
  ongoing: "Ongoing",
  completed: "Completed",
  hiatus: "On hiatus",
  cancelled: "Cancelled",
} as const;

const RELATIONSHIP_LABELS = {
  sequel: "a sequel of",
  prequel: "a prequel of",
  spinoff: "a spinoff of",
  reboot: "a reboot of",
  sideStory: "a side story of",
  other: "related to",
} as const;

type Volume = SeriesPageData["volumes"][number];
type Edition = Volume["editions"][number];
type Release = Edition["releases"][number];

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The packaging facts the hero states, rolled up from the Volume sequence:
 * how many distinct Editions cover this Series, how many Releases realize
 * them, which Publishers issue them, and which Edition Lines they belong to.
 * Everything is counted from the page's own data — nothing is fetched or
 * guessed.
 */
function packagingFacts(volumes: Volume[]) {
  const editions = new Set<number>();
  const publishers = new Map<string, string>();
  const lines = new Set<string>();
  let releases = 0;
  // The span of dated Releases, at whatever precision each date is known to.
  let first: Release["pubDate"] = null;
  let last: Release["pubDate"] = null;
  for (const volume of volumes) {
    for (const edition of volume.editions) {
      if (editions.has(edition.publicId)) continue;
      editions.add(edition.publicId);
      releases += edition.releases.length;
      if (edition.publisher) {
        publishers.set(edition.publisher.slug, edition.publisher.name);
      }
      if (edition.lineName) lines.add(edition.lineName);
      for (const release of edition.releases) {
        const date = release.pubDate;
        if (!date) continue;
        if (!first || date.sort < first.sort) first = date;
        if (!last || date.sort > last.sort) last = date;
      }
    }
  }
  const from = formatPartialDate(first);
  const to = formatPartialDate(last);
  return {
    editionCount: editions.size,
    releaseCount: releases,
    publishers: [...publishers].map(([slug, name]) => ({ slug, name })),
    lines: [...lines],
    dateSpan: from === null ? null : from === to ? from : `${from} – ${to}`,
  };
}

function seriesLinkParams(publicId: number, title: string) {
  const canonical = seriesPath(publicId, title);
  const slug = canonical.split("/").pop() ?? "";
  return { publicId: String(publicId), slug };
}

function SeriesPage() {
  const page = Route.useLoaderData();
  const { series, family, volumes, coverUrl } = page;
  const facts = packagingFacts(volumes);

  return (
    <main className="series-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>Series</span>
      </nav>

      <section className="series-hero">
        <div className="series-hero-aside">
          <div className="series-cover">
            {/* The representative cover the query picked: the first Release
                with art in reading order. Coverless Series get the cloth
                binding rather than a broken image. */}
            <Cover src={coverUrl} title={series.title} lazy={false} />
          </div>
          {facts.dateSpan ? (
            <p className="note">English releases on file: {facts.dateSpan}.</p>
          ) : null}
          {coverUrl ? null : (
            <p className="note">No cover art on file yet.</p>
          )}
        </div>

        <div className="series-hero-body">
          <h1 className="series-title">{series.title}</h1>
          <div className="chips">
            {series.sourceStatus ? (
              <span className="chip" title="Status of the original publication">
                {SOURCE_STATUS_LABELS[series.sourceStatus]}
              </span>
            ) : null}
            <span className="chip">
              {plural(volumes.length, "volume", "volumes")}
            </span>
            {facts.lines.map((line) => (
              <span key={line} className="chip chip--line">
                {line}
              </span>
            ))}
          </div>

          <dl className="facts">
            {series.sourceStatus ? (
              <div>
                <dt className="fact-term">Source status</dt>
                <dd className="fact-def">
                  {SOURCE_STATUS_LABELS[series.sourceStatus]} in Japanese
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="fact-term">Volumes</dt>
              <dd className="fact-def">
                {volumes.length} in the canonical sequence
              </dd>
            </div>
            {facts.editionCount > 0 ? (
              <div>
                <dt className="fact-term">English packaging</dt>
                <dd className="fact-def">
                  {plural(facts.editionCount, "edition", "editions")},{" "}
                  {plural(facts.releaseCount, "release", "releases")}
                </dd>
              </div>
            ) : null}
            {facts.publishers.length > 0 ? (
              <div>
                <dt className="fact-term">Publishers</dt>
                <dd className="fact-def">
                  {facts.publishers.map((publisher, i) => (
                    <span key={publisher.slug}>
                      {i > 0 ? ", " : ""}
                      <Link
                        to="/publisher/$slug"
                        params={{ slug: publisher.slug }}
                      >
                        {publisher.name}
                      </Link>
                    </span>
                  ))}
                </dd>
              </div>
            ) : null}
            {family ? (
              <div>
                <dt className="fact-term">Series family</dt>
                <dd className="fact-def">
                  {family.name}
                  {/* The siblings, linked from the hero; the shelf further
                      down shows them as books with their relationships. */}
                  <span className="fact-sub">
                    {family.members
                      .filter((member) => member.publicId !== series.publicId)
                      .map((member, i) => (
                        <span key={member.publicId}>
                          {i > 0 ? ", " : ""}
                          <Link
                            to="/series/$publicId/$slug"
                            params={seriesLinkParams(
                              member.publicId,
                              member.title,
                            )}
                          >
                            {member.title}
                          </Link>
                        </span>
                      ))}
                  </span>
                </dd>
              </div>
            ) : null}
            {series.altTitles.length > 0 ? (
              <div>
                <dt className="fact-term">Also known as</dt>
                <dd className="fact-def">{series.altTitles.join(", ")}</dd>
              </div>
            ) : null}
          </dl>

          {/* The signed-in tracking bar. Every control inside renders null
              signed out, which leaves the bar empty — CSS hides it then, so
              the public page keeps the hero clean. */}
          <div className="owner-bar">
            {/* Series Follow is the explicit toggle for future-release
                interest (#29); always private in v1. */}
            <SeriesFollowControls seriesPublicId={series.publicId} />
            {/* Series Reading Status is set only here, by explicit choice
                (#28); the tracking prompts never change it without
                confirmation. */}
            <SeriesReadingControls seriesPublicId={series.publicId} />
            {/* Per-Series visibility overrides for the public profile (#30). */}
            <SeriesVisibilityControls seriesPublicId={series.publicId} />
            <SeriesReadingProgress
              seriesPublicId={series.publicId}
              volumeCount={volumes.length}
            />
          </div>
        </div>
      </section>

      <section className="section reading-path">
        <div className="section-head">
          <h2 className="section-title">Reading path</h2>
          <p className="section-note">
            The canonical volume sequence. Open a volume for its own page, or
            its shelf below for every edition and release that covers it.
          </p>
        </div>
        {volumes.length === 0 ? (
          <p className="notice">
            No volumes are recorded for this series yet.
          </p>
        ) : (
          <div className="shelf">
            {volumes.map((volume) => (
              <VolumeShelfItem
                key={volume.publicId}
                volume={volume}
                seriesTitle={series.title}
                seriesPublicId={series.publicId}
              />
            ))}
          </div>
        )}
      </section>

      {volumes.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Editions, volume by volume</h2>
            <p className="section-note">
              Each volume opens onto the editions that collect it. Edition line
              numbering is the publisher's own and never the canonical
              sequence.
            </p>
          </div>
          <div className="vol-panels">
            {volumes.map((volume, i) => (
              <VolumePanel
                key={volume.publicId}
                volume={volume}
                seriesTitle={series.title}
                // The first volume opens by default: one worked example of
                // the edition/release structure, without unrolling the
                // whole series.
                open={i === 0}
              />
            ))}
          </div>
        </section>
      ) : null}

      {family ? <FamilySection family={family} self={series} /> : null}

      {/* Partially imported Series show as-is; every Series page carries the
          report affordance feeding the proposal queue (#40, spec §7). */}
      <SeriesReportAffordance seriesPublicId={series.publicId} />

      {/* Public revision history + the data-team entry points (#31/#32). */}
      <RecordHistory type="series" publicId={series.publicId} />
      <ModEditLink type="series" editKey={String(series.publicId)} />
      <ProposeNewRecordsLink seriesPublicId={series.publicId} />
    </main>
  );
}

/** Volume Label if the publisher gave one, else the em dash (spec §2). */
function volumeLabelText(volume: Volume): string {
  return volume.label !== null ? `Volume ${volume.label}` : "Unnumbered volume";
}

function releaseCountOf(volume: Volume): number {
  return volume.editions.reduce((n, edition) => n + edition.releases.length, 0);
}

/**
 * One book on the wall. The cloth binding carries the Volume Label (what the
 * publisher prints on the spine); the badge carries the Volume Position (the
 * canonical sort key, spec §2) — they are deliberately never conflated.
 * `seriesPage` has no per-Volume cover art, so these are cloth bindings until
 * it does; the hero shows the one representative cover the query finds.
 */
function VolumeShelfItem({
  volume,
  seriesTitle,
  seriesPublicId,
}: {
  volume: Volume;
  seriesTitle: string;
  seriesPublicId: number;
}) {
  const title = volumeTitle(seriesTitle, volume.label);
  const releaseCount = releaseCountOf(volume);
  return (
    <div className="shelf-item">
      <div className="cover-wrap">
        {/* Links the Volume page (ticket #23): every covering Release with
            complete/partial coverage listed distinctly. */}
        <Link
          className="cover-link"
          to="/volume/$publicId/$slug"
          params={slugParams(volume.publicId, title)}
          aria-label={title}
        >
          <Cover
            title={title}
            // A Volume Label goes on the cloth as the big number; an
            // unlabeled Volume (a oneshot, an extra) carries its title
            // instead — it has no number to print.
            numbered={
              volume.label !== null
                ? { series: seriesTitle, number: volume.label }
                : undefined
            }
            badges={
              <span
                className="vol-index"
                title="Position in the canonical reading order"
              >
                #{volume.position}
              </span>
            }
          />
        </Link>
      </div>
      <div className="caption">
        <Link
          className="caption-title"
          to="/volume/$publicId/$slug"
          params={slugParams(volume.publicId, title)}
        >
          {volumeLabelText(volume)}
        </Link>
        <div className="caption-meta">
          {volume.editions.length === 0 ? (
            <span>No English edition yet</span>
          ) : (
            <>
              <a className="caption-open" href={`#volume-${volume.position}`}>
                {plural(volume.editions.length, "edition", "editions")}
              </a>
              <span className="dot" />
              <span>{plural(releaseCount, "release", "releases")}</span>
            </>
          )}
        </div>
        {/* Durable, edition-independent read count (#28); signed-in only. */}
        <VolumeReadCount
          seriesPublicId={seriesPublicId}
          volumePublicId={volume.publicId}
        />
      </div>
    </div>
  );
}

/**
 * The Volume's editions, stacked like books laid on their side. Still a
 * `<details>`, so it stays keyboard-operable and works with no JavaScript;
 * the cover wall above links each volume's caption to this panel.
 */
function VolumePanel({
  volume,
  seriesTitle,
  open,
}: {
  volume: Volume;
  seriesTitle: string;
  open?: boolean;
}) {
  const title = volumeTitle(seriesTitle, volume.label);
  const releaseCount = releaseCountOf(volume);
  return (
    <details
      className="vol-panel"
      id={`volume-${volume.position}`}
      open={open}
    >
      <summary className="vol-panel-head">
        <h3 className="vol-panel-title">{volumeLabelText(volume)}</h3>
        <span className="chip" title="Position in the canonical reading order">
          #{volume.position}
        </span>
        <span className="vol-panel-note">
          {volume.editions.length === 0
            ? "No English edition yet"
            : `${plural(volume.editions.length, "edition", "editions")} · ${plural(releaseCount, "release", "releases")}`}
        </span>
      </summary>
      <div className="vol-panel-body">
        {volume.synopsis ? (
          <p className="vol-synopsis">{volume.synopsis}</p>
        ) : null}
        {volume.editions.length > 0 ? (
          <div className="spines">
            {volume.editions.map((edition) => (
              <EditionSpine
                key={edition.publicId}
                edition={edition}
                volume={volume}
                seriesTitle={seriesTitle}
              />
            ))}
          </div>
        ) : null}
        <p className="note">
          <Link
            to="/volume/$publicId/$slug"
            params={slugParams(volume.publicId, title)}
          >
            Open the full volume page
          </Link>
        </p>
      </div>
    </details>
  );
}

/** Coverage rows in canonical reading order; Labels display, Positions sort. */
function orderedCoverage(edition: Edition) {
  return [...edition.coverage].sort((a, b) => a.position - b.position);
}

/**
 * What this Edition contains, said once: "covers this volume completely" for
 * the ordinary one-to-one case, the full ordered span for an omnibus or a
 * split edition, with partial coverage always called out.
 */
function coverageSentence(edition: Edition): string {
  const coverage = orderedCoverage(edition);
  if (coverage.length <= 1) {
    return edition.extentForVolume === "partial"
      ? "Covers part of this volume"
      : "Covers this volume completely";
  }
  const spans = coverage.map(
    (cov) =>
      `Vol ${cov.label ?? `#${cov.position}`}${cov.extent === "partial" ? " (part)" : ""}`,
  );
  return `Covers ${spans.join(", ")}`;
}

/** The short mark on the spine's head band: line position, else the label. */
function spineMark(edition: Edition, volume: Volume): string {
  if (edition.lineName) {
    const initial = edition.lineName.slice(0, 1).toUpperCase();
    return edition.linePosition ? `${initial}${edition.linePosition}` : initial;
  }
  return volume.label ?? String(volume.position);
}

function EditionSpine({
  edition,
  volume,
  seriesTitle,
}: {
  edition: Edition;
  volume: Volume;
  seriesTitle: string;
}) {
  // The Edition's title is composed, never stored (spec §8).
  const title = editionTitle({
    seriesTitle,
    lineName: edition.lineName,
    linePosition: edition.linePosition,
    covered: orderedCoverage(edition).map((cov) => ({
      label: cov.label,
      position: cov.position,
    })),
  });
  const notes = orderedCoverage(edition).filter((cov) => cov.note !== null);
  const style = { "--cloth": clothColor(title) } as CSSProperties;
  return (
    <article className="spine" style={style}>
      <span className="spine-head" aria-hidden="true">
        {spineMark(edition, volume)}
      </span>
      <div className="spine-body">
        <h4 className="spine-title">
          {/* Links the Edition page — the book detail page (ticket #23). */}
          <Link
            to="/edition/$publicId/$slug"
            params={slugParams(edition.publicId, title)}
          >
            {title}
          </Link>
        </h4>
        <p className="spine-cov">
          {edition.publisher ? `${edition.publisher.name} · ` : ""}
          {coverageSentence(edition)}
        </p>
        {/* Edition Line Position is publisher package numbering — never the
            canonical volume number (spec §2). */}
        {edition.lineName ? (
          <p className="spine-line">
            {edition.lineName}
            {edition.linePosition ? `, position ${edition.linePosition}` : ""}
          </p>
        ) : null}
        {notes.map((cov) => (
          <p key={cov.volumePublicId} className="spine-line">
            Vol {cov.label ?? `#${cov.position}`} — {cov.note}
          </p>
        ))}
      </div>
      <div className="spine-releases">
        {edition.releases.map((release) => (
          <SpineRelease key={release.id} release={release} />
        ))}
      </div>
    </article>
  );
}

/**
 * A Release as a line on the spine's end band: the publication facts that
 * tell two Releases of one Edition apart, then the signed-in tracking
 * controls. The Release Description lives on the Volume and Edition pages —
 * the reading path keeps to dates, formats, and identifiers.
 */
function SpineRelease({ release }: { release: Release }) {
  const date = formatPartialDate(release.pubDate);
  const price = formatPrice(release.price);
  // Binding describes physical construction only (glossary: Binding).
  const binding = release.format === "physical" ? release.binding : null;
  return (
    <div className="spine-rel" id={release.isbn13 ?? undefined}>
      <p className="spine-rel-facts">
        <span className="spine-rel-date">{date ?? "Date TBA"}</span>
        <span className="chip">
          {release.format === "physical" ? "Physical" : "Digital"}
        </span>
        {binding ? <span>{binding}</span> : null}
        {release.language !== "en" ? <span>{release.language}</span> : null}
        {release.isbn13 ? (
          <span className="spine-rel-isbn">{release.isbn13}</span>
        ) : null}
        {price ? <span className="spine-rel-price">{price}</span> : null}
      </p>
      {release.variants.length > 0 ? (
        <p className="spine-rel-note">
          Cover variants:{" "}
          {release.variants.map((variant) => variant.name).join(", ")}
        </p>
      ) : null}
      {release.bundles.length > 0 ? (
        <p className="spine-rel-note">
          Also sold inside{" "}
          {release.bundles.map((bundle, i) => (
            <span key={bundle.publicId}>
              {i > 0 ? ", " : ""}
              <Link
                to="/bundle/$publicId/$slug"
                params={slugParams(bundle.publicId, bundle.name)}
              >
                {bundle.name}
              </Link>
            </span>
          ))}
        </p>
      ) : null}
      <div className="spine-rel-controls">
        {/* Collection Entry controls (#27); render nothing signed out. */}
        <ReleaseCollectionControls releaseId={release.id} />
        {/* Release Progress pass controls (#28); render nothing signed out. */}
        <ReleasePassControls releaseId={release.id} />
      </div>
    </div>
  );
}

/**
 * The Series Family shelf: sibling Series stand next to this one, each
 * keeping its own Volume sequence. The typed relationships are spelled out
 * underneath as sentences — the edge is stored once, whichever end this
 * Series is.
 */
function FamilySection({
  family,
  self,
}: {
  family: NonNullable<SeriesPageData["family"]>;
  self: SeriesPageData["series"];
}) {
  return (
    <section className="section series-family">
      <div className="section-head">
        <h2 className="section-title">{family.name} series family</h2>
        <p className="section-note">
          Related series share this shelf and keep their own volume sequences.
        </p>
      </div>
      <div className="shelf">
        {family.members.map((member) => {
          const isSelf = member.publicId === self.publicId;
          return (
            <div className="shelf-item" key={member.publicId}>
              <div className="cover-wrap">
                {isSelf ? (
                  <Cover title={member.title} />
                ) : (
                  <Link
                    className="cover-link"
                    to="/series/$publicId/$slug"
                    params={seriesLinkParams(member.publicId, member.title)}
                    aria-label={member.title}
                  >
                    <Cover title={member.title} />
                  </Link>
                )}
              </div>
              <div className="caption">
                {isSelf ? (
                  <span className="caption-title" aria-current="page">
                    {member.title}
                  </span>
                ) : (
                  <Link
                    className="caption-title"
                    to="/series/$publicId/$slug"
                    params={seriesLinkParams(member.publicId, member.title)}
                  >
                    {member.title}
                  </Link>
                )}
                <div className="caption-meta">
                  {isSelf ? <span>You are here</span> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {family.relationships.length > 0 ? (
        <ul className="family-relationships">
          {family.relationships.map((rel, i) => (
            <li key={i}>
              {rel.from.title} is {RELATIONSHIP_LABELS[rel.type]} {rel.to.title}
              {rel.note ? ` — ${rel.note}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
