import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { formatPartialDate, formatPrice } from "~/lib/format";
import { ModEditLink, RecordHistory } from "~/lib/moderation";
import { bundlePath, editionPath, parsePublicId } from "~/lib/slug";
import { fetchBundlePage, type BundlePageData } from "~/server/catalogPages";

/**
 * The Bundle page (ticket #23, spec §2/§11): `/bundle/{id}/{slug}`,
 * server-rendered from Convex. A Release Bundle is a purchasable box set
 * with its own publication facts (box-set ISBN, date, price); its member
 * Releases keep their individual identities, so each member links back to
 * its Edition page anchored at the Release row — and Release/Volume views
 * link here in return. When the box set pins a member's Release Variant
 * (e.g. an exclusive cover), the member names it.
 *
 * A stale slug or a merged Bundle's old ID 301s to the canonical URL; a
 * box-set ISBN pasted into search 301s here via `/isbn/{isbn}`.
 */
export const Route = createFileRoute("/bundle/$publicId/$slug")({
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    const page = await fetchBundlePage({ data: publicId });
    if (!page) throw notFound();
    const canonical = bundlePath(page.bundle.publicId, page.bundle.name);
    if (`/bundle/${params.publicId}/${params.slug}` !== canonical) {
      throw redirect({ href: canonical, statusCode: 301 });
    }
    return page;
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: `${loaderData.bundle.name} (Manga box set) — MangaDB` },
          {
            name: "description",
            content: `${loaderData.bundle.name}${
              loaderData.bundle.publisher
                ? ` from ${loaderData.bundle.publisher.name}`
                : ""
            }: the ${loaderData.members.length} books inside, with ISBNs and release dates.`,
          },
        ]
      : [],
  }),
  component: BundlePage,
  notFoundComponent: BundleNotFound,
});

function BundleNotFound() {
  return (
    <main>
      <h1>Bundle not found</h1>
      <p className="notice">
        No bundle lives at this address. <Link to="/">Browse the catalog</Link>.
      </p>
    </main>
  );
}

function BundlePage() {
  const { bundle, members } = Route.useLoaderData();
  const date = formatPartialDate(bundle.pubDate);
  const price = formatPrice(bundle.price);
  const form =
    bundle.format === "physical"
      ? "Physical"
      : bundle.format === "digital"
        ? "Digital"
        : null;

  return (
    <main className="bundle-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>Bundle</span>
      </nav>

      <h1>{bundle.name}</h1>
      <p className="series-facts">
        {bundle.publisher ? (
          <span className="fact">Published by {bundle.publisher.name}</span>
        ) : null}
        {form ? <span className="fact">{form}</span> : null}
        {date ? <span className="fact">{date}</span> : null}
        {bundle.isbn13 ? (
          <span className="fact release-isbn">ISBN-13 {bundle.isbn13}</span>
        ) : null}
        {bundle.isbn10 ? (
          <span className="fact release-isbn">ISBN-10 {bundle.isbn10}</span>
        ) : null}
        {price ? <span className="fact release-price">{price}</span> : null}
      </p>
      {bundle.description ? (
        <p className="release-description">{bundle.description}</p>
      ) : null}

      <section className="bundle-members">
        <h2>In this bundle</h2>
        <p className="section-hint">
          Each book keeps its own release identity — follow it to its edition
          page.
        </p>
        {members.length === 0 ? (
          <p className="notice">No member releases recorded yet.</p>
        ) : (
          <ol className="release-list">
            {members.map((member) => (
              <BundleMember key={member.anchor} member={member} />
            ))}
          </ol>
        )}
      </section>

      {/* Public revision history + the moderator edit entry point (#31). */}
      <RecordHistory type="releaseBundle" publicId={bundle.publicId} />
      <ModEditLink type="releaseBundle" editKey={String(bundle.publicId)} />
    </main>
  );
}

function BundleMember({
  member,
}: {
  member: BundlePageData["members"][number];
}) {
  const form =
    member.format === "physical"
      ? `Physical${member.binding ? ` · ${member.binding}` : ""}`
      : "Digital";
  const date = formatPartialDate(member.pubDate);
  // Member link: the Edition page anchored at this Release's row (spec §11 —
  // Releases are rows on their Edition page, never standalone).
  const href = `${editionPath(member.edition.publicId, member.edition.title)}#${member.anchor}`;
  return (
    <li className="release">
      <div className="release-facts">
        <span className="release-form">
          <a href={href}>{member.edition.title}</a>
        </span>
        <span>{form}</span>
        {date ? <span className="release-date">{date}</span> : null}
        {member.isbn13 ? (
          <span className="release-isbn">ISBN-13 {member.isbn13}</span>
        ) : null}
      </div>
      {member.pinnedVariant ? (
        <p className="release-variants">
          With the “{member.pinnedVariant.name}” variant
        </p>
      ) : null}
    </li>
  );
}
