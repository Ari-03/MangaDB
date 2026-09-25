// The canonical publisher list (spec §6 matching rung ③, §8 search) and the
// name rules every source resolves publisher strings through. Pure data +
// pure functions: launch.ts seeds these rows, the import pipeline resolves
// names against them, and the repair migration imports the same tables.
//
// Two different relationships, deliberately kept apart:
// - DUPLICATE_ALIASES: the same company under another string ("Kodansha
//   Comics" is Kodansha). These resolve to the company's one row.
// - Imprints: a publisher row of their own that names its parent company
//   (`parentSlug` → publishers.parentPublisherId, one level deep): "Ghost
//   Ship" is a Seven Seas imprint, "Vertical" a Kodansha one.

export type CanonicalPublisher = {
  name: string;
  slug: string;
  /** The parent company's slug when this row is an imprint. */
  parentSlug?: string;
  /** No longer publishing English manga (seeded as publishers.defunct). */
  defunct?: boolean;
};

/**
 * One row per company or imprint, idempotent by slug. Imprint slugs match
 * the rows the PRH importer historically created from imprint names, so the
 * existing rows are the ones these describe.
 */
export const CANONICAL_PUBLISHERS: CanonicalPublisher[] = [
  { name: "VIZ Media", slug: "viz-media" },
  { name: "Kodansha", slug: "kodansha" },
  { name: "Seven Seas Entertainment", slug: "seven-seas" },
  { name: "Yen Press", slug: "yen-press" },
  { name: "Dark Horse", slug: "dark-horse" },
  { name: "Square Enix", slug: "square-enix" },
  { name: "Vertical", slug: "vertical", parentSlug: "kodansha" },
  { name: "Denpa", slug: "denpa" },
  { name: "Tokyopop", slug: "tokyopop" },
  { name: "Del Rey Manga", slug: "del-rey-manga", defunct: true },
  { name: "Udon Entertainment", slug: "udon-entertainment" },
  { name: "One Peace Books", slug: "one-peace-books" },
  { name: "Kaiten Books", slug: "kaiten-books" },
  { name: "J-Novel Club", slug: "j-novel-club" },
  { name: "Drawn & Quarterly", slug: "drawn-and-quarterly" },
  { name: "Fantagraphics", slug: "fantagraphics" },
  { name: "Titan Manga", slug: "titan-manga" },
  { name: "ABLAZE", slug: "ablaze" },
  { name: "Ize Press", slug: "ize-press", parentSlug: "yen-press" },
  { name: "CMX", slug: "cmx", defunct: true },
  { name: "Digital Manga", slug: "digital-manga" },
  { name: "NETCOMICS", slug: "netcomics" },
  { name: "ComicsOne", slug: "comicsone", defunct: true },
  { name: "Star Fruit Books", slug: "star-fruit-books" },
  { name: "Glacier Bay Books", slug: "glacier-bay-books" },
  { name: "FAKKU", slug: "fakku" },
  { name: "Irodori Comics", slug: "irodori-comics" },
  { name: "Last Gasp", slug: "last-gasp" },
  { name: "Kuma", slug: "kuma" },
  { name: "Ghost Ship", slug: "ghost-ship", parentSlug: "seven-seas" },
  { name: "Steamship", slug: "steamship", parentSlug: "seven-seas" },
  { name: "Airship", slug: "airship", parentSlug: "seven-seas" },
  {
    name: "TOKYOPOP Classics",
    slug: "tokyopop-classics",
    parentSlug: "tokyopop",
  },
  {
    name: "TOKYOPOP LoveLove",
    slug: "tokyopop-lovelove",
    parentSlug: "tokyopop",
  },
  // The distributors ANN names on the releases no other source covers
  // (the release-less audit, 2026-09): legacy and small English manga
  // publishers, so ANN's release pages and OpenLibrary can place their
  // books. Imprints name their parent where it is a row here.
  { name: "SuBLime", slug: "sublime", parentSlug: "viz-media" },
  { name: "June", slug: "june", parentSlug: "digital-manga" },
  { name: "801 Media", slug: "801-media", parentSlug: "digital-manga", defunct: true },
  { name: "Blu", slug: "blu", parentSlug: "tokyopop", defunct: true },
  { name: "ADV Manga", slug: "adv-manga", defunct: true },
  { name: "Aurora Publishing", slug: "aurora-publishing", defunct: true },
  { name: "Deux Press", slug: "deux-press", parentSlug: "aurora-publishing", defunct: true },
  { name: "Central Park Media", slug: "central-park-media", defunct: true },
  { name: "Go! Comi", slug: "go-comi", defunct: true },
  { name: "Media Blasters", slug: "media-blasters", defunct: true },
  { name: "Kitty Media", slug: "kitty-media", parentSlug: "media-blasters", defunct: true },
  { name: "Broccoli Books", slug: "broccoli-books", defunct: true },
  { name: "Icarus Publishing", slug: "icarus-publishing", defunct: true },
  { name: "Bandai Entertainment", slug: "bandai-entertainment", defunct: true },
  { name: "DramaQueen", slug: "dramaqueen", defunct: true },
  { name: "DrMaster", slug: "drmaster", defunct: true },
  { name: "Studio Ironcat", slug: "studio-ironcat", defunct: true },
  { name: "Infinity Studios", slug: "infinity-studios", defunct: true },
  { name: "Gutsoon! Entertainment", slug: "gutsoon-entertainment", defunct: true },
  { name: "PictureBox", slug: "picturebox", defunct: true },
  { name: "Gen Manga", slug: "gen-manga", defunct: true },
  { name: "Tanoshimi", slug: "tanoshimi", defunct: true },
  { name: "Eros Comix", slug: "eros-comix", parentSlug: "fantagraphics", defunct: true },
  { name: "Project-H", slug: "project-h" },
  { name: "Ponent Mon", slug: "ponent-mon" },
  { name: "Fanfare", slug: "fanfare", parentSlug: "ponent-mon" },
  { name: "Living the Line", slug: "living-the-line" },
  { name: "Cross Infinite World", slug: "cross-infinite-world" },
  { name: "NBM Publishing", slug: "nbm-publishing" },
  { name: "Sol Press", slug: "sol-press" },
];

