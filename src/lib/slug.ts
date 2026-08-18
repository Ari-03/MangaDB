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

/**
 * Parse the `{id}` URL segment. Digits only; forms that don't round-trip
 * ("007") parse fine and the canonical-URL comparison 301s them.
 */
export function parsePublicId(raw: string): number | null {
  if (!/^[0-9]{1,12}$/.test(raw)) return null;
  const value = Number(raw);
  return value > 0 ? value : null;
}
