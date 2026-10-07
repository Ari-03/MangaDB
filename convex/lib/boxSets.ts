// What a box set holds, in words: "Vols. 1–16", "3-in-1 #1–3", or across
// Series "Dragon Ball Vols. 1–16; Dragon Ball Z Vols. 1–2". Derived from its
// member Releases' Editions (CONTEXT.md Release Bundle, Volume Coverage); an
// Unmapped Packaging member counts by its line position. Shared by the
// Bundle page and the Series page's box-set shelf (catalogPages.ts,
// catalog.ts).

/** One member book: the Series its Volumes are in, their labels, and its line. */
export type BoxSetPart = {
  seriesTitle: string;
  labels: ReadonlyArray<string | null>;
  line: { name: string; position: string | null } | null;
};

const NUMBER = /^\d+$/;

/** Labels as ranges, "1–7, 9, 12–13": numbers ascending first, any other label after, as written. */
export function labelRanges(labels: ReadonlyArray<string>): string {
  const numbers = [...new Set(labels.filter((l) => NUMBER.test(l)).map(Number))].sort(
    (a, b) => a - b,
  );
  const others = [...new Set(labels.filter((l) => !NUMBER.test(l)))];
  const runs: string[] = [];
  for (let i = 0; i < numbers.length; ) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j++;
    runs.push(i === j ? `${numbers[i]}` : `${numbers[i]}–${numbers[j]}`);
    i = j + 1;
  }
  return [...runs, ...others].join(", ");
}

/**
 * The box set's contents in words. `withSeries` names each Series (the
 * Bundle page); without it, one Series' parts read alone (the Series page,
 * which passes only its own). Empty when no member says what it holds.
 */
export function boxSetContents(parts: ReadonlyArray<BoxSetPart>, withSeries: boolean): string {
  const bySeries = new Map<string, BoxSetPart[]>();
  for (const part of parts) {
    bySeries.set(part.seriesTitle, [...(bySeries.get(part.seriesTitle) ?? []), part]);
  }
  const phrases: string[] = [];
  for (const [seriesTitle, group] of bySeries) {
    const pieces: string[] = [];
    const labels = group.flatMap((part) =>
      part.labels.filter((label): label is string => label !== null),
    );
    if (labels.length > 0) {
      pieces.push(`${new Set(labels).size === 1 ? "Vol." : "Vols."} ${labelRanges(labels)}`);
    }
    // Members no coverage maps: by their line's own numbering.
    const lines = new Map<string, string[]>();
    for (const part of group) {
      if (part.labels.length > 0 || part.line === null) continue;
      const positions = lines.get(part.line.name) ?? [];
      if (part.line.position !== null) positions.push(part.line.position);
      lines.set(part.line.name, positions);
    }
    for (const [name, positions] of lines) {
      pieces.push(positions.length > 0 ? `${name} #${labelRanges(positions)}` : name);
    }
    if (pieces.length === 0) continue;
    phrases.push(withSeries ? `${seriesTitle} ${pieces.join(", ")}` : pieces.join(", "));
  }
  return phrases.join("; ");
}
