import {
  createFileRoute,
  Link,
  notFound,
  redirect,
} from "@tanstack/react-router";

import { BundleCollectionControls } from "~/lib/collection";
import { Cover } from "~/lib/cover";
import { formatPartialDate, formatPrice } from "~/lib/format";
import { ModEditLink, RecordHistory } from "~/lib/moderation";
import {
  breadcrumbListJsonLd,
  bundleTitleTag,
  isoPartialDate,
  jsonLdScript,
  pageHead,
  truncateDescription,
} from "~/lib/seo";
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
  // Title/description formulas, cover-led social card, canonical link, and
  // BreadcrumbList JSON-LD (spec §11, ticket #39). Facts lead; the Bundle's
  // publisher blurb is the fallback.
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { bundle, members } = loaderData;
    const path = bundlePath(bundle.publicId, bundle.name);
    const facts = [
      bundle.publisher ? `from ${bundle.publisher.name}` : null,
      `the ${members.length} books inside`,
      bundle.pubDate ? `released ${isoPartialDate(bundle.pubDate)}` : null,
      bundle.isbn13 ? `box set ISBN ${bundle.isbn13}` : null,
    ].filter((fact) => fact !== null);
    return {
      ...pageHead({
        title: bundleTitleTag(bundle.name, bundle.publisher?.name ?? null),
        description: `${bundle.name} ${facts.join(", ")}.${
          bundle.description
            ? ` ${truncateDescription(bundle.description, 80)}`
            : ""
        }`,
        path,
        image: bundle.coverUrl,
        ogType: "book",
      }),
      scripts: [
        jsonLdScript(
          breadcrumbListJsonLd([
            { name: "MangaDB", path: "/" },
            { name: bundle.name },
          ]),
        ),
      ],
    };
  },
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

  return (
    <main className="bundle-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>Bundle</span>
      </nav>

      <section className="detail-hero">
        <div className="detail-cover">
          <div className="detail-cover-plate">
            <Cover
              src={bundle.coverUrl}
              title={bundle.name}
              foot={[
                members.length === 1 ? "1 book" : `${members.length} books`,
                bundle.publisher?.name,
              ]}
              lazy={false}
            />
          </div>
          {/* Collection Entry controls (#27); render nothing signed out.
              Owning the box set confers Derived Ownership on every member. */}
          <BundleCollectionControls bundleId={bundle.id} />
        </div>

        <div className="detail-body">
          <h1 className="detail-title">{bundle.name}</h1>
          <p className="fact-chips">
            {bundle.publisher ? (
              <Link
                className="chip"
                to="/publisher/$slug"
                params={{ slug: bundle.publisher.slug }}
              >
                {bundle.publisher.name}
              </Link>
            ) : null}
            {bundle.format === "physical" ? (
              <span className="chip chip--physical">Physical</span>
            ) : bundle.format === "digital" ? (
              <span className="chip chip--digital">Digital</span>
            ) : null}
            <span className="chip">
              {members.length === 1
                ? "1 book inside"
                : `${members.length} books inside`}
            </span>
          </p>

          <p className="release-line detail-line">
            {date ? <span className="release-date">{date}</span> : null}
            {price ? <span className="release-price">{price}</span> : null}
          </p>
          {bundle.isbn13 || bundle.isbn10 ? (
            <p className="release-ids">
              {bundle.isbn13 ? (
                <span className="release-isbn">
                  <span className="release-isbn-kind">ISBN-13</span>
                  {bundle.isbn13}
                </span>
              ) : null}
              {bundle.isbn10 ? (
                <span className="release-isbn">
                  <span className="release-isbn-kind">ISBN-10</span>
                  {bundle.isbn10}
                </span>
              ) : null}
            </p>
          ) : null}
          {bundle.description ? (
            <p className="detail-blurb">{bundle.description}</p>
          ) : null}
          <p className="detail-note">
            A box set has its own publication facts. Each book inside keeps its
            own release identity — and its own place in your collection.
          </p>

          <div className="section-head detail-section-head">
            <h2 className="section-title">In this bundle</h2>
            <p className="section-note">
              In the order the box set packs them; each opens its edition page.
            </p>
          </div>
          {members.length === 0 ? (
            <p className="notice">No member releases recorded yet.</p>
          ) : (
            <ol className="release-rows">
              {members.map((member) => (
                <BundleMember key={member.anchor} member={member} />
              ))}
            </ol>
          )}
        </div>
      </section>

      {bundle.publisher ? (
        <>
          <hr className="rule" />
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Keep browsing</h2>
              <p className="section-note">
                Who made this box set, and what they ship next.
              </p>
            </div>
            <div className="directory">
              <Link
                className="directory-row"
                to="/publisher/$slug"
                params={{ slug: bundle.publisher.slug }}
              >
                <span className="directory-name">{bundle.publisher.name}</span>
                <span className="directory-meta">
                  Publisher &middot; profile and upcoming releases
                </span>
              </Link>
            </div>
          </section>
        </>
      ) : null}

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
  const date = formatPartialDate(member.pubDate);
  const binding = member.format === "physical" ? member.binding : null;
  // Member link: the Edition page anchored at this Release's row (spec §11 —
  // Releases are rows on their Edition page, never standalone).
  const href = `${editionPath(member.edition.publicId, member.edition.title)}#${member.anchor}`;
  return (
    <li className="release-row">
      <div className="release-main">
        <h3 className="release-title">
          <a href={href}>{member.edition.title}</a>
        </h3>
        <p className="release-line">
          {member.format === "physical" ? (
            <span className="chip chip--physical">Physical</span>
          ) : (
            <span className="chip chip--digital">Digital</span>
          )}
          {binding ? <span className="release-binding">{binding}</span> : null}
          {date ? <span className="release-date">{date}</span> : null}
        </p>
        {member.isbn13 ? (
          <p className="release-ids">
            <span className="release-isbn">
              <span className="release-isbn-kind">ISBN-13</span>
              {member.isbn13}
            </span>
          </p>
        ) : null}
        {member.pinnedVariant ? (
          <p className="release-variants">
            Packed with the &ldquo;{member.pinnedVariant.name}&rdquo; variant
          </p>
        ) : null}
      </div>
    </li>
  );
}
