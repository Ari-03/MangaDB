// Personal collection UI (ticket #27, spec §3), rendered as a signed-in
// overlay on the public catalog pages: Wanted / Ordered / Owned toggles on
// every Release row and Bundle page, the pinned-Variant picker, Derived
// Ownership badges, the Volume ownership summary, and the /me collection
// grouped by state. Everything fetches through the reactive Convex client;
// signed-out viewers get null from the collection queries, so the public
// pages render identically without the controls.
//
// The state model from the glossary holds throughout: exactly one state per
// entry — picking a state replaces the previous one, picking the current
// state again removes the entry — and every transition is an explicit click.

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convexClient } from "~/providers";
import { slugParams } from "~/lib/slug";

const STATE_LABELS = {
  wanted: "Wanted",
  ordered: "Ordered",
  owned: "Owned",
} as const;

type CollectionState = keyof typeof STATE_LABELS;

const STATE_ORDER: CollectionState[] = ["wanted", "ordered", "owned"];

/**
 * The three-state toggle group. Exactly one state can be active; clicking
 * the active state removes the entry (state -> null), clicking another
 * replaces it — the exactly-one-state invariant rendered as controls.
 */
function StateButtons({
  current,
  onPick,
}: {
  current: CollectionState | null;
  onPick: (state: CollectionState | null) => void;
}) {
  return (
    <span className="collection-states" role="group" aria-label="Collection state">
      {STATE_ORDER.map((state) => (
        <button
          key={state}
          type="button"
          aria-pressed={current === state}
          className={current === state ? "state-active" : undefined}
          onClick={() => onPick(current === state ? null : state)}
        >
          {STATE_LABELS[state]}
        </button>
      ))}
    </span>
  );
}

// ---------- Release row controls ----------

/**
 * Collection controls on a Release row: the state toggles, the owned-Variant
 * picker when the Release has Variants, and Derived Ownership badges from
 * Owned Bundles. Mounts anywhere a Release row renders — Series, Volume, and
 * Edition pages; renders nothing signed out.
 */
export function ReleaseCollectionControls({ releaseId }: { releaseId: string }) {
  if (!convexClient) return null;
  // Release rows carry the Convex document id serialized through the SSR
  // loader; re-brand it for the typed function references.
  return <ReleaseControlsInner releaseId={releaseId as Id<"releases">} />;
}

