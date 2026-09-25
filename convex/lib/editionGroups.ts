// A Series' Editions grouped into the reading paths its page offers: one
// "standard" path per Publisher for Editions outside any Edition Line (a
// licence transfer gives each publisher's run its own path), and one path per
// Edition Line (Omnibus, Deluxe, …). Pure, so the Convex query and the route
// agree on the grouping and it stays unit-testable.

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
  /** In reading order: canonical position for standard, line number for lines. */
  books: E[];
};

function keyPart(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
): Array<EditionGroup<E>> {
  const groups = new Map<string, EditionGroup<E>>();
  for (const edition of editions) {
    const publisherKey = edition.publisher?.slug ?? "unknown";
    const kind = edition.lineName === null ? "standard" : "line";
    const key =
      edition.lineName === null
        ? publisherKey
        : `${publisherKey}-${keyPart(edition.lineName) || "line"}`;
    const group = groups.get(key);
    if (group) group.books.push(edition);
    else
      groups.set(key, {
        key,
        name: edition.lineName ?? "Standard edition",
        kind,
        publisher: edition.publisher,
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
  const earliest = (group: EditionGroup<E>) =>
    Math.min(...group.books.map(firstRelease));
  const standard = all
    .filter((g) => g.kind === "standard")
    .sort(byKeys((g) => -g.books.length, earliest));
  const lines = all
    .filter((g) => g.kind === "line")
    .sort(byKeys(earliest, (g) => -g.books.length));

  const ordered = [...standard, ...lines];
  const nameCounts = new Map<string, number>();
  for (const { name } of ordered) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  for (const group of ordered) {
    if ((nameCounts.get(group.name) ?? 0) > 1 && group.publisher) {
      group.name =
        group.kind === "standard"
          ? `${group.publisher.name} edition`
          : `${group.name} (${group.publisher.name})`;
    }
  }
  return ordered;
}
