// Tokyopop's own PDFs beside their EPUBs: the real Dramacon 2 and Dark Metro 1
// records and store products (test.tokyopopDigital.ts). Canonical IDs are
// local fixtures, never live IDs.
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { fileFormatFact } from "./lib/bookFacts";
import { parseEditionJson } from "./lib/openLibrary";
import { parseTitle } from "./lib/prh";
import type { RepairEntry } from "./lib/repair/entries";
import {
  projectSourceFormat,
  reviewedFormatRefusal,
  type ReviewedFormat,
} from "./lib/sourceFormat";
import { valueHash } from "./lib/values";
import {
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { makeT, type TestT } from "./test.helpers";
import { insertBook } from "./test.moderation";
import { dramaconEpubPrhFormat, tokyopopPdfEvidence } from "./test.tokyopopDigital";

const [dramacon, darkMetro, halloween] = tokyopopPdfEvidence;
type Evidence = (typeof tokyopopPdfEvidence)[number];

const sha = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

const parsed = (row: Evidence) => parseEditionJson(JSON.parse(row.wire))!;

/** The reviewed interpretation an operator submits for one held PDF. */
function reviewedFor(row: Evidence, publisher: ReviewedFormat["publisher"] = row.product) {
  const snapshot = parsed(row);
  const base = valueHash(snapshot);
  return {
    kind: "olInferredPhysicalToDigital",
    sourceKey: "openlibrary",
    from: "physical",
    to: "digital",
    key: snapshot.key,
    isbn13: snapshot.isbn13!,
    baseSnapshot: base,
    reason: "Tokyopop's own store SKU is this ISBN's non-shipping PDF eBook.",
    publisher,
    ol: {
      kind: "olPhysicalFormatAbsent",
      key: snapshot.key,
      isbn13: snapshot.isbn13!,
      url: row.olUrl,
      fetchedAt: row.olFetchedAt,
      bodySha256: row.olBodySha256,
      physicalFormatAbsent: true,
      normalizedSnapshot: base,
    },
  } satisfies ReviewedFormat;
}

const refusalFor = (row: Evidence, reviewed: ReviewedFormat) => {
  const snapshot = parsed(row);
  return reviewedFormatRefusal(
    { sourceKey: "openlibrary", sourceRecordId: snapshot.key, snapshot },
    reviewed,
  );
};

/**
 * Tokyopop and its Classics imprint; one Series and Volume; the Classics
 * ordinary Edition holding the EPUB (file format unclassified); optionally a
 * 2010 parent digital record; and the held Open Library PDF.
 */
async function seed(
  t: TestT,
  row: Evidence,
  book: { title: string; label: string; epub: string; parentDigital?: string },
) {
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
    const parentId = await insertPublisher(ctx, { name: "Tokyopop", slug: "tokyopop" });
    const classicsId = await insertPublisher(ctx, {
      name: "TOKYOPOP Classics",
      slug: "tokyopop-classics",
      parentPublisherId: parentId,
    });
    const seriesId = await insertSeries(ctx, { title: book.title });
    const volumeId = await insertVolume(ctx, {
      seriesId,
      label: book.label,
      position: Number(book.label),
    });
    const epub = await insertBook(ctx, {
      publisherId: classicsId,
      seriesId,
      volumeId,
      release: { format: "digital", isbn13: book.epub },
    });
    const parent = book.parentDigital
      ? await insertBook(ctx, {
          publisherId: parentId,
          seriesId,
          volumeId,
          release: {
            format: "digital",
            isbn13: book.parentDigital,
            pubDate: { year: 2010, sort: 20100000 },
          },
        })
      : null;
    // PRH's linked record of the EPUB: digital and Classics, file format unstated.
    const prhId = await insertObservation(ctx, {
      sourceKey: "prh",
      sourceRecordId: book.epub,
      snapshot: {
        kind: "prhTitle",
        isbn13: book.epub,
        format: "digital",
        imprint: "TOKYOPOP Classics",
      },
      recordRef: { type: "release", id: epub.releaseId },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "openlibrary",
      sourceRecordId: parsed(row).key,
      snapshot: parsed(row),
    });
    const holdId = await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "openlibrary",
      kind: "isbn",
      seriesId,
      heldAt: 0,
    });
    return { parentId, classicsId, seriesId, volumeId, epub, parent, prhId, observationId, holdId };
  });
}

