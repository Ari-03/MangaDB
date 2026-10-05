import { describe, expect, it } from "vitest";

import {
  findEditionGroup,
  groupEditions,
  previewCombinedPaths,
  type GroupableEdition,
} from "./editionGroups";

const kodansha = { name: "Kodansha", slug: "kodansha" };
const tokyopop = { name: "Tokyopop", slug: "tokyopop" };

let nextId = 1;
function book(
  overrides: Partial<GroupableEdition> & { at?: number[]; sort?: number },
): GroupableEdition {
  const { at = [], sort, ...rest } = overrides;
  return {
    publicId: nextId++,
    publisher: kodansha,
    lineName: null,
    linePosition: null,
    coverage: at.map((position) => ({ position })),
    releases: [{ pubDate: sort === undefined ? null : { sort } }],
    ...rest,
  };
}

describe("groupEditions", () => {
  it("puts the longest standard run first, then lines, each in reading order", () => {
    const groups = groupEditions([
      book({ lineName: "Omnibus", linePosition: "2", at: [3, 4], sort: 20240601 }),
      book({ at: [2], sort: 20190101 }),
      book({ lineName: "Omnibus", linePosition: "1", at: [1, 2], sort: 20240301 }),
      book({ at: [1], sort: 20180101 }),
    ]);
    expect(groups.map((g) => [g.key, g.name, g.kind])).toEqual([
      ["kodansha", "Standard edition", "standard"],
      ["kodansha-omnibus", "Omnibus", "line"],
    ]);
    expect(groups[0]?.books.map((b) => b.coverage[0]?.position)).toEqual([1, 2]);
    expect(groups[1]?.books.map((b) => b.linePosition)).toEqual(["1", "2"]);
  });

  it("gives each publisher's standard run its own path, named by publisher", () => {
    const groups = groupEditions([
      book({ publisher: tokyopop, at: [3] }),
      book({ publisher: tokyopop, at: [4] }),
      book({ publisher: kodansha, at: [1] }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["Tokyopop edition", "Kodansha edition"]);
  });

  it("keeps a line member with no mapped Volumes, ordered by its line number", () => {
    const groups = groupEditions([
      book({ lineName: "Deluxe", linePosition: "10" }),
      book({ lineName: "Deluxe", linePosition: "9", at: [25, 26, 27] }),
    ]);
    expect(groups[0]?.books.map((b) => b.linePosition)).toEqual(["9", "10"]);
  });

  it("combines the 100 Girlfriends imprint split without changing the books", () => {
    const sevenSeas = { name: "Seven Seas Entertainment", slug: "seven-seas" };
    const ghostShip = { name: "Ghost Ship", slug: "ghost-ship" };
    const books = Array.from({ length: 22 }, (_, i) =>
      book({
        at: [i + 1],
        publisher: i < 11 || i === 15 ? sevenSeas : ghostShip,
      }),
    );
    const line = book({
      publisher: sevenSeas,
      lineName: "Omnibus",
      linePosition: "1",
      at: [1, 2, 3],
    });
    const groups = groupEditions([...books.reverse(), line], {
      publishers: [sevenSeas, ghostShip],
      aliases: [sevenSeas.slug, ghostShip.slug],
    });
    expect(groups).toHaveLength(2);
    expect(groups[0]?.key).toBe("seven-seas");
    expect(groups[0]?.books.map((b) => b.coverage[0]?.position)).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 1),
    );
    expect(groups[0]?.books[11]?.publisher).toBe(ghostShip);
    expect(groups[0]?.books[15]?.publisher).toBe(sevenSeas);
    expect(groups[1]?.key).toBe("seven-seas-omnibus");
    expect(findEditionGroup(groups, "ghost-ship")).toBe(groups[0]);
    expect(findEditionGroup(groups, "absent")).toBeUndefined();
  });

  it("names all combined publishers when another standard run exists", () => {
    const third = { name: "Third Press", slug: "third" };
    const groups = groupEditions(
      [
        book({ publisher: kodansha, at: [1] }),
        book({ publisher: tokyopop, at: [2] }),
        book({ publisher: third, at: [3] }),
      ],
      { publishers: [kodansha, tokyopop], aliases: ["kodansha", "tokyopop"] },
    );
    expect(groups.map((group) => group.name)).toEqual([
      "Kodansha & Tokyopop edition",
      "Third Press edition",
    ]);
  });

  it("previews real gaps and overlap without losing duplicate books", () => {
    const preview = previewCombinedPaths(
      [
        {
          publisher: { id: "a" },
          books: [{ coverage: [{ volumePublicId: 1 }] }, { coverage: [{ volumePublicId: 3 }] }],
        },
        { publisher: { id: "b" }, books: [{ coverage: [{ volumePublicId: 3 }] }] },
      ],
      ["a", "b"],
      [1, 2, 3].map((position) => ({ publicId: position, position, label: String(position) })),
    );
    expect(preview.bookCount).toBe(3);
    expect(preview.gaps.map((volume) => volume.label)).toEqual(["2"]);
    expect(preview.overlaps.map((volume) => volume.label)).toEqual(["3"]);
  });
});
