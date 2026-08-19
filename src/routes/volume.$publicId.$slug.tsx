import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { CoverageChips, ReleaseRow } from "~/lib/catalogRows";
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
 * Canonical Volume numbering (hidden Position + public Label, spec §2) stays
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
    <main>
      <h1>Volume not found</h1>
      <p className="notice">
        No volume lives at this address. <Link to="/">Browse the catalog</Link>.
      </p>
    </main>
  );
}

function VolumePage() {
  const page = Route.useLoaderData();
  const { volume, series, editions } = page;
  const complete = editions.filter((e) => e.extentForVolume === "complete");
  const partial = editions.filter((e) => e.extentForVolume === "partial");

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
        <span aria-hidden="true">/</span> <span>Volume</span>
      </nav>

      <h1>{volume.title}</h1>
      <p className="series-facts">
        {/* Canonical numbering (spec §2): Position sorts, Label displays —
            and neither is ever an Edition Line's own numbering. */}
        <span className="fact vol-position" title="Position in the canonical reading order">
          #{volume.position} in {series.title}
        </span>
        <span className="fact vol-label">
          {volume.label !== null ? `Volume ${volume.label}` : "Unnumbered volume"}
        </span>
        {/* Durable, edition-independent read count (#28); signed-in only. */}
        <VolumeReadCount
          seriesPublicId={series.publicId}
          volumePublicId={volume.publicId}
        />
      </p>
      {volume.synopsis ? <p className="vol-synopsis">{volume.synopsis}</p> : null}

      {/* Volume ownership (#27): displayed purely through the owned Releases
          covering it — direct or via an Owned Bundle; no stored Volume state. */}
      <VolumeOwnership volumePublicId={volume.publicId} />

      {editions.length === 0 ? (
        <p className="notice">No releases cover this volume yet.</p>
      ) : null}

      {complete.length > 0 ? (
        <section className="covering-releases">
          <h2>Complete releases</h2>
          <p className="section-hint">
            Editions whose releases contain all of this volume.
          </p>
          {complete.map((edition) => (
            <CoveringEdition key={edition.publicId} edition={edition} />
          ))}
        </section>
      ) : null}

      {partial.length > 0 ? (
        <section className="covering-releases">
          <h2>Partial coverage</h2>
          <p className="section-hint">
            Editions whose releases contain only part of this volume.
          </p>
          {partial.map((edition) => (
            <CoveringEdition key={edition.publicId} edition={edition} />
          ))}
        </section>
      ) : null}

      {/* Public revision history + the moderator edit entry point (#31). */}
      <RecordHistory type="volume" publicId={volume.publicId} />
      <ModEditLink type="volume" editKey={String(volume.publicId)} />
    </main>
  );
}

type CoveringEditionData = VolumePageData["editions"][number];

function CoveringEdition({ edition }: { edition: CoveringEditionData }) {
  return (
    <article className="edition-card">
      <header className="edition-header">
        <span className="edition-name">
          <Link
            to="/edition/$publicId/$slug"
            params={slugParams(edition.publicId, edition.title)}
          >
            {edition.title}
          </Link>
          {/* Edition Line Position is publisher package numbering — never
              the canonical volume number (spec §2). */}
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

      {edition.extentNote ? (
        <p className="coverage">
          <span className="coverage-note">{edition.extentNote}</span>
        </p>
      ) : null}
      {/* The omnibus case: the full ordered Coverage shows every Volume this
          Edition spans, each linking its own page. */}
      {edition.coverage.length > 1 ||
      edition.coverage.some((c) => c.extent === "partial") ? (
        <CoverageChips coverage={edition.coverage} />
      ) : null}

      <ul className="release-list">
        {edition.releases.map((release) => (
          <ReleaseRow key={release.id} release={release} />
        ))}
      </ul>
    </article>
  );
}
