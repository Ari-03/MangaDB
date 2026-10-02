// Tracking-visibility UI (ticket #30, spec §3). Two surfaces:
// - SharingSettings on /me: the separate Ownership and Reading defaults
//   (private until explicitly opened) and the link to the public profile.
// - SeriesVisibilityControls on the Series page: the per-Series overrides,
//   in a popover so opening it never reflows the tracking bar. Each surface
//   offers exactly two choices: the account default (named: "Default:
//   private") and the one other visibility — an override that merely
//   repeats the default is shown, and cleared, as the default.
// Both are segmented pills rather than selects: there are only two states
// and the current one should be readable without opening anything.
// Everything fetches through the reactive Convex client; signed-out viewers
// get null from the queries, so the public pages render without the controls.

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";

import { api } from "../../convex/_generated/api";
import { convexClient } from "~/providers";
import { useReadyViewer } from "~/lib/viewer";

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
  const viewer = useReadyViewer();
  const setDefault = useMutation(api.sharing.setDefaultVisibility);
  if (!viewer) return null;

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
 * The per-Series visibility overrides on the Series page (spec §3), behind
 * one "Sharing" button in the tracking bar. The panel floats over the page
 * (never pushing the bar or the shelf below it) and closes on an outside
 * click or Escape. Renders nothing signed out.
 */
export function SeriesVisibilityControls({
  seriesPublicId,
}: {
  seriesPublicId: number;
}) {
  if (!convexClient) return null;
  return <SeriesVisibilityControlsInner seriesPublicId={seriesPublicId} />;
}

const VISIBILITY_WORDS: Record<Visibility, string> = {
  public: "Public",
  private: "Private",
};

function SeriesVisibilityControlsInner({
  seriesPublicId,
}: {
  seriesPublicId: number;
}) {
  const state = useQuery(api.sharing.seriesVisibility, { seriesPublicId });
  const setOverride = useMutation(api.sharing.setSeriesVisibility);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!state) return null;

  // An override only counts when it differs from the default it would replace.
  const effectiveOverride = (kind: Kind): Visibility | null => {
    const override = state.overrides[kind];
    return override && override !== state.defaults[kind] ? override : null;
  };
  const customised = (["ownership", "reading"] as const).some(
    (kind) => effectiveOverride(kind) !== null,
  );

  return (
    <div className="vis-pop" ref={root}>
      <span className="track-kicker">On your profile</span>
      <button
        type="button"
        className="vis-pop-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((prev) => !prev)}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
          <circle cx="8" cy="8" r="2" />
        </svg>
        Sharing
        {customised ? (
          <span className="vis-pop-dot" title="Customised for this series" />
        ) : null}
      </button>
      {open ? (
        <div
          className="vis-pop-panel"
          role="dialog"
          aria-label="Sharing for this series"
        >
          <p className="vis-hint">
            For this series only, on{" "}
            <Link to="/u/$username" params={{ username: state.username }}>
              your public profile
            </Link>
            . Follows always stay private.
          </p>
          {(["ownership", "reading"] as const).map((kind) => {
            const fallback = state.defaults[kind];
            const other: Visibility = fallback === "public" ? "private" : "public";
            return (
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
                  value={effectiveOverride(kind) ?? "default"}
                  options={[
                    {
                      value: "default",
                      label: `Default: ${VISIBILITY_WORDS[fallback].toLowerCase()}`,
                    },
                    { value: other, label: VISIBILITY_WORDS[other] },
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
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
