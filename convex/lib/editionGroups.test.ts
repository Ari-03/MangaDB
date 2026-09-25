import { describe, expect, it } from "vitest";

import { groupEditions, type GroupableEdition } from "./editionGroups";

const kodansha = { name: "Kodansha", slug: "kodansha" };
const tokyopop = { name: "Tokyopop", slug: "tokyopop" };

let nextId = 1;
function book(overrides: Partial<GroupableEdition> & { at?: number[]; sort?: number }): GroupableEdition {
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
});
