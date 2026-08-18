import { describe, expect, it } from "vitest";

import {
  normalizeUsername,
  RESERVED_USERNAMES,
  validateUsername,
} from "./usernames";

describe("normalizeUsername", () => {
  it("lowercases and trims", () => {
    expect(normalizeUsername("  ReaderOne ")).toBe("readerone");
  });
});

describe("validateUsername", () => {
  it("accepts letters, digits, underscores", () => {
    expect(validateUsername("Reader_One")).toEqual({
      ok: true,
      normalized: "reader_one",
    });
    expect(validateUsername("a1_")).toEqual({ ok: true, normalized: "a1_" });
  });

  it("rejects bad lengths and characters", () => {
    for (const name of [
      "ab",
      "a".repeat(21),
      "_underscore_first",
      "with space",
      "hy-phen",
      "dot.name",
      "émile",
      "",
    ]) {
      const result = validateUsername(name);
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid");
    }
  });

  it("rejects every reserved name, any casing", () => {
    for (const name of RESERVED_USERNAMES) {
      // Names shorter than the minimum or with separators are already invalid;
      // all reserved entries must still never validate as ok.
      expect(validateUsername(name).ok, name).toBe(false);
      expect(validateUsername(name.toUpperCase()).ok, name).toBe(false);
    }
    const result = validateUsername("Admin");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("reserved");
  });
});
