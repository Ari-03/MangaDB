import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { CoverageChips, ReleaseRow } from "~/lib/catalogRows";
import { Cover, firstIsbn } from "~/lib/cover";
import { ModEditLink, RecordHistory } from "~/lib/moderation";
import { VolumeOwnership } from "~/lib/collection";
import { VolumeReadCount } from "~/lib/reading";
import {
  breadcrumbListJsonLd,
  jsonLdScript,
  pageHead,
  truncateDescription,
  volumeTitleTag,
} from "~/lib/seo";
import { parsePublicId, seriesPath, slugParams, volumePath } from "~/lib/slug";
import { fetchVolumePage, type VolumePageData } from "~/server/catalogPages";

/**
 * The Volume page (ticket #23): `/volume/{id}/{slug}`, server-rendered from
 * Convex. It reveals every Release covering this Volume, grouped under its
 * Edition, with complete and partial coverage listed distinctly — including
 * the omnibus case, whose full ordered Coverage shows what else it spans.
 * Canonical Volume numbering (Position + public Label, spec §2) stays
 * visibly separate from any Edition Line numbering, and Release rows link
 * their containing Bundles.
 *
 * The public ID is identity; the slug is cosmetic, computed from the
 * composed Volume title (spec §8/§11). A stale or wrong slug — including the
 * old ID of a merged Volume, which resolves to its survivor — 301s to the
 * canonical URL.
 */
export const Route = createFileRoute("/volume/$publicId/$slug")({
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    const page = await fetchVolumePage({ data: publicId });
    if (!page) throw notFound();
    const canonical = volumePath(page.volume.publicId, page.volume.title);
    if (`/volume/${params.publicId}/${params.slug}` !== canonical) {
      throw redirect({ href: canonical, statusCode: 301 });
    }
    return page;
  },
  // Title/description formulas, cover-led social card, canonical link, and
  // BreadcrumbList JSON-LD (spec §11, ticket #39). The description falls
  // back to fact assembly when no Volume Synopsis exists.
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { volume, series, editions, coverUrl } = loaderData;
    const path = volumePath(volume.publicId, volume.title);
    const editionCount =
      editions.length === 1 ? "1 English edition" : `${editions.length} English editions`;
    return {
      ...pageHead({
        title: volumeTitleTag(series.title, volume.label),
        description: volume.synopsis
          ? truncateDescription(volume.synopsis)
          : `${volume.title} in English: ${editionCount} with every release date, format, and ISBN.`,
        path,
        image: coverUrl,
        ogType: "book",
      }),
      scripts: [
        jsonLdScript(
          breadcrumbListJsonLd([
            { name: "MangaDB", path: "/" },
            {
              name: series.title,
              path: seriesPath(series.publicId, series.title),
            },
            { name: volume.title },
          ]),
        ),
      ],
    };
  },
  component: VolumePage,
  notFoundComponent: VolumeNotFound,
});

function VolumeNotFound() {
  return (
    <main className="volume-page">
      <h1 className="volume-title">Volume not found</h1>
      <p className="notice">
        No volume lives at this address. <Link to="/">Browse the catalog</Link>.
      </p>
    </main>
  );
}

