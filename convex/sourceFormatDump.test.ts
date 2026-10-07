// The OL half of a reviewed physical-to-digital reading, proven by a line of
// Open Library's monthly editions dump, on retained 2026-09-30 lines and the
// held staging snapshots they belong to. Canonical IDs are local fixtures.
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { sha256Hex } from "./lib/olDump";
import {
  projectSourceFormat,
  reviewedFormatRefusal,
  type ReviewedFormat,
} from "./lib/sourceFormat";
import { valueHash } from "./lib/values";
import { insertObservation, insertPublisher, insertSeries, insertVolume } from "./test.factories";
import { makeT, type TestT } from "./test.helpers";
import { insertBook } from "./test.moderation";
import { dumpFormatEvidence } from "./test.olDumpFormats";
import { distributorFormatEvidence, sourceFormatEvidence } from "./test.sourceFormats";
import { parseEditionJson } from "./lib/openLibrary";

const [shield, nukozuke] = dumpFormatEvidence as [
  (typeof dumpFormatEvidence)[number],
  (typeof dumpFormatEvidence)[number],
];
type DumpOl = Extract<ReviewedFormat["ol"], { kind: "olDumpEditionPhysicalFormatAbsent" }>;
function dumpOl(reviewed: ReviewedFormat): DumpOl {
  if (reviewed.ol.kind !== "olDumpEditionPhysicalFormatAbsent") throw new Error("Dump fixture.");
  return reviewed.ol;
}
const refusal = (row: typeof shield, reviewed: ReviewedFormat = row.reviewed) =>
  reviewedFormatRefusal(
    { sourceKey: "openlibrary", sourceRecordId: row.snapshot.key, snapshot: row.snapshot },
    reviewed,
  );
/** The row's evidence with its OL half changed; the line hash follows unless pinned. */
function withOl(row: typeof shield, change: Partial<DumpOl>, rehash = true): ReviewedFormat {
  const ol = { ...dumpOl(row.reviewed), ...change };
  return {
    ...row.reviewed,
    ol: rehash && change.line ? { ...ol, lineSha256: sha256Hex(ol.line) } : ol,
  };
}
/** The row's line with its edition JSON or columns rewritten, as a real envelope. */
function rewritten(
  row: typeof shield,
  edit: (edition: Record<string, unknown>) => void,
  columns: (cells: string[]) => string[] = (cells) => cells,
) {
  const cells = dumpOl(row.reviewed).line.split("\t");
  const edition: Record<string, unknown> = JSON.parse(cells[4]!);
  edit(edition);
  return columns([...cells.slice(0, 4), JSON.stringify(edition)]).join("\t");
}

