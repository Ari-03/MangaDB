import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { MAX_GUARD_BYTES, reader, refuse, releaseContents } from "./heldBooks";
import { referenceAudit } from "./heldRepair";
import { claimResolver, isbnClaims, primaryIsbnsOf } from "./releaseIsbns";
import { isbnScope } from "./scope";
import { toIsbn13 } from "./isbn";
import { utf8Bytes } from "./sourceFormat";
import { valueHash } from "./values";

// Reviewed own-ISBN cases. Expanding this set requires separate evidence review.
// The captured Product and Manga breadcrumb identify the whole numbered ebook,
// not equality with any physical ISBN or an unchanged printing.
export const canonicalDigitalProof = {
  isbn13: "9781642734140",
  title: "Farming Life in Another World Volume 10",
  work: "Farming Life in Another World",
  volume: "10",
  publisher: "One Peace Books",
  language: "en",
  url: "https://bookwalker.com/volume/30VJ63EBSAB0/farming-life-in-another-world-volume-10",
  httpStatus: 200,
  fetchedAt: 1791339861829,
  bodyBytes: 340821,
  bodySha256: "d55decfd539565f7e94dde1ef63aca7918569bf2dc3d5516a0407a051652374f",
  product: {
    byteStart: 201047,
    byteEndExclusive: 203479,
    sectionSha256: "dc677a7020d678c8f59ad66d41d70e871a9f6896e1478601f2636bb1283a73ad",
    bookFormat: "https://schema.org/EBook",
  },
  breadcrumbs: {
    byteStart: 200559,
    byteEndExclusive: 201003,
    sectionSha256: "2e8c4c7b47dbda3f7d94cb2ffc1363e11106c73dda5deafd1d24df12321102fe",
    category: "Manga",
  },
} as const;

type CanonicalDigitalProof = {
  isbn13: string;
  title: string;
  work: string;
  volume: string;
  publisher: string;
  language: string;
  url: string;
  httpStatus: number;
  fetchedAt: number;
  bodyBytes: number;
  bodySha256: string;
  product: {
    byteStart: number;
    byteEndExclusive: number;
    sectionSha256: string;
    bookFormat: string;
  };
  breadcrumbs: {
    byteStart: number;
    byteEndExclusive: number;
    sectionSha256: string;
    category: string;
  };
};

