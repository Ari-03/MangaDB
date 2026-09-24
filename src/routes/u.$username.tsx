import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import type { CSSProperties } from "react";

import { Cover } from "~/lib/cover";
import { SITE_NAME } from "~/lib/seo";
import { slugParams } from "~/lib/slug";
import { fetchPublicProfile, type PublicProfileData } from "~/server/profile";

const STATUS_LABELS = {
  planToRead: "Plan to Read",
  reading: "Reading",
  paused: "Paused",
  dropped: "Dropped",
  completed: "Completed",
} as const;

/**
 * The public profile page (ticket #30, spec §3/§11): `/u/{username}` is a
 * current-state snapshot of what the user chooses to share — public Ownership
 * (Owned Releases with selected Variants, Bundles with derived member
 * ownership; never Wanted/Ordered) and public Reading (Series Reading Status,
 * active pass percentage, Volume read counts). Follows are never shown in v1,
 * and there is no activity feed. Visibility is enforced in the Convex query
 * (sharing.publicProfile); this page just renders what it is given.
 *
 * It is someone's shelf, so it is drawn as one: every Owned Release is a book,
 * every box set its own short shelf.
 *
 * Public but never indexed (spec §11): robots noindex, absent from sitemaps.
 */
export const Route = createFileRoute("/u/$username")({
  loader: async ({ params }) => {
    const profile = await fetchPublicProfile({ data: params.username });
    if (!profile) throw notFound();
    return profile;
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `@${loaderData.username} — ${SITE_NAME}`
          : `Profile — ${SITE_NAME}`,
      },
      // Profiles are public-but-noindex (spec §11): reachable by link, never
      // by search engine.
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ProfilePage,
  notFoundComponent: ProfileNotFound,
});

function ProfileNotFound() {
  return (
    <main className="profile-page">
      <div className="acct-head">
        <h1 className="acct-title">No shelf here</h1>
        <p className="acct-kicker">
          No one on {SITE_NAME} goes by that name — the username may have
          changed since the link was made.
        </p>
      </div>
      <p className="notfound-cta">
        <Link className="btn btn-primary" to="/">
          Browse the catalog
        </Link>
      </p>
    </main>
  );
}