describe("monthly dump evidence for an OL record without physical_format", () => {
  it("accepts the retained lines with the publisher's distributor proof, beside unchanged live-capture proofs", () => {
    expect(refusal(shield)).toBeNull();
    expect(refusal(nukozuke)).toBeNull();
    expect(dumpOl(shield.reviewed).schemaAddedFields).toEqual(["subtitle"]);
    expect(Object.hasOwn(shield.snapshot, "subtitle")).toBe(false);
    expect(dumpOl(nukozuke.reviewed).schemaAddedFields).toEqual([]);
    for (const row of [...sourceFormatEvidence, ...distributorFormatEvidence]) {
      const snapshot = parseEditionJson(JSON.parse(row.wire))!;
      expect(row.reviewed.ol.kind).toBe("olPhysicalFormatAbsent");
      expect(
        reviewedFormatRefusal(
          { sourceKey: "openlibrary", sourceRecordId: snapshot.key, snapshot },
          row.reviewed,
        ),
      ).toBeNull();
    }
  });

  it("refuses a line whose bytes, key, type or ISBNs are not the exact record's", () => {
    expect(
      refusal(shield, withOl(shield, { line: `${dumpOl(shield.reviewed).line} ` }, false)),
    ).toBe("Dump line SHA-256 disagrees.");
    expect(refusal(shield, withOl(shield, { lineSha256: "0".repeat(64) }))).toBe(
      "Dump line SHA-256 disagrees.",
    );
    expect(refusal(shield, withOl(shield, { key: "/books/OL56898159M" }))).toBe(
      "Exact OL absence evidence disagrees.",
    );
    // Nukozuke 1's own genuine line, offered for Shield Hero 8.
    expect(refusal(shield, withOl(shield, { line: dumpOl(nukozuke.reviewed).line }))).toBe(
      "Dump line key disagrees with the exact OL record.",
    );
    expect(
      refusal(
        shield,
        withOl(shield, {
          line: rewritten(
            shield,
            () => {},
            (cells) => ["/type/work", ...cells.slice(1)],
          ),
        }),
      ),
    ).toBe("Dump line is not an Open Library edition record.");
    expect(
      refusal(
        shield,
        withOl(shield, {
          line: rewritten(shield, (e) => {
            e.type = { key: "/type/work" };
          }),
        }),
      ),
    ).toBe("Dump line is not an Open Library edition record.");
    expect(
      refusal(
        shield,
        withOl(shield, {
          line: rewritten(shield, (e) => {
            e.isbn_13 = ["9781642730081", "9781642730005"];
          }),
        }),
      ),
    ).toBe("Every ISBN the dump record lists must be the source's own ISBN.");
    expect(
      refusal(
        shield,
        withOl(shield, {
          line: rewritten(shield, (e) => {
            e.isbn_10 = ["1642730009"];
          }),
        }),
      ),
    ).toBe("Every ISBN the dump record lists must be the source's own ISBN.");
    expect(refusal(shield, withOl(shield, { isbn13: "9781642730005" }))).toBe(
      "Exact OL absence evidence disagrees.",
    );
  });

  it("refuses physical_format stated in any form: a value, null or empty", () => {
    for (const value of ["Paperback", "eBook", null, ""])
      expect(
        refusal(
          shield,
          withOl(shield, {
            line: rewritten(shield, (e) => {
              e.physical_format = value;
            }),
          }),
        ),
      ).toBe("Dump record states physical_format; only an absent field qualifies.");
  });

  it("refuses a changed title or publisher instead of reading through it, and admits a subtitle only as declared", () => {
    const differs =
      "Dump record differs from the stored snapshot; refresh the raw source by review instead.";
    expect(
      refusal(
        shield,
        withOl(shield, {
          line: rewritten(shield, (e) => {
            e.title = "Rising of the Shield Hero Volume 09";
          }),
        }),
      ),
    ).toBe(differs);
    expect(
      refusal(
        shield,
        withOl(shield, {
          line: rewritten(shield, (e) => {
            e.publishers = ["Kodansha"];
          }),
        }),
      ),
    ).toBe(differs);
    // The subtitle is not silently ignored: undeclared, the reparse differs.
    expect(refusal(shield, withOl(shield, { schemaAddedFields: [] }))).toBe(differs);
    const declared =
      "A declared schema-added field must be stated by the dump and absent from the stored snapshot.";
    expect(refusal(nukozuke, withOl(nukozuke, { schemaAddedFields: ["subtitle"] }))).toBe(declared);
    expect(refusal(shield, withOl(shield, { schemaAddedFields: ["subtitle", "subtitle"] }))).toBe(
      declared,
    );
    // A stored snapshot that already has a subtitle cannot have it "added".
    const stored = { ...shield.snapshot, subtitle: "The Manga Companion" };
    const base = valueHash(stored);
    expect(
      reviewedFormatRefusal(
        { sourceKey: "openlibrary", sourceRecordId: stored.key, snapshot: stored },
        {
          ...withOl(shield, { normalizedSnapshot: base }),
          baseSnapshot: base,
        },
      ),
    ).toBe(declared);
  });

  it("holds a declared subtitle to the same binding, scope and Volume checks as a stored one", () => {
    const contradicts =
      "Known source work, Volume, packaging, binding or scope facts contradict this correction.";
    for (const [subtitle, reason] of [
      ["Hardcover", contradicts],
      ["Box Set", contradicts],
      ["Volume 9", contradicts],
      ["Audiobook", contradicts],
      ["Light Novel", "The deployed parser reads the dump line as out of scope."],
    ])
      expect(
        refusal(
          shield,
          withOl(shield, {
            line: rewritten(shield, (e) => {
              e.subtitle = subtitle;
            }),
          }),
        ),
        subtitle,
      ).toBe(reason);
  });

  it("dates the record and the dump, never the observation, and cites only an official dated file", () => {
    const ol = dumpOl(shield.reviewed);
    // An unchanged 2021 record stays valid evidence long after ingestion.
    expect(ol.lastModified < "2026-10-07").toBe(true);
    expect(refusal(shield, withOl(shield, { lastModified: "2021-12-27T06:58:16.927625" }))).toBe(
      "Dump line last_modified disagrees.",
    );
    expect(refusal(shield, withOl(shield, { lastModified: "2021-12-27" }))).toBe(
      "Dump line last_modified disagrees.",
    );
    const later = "2026-10-01T00:00:00.000000";
    expect(
      refusal(
        shield,
        withOl(shield, {
          lastModified: later,
          line: rewritten(
            shield,
            (e) => {
              e.last_modified = { type: "/type/datetime", value: later };
            },
            (cells) => [cells[0]!, cells[1]!, cells[2]!, later, cells[4]!],
          ),
        }),
      ),
    ).toBe("Record revision postdates the dump that carries it.");
    expect(refusal(shield, withOl(shield, { revision: 2 }))).toBe("Dump line revision disagrees.");
    const official =
      "Cite the official dated archive.org file of an Open Library monthly editions dump.";
    expect(
      refusal(
        shield,
        withOl(shield, { url: "https://openlibrary.org/data/ol_dump_editions_latest.txt.gz" }),
      ),
    ).toBe(official);
    expect(refusal(shield, withOl(shield, { dump: { ...ol.dump, date: "2026-02-30" } }))).toBe(
      official,
    );
    expect(
      refusal(
        shield,
        withOl(shield, { dump: { ...ol.dump, file: "ol_dump_editions_latest.txt.gz" } }),
      ),
    ).toBe(official);
    expect(
      refusal(shield, withOl(shield, { dump: { ...ol.dump, retrievedAt: Date.UTC(2026, 8, 29) } })),
    ).toBe("Dump retrieval cannot precede the dump's own date.");
    expect(
      refusal(shield, withOl(shield, { dump: { ...ol.dump, streamedSha256: "latest" } })),
    ).toBe("Invalid dump or line digest.");
  });

  it("refuses malformed TSV and an oversized line", () => {
    const cells = dumpOl(shield.reviewed).line.split("\t");
    expect(refusal(shield, withOl(shield, { line: cells.slice(0, 4).join("\t") }))).toMatch(
      /five tab-separated columns/,
    );
    expect(
      refusal(shield, withOl(shield, { line: [...cells.slice(0, 4), "{"].join("\t") })),
    ).toMatch(/not JSON/);
    expect(
      refusal(
        shield,
        withOl(shield, {
          line: rewritten(shield, (e) => {
            e.notes = "x".repeat(16 * 1024);
          }),
        }),
      ),
    ).toBe("Reviewed source Format evidence exceeds its bounds.");
  });

  it("still requires the publisher's own ebook proof for the exact ISBN", () => {
    // The OL half alone shows only that Open Library never stated a format.
    expect(refusal(shield, { ...shield.reviewed, publisher: nukozuke.reviewed.publisher })).toBe(
      "Publisher excerpt must attach ebook directly to the source's own ISBN.",
    );
    const publisher = shield.reviewed.publisher;
    if (
      publisher.kind !== "primaryDigitalDistributorOwnSku" ||
      publisher.distributor !== "bookwalker"
    )
      throw new Error("Shield Hero 8 is BookWalker.");
    expect(
      refusal(shield, {
        ...shield.reviewed,
        publisher: {
          ...publisher,
          product: {
            ...publisher.product,
            excerpt: publisher.product.excerpt.replace(
              "https://schema.org/EBook",
              "https://schema.org/Paperback",
            ),
          },
        },
      }),
    ).toBe("Distributor product must attach the exact ISBN to an English ebook at this SKU.");
  });
});

