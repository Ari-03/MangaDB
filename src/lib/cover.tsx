// The shared cover vocabulary of the Bookshelf look (styles/covers.css):
// a jacketed cover when art is on file, otherwise an unjacketed book in
// coloured cloth carrying the title — never a broken image, never fabricated
// art. Collection state is worn on the cover itself as a badge, and the
// followed-Series marker (#29) sits in the opposite corner.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

// Cloth colours for coverless books. Picked deterministically from the title
// so the same book is always the same colour across pages and reloads.
const CLOTH = [
  "#8a4426", "#6b2f4a", "#2b5d5b", "#3d5a3a", "#5a3d7a", "#7a5a2b",
  "#2f4d6b", "#7a2f2f", "#4a5a2b", "#6b4a2f", "#2b6b5a", "#7a3d5a",
];

/**
 * Cover art by ISBN-13, served from our own domain (src/server/covers.ts):
 * the Worker fetches it from a publisher-distribution CDN or OpenLibrary on
 * first request and keeps it. A Release with an ISBN therefore always has a
 * cover URL; the 404 for art nobody has is caught by <Cover>, which tries its
 * next candidate and ends at cloth.
 */
export function coverPath(isbn13: string): string {
  return `/covers/${isbn13}.jpg`;
}

// Enough to step past a physical ISBN nobody has art for to its digital
// twin (or the next Edition) without a long chain of misses per cover.
const MAX_CANDIDATES = 3;

/**
 * The ISBN-13s to look a page's cover up by when no stored art exists, best
 * first, for `<Cover isbn13>`: physical Releases before digital ones, each in
 * the given order across the Editions. The same jacket is usually on file
 * under several ISBNs, and not every upstream knows every one.
 */
export function coverIsbns(
  editions: ReadonlyArray<{
    releases: ReadonlyArray<{ isbn13: string | null; format?: string }>;
  }>,
): string[] {
  const releases = editions.flatMap((edition) => edition.releases);
  const ordered = [
    ...releases.filter((r) => r.format === "physical"),
    ...releases.filter((r) => r.format !== "physical"),
  ].flatMap((r) => (r.isbn13 ? [r.isbn13] : []));
  return [...new Set(ordered)].slice(0, MAX_CANDIDATES);
}

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
  /**
   * ISBN-13(s) to derive cover art from, tried in order after `src` until
   * one has art (see `coverIsbns`).
   */
  isbn13?: string | ReadonlyArray<string> | null;
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
  isbn13,
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
  // Every art URL to try, best first. An ISBN-derived URL 404s when nobody
  // has art for it; the next candidate takes over, and cloth after the last.
  // Failed URLs (not an index) are remembered, so a failure reported twice —
  // by onError and by the hydration check below — skips only one candidate,
  // and new props start clean.
  const isbns = typeof isbn13 === "string" ? [isbn13] : (isbn13 ?? []);
  const urls = [...new Set([src, ...isbns.map(coverPath)])].filter(
    (url): url is string => Boolean(url),
  );
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const art = urls.find((url) => !failed.has(url)) ?? null;
  const fail = (url: string) =>
    setFailed((prev) => (prev.has(url) ? prev : new Set(prev).add(url)));
  const img = useRef<HTMLImageElement>(null);
  // A server-rendered <img> can fail before React hydrates, and that error
  // event is gone by the time onError is attached; a finished image with no
  // pixels is the tell.
  useEffect(() => {
    const el = img.current;
    if (art && el && el.complete && el.naturalWidth === 0) fail(art);
  }, [art]);
  return (
    <span className={className ? `cover ${className}` : "cover"}>
      {art ? (
        <img
          // A fresh element per candidate, so `complete` above describes it.
          key={art}
          ref={img}
          src={art}
          alt={`Cover of ${title}`}
          loading={lazy ? "lazy" : "eager"}
          width={400}
          height={600}
          onError={() => fail(art)}
        />
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