/** Slugs of the rows above that no longer publish (seedPublishers marks them). */
export const DEFUNCT_SLUGS: ReadonlySet<string> = new Set(
  CANONICAL_PUBLISHERS.filter((pub) => pub.defunct).map((pub) => pub.slug),
);

/**
 * Imprints the catalog knows the parent of but does not seed (out of scope
 * for the manga catalog). The repair migration still records the parent on
 * an existing row.
 */
const UNSEEDED_IMPRINTS: CanonicalPublisher[] = [
  { name: "Waves of Color", slug: "waves-of-color", parentSlug: "seven-seas" },
];

/**
 * Imprint slug → parent company slug, for every known imprint. The repair
 * migration sets publishers.parentPublisherId from this.
 */
export const IMPRINT_PARENTS: Record<string, string> = Object.fromEntries(
  [...CANONICAL_PUBLISHERS, ...UNSEEDED_IMPRINTS].flatMap((pub) =>
    pub.parentSlug !== undefined ? [[pub.slug, pub.parentSlug]] : [],
  ),
);

/**
 * True duplicates: another string for a company that already has a row.
 * Keys are publisher-name keys (see publisherNameKey); values are canonical
 * slugs. The repair migration merges the historical rows with these names
 * (slugs "kodansha-comics", "vertical-comics", "square-enix-manga",
 * "dark-horse-manga", "dark-horse-manhwa") into their company.
 */
export const DUPLICATE_ALIASES: Record<string, string> = {
  "kodansha comics": "kodansha",
  "vertical comics": "vertical",
  "square enix manga": "square-enix",
  "square enix manga and books": "square-enix",
  "dark horse manga": "dark-horse",
  "dark horse manhwa": "dark-horse",
  "seven seas": "seven-seas",
  viz: "viz-media",
  "viz communications": "viz-media",
  "viz communication": "viz-media",
  "viz llc": "viz-media",
  "viz kids": "viz-media",
  "viz comics": "viz-media",
  // VIZ's imprint labels, which OpenLibrary records as the publisher
  // (One Piece's records read ["SHONEN JUMP", "viz media"]). Only VIZ uses
  // them; SuBLime, a real imprint, has its own row instead.
  "shonen jump": "viz-media",
  "shonen jump advanced": "viz-media",
  "shojo beat": "viz-media",
  "viz signature": "viz-media",
  "shonen sunday": "viz-media",
  "seven seas siren": "seven-seas",
  "titan comics": "titan-manga",
  "cpm manga": "central-park-media",
  dmp: "digital-manga",
  "irodori inc": "irodori-comics",
  // Deliberately absent: "yen on" and "del rey"/"ballantine" name prose
  // lines (light novels, SF), never their manga siblings.
};

/** Historical slugs of duplicate rows → the company slug they merge into. */
export const DUPLICATE_SLUGS: Record<string, string> = {
  "kodansha-comics": "kodansha",
  "vertical-comics": "vertical",
  "square-enix-manga": "square-enix",
  "dark-horse-manga": "dark-horse",
  "dark-horse-manhwa": "dark-horse",
};

/**
 * The comparison key for publisher names: lowercased, "&" → "and", accents
 * and punctuation folded, whitespace collapsed ("TOKYOPOP, Inc." → "tokyopop inc").
 */
export function publisherNameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const BY_SLUG = new Map(
  [...CANONICAL_PUBLISHERS, ...UNSEEDED_IMPRINTS].map((pub) => [pub.slug, pub]),
);
const BY_KEY = new Map(
  [...CANONICAL_PUBLISHERS, ...UNSEEDED_IMPRINTS].map((pub) => [
    publisherNameKey(pub.name),
    pub,
  ]),
);

/**
 * The canonical row a publisher string exactly names — its own name, or a
 * duplicate alias of it — or null for a name the list does not know.
 * Imprints resolve to themselves ("Ghost Ship" → Ghost Ship, not Seven Seas).
 */
export function canonicalPublisherFor(name: string): CanonicalPublisher | null {
  const key = publisherNameKey(name);
  if (key === "") return null;
  const aliased = DUPLICATE_ALIASES[key];
  if (aliased !== undefined) return BY_SLUG.get(aliased) ?? null;
  return BY_KEY.get(key) ?? null;
}

/** The canonical entry for a slug (following duplicate slugs), if known. */
export function canonicalPublisherBySlug(
  slug: string,
): CanonicalPublisher | null {
  return BY_SLUG.get(DUPLICATE_SLUGS[slug] ?? slug) ?? null;
}