async function shieldHeld(t: TestT) {
  await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkSubject: "admin",
      username: "ari",
      usernameNormalized: "ari",
      role: "administrator",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    }),
  );
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, {
      name: "One Peace Books",
      slug: "one-peace-books",
    });
    const seriesId = await insertSeries(ctx, {
      publicId: 4100,
      title: "The Rising of the Shield Hero",
    });
    const volumeId = await insertVolume(ctx, { seriesId, position: 8 });
    // The paperback on its own ISBN; the held ebook ISBN has no owner.
    const book = await insertBook(ctx, {
      publisherId,
      seriesId,
      volumeId,
      release: { isbn13: "9781642730005", format: "physical", language: "en" },
    });
    // Ingested 2026-10-07, years after the record's last revision.
    const lastSeenAt = Date.UTC(2026, 9, 7);
    const observationId = await insertObservation(ctx, {
      sourceKey: "openlibrary",
      sourceRecordId: shield.snapshot.key,
      snapshot: shield.snapshot,
      lastSeenAt,
    });
    const holdId = await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "openlibrary",
      kind: "isbn",
      seriesId,
      heldAt: lastSeenAt,
    });
    return { observationId, holdId, ...book };
  });
}

describe("recording a dump-backed source Format decision", () => {
  it("refuses a future retrieval at apply time without writing a decision or audit", async () => {
    const t = makeT();
    const s = await shieldHeld(t);
    const ol = dumpOl(shield.reviewed);
    const args = {
      observationId: s.observationId,
      reviewed: withOl(shield, {
        dump: { ...ol.dump, retrievedAt: Date.now() + 24 * 60 * 60 * 1000 },
      }),
    };
    const preview = await t.query(internal.heldBooks.previewSourceFormatInternal, args);
    expect(preview.refusal).toBeNull();
    const result = await t.mutation(internal.heldBooks.correctSourceFormatInternal, {
      ...args,
      actor: "ari",
      expected: preview.expected!,
    });
    expect(result).toMatchObject({
      status: "refused",
      reason: "Dump evidence retrieval cannot be after the correction decision.",
    });
    const after = await t.run(async (ctx) => ({
      decision: (await ctx.db.get(s.observationId))?.reviewedSourceFormat,
      hold: await ctx.db.get(s.holdId),
      proposals: await ctx.db.query("proposals").collect(),
      ledgers: await ctx.db.query("heldRepairLedger").collect(),
    }));
    expect(after.decision).toBeUndefined();
    expect(after.hold).not.toBeNull();
    expect(after.proposals).toHaveLength(0);
    expect(after.ledgers).toHaveLength(0);
  });

  it("records the line and its provenance in the audited decision, projects digital and restores", async () => {
    const t = makeT();
    const s = await shieldHeld(t);
    const args = { observationId: s.observationId, reviewed: shield.reviewed };
    const before = await t.run(async (ctx) => ({
      observation: (await ctx.db.get(s.observationId))!,
      hold: await ctx.db.get(s.holdId),
    }));
    const preview = await t.query(internal.heldBooks.previewSourceFormatInternal, args);
    expect(preview.refusal).toBeNull();
    expect(preview.proposedSnapshot).toEqual({ ...shield.snapshot, format: "digital" });
    const result = await t.mutation(internal.heldBooks.correctSourceFormatInternal, {
      ...args,
      expected: preview.expected!,
      actor: "ari",
    });
    expect(result.status).toBe("applied");
    const after = await t.run(async (ctx) => ({
      observation: (await ctx.db.get(s.observationId))!,
      hold: await ctx.db.get(s.holdId),
      versions: await ctx.db.query("proposalVersions").collect(),
      ledgers: await ctx.db.query("heldRepairLedger").collect(),
    }));
    const { reviewedSourceFormat: decision, ...raw } = after.observation;
    // Raw facts, ingestion time and the hold stay as they were; no refresh.
    expect(raw).toEqual(before.observation);
    expect(after.hold).toEqual(before.hold);
    expect(decision?.ol).toEqual(shield.reviewed.ol);
    expect(decision?.ol).toMatchObject({
      kind: "olDumpEditionPhysicalFormatAbsent",
      url: "https://archive.org/download/ol_dump_2026-09-30/ol_dump_editions_2026-09-30.txt.gz",
      dump: { file: "ol_dump_editions_2026-09-30.txt.gz", date: "2026-09-30" },
      revision: 1,
      lastModified: "2021-12-27T06:58:15.927625",
    });
    expect(after.versions).toHaveLength(1);
    expect(after.versions[0]!.evidence).toContainEqual({
      kind: "note",
      text: valueHash(shield.reviewed),
    });
    expect(after.versions[0]!.evidence).toContainEqual(
      expect.objectContaining({ url: dumpOl(shield.reviewed).url }),
    );
    expect(projectSourceFormat(after.observation)).toMatchObject({
      status: "corrected",
      snapshot: { ...shield.snapshot, format: "digital" },
    });
    await t.mutation(internal.heldBooks.restoreInternal, {
      actor: "ari",
      ledgerId: result.ledgerId!,
      expectedAfter: after.ledgers[0]!.after,
      reason: "Undo the dump-backed source interpretation before placement.",
    });
    const restored = await t.run(async (ctx) => (await ctx.db.get(s.observationId))!);
    expect(restored).toEqual(before.observation);
    expect(projectSourceFormat(restored).status).toBe("raw");
  });

  it("refuses through the guarded preview when the dump line is not the stored record", async () => {
    const t = makeT();
    const s = await shieldHeld(t);
    const preview = await t.query(internal.heldBooks.previewSourceFormatInternal, {
      observationId: s.observationId,
      reviewed: withOl(shield, {
        line: rewritten(shield, (e) => {
          e.physical_format = "Paperback";
        }),
      }),
    });
    expect(preview).toMatchObject({
      correctionReady: false,
      refusal: "Dump record states physical_format; only an absent field qualifies.",
    });
  });
});
