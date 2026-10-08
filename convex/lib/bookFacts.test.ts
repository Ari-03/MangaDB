import { describe, expect, it } from "vitest";
import { bookFacts, dedicatedFormatFacts } from "./bookFacts";

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

describe("connected contents completion and technical format payloads", () => {
  it.each(["(", "{", "(("])("keeps components across opening %s", (open) => {
    const close = open === "{" ? "}" : open === "((" ? "))" : ")";
    for (const connector of ["and", "&", "+", "/", "through", "or"]) {
      const known = bookFacts(`Includes Volumes 1 ${open}${connector} 2${close}`);
      expect(known.labels).toContain("2");
      const uncertain = bookFacts(`Includes Volumes 1 ${open}${connector} unresolved${close}`);
      expect(uncertain.unreadable.length).toBeGreaterThan(0);
    }
  });
  it.each([
    "II",
    "iv",
    "IX",
    "XXI",
    "L",
    "IIII",
    "GN unknown",
    "GN ?",
    "#unavailable",
    "GN (unknown)",
  ])("retains technical formats without using payload %s as canonical contents", (payload) => {
    const facts = bookFacts(`Paperback ${payload}; Hardback ${payload}; eBook ${payload}`);
    expect(facts.bindings).toEqual(["paperback", "hardcover"]);
    expect(facts.digital).toBe(true);
    expect(facts.labels).toEqual([]);
  });
  it.each([" ", "\t", "\n", "\u00a0"])(
    "preserves annotation scope through boundary %j",
    (space) => {
      const clause = `Includes Volumes 1${space}((Paperback${space};${space}Softcover))${space}and${space}2`;
      expect(bookFacts(clause)).toMatchObject({
        labels: ["1", "2"],
        bindings: ["paperback", "paperback"],
        unreadable: [],
      });
      expect(bookFacts(clause.replace(/2$/, "unknown")).unreadable.length).toBeGreaterThan(0);
    },
  );
  it("allows a genuinely separate prose clause to end contents scope", () => {
    expect(bookFacts("Includes Volume 1 (Paperback); Digital adventures")).toMatchObject({
      labels: ["1"],
      bindings: ["paperback"],
      digital: false,
      unreadable: [],
    });
  });
});

describe("annotations preserve pending contents", () => {
  it("accepts normalized equal labels through a format annotation", () => {
    expect(bookFacts("Volume 1 and (Paperback) I")).toMatchObject({
      labels: ["1", "1"],
      bindings: ["paperback"],
      packaging: [],
      unreadable: [],
    });
  });
  it("keeps a stated range even with equal endpoints", () => {
    const facts = bookFacts("Volume 1 through (Paperback) Volume I");
    expect(facts.packaging.length).toBeGreaterThan(0);
    expect(facts.unreadable).toEqual([]);
  });
  it("uses supported format boundaries consistently", () => {
    expect(bookFacts("Paperback+Hardcover")).toMatchObject({
      bindings: ["paperback", "hardcover"],
    });
    expect(bookFacts("Paperback/eBook").digital).toBe(true);
    expect(bookFacts("Hardcover dreams").bindings).toEqual([]);
  });
});

describe("dedicated format metadata", () => {
  it.each([
    "Hardcover",
    "Hardback",
    "Hard bound",
    "Paper-back",
    "Trade Paperback",
    "Mass-market paperback",
    "Softbound",
    "Soft cover",
    "Paper&#98;ack",
  ])("reads complete physical %s", (value) => {
    expect(dedicatedFormatFacts(value)).toMatchObject({
      physical: true,
      digital: false,
      unreadable: false,
    });
    expect(dedicatedFormatFacts(value).bindings).toHaveLength(1);
  });
  it.each([
    "Electronic resource",
    "eBook EPUB",
    "Kindle Edition",
    "EPUB FXL Manga RTL",
    "PDF",
    "MOBI",
    "AZW3",
    "e–book (PDF)",
    "e&#66;ook&nbsp;EPUB",
    "ＥＰＵＢ",
  ])("reads complete digital %s", (value) => {
    expect(dedicatedFormatFacts(value)).toMatchObject({
      physical: false,
      digital: true,
      unreadable: false,
    });
  });
  it.each([
    "Paperback / eBook EPUB",
    "EPUB; Hardcover",
    "Unknown",
    "Paperback unresolved",
    "Electronic resource unknown",
    "Digital adventures",
    "???",
    0,
    false,
    [],
  ])("retains uncertainty in %j", (value) => {
    expect(dedicatedFormatFacts(value).unreadable).toBe(true);
  });
  it.each([undefined, null, "", "  "])("absent %j asserts no format", (value) => {
    expect(dedicatedFormatFacts(value)).toEqual({
      bindings: [],
      digital: false,
      physical: false,
      unreadable: false,
    });
  });
  it("keeps display prose and dedicated metadata distinct", () => {
    expect(bookFacts("Digital adventures").digital).toBe(false);
    expect(dedicatedFormatFacts("Digital adventures")).toMatchObject({
      digital: true,
      unreadable: true,
    });
  });
});
