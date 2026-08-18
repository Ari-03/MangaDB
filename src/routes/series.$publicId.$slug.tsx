import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { parsePublicId, seriesPath } from "~/lib/slug";
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
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: `${loaderData.series.title} (Manga) — MangaDB` },
          {
            name: "description",
            content: `English releases of ${loaderData.series.title}: the canonical volume sequence with every edition and release date.`,
          },
        ]
      : [],
  }),
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

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatPartialDate(
  date: { year: number; month?: number; day?: number } | null,
): string | null {
  if (!date) return null;
  const month = date.month ? MONTHS[date.month - 1] : undefined;
  if (month && date.day) return `${month} ${date.day}, ${date.year}`;
  if (month) return `${month} ${date.year}`;
  return String(date.year);
}

function formatPrice(
  price: { amountCents: number; currency: string } | null,
): string | null {
  if (!price) return null;
  const amount = (price.amountCents / 100).toFixed(2);
  return price.currency === "USD" ? `$${amount}` : `${amount} ${price.currency}`;
}

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

      {family ? <FamilySection family={family} self={series} /> : null}

      <section className="reading-path">
        <h2>Reading path</h2>
        <p className="section-hint">
          The canonical volume sequence. Open a volume to see every edition and
          release that covers it.
        </p>
        <ol className="volume-list">
          {volumes.map((volume) => (
            <VolumeItem key={volume.publicId} volume={volume} />
          ))}
        </ol>
      </section>
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

function VolumeItem({ volume }: { volume: SeriesPageData["volumes"][number] }) {
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
          {volume.label !== null ? `Volume ${volume.label}` : "Unnumbered volume"}
        </span>
      </div>
      {volume.synopsis ? <p className="vol-synopsis">{volume.synopsis}</p> : null}
      <details className="volume-editions">
        <summary>
          {volume.editions.length}{" "}
          {volume.editions.length === 1 ? "edition" : "editions"} · {releaseCount}{" "}
          {releaseCount === 1 ? "release" : "releases"}
        </summary>
        {volume.editions.map((edition) => (
          <EditionCard key={edition.publicId} edition={edition} />
        ))}
      </details>
    </li>
  );
}

type Edition = SeriesPageData["volumes"][number]["editions"][number];

function EditionCard({ edition }: { edition: Edition }) {
  return (
    <article className="edition-card">
      <header className="edition-header">
        <span className="edition-name">
          {edition.lineName ?? "Standard edition"}
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
          Also in {release.bundles.map((bundle) => bundle.name).join(", ")}
        </p>
      ) : null}
    </li>
  );
}
