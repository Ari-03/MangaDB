// Tracking-visibility UI (ticket #30, spec §3). Two surfaces:
// - SharingSettings on /me: the separate Ownership and Reading defaults
//   (private until explicitly opened) and the link to the public profile.
// - SeriesVisibilityControls on the Series page: the per-Series overrides,
//   each either "default" (follow the account default) or an explicit
//   public/private choice for exactly this Series.
// Both are segmented pills rather than selects: there are only two or three
// states and the current one should be readable without opening anything.
// Everything fetches through the reactive Convex client; signed-out viewers
// get null from the queries, so the public pages render without the controls.

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import { convexClient } from "~/providers";

type Kind = "ownership" | "reading";
type Visibility = "public" | "private";
type Choice = Visibility | "default";

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

/**
 * One segmented pill: a real radio group, so it is keyboard-operable and
 * announces the current state. `name` must be unique per group on the page.
 */
function VisibilitySegments({
  name,
  labelledBy,
  value,
  options,
  onPick,
}: {
  name: string;
  labelledBy: string;
  value: Choice;
  options: Array<{ value: Choice; label: string }>;
  onPick: (next: Choice) => void;
}) {
  return (
    <span className="seg-pill" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((option) => (
        <label className="seg-opt" key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onPick(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </span>
  );
}

const PUBLIC_PRIVATE: Array<{ value: Choice; label: string }> = [
  { value: "private", label: "Private" },
  { value: "public", label: "Public" },
];

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
      <p className="sharing-lede">
        Your tracking is private by default. Ownership and Reading are shared
        separately; each series page can override your default for that series.
        Series follows always stay private.
      </p>
      {(["ownership", "reading"] as const).map((kind) => (
        <div className="vis-field" key={kind}>
          <span className="vis-legend" id={`visibility-${kind}-label`}>
            {KIND_LABELS[kind]}
          </span>
          <VisibilitySegments
            name={`visibility-${kind}`}
            labelledBy={`visibility-${kind}-label`}
            value={defaults[kind]}
            options={PUBLIC_PRIVATE}
            onPick={(next) =>
              void setDefault({ kind, visibility: next as Visibility })
            }
          />
          <p className="vis-hint">{KIND_HINTS[kind]}</p>
        </div>
      ))}
      <p className="sharing-profile-link">
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
 * segmented pill per surface, defaulting to the account default and
 * overridable to public or private for exactly this Series. Renders nothing
 * signed out.
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
      <p className="vis-hint">
        Overrides your account defaults for this series only, on{" "}
        <Link to="/u/$username" params={{ username: state.username }}>
          your public profile
        </Link>
        .
      </p>
      {(["ownership", "reading"] as const).map((kind) => (
        <div className="vis-field" key={kind}>
          <span
            className="vis-legend"
            id={`series-visibility-${seriesPublicId}-${kind}-label`}
          >
            {KIND_LABELS[kind]}
          </span>
          <VisibilitySegments
            name={`series-visibility-${seriesPublicId}-${kind}`}
            labelledBy={`series-visibility-${seriesPublicId}-${kind}-label`}
            value={state.overrides[kind] ?? "default"}
            options={[
              {
                value: "default",
                label:
                  state.defaults[kind] === "public"
                    ? "Default: public"
                    : "Default: private",
              },
              ...PUBLIC_PRIVATE,
            ]}
            onPick={(next) =>
              void setOverride({
                seriesId: state.seriesId,
                kind,
                visibility: next,
              })
            }
          />
        </div>
      ))}
    </details>
  );
}
