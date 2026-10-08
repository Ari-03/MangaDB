// A Series' Editions grouped into the reading paths its page offers: one
// "standard" path per Publisher for Editions outside any Edition Line (a
// licence transfer gives each publisher's run its own path unless a moderator
// combines them for this Series), and one path per Edition Line (Omnibus,
// Deluxe, …). Pure, shared by the catalog and personal library.

type Publisher = { name: string; slug: string };
export const COMBINED_PUBLISHERS_CAP = 8;

export type PathCombination = {
  /** Lead first; its slug remains the combined path's key. */
  publishers: Publisher[];
  /** Former member keys, including publishers that have since merged. */
  aliases: string[];
};

export function combinedPathFor(
  edition: { publisher: { slug: string } | null; lineName: string | null },
  combination?: PathCombination,
) {
  return edition.lineName === null &&
    combination?.publishers.some((publisher) => publisher.slug === edition.publisher?.slug)
    ? combination
    : undefined;
}

/** Both original publisher links continue to open the combined shelf. */
export function findEditionGroup<G extends { key: string; aliases: readonly string[] }>(
  groups: readonly G[],
  key: string | undefined,
) {
  return groups.find(
    (group) => group.key === key || (key !== undefined && group.aliases.includes(key)),
  );
}

type PathVolume = { publicId: number; position: number; label: string | null };
type StandardRun = {
  publisher: { id: string };
  books: readonly { coverage: readonly { volumePublicId: number }[] }[];
};

/** Preview the union, preserving duplicate books and distinguishing real gaps. */
export function previewCombinedPaths(
  runs: readonly StandardRun[],
  publisherIds: readonly string[],
  volumes: readonly PathVolume[],
) {
  const selected = runs.filter((run) => publisherIds.includes(run.publisher.id));
  const owners = new Map<number, Set<string>>();
  for (const run of selected) {
    for (const book of run.books) {
      for (const coverage of book.coverage) {
        const publishers = owners.get(coverage.volumePublicId) ?? new Set<string>();
        publishers.add(run.publisher.id);
        owners.set(coverage.volumePublicId, publishers);
      }
    }
  }
  const covered = volumes.filter((volume) => owners.has(volume.publicId));
  const lastPosition = covered.at(-1)?.position ?? -Infinity;
  return {
    bookCount: selected.reduce((count, run) => count + run.books.length, 0),
    covered,
    gaps: volumes.filter(
      (volume) => volume.position <= lastPosition && !owners.has(volume.publicId),
    ),
    overlaps: volumes.filter((volume) => (owners.get(volume.publicId)?.size ?? 0) > 1),
  };
}

/** The Edition fields grouping reads; the query's Edition rows carry more. */
export type GroupableEdition = {
  publicId: number;
  publisher: { name: string; slug: string } | null;
  lineName: string | null;
  linePosition: string | null;
  coverage: ReadonlyArray<{ position: number }>;
  releases: ReadonlyArray<{ pubDate: { sort: number } | null }>;
};

export type EditionGroup<E extends GroupableEdition> = {
  /** URL value for `?edition=`: the publisher slug, plus the line for lines. */
  key: string;
  name: string;
  kind: "standard" | "line";
  publisher: E["publisher"];
  publishers: Publisher[];
  aliases: string[];
  /** In reading order: canonical position for standard, line number for lines. */
  books: E[];
};

export function keyPart(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The reading-path key one Edition belongs to — the same value `groupEditions`
 * gives its group, so a personal view can name a path ("Dark Horse's Deluxe
 * Edition") without rebuilding the whole Series page.
 */
export function editionPathKey(
  edition: {
    publisher: { slug: string } | null;
    lineName: string | null;
  },
  combination?: PathCombination,
): string {
  const combined = combinedPathFor(edition, combination);
  if (combined?.publishers[0]) return combined.publishers[0].slug;
  const publisherKey = edition.publisher?.slug ?? "unknown";
  return edition.lineName === null
    ? publisherKey
    : `${publisherKey}-${keyPart(edition.lineName) || "line"}`;
}

function firstPosition(edition: GroupableEdition): number {
  return Math.min(Infinity, ...edition.coverage.map((cov) => cov.position));
}

function firstRelease(edition: GroupableEdition): number {
  return Math.min(
    Infinity,
    ...edition.releases.flatMap((r) => (r.pubDate ? [r.pubDate.sort] : [])),
  );
}

/** "Omnibus 7" sorts as 7; an unnumbered member falls back to its coverage. */
function lineNumber(edition: GroupableEdition): number {
  const n = Number(edition.linePosition);
  return edition.linePosition !== null && Number.isFinite(n) ? n : Infinity;
}

function byKeys<T>(...keys: Array<(item: T) => number>) {
  return (a: T, b: T) => {
    for (const key of keys) {
      const diff = key(a) - key(b);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
    }
    return 0;
  };
}

/**
 * Group and order a Series' Editions. Standard paths lead (the longest run
 * first — it fronts the Series), then Edition Lines by first release. Names
 * only carry the publisher when two paths would otherwise read the same.
 */
export function groupEditions<E extends GroupableEdition>(
  editions: ReadonlyArray<E>,
  combination?: PathCombination,
): Array<EditionGroup<E>> {
  const groups = new Map<string, EditionGroup<E>>();
  for (const edition of editions) {
    const kind = edition.lineName === null ? "standard" : "line";
    const combined = combinedPathFor(edition, combination);
    const key = editionPathKey(edition, combination);
    const group = groups.get(key);
    if (group) group.books.push(edition);
    else
      groups.set(key, {
        key,
        name: edition.lineName ?? "Standard edition",
        kind,
        publisher: combined?.publishers[0] ?? edition.publisher,
        publishers: combined?.publishers ?? (edition.publisher ? [edition.publisher] : []),
        aliases: combined?.aliases.filter((alias) => alias !== key) ?? [],
        books: [edition],
      });
  }

  const all = [...groups.values()];
  for (const group of all) {
    group.books.sort(
      group.kind === "standard"
        ? byKeys(firstPosition, firstRelease, (e) => e.publicId)
        : byKeys(lineNumber, firstPosition, firstRelease, (e) => e.publicId),
    );
  }
  const earliest = (group: EditionGroup<E>) => Math.min(...group.books.map(firstRelease));
  const standard = all
    .filter((g) => g.kind === "standard")
    .sort(byKeys((g) => -g.books.length, earliest));
  const lines = all.filter((g) => g.kind === "line").sort(byKeys(earliest, (g) => -g.books.length));

  const ordered = [...standard, ...lines];
  const nameCounts = new Map<string, number>();
  for (const { name } of ordered) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  for (const group of ordered) {
    if ((nameCounts.get(group.name) ?? 0) > 1 && group.publisher) {
      group.name =
        group.kind === "standard"
          ? `${group.publishers.map((publisher) => publisher.name).join(" & ")} edition`
          : `${group.name} (${group.publisher.name})`;
    }
  }
  return ordered;
}