// Each ISBN selects its own immutable captured product; callers cannot supply proof.
export const canonicalDigitalProofs: Readonly<Partial<Record<string, CanonicalDigitalProof>>> = {
  [canonicalDigitalProof.isbn13]: canonicalDigitalProof,
  "9781642730432": {
    isbn13: "9781642730432",
    title: "The Rising of the Shield Hero Volume 11: The Manga Companion",
    work: "The Rising of the Shield Hero",
    volume: "11",
    publisher: "One Peace Books",
    language: "en",
    url: "https://bookwalker.com/volume/28BBMVTR31VG/the-rising-of-the-shield-hero-volume-11-the-manga-companion",
    httpStatus: 200,
    fetchedAt: 1791339863960,
    bodyBytes: 338711,
    bodySha256: "7e5d03617a27ed046ba648c962503f7f4212fa9da20d36719d54d015a185dbdd",
    product: {
      byteStart: 199503,
      byteEndExclusive: 201814,
      sectionSha256: "9960039815620613ee3070eabeca9b015150a38d9ca862cd9934a29031a51d30",
      bookFormat: "https://schema.org/EBook",
    },
    breadcrumbs: {
      byteStart: 198974,
      byteEndExclusive: 199459,
      sectionSha256: "49517ae558f1caebc9e4cd8fca9a3ad6da4b3c7b5eea99ead2921bde2e880562",
      category: "Manga",
    },
  },
  "9781642731491": {
    isbn13: "9781642731491",
    title: "The New Gate Volume 6",
    work: "The New Gate",
    volume: "6",
    publisher: "One Peace Books",
    language: "en",
    url: "https://bookwalker.com/volume/05BHWBZKYBMG/the-new-gate-volume-6",
    httpStatus: 200,
    fetchedAt: 1791339499828,
    bodyBytes: 337356,
    bodySha256: "0aa3742c19cfb5577b234cff6c5c5e71a0150dd30d2e9f201f9fb52091114dbf",
    product: {
      byteStart: 199332,
      byteEndExclusive: 201621,
      sectionSha256: "bcd872eeb45ac09f3c0d68ab9cd1c7a2e999becd059c67957b6d7b49464b780f",
      bookFormat: "https://schema.org/EBook",
    },
    breadcrumbs: {
      byteStart: 198880,
      byteEndExclusive: 199288,
      sectionSha256: "e8e4fb462b148be1108a4e60c5239ce23932e058be77b06c7ff1112e0942102b",
      category: "Manga",
    },
  },
  "9781642732511": {
    isbn13: "9781642732511",
    title: "The Rising of the Shield Hero Volume 19",
    work: "The Rising of the Shield Hero",
    volume: "19",
    publisher: "One Peace Books",
    language: "en",
    url: "https://bookwalker.com/volume/2MW4BS3HRHCG/the-rising-of-the-shield-hero-volume-19",
    httpStatus: 200,
    fetchedAt: 1791339450665,
    bodyBytes: 338512,
    bodySha256: "9ec88a2b176b17dd4514fc226a930e3ae08efe793797813b72981ef6728be033",
    product: {
      byteStart: 199386,
      byteEndExclusive: 201676,
      sectionSha256: "842d91f07f6a56fa676ac8562ad8dbc281ff9d7cc5f83e1e454e5f49c556ec7f",
      bookFormat: "https://schema.org/EBook",
    },
    breadcrumbs: {
      byteStart: 198898,
      byteEndExclusive: 199342,
      sectionSha256: "797e6652e77d65fce19d7ad8e9fec686df2646324727bd932a27326bad637fe3",
      category: "Manga",
    },
  },
  "9781642731156": {
    isbn13: "9781642731156",
    title: "Hinamatsuri Volume 10",
    work: "Hinamatsuri",
    volume: "10",
    publisher: "One Peace Books",
    language: "en",
    url: "https://bookwalker.com/volume/3EETDFE2MH60/hinamatsuri-volume-10",
    httpStatus: 200,
    fetchedAt: 1791339450651,
    bodyBytes: 340828,
    bodySha256: "4ffb11ef34a68235c9574331a7443955bc4c8d0cbf40c6502f060dc192f0ea0f",
    product: {
      byteStart: 200733,
      byteEndExclusive: 203229,
      sectionSha256: "5e32ece3fb8a8f8fc9724aeeb5ffa1a882d0d18c3d9a885200ea58ed7cc2f3d8",
      bookFormat: "https://schema.org/EBook",
    },
    breadcrumbs: {
      byteStart: 200281,
      byteEndExclusive: 200689,
      sectionSha256: "c9d20b9ec8d4c2de0c20bccac1e5c8b8676e189f36c05ff21b2a86664201577f",
      category: "Manga",
    },
  },
};