async function correct(
  t: TestT,
  observationId: Id<"sourceObservations">,
  reviewed: ReviewedFormat,
) {
  const args = { observationId, reviewed };
  const preview = await t.query(internal.heldBooks.previewSourceFormatInternal, args);
  expect(preview.refusal).toBeNull();
  const result = await t.mutation(internal.heldBooks.correctSourceFormatInternal, {
    ...args,
    expected: preview.expected!,
    actor: "ari",
  });
  expect(result.status).toBe("applied");
}

async function replay(t: TestT, observationId: Id<"sourceObservations">) {
  const args = { observationId, replay: true };
  const preview = await t.query(internal.heldBooks.previewInternal, args);
  expect(preview.refusal).toBeNull();
  expect(preview.placement).toBe("create");
  const result = await t.mutation(internal.heldBooks.executeInternal, {
    ...args,
    actor: "ari",
    expected: preview.expected!,
    operation: "replay",
    reason: "Guarded PDF placement after exact store-product review.",
    evidenceUrls: ["https://tokyopop.com/products.json?limit=250&page=4"],
  });
  expect(result.status).toBe("applied");
  return result.releaseId!;
}

const classify = (
  releaseId: Id<"releases">,
  evidence: Id<"sourceObservations"> | null,
): RepairEntry => ({
  kind: "updateFields",
  key: `epub:${releaseId}`,
  reason: "PRH's own page attaches EPUB FXL Manga RTL to this exact ISBN.",
  table: "releases",
  id: releaseId,
  changes: [{ field: "digitalFileFormat", before: null, after: "epub" }],
  evidenceObservationId: evidence,
});
const run = (t: TestT, entries: RepairEntry[]) =>
  t.mutation(internal.repair.runBatch, { entries, dryRun: false, actor: "ari" });

