import { describe, expect, it } from "vitest";

import { parsePublicId, seriesPath, slugify } from "./slug";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Tokyo Ghoul")).toBe("tokyo-ghoul");
  });

  it("collapses punctuation runs and trims edge hyphens", () => {
    expect(slugify("Tokyo Ghoul:re")).toBe("tokyo-ghoul-re");
    expect(slugify("  --Hello, World!--  ")).toBe("hello-world");
  });

  it("strips diacritics", () => {
    expect(slugify("Pokémon Adventures")).toBe("pokemon-adventures");
  });

  it("never produces an empty slug", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("〜〜〜")).toBe("untitled");
  });
});

describe("seriesPath", () => {
  it("builds the canonical flat URL", () => {
    expect(seriesPath(7, "Tokyo Ghoul:re")).toBe("/series/7/tokyo-ghoul-re");
  });
});

describe("parsePublicId", () => {
  it("parses plain integers", () => {
    expect(parsePublicId("42")).toBe(42);
  });

  it("accepts zero-padded forms so the canonical comparison can 301 them", () => {
    expect(parsePublicId("007")).toBe(7);
  });

  it("rejects non-numeric, negative, zero, and oversized segments", () => {
    expect(parsePublicId("abc")).toBeNull();
    expect(parsePublicId("-3")).toBeNull();
    expect(parsePublicId("3.5")).toBeNull();
    expect(parsePublicId("0")).toBeNull();
    expect(parsePublicId("9".repeat(13))).toBeNull();
    expect(parsePublicId("")).toBeNull();
  });
});
