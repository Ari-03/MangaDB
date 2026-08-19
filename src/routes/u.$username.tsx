import { createFileRoute, Link, notFound } from "@tanstack/react-router";

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
    <main>
      <h1>Profile not found</h1>
      <p className="notice">
        No one lives at this address. <Link to="/">Browse the catalog</Link>.
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
      <h1>@{profile.username}</h1>
      <p className="tagline">
        What @{profile.username} shares on {SITE_NAME} — current state only.
      </p>

      {sharesNothing ? (
        <p className="notice">
          @{profile.username} isn’t sharing anything publicly.
        </p>
      ) : (
        <>
          {ownsAnything ? <OwnershipSection ownership={ownership} /> : null}
          {reading.length > 0 ? <ReadingSection reading={reading} /> : null}
        </>
      )}
    </main>
  );
}

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

function ReleaseItem({
  row,
}: {
  row: PublicProfileData["ownership"]["releases"][number];
}) {
  return (
    <li>
      <Link
        to="/edition/$publicId/$slug"
        params={slugParams(row.editionPublicId, row.editionTitle)}
        hash={row.anchor}
      >
        {row.editionTitle}
      </Link>{" "}
      <span className="pass-facts">{releaseFacts(row)}</span>
    </li>
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
      <h2>Collection</h2>
      {ownership.releases.length > 0 ? (
        <ul>
          {ownership.releases.map((row, i) => (
            <ReleaseItem key={i} row={row} />
          ))}
        </ul>
      ) : null}
      {ownership.bundles.length > 0 ? (
        <>
          <h3>Box sets</h3>
          <ul>
            {ownership.bundles.map((bundle) => (
              <li key={bundle.bundlePublicId}>
                <Link
                  to="/bundle/$publicId/$slug"
                  params={slugParams(bundle.bundlePublicId, bundle.name)}
                >
                  {bundle.name}
                </Link>{" "}
                <span className="pass-facts">Box set</span>
                {bundle.members.length > 0 ? (
                  <ul className="bundle-derived">
                    {bundle.members.map((member, i) => (
                      <ReleaseItem key={i} row={member} />
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
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
      <h2>Reading</h2>
      <ul className="profile-reading">
        {reading.map((series) => (
          <li key={series.seriesPublicId}>
            <Link
              to="/series/$publicId/$slug"
              params={slugParams(series.seriesPublicId, series.title)}
            >
              {series.title}
            </Link>{" "}
            <span className="pass-facts">
              {series.readingStatus
                ? STATUS_LABELS[series.readingStatus]
                : "Untracked"}
              {series.totalVolumes > 0
                ? ` · ${series.readVolumes.length} of ${series.totalVolumes} ${
                    series.totalVolumes === 1 ? "volume" : "volumes"
                  } read`
                : ""}
            </span>
            {series.readVolumes.length > 0 ? (
              <p className="profile-read-volumes">
                {series.readVolumes
                  .map(
                    (volume) =>
                      `Vol ${volume.label ?? `#${volume.position}`}${
                        volume.readCount > 1 ? ` ×${volume.readCount}` : ""
                      }`,
                  )
                  .join(" · ")}
              </p>
            ) : null}
            {series.passes.length > 0 ? (
              <ul className="profile-passes">
                {series.passes.map((pass, i) => (
                  <li key={i}>
                    Reading{" "}
                    <Link
                      to="/edition/$publicId/$slug"
                      params={slugParams(pass.editionPublicId, pass.editionTitle)}
                      hash={pass.anchor}
                    >
                      {pass.editionTitle}
                    </Link>
                    <span className="pass-facts">
                      {pass.percent !== null ? ` · ${pass.percent}%` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
