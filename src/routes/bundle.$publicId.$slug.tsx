import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { catalogQuery, type BundlePageData } from "~/lib/catalogData";
import { BundleCollectionControls } from "~/lib/collection";
import { Cover } from "~/lib/cover";
import { formatPartialDate, formatPrice, plural } from "~/lib/format";
import { ConcealArt } from "~/lib/mature";
import { ModEditLink, RecordHistory } from "~/lib/moderation";
import { BlurbSource, ContextEditLink, EditLinks } from "~/lib/contextEdit";
import { bundleTitleTag, isoPartialDate, pageHead, truncateDescription } from "~/lib/seo";
import { Breadcrumbs, NotFound } from "~/lib/pageScaffold";
import { bundlePath, editionPath, parsePublicId } from "~/lib/slug";

/**
 * The Bundle page (spec §2/§11): `/bundle/{id}/{slug}`,
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
    const page = await catalogQuery(api.catalogPages.bundlePage, { publicId });
    if (!page) throw notFound();
    const canonical = bundlePath(page.bundle.publicId, page.bundle.name);
    if (`/bundle/${params.publicId}/${params.slug}` !== canonical) {
      throw redirect({ href: canonical, statusCode: 301 });
    }
    return page;
  },
  // Title/description formulas, cover-led social card, canonical link, and
  // BreadcrumbList JSON-LD (spec §11). Facts lead; the Bundle's
  // publisher blurb is the fallback.
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { bundle, members, mature } = loaderData;
    const path = bundlePath(bundle.publicId, bundle.name);
    const facts = [
      bundle.publisher ? `from ${bundle.publisher.name}` : null,
      bundle.contents ? `holding ${bundle.contents}` : `the ${members.length} books inside`,
      bundle.pubDate ? `released ${isoPartialDate(bundle.pubDate)}` : null,
      bundle.isbn13 ? `box set ISBN ${bundle.isbn13}` : null,
    ].filter((fact) => fact !== null);
    return pageHead({
      title: bundleTitleTag(bundle.name, bundle.publisher?.name ?? null),
      description: `${bundle.name} ${facts.join(", ")}.${
        bundle.description ? ` ${truncateDescription(bundle.description, 80)}` : ""
      }`,
      path,
      image: bundle.coverUrl,
      ogType: "book",
      mature,
      breadcrumbs: [{ name: bundle.name }],
    });
  },
  component: ConcealedBundlePage,
  notFoundComponent: () => <NotFound noun="Bundle" />,
});

/** A Mature Series' page hides its art from viewers who have not opted in (lib/mature.tsx). */
function ConcealedBundlePage() {
  return (
    <ConcealArt mature={Route.useLoaderData().mature}>
      <BundlePage />
    </ConcealArt>
  );
}

/** The box set as the edit links' owner. */
function bundleOwner(bundle: { publicId: number }) {
  return { type: "releaseBundle" as const, key: String(bundle.publicId), label: "this box set" };
}

function BundlePage() {
  const { bundle, members } = Route.useLoaderData();
  const date = formatPartialDate(bundle.pubDate);
  const price = formatPrice(bundle.price);

  return (
    <main className="bundle-page">
      <Breadcrumbs trail={["Bundle"]} />

      <section className="detail-hero">
        <div className="detail-cover">
          <div className="detail-cover-plate">
            <Cover
              src={bundle.coverUrl}
              isbn13={bundle.isbn13}
              title={bundle.name}
              foot={[plural(members.length, "book"), bundle.publisher?.name]}
              lazy={false}
            />
          </div>
          {/* Collection Entry controls; render nothing signed out.
              Owning the box set confers Derived Ownership on every member. */}
          <BundleCollectionControls bundleId={bundle.id} />
          <EditLinks id="cover">
            <ContextEditLink owner={bundleOwner(bundle)} anchor="cover">
              {bundle.coverUrl ? "Change cover" : "Add a cover"}
            </ContextEditLink>
          </EditLinks>
        </div>

        <div className="detail-body">
          <h1 className="detail-title">{bundle.name}</h1>
          <p className="fact-chips">
            {bundle.publisher ? (
              <Link className="chip" to="/publisher/$slug" params={{ slug: bundle.publisher.slug }}>
                {bundle.publisher.name}
              </Link>
            ) : null}
            {bundle.format === "physical" ? (
              <span className="chip chip--physical">Physical</span>
            ) : bundle.format === "digital" ? (
              <span className="chip chip--digital">Digital</span>
            ) : null}
            <span className="chip">
              {members.length === 1 ? "1 book inside" : `${members.length} books inside`}
            </span>
            {bundle.contents ? <span className="chip">{bundle.contents}</span> : null}
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
            <div className="detail-blurb">
              <p>{bundle.description}</p>
              <BlurbSource attribution={bundle.attribution} />
            </div>
          ) : null}
          <EditLinks>
            <ContextEditLink owner={bundleOwner(bundle)} anchor="description">
              {bundle.description ? "Edit description" : "Write a description"}
            </ContextEditLink>
          </EditLinks>
          <p className="detail-note">
            A box set has its own publication facts. Each book inside keeps its own release identity
            — and its own place in your collection.
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
              <p className="section-note">Who made this box set, and what they ship next.</p>
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

      {/* Public revision history + the moderator edit entry point. */}
      <RecordHistory type="releaseBundle" publicId={bundle.publicId} />
      <ModEditLink type="releaseBundle" editKey={String(bundle.publicId)} />
    </main>
  );
}

function BundleMember({ member }: { member: BundlePageData["members"][number] }) {
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
