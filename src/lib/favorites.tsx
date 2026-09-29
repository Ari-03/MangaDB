// Favorites UI (CONTEXT.md: Favorite): the private toggle in the TakePanel
// under the cover of Series, Volume and Edition pages (a single-volume
// Edition's favorites its Volume; an omnibus is favorited as one book), styled
// like the Follow button (lib/follows.tsx), and the Favorites view of the
// library (/me?tab=favorites). Signed out, the queries answer null and
// nothing renders, so the panel stays empty and hides itself.

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState, type ReactNode } from "react";

import { api } from "../../convex/_generated/api";
import { track } from "~/lib/analytics";
import { Cover } from "~/lib/cover";
import { ConcealArt } from "~/lib/mature";
import type { RatingTarget } from "~/lib/ratings";
import { slugParams } from "~/lib/slug";
import { convexClient } from "~/providers";

function HeartGlyph({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 13.6S2 10.1 2 5.9A3.1 3.1 0 0 1 8 4.6a3.1 3.1 0 0 1 6 1.3c0 4.2-6 7.7-6 7.7Z" />
    </svg>
  );
}

/** The "Favorite" / "Favorited" toggle for a Series, Volume or omnibus Edition; nothing signed out. */
export function FavoriteButton({ target }: { target: RatingTarget }) {
  if (!convexClient) return null;
  return <FavoriteButtonInner target={target} />;
}

function FavoriteButtonInner({ target }: { target: RatingTarget }) {
  const data = useQuery(api.favorites.isFavorite, { target });
  const toggle = useMutation(api.favorites.toggle);
  // A toggle is not idempotent: one write at a time.
  const [busy, setBusy] = useState(false);
  if (!data) return null; // loading, signed out, or username pending
  return (
    <button
      type="button"
      aria-pressed={data.favorite}
      className={`follow-btn fav-btn${data.favorite ? " is-following" : ""}`}
      disabled={busy}
      title="Favorites are private"
      onClick={() => {
        setBusy(true);
        toggle({ target: data.target })
          .then(({ favorite }) =>
            track("favorite_toggled", { target: target.kind, publicId: target.publicId, favorite }),
          )
          .finally(() => setBusy(false));
      }}
    >
      <HeartGlyph filled={data.favorite} />
      {data.favorite ? "Favorited" : "Favorite"}
    </button>
  );
}

type FavoriteItem = NonNullable<FunctionReturnType<typeof api.favorites.mine>>["items"][number];

/**
 * The library's Favorites view: every favorited Series, Volume and omnibus
 * Edition as a cover, newest first, each removable in place. A Mature
 * title's cover is concealed unless the viewer opted in.
 */
export function LibraryFavorites() {
  if (!convexClient) return null;
  return <LibraryFavoritesInner />;
}

function LibraryFavoritesInner() {
  const mine = useQuery(api.favorites.mine, {});
  if (mine === undefined) return <p className="placeholder">Loading…</p>;
  if (mine === null) return null;
  if (mine.items.length === 0) {
    return (
      <p className="placeholder">
        Favorite a series, a volume or an omnibus from its page and it lands here. Favorites are private.
      </p>
    );
  }
  return (
    <section className="lib-block">
      <div className="lib-block-head">
        <h3 className="lib-group-title">Favorites</h3>
        <p className="lib-block-note">Newest first · only you can see these.</p>
      </div>
      <div className="shelf">
        {mine.items.map((item) => (
          <FavoriteCover key={`${item.kind}:${item.publicId}`} item={item} />
        ))}
      </div>
    </section>
  );
}

const KIND_LABELS: Record<FavoriteItem["kind"], string> = {
  series: "Series",
  volume: "Volume",
  edition: "Edition",
};

/** A link to a favorite's own page: its Series, Volume or Edition route. */
function FavoriteLink({
  item,
  className,
  label,
  children,
}: {
  item: FavoriteItem;
  className: string;
  label?: string;
  children: ReactNode;
}) {
  const params = slugParams(item.publicId, item.title);
  switch (item.kind) {
    case "series":
      return (
        <Link className={className} to="/series/$publicId/$slug" params={params} aria-label={label}>
          {children}
        </Link>
      );
    case "volume":
      return (
        <Link className={className} to="/volume/$publicId/$slug" params={params} aria-label={label}>
          {children}
        </Link>
      );
    case "edition":
      return (
        <Link className={className} to="/edition/$publicId/$slug" params={params} aria-label={label}>
          {children}
        </Link>
      );
  }
}

function FavoriteCover({ item }: { item: FavoriteItem }) {
  const toggle = useMutation(api.favorites.toggle);
  const [busy, setBusy] = useState(false);
  const cover = (
    <ConcealArt mature={item.mature} notice={false}>
      <Cover
        src={item.coverUrl}
        isbn13={item.coverIsbn}
        title={item.title}
        numbered={item.label !== null ? { series: item.seriesTitle, number: item.label } : undefined}
      />
    </ConcealArt>
  );
  return (
    <div className="shelf-item">
      <div className="cover-wrap">
        <FavoriteLink item={item} className="cover-link" label={item.title}>
          {cover}
        </FavoriteLink>
        <div className="cover-actions">
          <div className="cover-actions-row">
            <button
              type="button"
              className="quick-btn"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void toggle({ target: item.target })
                  .then(({ favorite }) =>
                    track("favorite_toggled", { target: item.kind, publicId: item.publicId, favorite }),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Unfavorite
            </button>
          </div>
        </div>
      </div>
      <div className="caption">
        <FavoriteLink item={item} className="caption-title">
          {item.title}
        </FavoriteLink>
        <div className="caption-meta">
          <span>{KIND_LABELS[item.kind]}</span>
        </div>
      </div>
    </div>
  );
}
