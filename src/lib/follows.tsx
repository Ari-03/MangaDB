// Series Follows + My Upcoming Releases UI (spec §3), rendered
// as a signed-in overlay like the collection and reading slices: signed-out
// viewers get null from the follow queries, so the public pages render
// identically without the controls. Follows are always private in v1 —
// there is no visibility control to render.

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";

import { api } from "../../convex/_generated/api";
import { track } from "~/lib/analytics";
import { Cover, CoverBadge } from "~/lib/cover";
import { formatPartialDate, plural } from "~/lib/format";
import { sortKeyMonth } from "~/lib/month";
import { convexClient } from "~/providers";
import { useReadyViewer } from "~/lib/viewer";
import { slugParams } from "~/lib/slug";

/** A Series a collection write suggests following (collection.setReleaseEntry and kin). */
export type FollowSuggestion = FunctionReturnType<
  typeof api.collection.setReleaseEntry
>["suggestFollow"][number];

// ---------- Series page follow toggle ----------

/**
 * The explicit Series Follow toggle on the Series page — the one deliberate
 * way to start tracking a Series' future Releases. Renders nothing signed
 * out. It returns the toggle and its hint as bare siblings, so the actions
 * row of the page's TakePanel (lib/reviews.tsx) sets the toggle beside
 * Favorite with the hint under both (and stays empty, and hidden, for
 * signed-out viewers).
 */
export function SeriesFollowControls({
  seriesPublicId,
}: {
  seriesPublicId: number;
}) {
  if (!convexClient) return null;
  return <SeriesFollowControlsInner seriesPublicId={seriesPublicId} />;
}

function SeriesFollowControlsInner({
  seriesPublicId,
}: {
  seriesPublicId: number;
}) {
  const data = useQuery(api.follows.seriesFollow, { seriesPublicId });
  const setFollow = useMutation(api.follows.setSeriesFollow);
  if (!data) return null; // loading, signed out, or username pending
  return (
    <>
      <button
        type="button"
        aria-pressed={data.following}
        className={`follow-btn${data.following ? " is-following" : ""}`}
        onClick={() => {
          const following = !data.following;
          void setFollow({ seriesId: data.seriesId, following }).then(() =>
            track(following ? "series_followed" : "series_unfollowed", {
              seriesId: data.seriesId,
              source: "series_page",
            }),
          );
        }}
      >
        {data.following ? (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M2.6 8.4 6.2 12 13.4 4.4" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M8 3v10M3 8h10" />
          </svg>
        )}
        {data.following ? "Following" : "Follow series"}
      </button>
      <span className="track-hint">
        {data.following
          ? "Announced releases land in your Upcoming. Follows are private."
          : "Follow to get announced releases in your Upcoming. Follows are private."}
      </span>
    </>
  );
}

// ---------- post-first-entry follow prompt ----------

/**
 * The one non-blocking follow prompt per Series (spec §3), rendered from the
 * `suggestFollow` a collection mutation returned after a first Collection
 * Entry in a Series. Only the Follow button creates the follow; "Don't ask
 * again" dismisses permanently; ignoring it changes nothing.
 */
export function FollowPrompt({
  suggestions,
  onDone,
}: {
  suggestions: FollowSuggestion[];
  onDone: () => void;
}) {
  const setFollow = useMutation(api.follows.setSeriesFollow);
  const dismiss = useMutation(api.follows.dismissFollowPrompt);
  if (suggestions.length === 0) return null;
  return (
    <span className="prompt" role="status">
      {suggestions.map((suggestion) => (
        <span key={suggestion.seriesId} className="prompt-line">
          Follow “{suggestion.title}” to see its announced releases in your
          Upcoming?{" "}
          <button
            type="button"
            onClick={() => {
              void setFollow({ seriesId: suggestion.seriesId, following: true }).then(() =>
                track("series_followed", { seriesId: suggestion.seriesId, source: "prompt" }),
              );
              onDone();
            }}
          >
            Follow
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              void dismiss({ seriesId: suggestion.seriesId });
              onDone();
            }}
          >
            Don’t ask again
          </button>{" "}
          <button type="button" onClick={onDone}>
            Not now
          </button>
        </span>
      ))}
    </span>
  );
}

// ---------- library: the Upcoming tab ----------

const FORMAT_LABELS = { physical: "Physical", digital: "Digital" } as const;

const PREFERENCE_LABELS = {
  both: "Physical and digital",
  physical: "Physical only",
  digital: "Digital only",
} as const;

/** A pubDate.sort key back to its partial-precision display form. */
function sortDate(sort: number, day: number | null): string | null {
  const { year, month } = sortKeyMonth(sort);
  return formatPartialDate({
    year,
    month: month || undefined,
    day: day ?? undefined,
  });
}

/**
 * The Upcoming tab of the library: the Series the viewer follows as a rail
 * of covers (each with its next announced date, unfollowable in place), the
 * format preference that scopes them, and My Upcoming Releases —
 * follows.myUpcoming, computed live — as a shelf of covers, nearest first.
 * `todaySort` comes from the page, so its tab count shares this query.
 */
export function LibraryUpcoming({ todaySort }: { todaySort: number }) {
  if (!convexClient) return null;
  return <LibraryUpcomingInner todaySort={todaySort} />;
}