function ProfilePage() {
  const profile = Route.useLoaderData();
  const { ownership, reading } = profile;
  const ownsAnything =
    ownership.releases.length > 0 || ownership.bundles.length > 0;
  const sharesNothing = !ownsAnything && reading.length === 0;

  return (
    <main className="profile-page">
      <div className="acct-head">
        <h1 className="acct-title">@{profile.username}</h1>
        <p className="acct-kicker">
          What @{profile.username} shares on {SITE_NAME} — current state, not a
          history.
        </p>
        {sharesNothing ? null : (
          <div className="acct-stats">
            {ownership.releases.length > 0 ? (
              <div className="acct-stat">
                <div className="acct-num">{ownership.releases.length}</div>
                <div className="acct-label">
                  {ownership.releases.length === 1 ? "Book" : "Books"} owned
                </div>
              </div>
            ) : null}
            {ownership.bundles.length > 0 ? (
              <div className="acct-stat">
                <div className="acct-num">{ownership.bundles.length}</div>
                <div className="acct-label">
                  Box {ownership.bundles.length === 1 ? "set" : "sets"}
                </div>
              </div>
            ) : null}
            {reading.length > 0 ? (
              <div className="acct-stat">
                <div className="acct-num">{reading.length}</div>
                <div className="acct-label">
                  {reading.length === 1 ? "Series" : "Series"} tracked
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {sharesNothing ? (
        <div className="empty-shelf">
          <div className="ghost-shelf" aria-hidden="true">
            <GhostSpine cloth="#455060" />
            <GhostSpine cloth="#7a2e2a" />
            <GhostSpine cloth="#2b5d5b" />
          </div>
          <div className="empty-note">
            <p>
              @{profile.username} keeps their shelf private. Nothing here is
              hidden from you in particular — tracking on {SITE_NAME} is
              private until its owner opens it.
            </p>
          </div>
        </div>
      ) : (
        <>
          {ownsAnything ? <OwnershipSection ownership={ownership} /> : null}
          {reading.length > 0 ? <ReadingSection reading={reading} /> : null}
        </>
      )}
    </main>
  );
}

function GhostSpine({ cloth }: { cloth: string }) {
  return (
    <div className="ghost-spine">
      <span className="cover">
        <span className="cover-ph" style={{ "--cloth": cloth } as CSSProperties} />
      </span>
    </div>
  );
}

type ReleaseRow = PublicProfileData["ownership"]["releases"][number];

function releaseFacts(row: {
  format: "physical" | "digital";
  binding: string | null;
  variantName: string | null;
}) {
  const form =
    row.format === "physical"
      ? `Physical${row.binding ? ` · ${row.binding}` : ""}`
      : "Digital";
  return `${form}${row.variantName ? ` · ${row.variantName} variant` : ""}`;
}

/** One Owned Release, shelved: the book, then its title and edition facts. */
function ReleaseItem({ row }: { row: ReleaseRow }) {
  const params = slugParams(row.editionPublicId, row.editionTitle);
  return (
    <div className="shelf-item">
      <div className="cover-wrap">
        <Link
          className="cover-link"
          to="/edition/$publicId/$slug"
          params={params}
          hash={row.anchor}
        >
          {/* No foot: the caption under the book already carries the
              edition facts, and the placeholder reads better as a plain
              cloth binding with the title on it. */}
          <Cover title={row.editionTitle} />
        </Link>
      </div>
      <div className="caption">
        <Link
          className="caption-title"
          to="/edition/$publicId/$slug"
          params={params}
          hash={row.anchor}
        >
          {row.editionTitle}
        </Link>
        <div className="caption-meta">
          <span>{releaseFacts(row)}</span>
        </div>
      </div>
    </div>
  );
}

/** Owned Releases (with selected Variants) and Bundles with derived members. */
function OwnershipSection({
  ownership,
}: {
  ownership: PublicProfileData["ownership"];
}) {
  return (
    <section className="me-section">
      <div className="section-head">
        <h2 className="section-title">Collection</h2>
        <p className="section-note">Owned only — wanted and ordered stay private</p>
      </div>
      {ownership.releases.length > 0 ? (
        <div className="shelf">
          {ownership.releases.map((row, i) => (
            <ReleaseItem key={i} row={row} />
          ))}
        </div>
      ) : null}
      {ownership.bundles.map((bundle) => (
        <div className="boxset" key={bundle.bundlePublicId}>
          <div className="boxset-head">
            <h3 className="boxset-name">
              <Link
                to="/bundle/$publicId/$slug"
                params={slugParams(bundle.bundlePublicId, bundle.name)}
              >
                {bundle.name}
              </Link>
            </h3>
            <p className="boxset-note">
              Box set
              {bundle.members.length > 0
                ? ` · ${bundle.members.length} books inside`
                : ""}
            </p>
          </div>
          {bundle.members.length > 0 ? (
            <div className="shelf">
              {bundle.members.map((member, i) => (
                <ReleaseItem key={i} row={member} />
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

/** Series Reading Status, Volume read counts, and active pass percentages. */
function ReadingSection({
  reading,
}: {
  reading: PublicProfileData["reading"];
}) {
  return (
    <section className="me-section">
      <div className="section-head">
        <h2 className="section-title">Reading</h2>
        <p className="section-note">Status, read volumes and passes in progress</p>
      </div>
      <ul className="reading-list">
        {reading.map((series) => {
          const params = slugParams(series.seriesPublicId, series.title);
          const readCount = series.readVolumes.length;
          return (
            <li className="reading-row" key={series.seriesPublicId}>
              <Link
                className="reading-cover cover-link"
                to="/series/$publicId/$slug"
                params={params}
              >
                <Cover title={series.title} />
              </Link>
              <div>
                <h3 className="reading-title">
                  <Link to="/series/$publicId/$slug" params={params}>
                    {series.title}
                  </Link>
                </h3>
                <div className="reading-meta">
                  <span className="chip">
                    {series.readingStatus
                      ? STATUS_LABELS[series.readingStatus]
                      : "Untracked"}
                  </span>
                  {series.totalVolumes > 0 ? (
                    <span>
                      {readCount} of {series.totalVolumes}{" "}
                      {series.totalVolumes === 1 ? "volume" : "volumes"} read
                    </span>
                  ) : null}
                </div>
                {series.totalVolumes > 0 ? (
                  <div className="reading-bar">
                    <div className="reading-track">
                      <div
                        className="reading-fill"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.round((readCount / series.totalVolumes) * 100),
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                ) : null}
                {readCount > 0 ? (
                  <div className="vol-ticks">
                    {series.readVolumes.map((volume) => (
                      <span className="vol-tick" key={volume.volumePublicId}>
                        {volume.label ?? volume.position}
                        {volume.readCount > 1 ? ` ×${volume.readCount}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
                {series.passes.length > 0 ? (
                  <ul className="profile-passes">
                    {series.passes.map((pass, i) => (
                      <li key={i}>
                        Reading{" "}
                        <Link
                          to="/edition/$publicId/$slug"
                          params={slugParams(
                            pass.editionPublicId,
                            pass.editionTitle,
                          )}
                          hash={pass.anchor}
                        >
                          {pass.editionTitle}
                        </Link>
                        {pass.percent !== null ? (
                          <span className="pass-facts"> · {pass.percent}%</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
