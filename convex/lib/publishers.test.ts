// The canonical publisher list and name rules (lib/publishers.ts): true
// duplicates resolve to their company, imprints to their own row with a
// parent, and the tables the repair migration imports stay consistent.

import { describe, expect, it } from "vitest";

import {
  canonicalPublisherBySlug,
  canonicalPublisherFor,
  CANONICAL_PUBLISHERS,
  DUPLICATE_ALIASES,
  DUPLICATE_SLUGS,
  IMPRINT_PARENTS,
  publisherNameKey,
} from "./publishers";

describe("canonicalPublisherFor", () => {
  it("merges only true duplicates into their company", () => {
    expect(canonicalPublisherFor("Kodansha Comics")?.slug).toBe("kodansha");
    expect(canonicalPublisherFor("Vertical Comics")?.slug).toBe("vertical");
    expect(canonicalPublisherFor("Square Enix Manga")?.slug).toBe(
      "square-enix",
    );
    expect(canonicalPublisherFor("Dark Horse Manga")?.slug).toBe("dark-horse");
    expect(canonicalPublisherFor("Dark Horse Manhwa")?.slug).toBe("dark-horse");
    expect(canonicalPublisherFor("Irodori Inc.")?.slug).toBe("irodori-comics");
  });

  it("resolves imprints to their own row, naming the parent company", () => {
    expect(canonicalPublisherFor("Ghost Ship")).toEqual({
      name: "Ghost Ship",
      slug: "ghost-ship",
      parentSlug: "seven-seas",
    });
    expect(canonicalPublisherFor("TOKYOPOP LoveLove")?.parentSlug).toBe(
      "tokyopop",
    );
    expect(canonicalPublisherFor("TOKYOPOP Classics")?.parentSlug).toBe(
      "tokyopop",
    );
    expect(canonicalPublisherFor("Steamship")?.parentSlug).toBe("seven-seas");
    expect(canonicalPublisherFor("Ize Press")?.parentSlug).toBe("yen-press");
    // Vertical stays its own publisher, an imprint of Kodansha.
    expect(canonicalPublisherFor("Vertical")).toEqual({
      name: "Vertical",
      slug: "vertical",
      parentSlug: "kodansha",
    });
  });

  it("matches case- and punctuation-insensitively, and knows nothing else", () => {
    expect(canonicalPublisherFor("TOKYOPOP")?.slug).toBe("tokyopop");
    expect(canonicalPublisherFor("Drawn and Quarterly")?.slug).toBe(
      "drawn-and-quarterly",
    );
    expect(canonicalPublisherFor("Kumar Publishing")).toBeNull();
    expect(canonicalPublisherFor("")).toBeNull();
  });
});

describe("the exported tables", () => {
  it("every alias and duplicate slug points at a canonical row", () => {
    const slugs = new Set(CANONICAL_PUBLISHERS.map((pub) => pub.slug));
    for (const slug of [
      ...Object.values(DUPLICATE_ALIASES),
      ...Object.values(DUPLICATE_SLUGS),
    ]) {
      expect(slugs.has(slug), slug).toBe(true);
    }
    expect(canonicalPublisherBySlug("kodansha-comics")?.slug).toBe("kodansha");
  });

  it("parents are one level deep and exist", () => {
    const slugs = new Set(CANONICAL_PUBLISHERS.map((pub) => pub.slug));
    for (const [imprint, parent] of Object.entries(IMPRINT_PARENTS)) {
      expect(slugs.has(parent), `${imprint} → ${parent}`).toBe(true);
      expect(
        IMPRINT_PARENTS[parent],
        `${parent} has no parent`,
      ).toBeUndefined();
    }
    expect(IMPRINT_PARENTS["waves-of-color"]).toBe("seven-seas");
    expect(IMPRINT_PARENTS["titan-manga"]).toBeUndefined();
  });

  it("keys names for comparison", () => {
    expect(publisherNameKey("TOKYOPOP, Inc.")).toBe("tokyopop inc");
    expect(publisherNameKey("Drawn & Quarterly")).toBe("drawn and quarterly");
  });
});
