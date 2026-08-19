// Authority conflict rules (ticket #35, spec §6): the pure decision table.
// Every row of the spec's conflict rules, plus the date-precision
// refinement rules, exercised without a database.

import { describe, expect, it } from "vitest";

import {
  authorityRank,
  datePrecision,
  datesConsistent,
  decideField,
  type Incumbent,
} from "./authority";

const SEVEN_SEAS = { date: "authoritative", isbn: "authoritative", price: "authoritative" } as const;
const ANN = { date: "standard", titles: "standard" } as const;
const OPENLIBRARY = { date: "weak", isbn: "standard" } as const;

describe("authorityRank", () => {
  it("maps fields through their category to the registry level", () => {
    expect(authorityRank(SEVEN_SEAS, "pubDate")).toBe(3);
    expect(authorityRank(ANN, "pubDate")).toBe(2);
    expect(authorityRank(OPENLIBRARY, "pubDate")).toBe(1);
    expect(authorityRank(OPENLIBRARY, "isbn13")).toBe(2);
  });

  it('an absent category is the table\'s "—": no authority at all', () => {
    expect(authorityRank(ANN, "isbn13")).toBe(0); // ANN has no ISBN authority
    expect(authorityRank(SEVEN_SEAS, "description")).toBe(0); // no category
    expect(authorityRank(undefined, "pubDate")).toBe(0); // unknown source
  });
});

describe("date precision", () => {
  it("ranks year < month < day and checks shared-part consistency", () => {
    expect(datePrecision({ year: 2026 })).toBe(1);
    expect(datePrecision({ year: 2026, month: 3 })).toBe(2);
    expect(datePrecision({ year: 2026, month: 3, day: 14 })).toBe(3);
    expect(datesConsistent({ year: 2026, month: 3 }, { year: 2026, month: 3, day: 14 })).toBe(true);
    expect(datesConsistent({ year: 2026, month: 3 }, { year: 2026, month: 4, day: 1 })).toBe(false);
    expect(datesConsistent({ year: 2026 }, { year: 2027 })).toBe(false);
  });
});

// A decideField call with sensible defaults, overridable per case.
function decide(overrides: Partial<Parameters<typeof decideField>[0]> = {}) {
  return decideField({
    field: "pubDate",
    current: { year: 2026, month: 1, day: 6, sort: 20260106 },
    offered: { year: 2026, month: 2, day: 3, sort: 20260203 },
    overridden: false,
    incomingSourceKey: "sevenseas",
    incomingRank: 3,
    incumbent: { kind: "source", sourceKey: "ann", rank: 2 },
    ...overrides,
  });
}

const src = (sourceKey: string, rank: number): Incumbent => ({
  kind: "source",
  sourceKey,
  rank,
});

describe("decideField — the conflict table", () => {
  it("skips when the value already matches", () => {
    const value = { year: 2026, month: 1, day: 6, sort: 20260106 };
    expect(decide({ current: value, offered: { ...value } }).action).toBe("skip");
  });

  it("auto-updates only from strictly higher authority", () => {
    expect(decide({ incomingRank: 3, incumbent: src("ann", 2) }).action).toBe("auto");
    expect(decide({ incomingRank: 2, incumbent: src("openlibrary", 1) }).action).toBe("auto");
  });

  it("queues an equal-authority disagreement", () => {
    expect(decide({ incomingRank: 3, incumbent: src("kodansha", 3) }).action).toBe("queue");
    expect(decide({ incomingRank: 2, incumbent: src("prh", 2) }).action).toBe("queue");
  });

  it("records a lower-authority disagreement on the observation only", () => {
    expect(decide({ incomingRank: 2, incumbent: src("kodansha", 3) }).action).toBe(
      "recordOnly",
    );
    expect(decide({ incomingRank: 1, incumbent: src("prh", 3) }).action).toBe(
      "recordOnly",
    );
  });

  it("lets a source update its own fact, whatever the ranks say", () => {
    expect(
      decide({ incomingRank: 3, incumbent: src("sevenseas", 3) }).action,
    ).toBe("auto");
  });

  it("Human Overrides stay sticky: queue at ANY authority, never overwrite", () => {
    expect(decide({ overridden: true, incomingRank: 3 }).action).toBe("queue");
    expect(
      decide({ overridden: true, incumbent: src("sevenseas", 3) }).action,
    ).toBe("queue");
    // Even an override on an empty field holds.
    expect(
      decide({ overridden: true, current: undefined, incumbent: { kind: "none" } })
        .action,
    ).toBe("queue");
  });

  it("human-authored (or unattributed) values never lose silently", () => {
    expect(decide({ incumbent: { kind: "human" } }).action).toBe("queue");
    expect(decide({ incumbent: { kind: "unattributed" } }).action).toBe("queue");
  });

  it("a source with no authority for the field records only", () => {
    expect(decide({ incomingRank: 0 }).action).toBe("recordOnly");
    expect(
      decide({ incomingRank: 0, current: undefined, incumbent: { kind: "none" } })
        .action,
    ).toBe("recordOnly");
  });

  it("filling an empty field is not a disagreement", () => {
    expect(
      decide({ current: undefined, incumbent: { kind: "none" }, incomingRank: 1 })
        .action,
    ).toBe("auto");
  });
});

describe("decideField — date precision refinement", () => {
  const monthOnly = { year: 2026, month: 1, sort: 20260100 };
  const fullDate = { year: 2026, month: 1, day: 6, sort: 20260106 };

  it("a consistent more-precise date auto-refines at equal-or-higher authority", () => {
    expect(
      decide({
        current: monthOnly,
        offered: fullDate,
        incomingRank: 3,
        incumbent: src("kodansha", 3), // equal
      }).action,
    ).toBe("auto");
    expect(
      decide({
        current: monthOnly,
        offered: fullDate,
        incomingRank: 3,
        incumbent: src("ann", 2), // higher
      }).action,
    ).toBe("auto");
  });

  it("a consistent more-precise date from LOWER authority records only", () => {
    expect(
      decide({
        current: monthOnly,
        offered: fullDate,
        incomingRank: 1,
        incumbent: src("kodansha", 3),
      }).action,
    ).toBe("recordOnly");
  });

  it("less precise never replaces more precise — not even a conflict", () => {
    expect(
      decide({
        current: fullDate,
        offered: monthOnly,
        incomingRank: 3,
        incumbent: src("ann", 2), // strictly higher would otherwise auto
      }).action,
    ).toBe("skip");
  });

  it("an INCONSISTENT date falls through to the plain conflict rules", () => {
    const otherFull = { year: 2026, month: 2, day: 3, sort: 20260203 };
    expect(
      decide({
        current: fullDate,
        offered: otherFull,
        incomingRank: 3,
        incumbent: src("kodansha", 3),
      }).action,
    ).toBe("queue");
  });

  it("refining a human-authored date still needs a human", () => {
    expect(
      decide({
        current: monthOnly,
        offered: fullDate,
        incumbent: { kind: "human" },
      }).action,
    ).toBe("queue");
  });
});
