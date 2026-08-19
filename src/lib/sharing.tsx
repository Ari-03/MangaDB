// Tracking-visibility UI (ticket #30, spec §3). Two surfaces:
// - SharingSettings on /me: the separate Ownership and Reading defaults
//   (private until explicitly opened) and the link to the public profile.
// - SeriesVisibilityControls on the Series page: the per-Series overrides,
//   each either "default" (follow the account default) or an explicit
//   public/private choice for exactly this Series.
// Everything fetches through the reactive Convex client; signed-out viewers
// get null from the queries, so the public pages render without the controls.

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import { convexClient } from "~/providers";

type Kind = "ownership" | "reading";
type Visibility = "public" | "private";

const KIND_LABELS: Record<Kind, string> = {
  ownership: "Collection (Owned)",
  reading: "Reading",
};

const KIND_HINTS: Record<Kind, string> = {
  ownership:
    "Public shows your Owned releases, variants, and box sets. Wanted and Ordered are never shown to anyone.",
  reading:
    "Public shows your reading statuses, volume read counts, and active passes.",
};

// ---------- /me defaults ----------

/** The Sharing section of /me: both visibility defaults + the profile link. */
export function SharingSettings() {
  if (!convexClient) return null;
  return <SharingSettingsInner />;
}

function SharingSettingsInner() {
  const viewer = useQuery(api.users.viewer, {});
  const setDefault = useMutation(api.sharing.setDefaultVisibility);
  if (!viewer || viewer.needsUsername) return null;

  const defaults: Record<Kind, Visibility> = {
    ownership: viewer.ownershipVisibility,
    reading: viewer.readingVisibility,
  };
  const anythingPublic =
    viewer.ownershipVisibility === "public" ||
    viewer.readingVisibility === "public";

  return (
    <div className="sharing-settings">
      <p>
        Your tracking is private by default. Ownership and Reading are shared
        separately; each series page can override your default for that series.
        Series follows always stay private.
      </p>
      {(["ownership", "reading"] as const).map((kind) => (
        <label key={kind} className="visibility-control">
          {KIND_LABELS[kind]}{" "}
          <select
            value={defaults[kind]}
            onChange={(event) =>
              void setDefault({
                kind,
                visibility: event.currentTarget.value as Visibility,
              })
            }
          >
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
          <span className="section-hint"> {KIND_HINTS[kind]}</span>
        </label>
      ))}
      <p>
        Your public profile:{" "}
        <Link to="/u/$username" params={{ username: viewer.username }}>
          /u/{viewer.username}
        </Link>{" "}
        {anythingPublic
          ? "— shows exactly what the settings above (and any per-series overrides) allow."
          : "— currently shows nothing."}
      </p>
    </div>
  );
}

// ---------- per-Series overrides ----------

/**
 * The per-Series visibility overrides on the Series page (spec §3): one
 * select per surface, defaulting to the account default and overridable to
 * public or private for exactly this Series. Renders nothing signed out.
 */
export function SeriesVisibilityControls({
  seriesPublicId,
}: {
  seriesPublicId: number;
}) {
  if (!convexClient) return null;
  return <SeriesVisibilityControlsInner seriesPublicId={seriesPublicId} />;
}

function SeriesVisibilityControlsInner({
  seriesPublicId,
}: {
  seriesPublicId: number;
}) {
  const state = useQuery(api.sharing.seriesVisibility, { seriesPublicId });
  const setOverride = useMutation(api.sharing.setSeriesVisibility);
  if (!state) return null;

  return (
    <details className="series-visibility">
      <summary>Sharing for this series</summary>
      <p className="section-hint">
        Overrides your account defaults for this series only, on{" "}
        <Link to="/u/$username" params={{ username: state.username }}>
          your public profile
        </Link>
        .
      </p>
      {(["ownership", "reading"] as const).map((kind) => (
        <label key={kind} className="visibility-control">
          {KIND_LABELS[kind]}{" "}
          <select
            value={state.overrides[kind] ?? "default"}
            onChange={(event) =>
              void setOverride({
                seriesId: state.seriesId,
                kind,
                visibility: event.currentTarget.value as
                  | Visibility
                  | "default",
              })
            }
          >
            <option value="default">
              Default ({state.defaults[kind] === "public" ? "Public" : "Private"})
            </option>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
        </label>
      ))}
    </details>
  );
}