describe("Tokyopop store-product PDFs", () => {
  it("accepts I Luv Halloween's real graphic-novel series tag as manga", async () => {
    expect(await sha(halloween.wire)).toBe(halloween.olBodySha256);
    expect(await sha(halloween.product.product.excerpt)).toBe(
      halloween.product.product.sectionSha256,
    );
    expect(JSON.parse(halloween.product.product.excerpt).tags).toContain(
      "series:i-luv-halloween-graphic-novel",
    );
    expect(refusalFor(halloween, reviewedFor(halloween))).toBeNull();
  });

  it("checks the saved bytes and refuses another SKU's product, imprint or file format", async () => {
    for (const row of tokyopopPdfEvidence) {
      expect(await sha(row.wire)).toBe(row.olBodySha256);
      expect(await sha(row.product.product.excerpt)).toBe(row.product.product.sectionSha256);
      expect(refusalFor(row, reviewedFor(row))).toBeNull();
    }
    // Dark Metro's real product offered for Dramacon's record.
    expect(
      refusalFor(
        dramacon,
        reviewedFor(dramacon, { ...darkMetro.product, isbn13: dramacon.product.isbn13 }),
      ),
    ).toMatch(/exact ISBN/);
    // The parent's own product does not say Classics, nor EPUB.
    expect(
      refusalFor(
        darkMetro,
        reviewedFor(darkMetro, { ...darkMetro.product, imprint: "TOKYOPOP Classics" }),
      ),
    ).toMatch(/file format, imprint/);
    expect(
      refusalFor(
        dramacon,
        reviewedFor(dramacon, { ...dramacon.product, digitalFileFormat: "epub" }),
      ),
    ).toMatch(/file format, imprint/);
    // PRH's own EPUB subformat is read as EPUB, and only on an ebook.
    expect(fileFormatFact(dramaconEpubPrhFormat.subname)).toBe("epub");
    const prh = {
      isbn: "9781427860835",
      title: "Dramacon, Volume 2",
      imprint: "TOKYOPOP Classics",
      subformat: {
        code: dramaconEpubPrhFormat.subcode,
        description: dramaconEpubPrhFormat.subname,
      },
    };
    expect(parseTitle({ ...prh, format: { code: "EL", description: "Ebook" } })).toMatchObject({
      format: "digital",
      digitalFileFormat: "epub",
    });
    expect(
      parseTitle({ ...prh, format: { code: "TR", description: "Trade Paperback" } })
        ?.digitalFileFormat,
    ).toBeUndefined();
  });

  it("places Dramacon 2's Classics PDF beside its EPUB only once the EPUB is classified, keeping the 2010 parent record", async () => {
    const t = makeT();
    const s = await seed(t, dramacon, {
      title: "Dramacon",
      label: "2",
      epub: "9781427860835",
      parentDigital: "9781427820273",
    });
    const before = await t.run((ctx) => ctx.db.query("releases").collect());
    await correct(t, s.observationId, reviewedFor(dramacon));
    const observation = await t.run((ctx) => ctx.db.get(s.observationId));
    expect(observation?.snapshot).toEqual(parsed(dramacon));
    expect(projectSourceFormat(observation!)).toMatchObject({
      status: "corrected",
      snapshot: {
        format: "digital",
        digitalFileFormat: "pdf",
        publishers: ["TOKYOPOP Classics"],
        publishDate: { year: 2018, month: 12, day: 3 },
      },
    });

    // The unclassified EPUB keeps the Classics digital slot.
    const blocked = await t.query(internal.heldBooks.previewInternal, {
      observationId: s.observationId,
    });
    expect(blocked.placement).toBe("hold");
    // A classification needs the EPUB's own linked record.
    expect((await run(t, [classify(s.epub.releaseId, null)]))[0]?.status).toBe("skipped");
    expect((await run(t, [classify(s.epub.releaseId, s.prhId)]))[0]?.status).toBe("applied");

    const pdfId = await replay(t, s.observationId);
    const after = await t.run((ctx) => ctx.db.query("releases").collect());
    const pdf = after.find((r) => r._id === pdfId)!;
    expect(pdf).toMatchObject({
      editionId: s.epub.editionId,
      publisherId: s.classicsId,
      format: "digital",
      digitalFileFormat: "pdf",
      isbn13: "9781427860828",
      pubDate: { year: 2018, month: 12, day: 3, sort: 20181203 },
    });
    expect(pdf.price).toBeUndefined();
    expect(pdf.binding).toBeUndefined();
    expect(after.find((r) => r._id === s.epub.releaseId)?.digitalFileFormat).toBe("epub");
    expect(after.find((r) => r._id === s.parent!.releaseId)).toEqual(
      before.find((r) => r._id === s.parent!.releaseId),
    );
    expect(await t.run((ctx) => ctx.db.get(s.holdId))).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(s.observationId)))?.snapshot).toEqual(parsed(dramacon));
  });

  it("places Dark Metro 1's parent PDF on the parent, never the Classics EPUB's Edition", async () => {
    const t = makeT();
    const s = await seed(t, darkMetro, { title: "Dark Metro", label: "1", epub: "9781427861344" });
    await correct(t, s.observationId, reviewedFor(darkMetro));
    const pdfId = await replay(t, s.observationId);
    const pdf = (await t.run((ctx) => ctx.db.get(pdfId)))!;
    expect(pdf).toMatchObject({
      publisherId: s.parentId,
      digitalFileFormat: "pdf",
      pubDate: { year: 2020, month: 4, day: 10, sort: 20200410 },
    });
    expect(pdf.editionId).not.toBe(s.epub.editionId);
    expect((await t.run((ctx) => ctx.db.get(pdf.editionId)))?.publisherId).toBe(s.parentId);
  });

  it("keeps the slot closed while a hidden PDF of the same Edition holds it", async () => {
    const t = makeT();
    const s = await seed(t, dramacon, { title: "Dramacon", label: "2", epub: "9781427860835" });
    await t.run(async (ctx) => {
      await ctx.db.patch(s.epub.releaseId, { digitalFileFormat: "epub" });
      // Another PDF ISBN already on the Classics Edition, hidden.
      await insertRelease(ctx, {
        editionId: s.epub.editionId,
        publisherId: s.classicsId,
        seriesIds: [s.seriesId],
        format: "digital",
        digitalFileFormat: "pdf",
        isbn13: "9781427899996",
        status: "hidden",
      });
    });
    await correct(t, s.observationId, reviewedFor(dramacon));
    const preview = await t.query(internal.heldBooks.previewInternal, {
      observationId: s.observationId,
      replay: true,
    });
    expect(preview.refusal).toMatch(/slot is occupied/);
  });
});
