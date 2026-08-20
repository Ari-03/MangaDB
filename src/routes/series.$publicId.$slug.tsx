import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { editionTitle, volumeTitle } from "../../convex/lib/titles";
import { ReleaseCollectionControls } from "~/lib/collection";
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
 * The canonical Volume sequence leads; publisher packaging (Editions, Edition
 * Lines, Releases, Variants, Bundles) is inspected beneath each Volume.
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
    <main>
      <h1>Series not found</h1>
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

function SeriesPage() {
  const page = Route.useLoaderData();
  const { series, family, volumes } = page;

  return (
    <main className="series-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>Series</span>
      </nav>

      <h1>{series.title}</h1>
      <p className="series-facts">
        {series.sourceStatus ? (
          <span className="fact">
            Source: {SOURCE_STATUS_LABELS[series.sourceStatus]}
          </span>
        ) : null}
        {series.altTitles.length > 0 ? (
          <span className="fact">Also known as {series.altTitles.join(", ")}</span>
        ) : null}
      </p>

      {/* Series Follow is the explicit toggle for future-release interest
          (#29); always private in v1. Renders nothing signed out. */}
      <SeriesFollowControls seriesPublicId={series.publicId} />

      {/* Series Reading Status is set only here, by explicit choice (#28);
          the tracking prompts never change it without confirmation. Renders
          nothing signed out. */}
      <SeriesReadingControls seriesPublicId={series.publicId} />

      {/* Per-Series visibility overrides for the public profile (#30);
          renders nothing signed out. */}
      <SeriesVisibilityControls seriesPublicId={series.publicId} />

      {family ? <FamilySection family={family} self={series} /> : null}

      <section className="reading-path">
        <h2>Reading path</h2>
        <p className="section-hint">
          The canonical volume sequence. Open a volume to see every edition and
          release that covers it.
        </p>
        <ol className="volume-list">
          {volumes.map((volume) => (
            <VolumeItem
              key={volume.publicId}
              volume={volume}
              seriesTitle={series.title}
              seriesPublicId={series.publicId}
            />
          ))}
        </ol>
      </section>

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

function FamilySection({
  family,
  self,
}: {
  family: NonNullable<SeriesPageData["family"]>;
  self: SeriesPageData["series"];
}) {
  return (
    <section className="series-family">
      <h2>{family.name} series family</h2>
      <ul className="family-members">
        {family.members.map((member) =>
          member.publicId === self.publicId ? (
            <li key={member.publicId} aria-current="page">
              {member.title}
            </li>
          ) : (
            <li key={member.publicId}>
              <Link
                to="/series/$publicId/$slug"
                params={seriesLinkParams(member.publicId, member.title)}
              >
                {member.title}
              </Link>
            </li>
          ),
        )}
      </ul>
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

function seriesLinkParams(publicId: number, title: string) {
  const canonical = seriesPath(publicId, title);
  const slug = canonical.split("/").pop() ?? "";
  return { publicId: String(publicId), slug };
}

function VolumeItem({
  volume,
  seriesTitle,
  seriesPublicId,
}: {
  volume: SeriesPageData["volumes"][number];
  seriesTitle: string;
  seriesPublicId: number;
}) {
  const releaseCount = volume.editions.reduce(
    (n, edition) => n + edition.releases.length,
    0,
  );
  return (
    <li className="volume" value={volume.position}>
      <div className="volume-heading">
        {/* Position is the sort key and stays visibly separate from the
            display-only Label (spec §2). */}
        <span className="vol-position" title="Position in the canonical reading order">
          #{volume.position}
        </span>
        <span className="vol-label">
          {/* Links the Volume page (ticket #23): every covering Release with
              complete/partial coverage listed distinctly. */}
          <Link
            to="/volume/$publicId/$slug"
            params={slugParams(
              volume.publicId,
              volumeTitle(seriesTitle, volume.label),
            )}
          >
            {volume.label !== null ? `Volume ${volume.label}` : "Unnumbered volume"}
          </Link>
        </span>
        {/* Durable, edition-independent read count (#28); signed-in only. */}
        <VolumeReadCount
          seriesPublicId={seriesPublicId}
          volumePublicId={volume.publicId}
        />
      </div>
      {volume.synopsis ? <p className="vol-synopsis">{volume.synopsis}</p> : null}
      <details className="volume-editions">
        <summary>
          {volume.editions.length}{" "}
          {volume.editions.length === 1 ? "edition" : "editions"} · {releaseCount}{" "}
          {releaseCount === 1 ? "release" : "releases"}
        </summary>
        {volume.editions.map((edition) => (
          <EditionCard
            key={edition.publicId}
            edition={edition}
            seriesTitle={seriesTitle}
          />
        ))}
      </details>
    </li>
  );
}

type Edition = SeriesPageData["volumes"][number]["editions"][number];

function EditionCard({
  edition,
  seriesTitle,
}: {
  edition: Edition;
  seriesTitle: string;
}) {
  return (
    <article className="edition-card">
      <header className="edition-header">
        <span className="edition-name">
          {/* Links the Edition page — the book detail page (ticket #23). The
              Edition's title is composed, never stored (spec §8). */}
          <Link
            to="/edition/$publicId/$slug"
            params={slugParams(
              edition.publicId,
              editionTitle({
                seriesTitle,
                lineName: edition.lineName,
                linePosition: edition.linePosition,
                covered: edition.coverage.map((c) => ({
                  label: c.label,
                  position: c.position,
                })),
              }),
            )}
          >
            {edition.lineName ?? "Standard edition"}
          </Link>
          {/* Edition Line Position is publisher package numbering — never the
              canonical volume number (spec §2). */}
          {edition.lineName && edition.linePosition ? (
            <span className="line-position" title="Position within the edition line">
              {" "}
              · line #{edition.linePosition}
            </span>
          ) : null}
        </span>
        {edition.publisher ? (
          <span className="edition-publisher">{edition.publisher.name}</span>
        ) : null}
      </header>

      {edition.coverage.length > 1 || edition.coverage.some((c) => c.extent === "partial") ? (
        <p className="coverage">
          Covers{" "}
          {edition.coverage.map((cov, i) => (
            <span key={cov.volumePublicId} className="coverage-chip">
              {i > 0 ? " " : ""}
              Vol {cov.label ?? `#${cov.position}`}
              {cov.extent === "partial" ? " (partial)" : ""}
              {cov.note ? <span className="coverage-note"> — {cov.note}</span> : null}
            </span>
          ))}
        </p>
      ) : null}

      <ul className="release-list">
        {edition.releases.map((release) => (
          <ReleaseRow key={release.id} release={release} />
        ))}
      </ul>
    </article>
  );
}

function ReleaseRow({ release }: { release: Edition["releases"][number] }) {
  const form =
    release.format === "physical"
      ? `Physical${release.binding ? ` · ${release.binding}` : ""}`
      : "Digital";
  const date = formatPartialDate(release.pubDate);
  const price = formatPrice(release.price);
  return (
    <li className="release" id={release.isbn13 ?? undefined}>
      <div className="release-facts">
        <span className="release-form">{form}</span>
        {date ? <span className="release-date">{date}</span> : null}
        {release.isbn13 ? (
          <span className="release-isbn">ISBN {release.isbn13}</span>
        ) : null}
        {price ? <span className="release-price">{price}</span> : null}
      </div>
      {release.description ? (
        <p className="release-description">{release.description}</p>
      ) : null}
      {release.variants.length > 0 ? (
        <p className="release-variants">
          Cover variants:{" "}
          {release.variants.map((variant) => variant.name).join(", ")}
        </p>
      ) : null}
      {release.bundles.length > 0 ? (
        <p className="release-bundles">
          Also in{" "}
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
      {/* Collection Entry controls (#27); render nothing signed out. */}
      <ReleaseCollectionControls releaseId={release.id} />
      {/* Release Progress pass controls (#28); render nothing signed out. */}
      <ReleasePassControls releaseId={release.id} />
    </li>
  );
}