function LibraryUpcomingInner({ todaySort }: { todaySort: number }) {
  const upcoming = useQuery(api.follows.myUpcoming, { todaySort });
  const following = useQuery(api.follows.myFollowing, {});
  const viewer = useReadyViewer();
  const setPreference = useMutation(api.users.setFormatPreference);
  const setFollow = useMutation(api.follows.setSeriesFollow);

  if (upcoming === undefined || following === undefined) {
    return <p className="placeholder">Loading…</p>;
  }
  if (upcoming === null || following === null) return null;

  return (
    <div className="lib-upcoming">
      <section className="lib-block">
        <div className="lib-block-head">
          <h3 className="lib-group-title">Following</h3>
          <p className="lib-block-note">
            {following.series.length === 0
              ? "Follow a series from its page to see its announced releases here. Follows are private."
              : `${plural(following.series.length, "series", "series")} · new releases appear below. Follows are private.`}
          </p>
        </div>
        {following.series.length > 0 ? (
          <div className="rail lib-rail lib-following">
            {following.series.map((series) => {
              const next = sortDate(series.nextReleaseSort, null);
              return (
                <div key={series.seriesId} className="shelf-item">
                  <div className="cover-wrap">
                    <Link
                      className="cover-link"
                      to="/series/$publicId/$slug"
                      params={slugParams(series.seriesPublicId, series.title)}
                      aria-label={series.title}
                    >
                      <Cover
                        src={series.coverUrl}
                        isbn13={series.coverIsbn}
                        title={series.title}
                        followed
                      />
                    </Link>
                    <div className="cover-actions">
                      <div className="cover-actions-row">
                        <button
                          type="button"
                          className="quick-btn"
                          onClick={() =>
                            void setFollow({ seriesId: series.seriesId, following: false }).then(
                              () =>
                                track("series_unfollowed", {
                                  seriesId: series.seriesId,
                                  source: "library",
                                }),
                            )
                          }
                        >
                          Unfollow
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="caption">
                    <Link
                      className="caption-title"
                      to="/series/$publicId/$slug"
                      params={slugParams(series.seriesPublicId, series.title)}
                    >
                      {series.title}
                    </Link>
                    <div className="caption-meta">
                      {series.nextReleaseSort > 0 ? (
                        <span className="caption-date">Next {next}</span>
                      ) : (
                        <span>Nothing announced</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className="lib-block">
        <div className="lib-block-head">
          <h3 className="lib-group-title">Announced releases</h3>
          {viewer ? (
            <label className="upcoming-preference">
              From followed series, show{" "}
              <select
                value={viewer.formatPreference}
                onChange={(event) =>
                  void setPreference({
                    preference: event.currentTarget
                      .value as keyof typeof PREFERENCE_LABELS,
                  })
                }
              >
                {(["both", "physical", "digital"] as const).map((preference) => (
                  <option key={preference} value={preference}>
                    {PREFERENCE_LABELS[preference]}
                  </option>
                ))}
              </select>{" "}
              <span className="pass-facts">Wanted and Ordered items always appear.</span>
            </label>
          ) : null}
        </div>
        {upcoming.items.length === 0 ? (
          <p className="placeholder">
            Follow a series, or mark a release or box set Wanted or Ordered, and
            its announced future releases will appear here.
          </p>
        ) : (
          <div className="shelf">
            {upcoming.items.map((item) => (
              <UpcomingItem key={item.id} item={item} />
            ))}
          </div>
        )}
        {upcoming.capped ? (
          <p className="pass-facts">
            Showing the nearest announced releases; more exist further out.
          </p>
        ) : null}
      </section>
    </div>
  );
}

type UpcomingData = NonNullable<
  FunctionReturnType<typeof api.follows.myUpcoming>
>;

/** One announced release (or box set) as a book on the Upcoming shelf. */
function UpcomingItem({ item }: { item: UpcomingData["items"][number] }) {
  const date = sortDate(item.sort, item.day) ?? "Date TBA";
  if (item.kind === "bundle") {
    return (
      <div className="shelf-item">
        <div className="cover-wrap">
          <Link
            className="cover-link"
            to="/bundle/$publicId/$slug"
            params={slugParams(item.bundlePublicId, item.name)}
            aria-label={item.name}
          >
            <Cover
              title={item.name}
              foot={["Box set", item.format ? FORMAT_LABELS[item.format] : null]}
              badges={<CoverBadge state={item.state} />}
            />
          </Link>
        </div>
        <div className="caption">
          <Link
            className="caption-title"
            to="/bundle/$publicId/$slug"
            params={slugParams(item.bundlePublicId, item.name)}
          >
            {item.name}
          </Link>
          <div className="caption-meta">
            <span className="caption-date">{date}</span>
            <span className="dot" />
            <span>Box set</span>
          </div>
        </div>
      </div>
    );
  }
  const title = item.series.map((series) => series.title).join(" × ");
  const label = item.volumeLabel ? `${title} — ${item.volumeLabel}` : title;
  return (
    <div className="shelf-item">
      <div className="cover-wrap">
        <Link
          className="cover-link"
          to="/edition/$publicId/$slug"
          params={slugParams(item.edition.publicId, item.edition.title)}
          hash={item.anchor}
          aria-label={item.edition.title}
        >
          <Cover
            src={item.coverUrl}
            isbn13={item.coverIsbns}
            title={item.edition.title}
            foot={[item.volumeLabel, item.publisher?.name]}
            badges={item.state ? <CoverBadge state={item.state} /> : undefined}
            followed={item.followed}
          />
        </Link>
      </div>
      <div className="caption">
        <Link
          className="caption-title"
          to="/edition/$publicId/$slug"
          params={slugParams(item.edition.publicId, item.edition.title)}
          hash={item.anchor}
        >
          {label}
        </Link>
        <div className="caption-meta">
          <span className="caption-date">{date}</span>
          <span className="dot" />
          <span>
            {item.format === "physical"
              ? (item.binding ?? "Print")
              : "Digital"}
            {item.publisher ? ` · ${item.publisher.name}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