type CoveringEditionData = VolumePageData["editions"][number];

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function VolumePage() {
  const page = Route.useLoaderData();
  const { volume, series, editions, coverUrl } = page;
  const complete = editions.filter((e) => e.extentForVolume === "complete");
  const partial = editions.filter((e) => e.extentForVolume === "partial");
  const releaseCount = editions.reduce((n, e) => n + e.releases.length, 0);
  // Distinct Publishers issuing the Editions on this page, in first-seen order.
  const publishers = [
    ...new Map(
      editions.flatMap((edition) =>
        edition.publisher
          ? [[edition.publisher.slug, edition.publisher.name] as const]
          : [],
      ),
    ),
  ].map(([slug, name]) => ({ slug, name }));

  return (
    <main className="volume-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <Link
          to="/series/$publicId/$slug"
          params={slugParams(series.publicId, series.title)}
        >
          {series.title}
        </Link>{" "}
        <span aria-hidden="true">/</span>{" "}
        <span>
          {volume.label !== null ? `Volume ${volume.label}` : "Unnumbered volume"}
        </span>
      </nav>

      <div className="volume-hero">
        <div className="volume-hero-aside">
          <div className="volume-cover">
            {/* The representative cover across this Volume's Releases; a
                coverless Volume gets its cloth binding with the Label on it. */}
            <Cover
              src={coverUrl}
              isbn13={firstIsbn(editions)}
              title={volume.title}
              // The Label goes on the cloth; an unlabeled Volume carries its
              // title instead, since it has no number to print.
              numbered={
                volume.label !== null
                  ? { series: series.title, number: volume.label }
                  : undefined
              }
              lazy={false}
            />
          </div>
          {/* The signed-in tracking card. Both controls render null signed
              out, leaving the card empty — CSS hides it then. */}
          <div className="track-card">
            {/* Volume ownership (#27): displayed purely through the owned
                Releases covering it — direct or via an Owned Bundle; no
                stored Volume state. */}
            <VolumeOwnership volumePublicId={volume.publicId} />
            {/* Durable, edition-independent read count (#28). */}
            <VolumeReadCount
              seriesPublicId={series.publicId}
              volumePublicId={volume.publicId}
            />
          </div>
        </div>

        <div className="volume-hero-body">
          <h1 className="volume-title">{volume.title}</h1>
          <div className="chips">
            <Link
              className="chip"
              to="/series/$publicId/$slug"
              params={slugParams(series.publicId, series.title)}
            >
              {series.title}
            </Link>
            {/* Canonical numbering (spec §2): Position sorts, Label displays —
                and neither is ever an Edition Line's own numbering. */}
            <span
              className="chip"
              title="Position in the canonical reading order"
            >
              #{volume.position} in the reading path
            </span>
            <span className="chip">
              {volume.label !== null
                ? `Volume label “${volume.label}”`
                : "Unnumbered volume"}
            </span>
            {publishers.map((publisher) => (
              <Link
                key={publisher.slug}
                className="chip"
                to="/publisher/$slug"
                params={{ slug: publisher.slug }}
              >
                {publisher.name}
              </Link>
            ))}
          </div>

          {volume.synopsis ? (
            <div className="synopsis">
              <p>{volume.synopsis}</p>
              <p className="note">
                Volume synopsis curated by editors. Each release below carries
                its publisher's own description.
              </p>
            </div>
          ) : (
            <div className="synopsis">
              <p className="note">
                No volume synopsis yet. The releases below carry their
                publishers' descriptions.
              </p>
            </div>
          )}

          <div className="section-head volume-editions-head">
            <h2 className="section-title">Editions covering this volume</h2>
            <p className="section-note">
              {editions.length === 0
                ? "None yet"
                : `${plural(editions.length, "edition", "editions")} · ${plural(releaseCount, "release", "releases")}`}
            </p>
          </div>

          {editions.length === 0 ? (
            <p className="notice">
              No release covers this volume yet. Its editions appear here as
              soon as a publisher announces one.
            </p>
          ) : null}

          {complete.map((edition) => (
            <CoveringEdition key={edition.publicId} edition={edition} />
          ))}

          {partial.length > 0 ? (
            <>
              <div className="section-head volume-editions-head">
                <h3 className="section-title">Partial coverage</h3>
                <p className="section-note">
                  Editions whose releases contain only part of this volume.
                </p>
              </div>
              {partial.map((edition) => (
                <CoveringEdition key={edition.publicId} edition={edition} />
              ))}
            </>
          ) : null}
        </div>
      </div>

      {/* Public revision history + the moderator edit entry point (#31). */}
      <RecordHistory type="volume" publicId={volume.publicId} />
      <ModEditLink type="volume" editKey={String(volume.publicId)} />
    </main>
  );
}

function CoveringEdition({ edition }: { edition: CoveringEditionData }) {
  return (
    <article className="vol-edition">
      <header className="vol-edition-head">
        <h3 className="vol-edition-name">
          <Link
            to="/edition/$publicId/$slug"
            params={slugParams(edition.publicId, edition.title)}
          >
            {edition.title}
          </Link>
        </h3>
        {edition.publisher ? (
          <span className="chip">{edition.publisher.name}</span>
        ) : null}
        {/* Edition Line Position is publisher package numbering — never
            the canonical volume number (spec §2). */}
        {edition.lineName ? (
          <span className="chip chip--line">
            {edition.lineName}
            {edition.linePosition ? `, position ${edition.linePosition}` : ""}
          </span>
        ) : null}
        <span className="vol-edition-extent">
          {edition.extentForVolume === "partial"
            ? "Covers part of this volume"
            : "Covers this volume completely"}
        </span>
      </header>

      {edition.extentNote ? (
        <p className="vol-edition-note">{edition.extentNote}</p>
      ) : null}
      {/* The omnibus case: the full ordered Coverage shows every Volume this
          Edition spans, each linking its own page. */}
      {edition.coverage.length > 1 ||
      edition.coverage.some((c) => c.extent === "partial") ? (
        <CoverageChips coverage={edition.coverage} />
      ) : null}

      <ul className="release-rows">
        {edition.releases.map((release) => (
          <ReleaseRow key={release.id} release={release} />
        ))}
      </ul>
    </article>
  );
}
