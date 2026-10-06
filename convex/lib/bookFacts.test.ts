import { describe, expect, it } from "vitest";
import { bookFacts } from "./bookFacts";

describe("technical facts outside the complete work name", () => {
  it.each([
    "Tales of Volume 2",
    "Digital Download",
    "Hardcover Edition",
    "Alpha: Volume I",
    "İİİİ: Volume II",
  ])("does not read facts inside authentic %s", (name) => {
    expect(bookFacts(name, [name])).toEqual({
      labels: [],
      bindings: [],
      packaging: [],
      unreadable: [],
      digital: false,
    });
    expect(bookFacts(`${name}, Vol. 01 (Hardback), Digital Download`, [name])).toEqual({
      labels: ["1"],
      bindings: ["hardcover"],
      packaging: [],
      unreadable: [],
      digital: true,
    });
  });
  it("requires the whole work prefix, with longest exact names taking precedence", () => {
    expect(bookFacts("Alpha: Volume I, Vol. 2", ["Alpha", "Alpha: Volume I"]).labels).toEqual([
      "2",
    ]);
    expect(bookFacts("Volume II", ["Volume I"]).labels).toEqual(["2"]);
  });
});

// Whitespace is normalized only while reading decisions. The source snapshot
// remains verbatim, as the registered producer tests assert separately.
describe("technical clause completion", () => {
  it.each([" ", "\t", "\n", "\u00a0"])(
    "preserves every known fact before boundaries using %j",
    (space) => {
      for (const clause of [
        "Vol. 1 (Hardback); Paperback.",
        "Vol. 1 [Hardbound] (Hardcover Edition).",
        "Vol. 1 (Digital Download); eBook (GN 1).",
        "Vol. 1 (Kindle Edition 1); Digital.",
        "Vol. 1: Includes Volumes 1, 01 and Volume I.",
      ]) {
        const spaced = clause.replace(/([()[\];:]|\.$)/g, `${space}$1`);
        expect(bookFacts(spaced)).toEqual(bookFacts(clause));
      }
    },
  );
  it.each([
    "Includes Volume 1, plus Volume 2",
    "Includes Volume 1 and also Volume 2",
    "Collects Volume 1 plus Volume 2",
    "Contains Volume 1, ?, Contains Volume 2",
    "Includes Volume 1, unresolved (Volume 2)",
    "Includes Volumes 1, [?, Volume 2]",
  ])("keeps a later marked fact in incomplete %s", (clause) => {
    const facts = bookFacts(clause);
    expect(facts.labels).toContain("1");
    expect(facts.labels).toContain("2");
    expect(facts.unreadable.length).toBeGreaterThan(0);
  });
  it.each(["?", "unknown", "unavailable", "undecided", "an unspecified component"])(
    "does not make unresolved component %s unknown evidence",
    (component) => {
      for (const connector of [", ", " and ", " or ", " / ", " & ", " + "]) {
        const facts = bookFacts(`Includes Volumes 1${connector}${component}`);
        expect(facts.labels).toContain("1");
        expect(facts.unreadable.length).toBeGreaterThan(0);
      }
    },
  );
  it.each(["1-1", "1-0", "1-1.5", "1--2", "1, 3"])(
    "never treats range/list %s as one certified Volume",
    (contents) => {
      const facts = bookFacts(`Includes Volumes ${contents}`);
      expect(facts.packaging.length + facts.unreadable.length).toBeGreaterThan(0);
    },
  );
  it("keeps a second verb and successive nested format clauses", () => {
    expect(bookFacts("Includes Volume 01; Contains Volume I (Paperback ; Hardback )")).toEqual({
      labels: ["1", "1"],
      bindings: ["paperback", "hardcover"],
      digital: false,
      packaging: [],
      unreadable: [],
    });
  });
  it.each(["eBook 1", "Kindle Edition 1", "Digital GN 1", "Electronic Volume 1"])(
    "keeps numbered format %s",
    (clause) => {
      expect(bookFacts(clause).digital).toBe(true);
    },
  );
  it.each([
    "Digital adventures",
    "Hardcover dreams",
    "The Digital Journey",
    "Book of Shadows",
    "Part of the Journey",
    "Vol. 1: Something Sinister",
    "Includes Volume 1; Something Sinister",
  ])("preserves ordinary prose outside technical lists: %s", (clause) => {
    expect(bookFacts(clause)).toMatchObject({
      bindings: [],
      digital: false,
      packaging: [],
      unreadable: [],
    });
  });
});

it("keeps a known later label after the first contents component is unreadable", () => {
  const facts = bookFacts("Includes Volumes unknown and Volume 2");
  expect(facts.labels).toEqual(["2"]);
  expect(facts.unreadable.length).toBeGreaterThan(0);
});
it("keeps successive numbered format facts without turning payloads into Volume labels", () => {
  expect(bookFacts("Paperback 1 Hardcover 2 eBook GN 3")).toEqual({
    labels: [],
    bindings: ["paperback", "hardcover"],
    digital: true,
    packaging: [],
    unreadable: [],
  });
});

it("preserves marked Volume facts following a format token", () => {
  expect(bookFacts("Paperback Volume 2")).toEqual({
    labels: ["2"],
    bindings: ["paperback"],
    digital: false,
    packaging: [],
    unreadable: [],
  });
});

it.each(["(Includes Volume 1) and (unknown)", "((Collects Volume 1)), unresolved"])(
  "preserves an incomplete continuation after closing wrappers in %s",
  (clause) => {
    const facts = bookFacts(clause);
    expect(facts.labels).toContain("1");
    expect(facts.unreadable.length).toBeGreaterThan(0);
  },
);

it("retains known format before an unreadable marked contents clause", () => {
  const facts = bookFacts("Hardback Includes Volumes unknown");
  expect(facts.bindings).toEqual(["hardcover"]);
  expect(facts.unreadable.length).toBeGreaterThan(0);
});
