// Pure quality-gate helpers (ticket #40): the title-similarity duplicate
// sweep and the sampling reservoir.

import { describe, expect, it } from "vitest";

import { findDuplicatePairs, pairKeyOf, Reservoir, tokenKey } from "./qa";

describe("tokenKey", () => {
  it("sorts tokens and drops articles and medium words", () => {
    expect(tokenKey("The Fullmetal Alchemist Manga")).toBe("alchemist fullmetal");
    expect(tokenKey("Fullmetal Alchemist")).toBe("alchemist fullmetal");
  });

  it("strips parenthesized discriminators via normalizeTitle", () => {
    expect(tokenKey("Berserk (Manga)")).toBe("berserk");
  });
});

describe("findDuplicatePairs", () => {
  it("flags identical normalized titles across punctuation differences", () => {
    const pairs = findDuplicatePairs([
      { id: "a", title: "Tokyo Ghoul: re", altTitles: [] },
      { id: "b", title: "Tokyo Ghoul re", altTitles: [] },
      { id: "c", title: "Dungeon Meshi", altTitles: [] },
    ]);
    expect(pairs).toEqual([
      { aId: "a", bId: "b", reason: "identical normalized title" },
    ]);
  });

  it("flags a title colliding with another Series' alt title", () => {
    const pairs = findDuplicatePairs([
      { id: "a", title: "Delicious in Dungeon", altTitles: ["Dungeon Meshi"] },
      { id: "b", title: "Dungeon Meshi", altTitles: [] },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ aId: "a", bId: "b" });
  });

  it("flags same-token-set titles (word order, articles, 'manga')", () => {
    const pairs = findDuplicatePairs([
      { id: "a", title: "Fullmetal Alchemist", altTitles: [] },
      { id: "b", title: "The Fullmetal Alchemist Manga", altTitles: [] },
    ]);
    expect(pairs).toEqual([
      { aId: "a", bId: "b", reason: "same title tokens" },
    ]);
  });

  it("never pairs a Series with itself and dedups each pair", () => {
    const pairs = findDuplicatePairs([
      // title and alt normalize identically — no self-pair.
      { id: "a", title: "Berserk", altTitles: ["Berserk (Manga)"] },
      // collides with `a` on BOTH keys — still one pair.
      { id: "b", title: "Berserk", altTitles: [] },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.reason).toBe("identical normalized title");
  });

  it("leaves genuinely distinct titles alone", () => {
    const pairs = findDuplicatePairs([
      { id: "a", title: "Naruto", altTitles: [] },
      { id: "b", title: "Boruto", altTitles: [] },
      { id: "c", title: "One Piece", altTitles: [] },
    ]);
    expect(pairs).toEqual([]);
  });
});

describe("pairKeyOf", () => {
  it("is order-insensitive", () => {
    expect(pairKeyOf("x", "y")).toBe(pairKeyOf("y", "x"));
  });
});

describe("Reservoir", () => {
  it("keeps everything below k", () => {
    const r = new Reservoir<number>(5, () => 0);
    for (let i = 0; i < 3; i++) r.add(i);
    expect(r.sample()).toEqual([0, 1, 2]);
    expect(r.count).toBe(3);
  });

  it("holds exactly k items over a longer stream", () => {
    const r = new Reservoir<number>(5);
    for (let i = 0; i < 1000; i++) r.add(i);
    expect(r.sample()).toHaveLength(5);
    expect(r.count).toBe(1000);
  });

  it("is uniform-ish: with random()≈1 the reservoir never replaces", () => {
    const r = new Reservoir<number>(2, () => 0.999999);
    for (let i = 0; i < 100; i++) r.add(i);
    expect(r.sample()).toEqual([0, 1]);
  });
});
