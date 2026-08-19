// Series Follows + My Upcoming Releases UI (ticket #29, spec §3), rendered
// as a signed-in overlay like the collection and reading slices: signed-out
// viewers get null from the follow queries, so the public pages render
// identically without the controls. Follows are always private in v1 —
// there is no visibility control to render.

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { formatPartialDate } from "~/lib/format";
import { todaySortKey } from "~/lib/month";
import { convexClient } from "~/providers";
import { slugParams } from "~/lib/slug";

export type FollowSuggestion = { seriesId: Id<"series">; title: string };

// ---------- Series page follow toggle ----------

/**
 * The explicit Series Follow toggle on the Series page — the one deliberate
 * way to start tracking a Series' future Releases. Renders nothing signed
 * out.
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
    <div className="follow-controls">
      <button
        type="button"
        aria-pressed={data.following}
        className={data.following ? "follow-active" : undefined}
        onClick={() =>
          void setFollow({ seriesId: data.seriesId, following: !data.following })
        }
      >
        {data.following ? "Following" : "Follow series"}
      </button>
      <span className="follow-hint">
        {data.following
          ? "New releases appear in your Upcoming. Follows are private."
          : "See announced releases in your Upcoming. Follows are private."}
      </span>
    </div>
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
              void setFollow({ seriesId: suggestion.seriesId, following: true });
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

// ---------- /me upcoming ----------

const FORMAT_LABELS = { physical: "Physical", digital: "Digital" } as const;

const PREFERENCE_LABELS = {
  both: "Physical and digital",
  physical: "Physical only",
  digital: "Digital only",
} as const;

/** A pubDate.sort key back to its partial-precision display form. */
function sortDate(sort: number, day: number | null): string | null {
  const year = Math.floor(sort / 10000);
  const month = Math.floor(sort / 100) % 100;
  return formatPartialDate({
    year,
    month: month || undefined,
    day: day ?? undefined,
  });
}

/**
 * The Upcoming section of /me: My Upcoming Releases computed live by
 * follows.myUpcoming, plus the Physical/Digital/Both preference that scopes
 * the followed-Series clause of the formula.
 */
export function MyUpcoming() {
  if (!convexClient) return null;
  return <MyUpcomingInner />;
}

function MyUpcomingInner() {
  // Computed once per mount so the reactive query key stays stable.
  const [todaySort] = useState(() => todaySortKey());
  const upcoming = useQuery(api.follows.myUpcoming, { todaySort });
  const viewer = useQuery(api.users.viewer, {});
  const setPreference = useMutation(api.users.setFormatPreference);

  if (upcoming === undefined) return <p className="placeholder">Loading…</p>;
  if (upcoming === null) return null;

  return (
    <div className="my-upcoming">
      {viewer && !viewer.needsUsername ? (
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
          <span className="pass-facts">
            Wanted and Ordered items always appear.
          </span>
        </label>
      ) : null}
      {upcoming.items.length === 0 ? (
        <p className="placeholder">
          Follow a series, or mark a release or box set Wanted or Ordered, and
          its announced future releases will appear here.
        </p>
      ) : (
        <ul className="upcoming-list">
          {upcoming.items.map((item) => (
            <UpcomingItem key={item.id} item={item} />
          ))}
        </ul>
      )}
      {upcoming.capped ? (
        <p className="pass-facts">
          Showing the nearest announced releases; more exist further out.
        </p>
      ) : null}
    </div>
  );
}

type UpcomingData = NonNullable<
  FunctionReturnType<typeof api.follows.myUpcoming>
>;

function UpcomingItem({ item }: { item: UpcomingData["items"][number] }) {
  const date = sortDate(item.sort, item.day);
  return (
    <li className="upcoming-item">
      <span className="upcoming-date">{date ?? "Date TBA"}</span>{" "}
      {item.kind === "release" ? (
        <>
          <Link
            to="/edition/$publicId/$slug"
            params={slugParams(item.edition.publicId, item.edition.title)}
            hash={item.anchor}
          >
            {item.series.map((series) => series.title).join(" × ")}
            {item.volumeLabel ? ` — ${item.volumeLabel}` : ""}
          </Link>{" "}
          <span className="pass-facts">
            {item.format === "physical"
              ? `Physical${item.binding ? ` · ${item.binding}` : ""}`
              : "Digital"}
            {item.publisher ? ` · ${item.publisher.name}` : ""}
          </span>
          {item.state ? (
            <span className={`upcoming-badge ${item.state}`}>
              {item.state === "wanted" ? "Wanted" : "Ordered"}
            </span>
          ) : null}
          {item.followed ? (
            <span
              className="followed-marker"
              title="From a series you follow"
            >
              ★ Following
            </span>
          ) : null}
        </>
      ) : (
        <>
          <Link
            to="/bundle/$publicId/$slug"
            params={slugParams(item.bundlePublicId, item.name)}
          >
            {item.name}
          </Link>{" "}
          <span className="pass-facts">
            Box set
            {item.format ? ` · ${FORMAT_LABELS[item.format]}` : ""}
          </span>
          <span className={`upcoming-badge ${item.state}`}>
            {item.state === "wanted" ? "Wanted" : "Ordered"}
          </span>
        </>
      )}
    </li>
  );
}