/** Capture the exact transaction closure before calling the existing audited field repair. */
export async function canonicalDigitalState(
  ctx: QueryCtx,
  releaseId: Id<"releases">,
  observationId: Id<"sourceObservations">,
) {
  const r = reader(ctx);
  const content = await releaseContents(ctx, releaseId, r);
  const { release, publisher, contents } = content;
  const proof = release.isbn13 ? canonicalDigitalProofs[release.isbn13] : undefined;
  if (!proof) return refuse("Target ISBN has no reviewed own-ISBN ebook proof.");
  if (
    release._id !== releaseId ||
    release.format !== "physical" ||
    release.isbn13 !== proof.isbn13 ||
    release.language !== proof.language ||
    (release.isbn10 !== undefined && toIsbn13(release.isbn10) !== proof.isbn13) ||
    release.publisherId !== publisher._id ||
    content.edition.publisherId !== publisher._id ||
    primaryIsbnsOf(release).size !== 1 ||
    publisher.name !== proof.publisher ||
    content.series.length !== 1 ||
    contents.length !== 1 ||
    contents[0]?.work.title !== proof.work ||
    contents[0]?.volume.label !== proof.volume
  )
    return refuse("Target differs from the reviewed own-ISBN whole manga ebook.");
  const refs = await referenceAudit(ctx, releaseId);
  // These cases need no tracking interpretation changes. A nonempty
  // personal or alias closure requires a separately reviewed preserving path.
  if (!refs.complete || Object.values(refs.counts).some((n) => n !== 0) || refs.variants.length)
    return refuse("Personal references, aliases or variants require separate review.");
  r.facts.push(refs.counts, refs.variants);
  for (const [table, index] of [
    ["releaseIsbns", "by_release"],
    ["bundleMemberships", "by_release"],
    ["bundleConversions", "by_release"],
  ] as const) {
    const rows = await r.many(
      ctx.db.query(table).withIndex(index, (q) => q.eq("releaseId", releaseId)),
    );
    if (rows.length)
      return refuse("Other printings, Bundle membership or conversion require review.");
  }
  const resolver = claimResolver(ctx, { room: r.room });
  for (const isbn of primaryIsbnsOf(release)) {
    const scope = await isbnScope(ctx, isbn);
    if (scope) return refuse(scope);
    // Capture inactive decisions as well: absence of an exclusion is guarded.
    await r.many(
      ctx.db.query("scopeDecisions").withIndex("by_isbn13", (q) => q.eq("isbn13", isbn)),
    );
    const claims = await isbnClaims(ctx, isbn, { resolver, room: r.room });
    if (
      !claims?.complete ||
      claims.unresolved.length ||
      claims.printed ||
      claims.owners.size !== 1 ||
      !claims.owners.has(releaseId) ||
      [...claims.owners.values()].some((o) => o.claims.some((c) => c.storedId !== releaseId))
    )
      return refuse("ISBN namespace is incomplete, aliased, printed or ambiguous.");
    r.facts.push([...claims.owners.values()]);
  }
  // Inspect every covering Edition, not just siblings on this Edition.
  const seen = new Set<Id<"editions">>();
  for (const { volume } of contents) {
    const rows = await r.many(
      ctx.db.query("volumeCoverages").withIndex("by_volume", (q) => q.eq("volumeId", volume._id)),
    );
    for (const row of rows) {
      if (seen.has(row.editionId)) continue;
      seen.add(row.editionId);
      await r.read(row.editionId);
      const siblings = await r.many(
        ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", row.editionId)),
      );
      for (const sibling of siblings) {
        if (
          sibling._id === releaseId ||
          sibling.status !== "active" ||
          sibling.format !== "digital"
        )
          continue;
        const owner = await r.active(sibling.publisherId);
        if (owner._id === publisher._id)
          return refuse("A digital Release already occupies the work/publisher content slot.");
      }
    }
  }
  const proposals = new Set<Id<"proposals">>();
  const linked = await r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_record", (q) =>
        q.eq("recordRef.type", "release").eq("recordRef.id", releaseId),
      ),
  );
  const anchor = await r.read(observationId);
  if (
    !anchor ||
    anchor.withdrawn ||
    anchor.recordRef?.type !== "release" ||
    anchor.recordRef.id !== releaseId ||
    !linked.some((s) => s._id === observationId)
  )
    return refuse("Ledger anchor must remain a current linked target source.");
  for (const source of linked) {
    if (source.queuedProposalId) proposals.add(source.queuedProposalId);
    if (source.withdrawn || source.conflicts?.some((c) => c.field !== "placement"))
      return refuse("Withdrawn or conflicting linked source requires separate review.");
    const snapshot = source.snapshot as {
      kind?: string;
      isbn13?: string;
      format?: string;
      binding?: string;
    };
    // Physical from the old OL default is the known error. Never override a
    // stated binding, an explicit source decision, or another source's print claim.
    if (
      source.printingIsbn13 ||
      snapshot.isbn13 !== proof.isbn13 ||
      snapshot.binding ||
      source.reviewedSourceFormat ||
      (snapshot.format !== "digital" &&
        !(
          source.sourceKey === "openlibrary" &&
          snapshot.kind === "olEdition" &&
          snapshot.format === "physical"
        ))
    )
      return refuse("Linked source printing, ISBN, binding or format needs separate review.");
    await r.many(
      ctx.db.query("approvedSources").withIndex("by_key", (q) => q.eq("key", source.sourceKey)),
    );
    await r.many(
      ctx.db
        .query("observationSnapshots")
        .withIndex("by_observation", (q) => q.eq("observationId", source._id)),
    );
    await r.many(
      ctx.db
        .query("placementHolds")
        .withIndex("by_observation", (q) => q.eq("observationId", source._id)),
    );
    await r.many(
      ctx.db
        .query("heldRepairLedger")
        .withIndex("by_observation", (q) => q.eq("observationId", source._id)),
    );
  }
  for (const ref of [
    { type: "release" as const, id: releaseId },
    { type: "edition" as const, id: content.edition._id },
    ...content.series.map((s) => ({ type: "series" as const, id: s._id })),
    ...contents.map((c) => ({ type: "volume" as const, id: c.volume._id })),
  ]) {
    const revisions = await r.many(
      ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id)),
    );
    for (const revision of revisions) proposals.add(revision.proposalId);
  }
  for (const id of proposals) {
    await r.read(id);
    await r.many(
      ctx.db.query("proposalVersions").withIndex("by_proposal", (q) => q.eq("proposalId", id)),
    );
  }
  const before = valueHash({ proof, releaseId, observationId, facts: r.facts });
  if (utf8Bytes(before) > MAX_GUARD_BYTES / 2)
    return refuse("Canonical correction closure exceeds ledger bounds.");
  return { expected: before, before, release, proof, r };
}
