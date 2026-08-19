// Catalog URLs are `/{entity}/{publicId}/{slug}` (spec §11): the integer is
// identity, the slug is cosmetic — computed from the current title at request
// time, never stored (spec §8). A request whose slug (or ID formatting)
// doesn't match the canonical form 301s to it, so stale slugs after a retitle
// and merged records' old IDs both land on one canonical URL.

/** Cosmetic slug from a title: lowercased ASCII, hyphen-separated. */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    // Strip combining marks left by NFKD so "Pokémon" → "pokemon".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Titles with no ASCII representation still get a stable, non-empty slug.
  return slug || "untitled";
}

/** Canonical Series URL path. */
export function seriesPath(publicId: number, title: string): string {
  return `/series/${publicId}/${slugify(title)}`;
}

// Volume, Edition, and Bundle titles are composed, not stored (spec §8):
// Volumes/Editions from series + label/line (convex/lib/titles.ts), Bundles
// from their stored name. The slug is computed from that composed title.

/** Canonical Volume URL path, from the composed Volume title. */
export function volumePath(publicId: number, title: string): string {
  return `/volume/${publicId}/${slugify(title)}`;
}

/** Canonical Edition URL path, from the composed Edition title. */
export function editionPath(publicId: number, title: string): string {
  return `/edition/${publicId}/${slugify(title)}`;
}

/** Canonical Bundle URL path, from the Bundle's name. */
export function bundlePath(publicId: number, title: string): string {
  return `/bundle/${publicId}/${slugify(title)}`;
}

/** Route `params` for a `/{entity}/$publicId/$slug` Link. */
export function slugParams(publicId: number, title: string) {
  return { publicId: String(publicId), slug: slugify(title) };
}

/**
 * Parse the `{id}` URL segment. Digits only; forms that don't round-trip
 * ("007") parse fine and the canonical-URL comparison 301s them.
 */
export function parsePublicId(raw: string): number | null {
  if (!/^[0-9]{1,12}$/.test(raw)) return null;
  const value = Number(raw);
  return value > 0 ? value : null;
}
