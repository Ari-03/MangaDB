// The shared cover vocabulary of the Bookshelf look (styles/covers.css):
// a jacketed cover when art is on file, otherwise an unjacketed book in
// coloured cloth carrying the title — never a broken image, never fabricated
// art. Collection state is worn on the cover itself as a badge, and the
// followed-Series marker (#29) sits in the opposite corner.

import type { CSSProperties, ReactNode } from "react";

// Cloth colours for coverless books. Picked deterministically from the title
// so the same book is always the same colour across pages and reloads.
const CLOTH = [
  "#8a4426", "#6b2f4a", "#2b5d5b", "#3d5a3a", "#5a3d7a", "#7a5a2b",
  "#2f4d6b", "#7a2f2f", "#4a5a2b", "#6b4a2f", "#2b6b5a", "#7a3d5a",
];

export function clothColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return CLOTH[Math.abs(hash) % CLOTH.length]!;
}

export type CollectionState = "owned" | "ordered" | "wanted" | "read";

const BADGE_ICONS: Record<CollectionState, ReactNode> = {
  owned: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.6 8.4 6.2 12 13.4 4.4" />
    </svg>
  ),
  ordered: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 5.2 8 2.3l6 2.9v5.6L8 13.7 2 10.8z" />
      <path d="M2 5.2 8 8l6-2.8M8 8v5.7" />
    </svg>
  ),
  wanted: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 2.6h8v11l-4-3-4 3z" />
    </svg>
  ),
  read: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.6 8.4 6.2 12 13.4 4.4" />
    </svg>
  ),
};

const BADGE_LABELS: Record<CollectionState, string> = {
  owned: "Owned",
  ordered: "Ordered",
  wanted: "Wanted",
  read: "Read",
};

/** A collection-state badge worn on a cover (inside `<Cover badges>`). */
export function CoverBadge({ state, label }: { state: CollectionState; label?: string }) {
  return (
    <span className={`badge badge--${state}`}>
      {BADGE_ICONS[state]}
      {label ?? BADGE_LABELS[state]}
    </span>
  );
}

type CoverProps = {
  /** Cover art URL; when absent the cloth placeholder renders. */
  src?: string | null;
  /** The book's title, used for alt text and printed on the placeholder. */
  title: string;
  /** Placeholder foot, e.g. the volume label and publisher. */
  foot?: [string | null | undefined, string | null | undefined];
  /**
   * Series-shelf placeholder: one trade dress per Series with a big volume
   * number instead of the full title.
   */
  numbered?: { series: string; number: string };
  /** Collection badges, usually `<CoverBadge>`s. */
  badges?: ReactNode;
  /** True when the viewer follows this Series (the ★ marker, #29). */
  followed?: boolean;
  /** `false` for the first covers above the fold. Defaults to lazy. */
  lazy?: boolean;
  className?: string;
};

export function Cover({
  src,
  title,
  foot,
  numbered,
  badges,
  followed,
  lazy = true,
  className,
}: CoverProps) {
  const seed = numbered ? numbered.series : title;
  const style = { "--cloth": clothColor(seed) } as CSSProperties;
  return (
    <span className={className ? `cover ${className}` : "cover"}>
      {src ? (
        <img src={src} alt={`Cover of ${title}`} loading={lazy ? "lazy" : "eager"} width={400} height={600} />
      ) : numbered ? (
        <span className="cover-ph cover-ph--numbered" style={style} aria-label={`${title} (no cover on file)`}>
          <span className="cover-ph-series">{numbered.series}</span>
          <span className="cover-ph-num">{numbered.number}</span>
        </span>
      ) : (
        <span className="cover-ph" style={style} aria-label={`${title} (no cover on file)`}>
          <span className="cover-ph-title">{title}</span>
          <span className="cover-ph-mark" aria-hidden="true">{foot?.[0] ?? ""}</span>
          {foot ? (
            <span className="cover-ph-foot">
              <span>{foot[0] ?? ""}</span>
              <span>{foot[1] ?? ""}</span>
            </span>
          ) : null}
        </span>
      )}
      {badges ? <span className="cover-badges">{badges}</span> : null}
      {followed ? (
        <span className="cover-flag" title="You follow this series" aria-label="You follow this series">
          ★
        </span>
      ) : null}
    </span>
  );
}
