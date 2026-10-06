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
