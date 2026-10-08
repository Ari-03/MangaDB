import { describe, expect, it } from "vitest";

import type { Doc, Id } from "../_generated/dataModel";
import {
  matchesQueueFilters,
  queueKindOf,
  reportMessage,
  reportSeriesPublicId,
  summarizeVersion,
  type QueueFacets,
} from "./queueSummary";

type Version = Doc<"proposalVersions">;

const releaseRef = { type: "release" as const, id: "r1" as Id<"releases"> };
const seriesRef = { type: "series" as const, id: "s1" as Id<"series"> };
const source = { kind: "source" as const, sourceKey: "kodansha" };
const person = { kind: "user" as const, userId: "u1" as Id<"users"> };

const reportEvidence: Version["evidence"] = [
  { kind: "url", url: "/series/7", note: "Reported from the Series page: Witch Hat: Atelier" },
];

describe("summarizeVersion", () => {
  it("reads an import conflict on one field as an import offer with its label", () => {
    const ops: Version["ops"] = [
      {
        kind: "update",
        ref: releaseRef,
        changes: [
          {
            field: "pubDate",
            before: { year: 2026, month: 3, day: 10 },
            after: { year: 2026, month: 3, day: 24 },
          },
        ],
      },
    ];
    expect(summarizeVersion(ops, source, "Import conflict from Kodansha: …", [])).toEqual({
      kind: "importOffer",
      fields: [
        {
          field: "pubDate",
          label: "Publication date",
          before: { year: 2026, month: 3, day: 10 },
          after: { year: 2026, month: 3, day: 24 },
        },
      ],
      moreFields: 0,
      creates: [],
      clears: [],
      actions: [],
      report: null,
    });
  });

  it("reads a zero-op proposal by a person as a report, without its prefix", () => {
    const summary = summarizeVersion(
      [],
      person,
      "[Report] Witch Hat: Atelier: Volume 14 is missing.",
      reportEvidence,
    );
    expect(summary).toMatchObject({ kind: "report", report: "Volume 14 is missing." });
    expect(reportSeriesPublicId(reportEvidence)).toBe(7);
  });

  it("lists what a person's creation makes, once each, in op order", () => {
    const ops: Version["ops"] = [
      { kind: "create", table: "volumes", tempId: "v", fields: {} },
      { kind: "create", table: "editions", tempId: "e", fields: {} },
      { kind: "create", table: "releases", tempId: "r", fields: {} },
      { kind: "create", table: "releases", tempId: "r2", fields: {} },
    ];
    expect(summarizeVersion(ops, person, "New volume.", [])).toMatchObject({
      kind: "newRecords",
      creates: ["volume", "edition", "release"],
    });
    expect(queueKindOf(ops, source)).toBe("importCreation");
  });

  it("reads a merge as sensitive, whoever wrote it", () => {
    const ops: Version["ops"] = [
      { kind: "merge", survivor: seriesRef, merged: seriesRef, baseRevisionIds: [] },
    ];
    expect(queueKindOf(ops, person)).toBe("sensitive");
    expect(summarizeVersion(ops, person, "", []).actions).toEqual(["merge"]);
    expect(queueKindOf(ops, source)).toBe("sensitive");
  });

  it("names three fields and counts the rest, and labels a cleared override", () => {
    const ops: Version["ops"] = [
      {
        kind: "update",
        ref: releaseRef,
        changes: ["isbn13", "isbn10", "pubDate", "price"].map((field) => ({ field, after: 1 })),
      },
      { kind: "update", ref: seriesRef, changes: [{ field: "title", after: "B" }] },
      { kind: "clearOverride", ref: releaseRef, field: "pubDate" },
    ];
    const summary = summarizeVersion(ops, person, "", []);
    expect(summary.kind).toBe("fieldChange");
    expect(summary.fields.map((field) => field.label)).toEqual([
      "ISBN-13",
      "ISBN-10",
      "Publication date",
    ]);
    expect(summary.moreFields).toBe(2);
    expect(summary.clears).toEqual(["Publication date"]);
  });
});

describe("reportMessage", () => {
  it("keeps a comment that has no recognisable prefix", () => {
    expect(reportMessage("[Report] Something odd", [])).toBe("Something odd");
    expect(reportMessage("Plain text", [])).toBe("Plain text");
  });
});

describe("matchesQueueFilters", () => {
  const row: QueueFacets = {
    opKinds: ["update"],
    recordTypes: ["release"],
    kind: "importOffer",
    author: { kind: "source", sourceKey: "kodansha" },
    stale: false,
    warnings: [],
    submittedAt: 1_000,
  };
  const hour = 60 * 60 * 1000;

  it("passes a row with no filters set", () => {
    expect(matchesQueueFilters(row, {})).toBe(true);
  });

  it("applies each facet", () => {
    expect(matchesQueueFilters(row, { operation: "update" })).toBe(true);
    expect(matchesQueueFilters(row, { operation: "create" })).toBe(false);
    expect(matchesQueueFilters(row, { recordType: "series" })).toBe(false);
    expect(matchesQueueFilters(row, { kind: "importOffer" })).toBe(true);
    expect(matchesQueueFilters(row, { kind: "report" })).toBe(false);
    expect(matchesQueueFilters(row, { authorKind: "imports" })).toBe(true);
    expect(matchesQueueFilters(row, { authorKind: "humans" })).toBe(false);
    expect(matchesQueueFilters(row, { author: "kodansha" })).toBe(true);
    expect(matchesQueueFilters(row, { author: "bob" })).toBe(false);
    expect(matchesQueueFilters(row, { staleOnly: true })).toBe(false);
    expect(matchesQueueFilters({ ...row, stale: true }, { staleOnly: true })).toBe(true);
    expect(matchesQueueFilters(row, { warningsOnly: true })).toBe(false);
  });

  it("measures age from the client's clock", () => {
    expect(matchesQueueFilters(row, { minAgeHours: 2, now: 1_000 + hour })).toBe(false);
    expect(matchesQueueFilters(row, { minAgeHours: 2, now: 1_000 + 2 * hour })).toBe(true);
  });
});