function ReleaseControlsInner({ releaseId }: { releaseId: Id<"releases"> }) {
  const data = useQuery(api.collection.entryForRelease, { releaseId });
  const setEntry = useMutation(api.collection.setReleaseEntry);
  if (!data) return null; // loading, signed out, or username pending
  const entry = data.entry;

  return (
    <div className="collection-controls">
      <StateButtons
        current={entry?.state ?? null}
        onPick={(state) =>
          void setEntry({
            releaseId: data.releaseId,
            state: state ?? undefined,
            // Keep the pinned Variant across state changes; removal clears it
            // with the entry.
            variantId: state ? (entry?.variantId ?? undefined) : undefined,
          })
        }
      />
      {entry && data.variants.length > 0 ? (
        <label className="variant-pick">
          Variant{" "}
          <select
            value={entry.variantId ?? ""}
            onChange={(event) => {
              const value = event.currentTarget.value;
              void setEntry({
                releaseId: data.releaseId,
                state: entry.state,
                variantId: value === "" ? undefined : (value as Id<"releaseVariants">),
              });
            }}
          >
            <option value="">Standard cover</option>
            {data.variants.map((variant) => (
              <option key={variant.variantId} value={variant.variantId}>
                {variant.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {/* Derived Ownership (computed, never stored) coexists with the direct
          entry above — an Owned bundle shows here without occupying a state. */}
      {data.derived.map((bundle) => (
        <span key={bundle.bundlePublicId} className="derived-ownership">
          Owned via{" "}
          <Link
            to="/bundle/$publicId/$slug"
            params={slugParams(bundle.bundlePublicId, bundle.bundleName)}
          >
            {bundle.bundleName}
          </Link>
          {bundle.pinnedVariantName ? ` (${bundle.pinnedVariantName} variant)` : ""}
        </span>
      ))}
    </div>
  );
}

// ---------- Bundle page controls ----------

/** Collection controls on the Bundle page; renders nothing signed out. */
export function BundleCollectionControls({ bundleId }: { bundleId: string }) {
  if (!convexClient) return null;
  return <BundleControlsInner bundleId={bundleId as Id<"releaseBundles">} />;
}

function BundleControlsInner({ bundleId }: { bundleId: Id<"releaseBundles"> }) {
  const data = useQuery(api.collection.entryForBundle, { bundleId });
  const setEntry = useMutation(api.collection.setBundleEntry);
  if (!data) return null;
  return (
    <div className="collection-controls">
      <StateButtons
        current={data.entry?.state ?? null}
        onPick={(state) =>
          void setEntry({ bundleId: data.bundleId, state: state ?? undefined })
        }
      />
      {data.entry?.state === "owned" ? (
        <span className="derived-ownership">
          Owning this box set marks every book inside as owned.
        </span>
      ) : null}
    </div>
  );
}

// ---------- Volume ownership summary ----------

/**
 * How the viewer owns this Volume — purely through owned covering Releases
 * (direct or via an Owned Bundle), since no Volume-ownership state exists.
 * Renders nothing signed out or when nothing covering it is owned.
 */
export function VolumeOwnership({ volumePublicId }: { volumePublicId: number }) {
  if (!convexClient) return null;
  return <VolumeOwnershipInner volumePublicId={volumePublicId} />;
}

function VolumeOwnershipInner({ volumePublicId }: { volumePublicId: number }) {
  const data = useQuery(api.collection.volumeOwnership, { volumePublicId });
  if (!data || data.owned.length === 0) return null;
  return (
    <div className="volume-ownership" role="status">
      <strong>In your collection</strong> through:
      <ul>
        {data.owned.map((item, i) => (
          <li key={i}>
            <Link
              to="/edition/$publicId/$slug"
              params={slugParams(item.editionPublicId, item.editionTitle)}
              hash={item.anchor}
            >
              {item.editionTitle}
            </Link>{" "}
            <span className="pass-facts">
              {item.format === "physical"
                ? `Physical${item.binding ? ` · ${item.binding}` : ""}`
                : "Digital"}
              {item.extent === "partial" ? " · partial coverage" : ""}
              {item.variantName ? ` · ${item.variantName} variant` : ""}
            </span>
            {item.via ? (
              <span className="pass-facts">
                {" "}
                — via{" "}
                <Link
                  to="/bundle/$publicId/$slug"
                  params={slugParams(item.via.bundlePublicId, item.via.bundleName)}
                >
                  {item.via.bundleName}
                </Link>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- /me collection overview ----------

/** The Collection section of /me: every entry grouped by state. */
export function MyCollection() {
  if (!convexClient) return null;
  return <MyCollectionInner />;
}

function MyCollectionInner() {
  const overview = useQuery(api.collection.myCollection, {});
  if (overview === undefined) return <p className="placeholder">Loading…</p>;
  if (overview === null) return null;
  if (overview.entries.length === 0) {
    return (
      <p className="placeholder">
        Mark any release or box set as Wanted, Ordered, or Owned and it will
        appear here.
      </p>
    );
  }

  const grouped = (["owned", "ordered", "wanted"] as const)
    .map((state) => ({
      state,
      entries: overview.entries.filter((entry) => entry.state === state),
    }))
    .filter((group) => group.entries.length > 0);

  return (
    <div className="my-collection">
      {grouped.map((group) => (
        <div key={group.state} className="my-collection-group">
          <h3>{STATE_LABELS[group.state]}</h3>
          <ul>
            {group.entries.map((entry) => (
              <li key={entry.kind === "release" ? entry.releaseId : entry.bundleId}>
                {entry.kind === "release" ? (
                  <>
                    <Link
                      to="/edition/$publicId/$slug"
                      params={slugParams(entry.editionPublicId, entry.editionTitle)}
                      hash={entry.anchor}
                    >
                      {entry.editionTitle}
                    </Link>{" "}
                    <span className="pass-facts">
                      {entry.format === "physical"
                        ? `Physical${entry.binding ? ` · ${entry.binding}` : ""}`
                        : "Digital"}
                      {entry.variantName ? ` · ${entry.variantName} variant` : ""}
                    </span>
                  </>
                ) : (
                  <>
                    <Link
                      to="/bundle/$publicId/$slug"
                      params={slugParams(entry.bundlePublicId, entry.title)}
                    >
                      {entry.title}
                    </Link>{" "}
                    <span className="pass-facts">Box set</span>
                    {entry.members.length > 0 ? (
                      <ul className="bundle-derived">
                        {entry.members.map((member, i) => (
                          <li key={i}>
                            <Link
                              to="/edition/$publicId/$slug"
                              params={slugParams(
                                member.editionPublicId,
                                member.editionTitle,
                              )}
                              hash={member.anchor}
                            >
                              {member.editionTitle}
                            </Link>
                            {member.variantName ? (
                              <span className="pass-facts">
                                {" "}
                                · {member.variantName} variant
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
