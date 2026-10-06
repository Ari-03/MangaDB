import type { Id, Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { reader, releaseContents, refuse, MAX_GUARD_BYTES } from "./heldBooks";
import { claimResolver, isbnClaims, primaryIsbnsOf } from "./releaseIsbns";
import { valueHash } from "./values";
import { isbnScope, scopeState } from "./scope";

/** Bounded reverse aliases: current private references can retain a merged ID. */
async function aliases<I extends string>(
  id: I,
  query: (id: I) => AsyncIterable<{ _id: I; status: string }>,
  r: ReturnType<typeof reader>,
) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) {
    if (ids.length > 30) return refuse("Alias closure incomplete; inspect separately.");
    const rows = await r.many(query(ids[i]!));
    for (const row of rows) {
      if (row.status !== "merged" || ids.includes(row._id))
        return refuse("Alias cycle or invalid merge status.");
      ids.push(row._id);
    }
  }
  return ids;
}

/** Exact dependency closure. Personal rows never leave this helper; only counts do. */
export async function referenceAudit(
  ctx: QueryCtx,
  releaseId: Id<"releases">,
  bundleId?: Id<"releaseBundles">,
) {
  const r = reader(ctx);
  const release = (await r.read(releaseId)) ?? refuse("No Release.");
  const edition = await r.active(release.editionId);
  const coverages = await r.many(
    ctx.db.query("volumeCoverages").withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
  );
  const volumes: Doc<"volumes">[] = [];
  for (const coverage of coverages) {
    const volume = await r.active(coverage.volumeId);
    if (!volumes.some((v) => v._id === volume._id)) volumes.push(volume);
  }
  const variants = await r.many(
    ctx.db.query("releaseVariants").withIndex("by_release", (q) => q.eq("releaseId", releaseId)),
  );
  const releaseIds = await aliases(
    releaseId,
    (id) => ctx.db.query("releases").withIndex("by_mergedInto", (q) => q.eq("mergedIntoId", id)),
    r,
  );
  const editionIds = await aliases(
    edition._id,
    (id) => ctx.db.query("editions").withIndex("by_mergedInto", (q) => q.eq("mergedIntoId", id)),
    r,
  );
  const volumeIds = [];
  for (const v of volumes)
    volumeIds.push(
      ...(await aliases(
        v._id,
        (id) => ctx.db.query("volumes").withIndex("by_mergedInto", (q) => q.eq("mergedIntoId", id)),
        r,
      )),
    );
  const bundleIds = bundleId
    ? await aliases(
        bundleId,
        (id) =>
          ctx.db
            .query("releaseBundles")
            .withIndex("by_mergedInto", (q) => q.eq("mergedIntoId", id)),
        r,
      )
    : [];
  const seriesIds = new Set<Id<"series">>();
  const canonicalSeriesIds = new Set<Id<"series">>();
  for (const id of release.seriesIds) {
    const series = await r.active(id);
    canonicalSeriesIds.add(series._id);
    for (const alias of await aliases(
      series._id,
      (id) => ctx.db.query("series").withIndex("by_mergedInto", (q) => q.eq("mergedIntoId", id)),
      r,
    ))
      seriesIds.add(alias);
  }
  const counts: Record<string, number> = {};
  counts.mergedAliases =
    seriesIds.size -
    canonicalSeriesIds.size +
    releaseIds.length +
    editionIds.length +
    volumeIds.length +
    bundleIds.length -
    (2 + volumes.length + (bundleId ? 1 : 0));
  const reviewIds = new Set<Id<"reviews">>();
  const commentIds = new Set<Id<"comments">>();
  const count = async <T>(name: string, query: AsyncIterable<T>) => {
    const rows = await r.many(query);
    counts[name] = (counts[name] ?? 0) + rows.length;
    return rows;
  };
  await count(
    "collectionEntries.release",
    ctx.db.query("collectionEntries").withIndex("by_release", (q) => q.eq("releaseId", releaseId)),
  );
  await count(
    "releaseProgress",
    ctx.db.query("releaseProgress").withIndex("by_release", (q) => q.eq("releaseId", releaseId)),
  );
  if (bundleId)
    await count(
      "collectionEntries.bundle",
      ctx.db.query("collectionEntries").withIndex("by_bundle", (q) => q.eq("bundleId", bundleId)),
    );
  for (const variant of variants)
    await count(
      `collectionEntries.variant.${variant._id}`,
      ctx.db
        .query("collectionEntries")
        .withIndex("by_variantId", (q) => q.eq("variantId", variant._id)),
    );
  for (const table of ["ratings", "ratingStats", "favorites", "reviews"] as const) {
    const editionRows = await count(
      `${table}.edition`,
      ctx.db.query(table).withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
    );
    if (table === "reviews") for (const row of editionRows) reviewIds.add(row._id as Id<"reviews">);
    for (const volume of volumes) {
      const rows = await count(
        `${table}.volume.${volume._id}`,
        ctx.db.query(table).withIndex("by_volume", (q) => q.eq("volumeId", volume._id)),
      );
      if (table === "reviews") for (const row of rows) reviewIds.add(row._id as Id<"reviews">);
    }
    for (const seriesId of seriesIds) {
      const rows = await count(
        `${table}.series.${seriesId}`,
        ctx.db.query(table).withIndex("by_series", (q) => q.eq("seriesId", seriesId)),
      );
      if (table === "reviews") for (const row of rows) reviewIds.add(row._id as Id<"reviews">);
    }
  }
  for (const volume of volumes) {
    await count(
      `volumeProgress.${volume._id}`,
      ctx.db.query("volumeProgress").withIndex("by_volume", (q) => q.eq("volumeId", volume._id)),
    );
    const comments = await count(
      `comments.volume.${volume._id}`,
      ctx.db.query("comments").withIndex("by_volume", (q) => q.eq("volumeId", volume._id)),
    );
    for (const comment of comments) commentIds.add(comment._id);
  }
  for (const seriesId of seriesIds) {
    const comments = await count(
      `comments.series.${seriesId}`,
      ctx.db.query("comments").withIndex("by_series", (q) => q.eq("seriesId", seriesId)),
    );
    for (const comment of comments) commentIds.add(comment._id);
    await count(
      `userSeriesStates.${seriesId}`,
      ctx.db.query("userSeriesStates").withIndex("by_series", (q) => q.eq("seriesId", seriesId)),
    );
  }
  for (const id of releaseIds.slice(1)) {
    await count(
      "collectionEntries.mergedRelease",
      ctx.db.query("collectionEntries").withIndex("by_release", (q) => q.eq("releaseId", id)),
    );
    await count(
      "releaseProgress.mergedRelease",
      ctx.db.query("releaseProgress").withIndex("by_release", (q) => q.eq("releaseId", id)),
    );
    const aliasVariants = await r.many(
      ctx.db.query("releaseVariants").withIndex("by_release", (q) => q.eq("releaseId", id)),
    );
    for (const variant of aliasVariants)
      await count(
        "collectionEntries.mergedVariant",
        ctx.db
          .query("collectionEntries")
          .withIndex("by_variantId", (q) => q.eq("variantId", variant._id)),
      );
  }
  for (const id of bundleIds.slice(1))
    await count(
      "collectionEntries.mergedBundle",
      ctx.db.query("collectionEntries").withIndex("by_bundle", (q) => q.eq("bundleId", id)),
    );
  for (const table of ["ratings", "ratingStats", "favorites", "reviews"] as const) {
    for (const id of editionIds.slice(1)) {
      const rows = await count(
        `${table}.mergedEdition`,
        ctx.db.query(table).withIndex("by_edition", (q) => q.eq("editionId", id)),
      );
      if (table === "reviews") for (const row of rows) reviewIds.add(row._id as Id<"reviews">);
    }
    for (const id of volumeIds.filter((id) => !volumes.some((v) => v._id === id))) {
      const rows = await count(
        `${table}.mergedVolume`,
        ctx.db.query(table).withIndex("by_volume", (q) => q.eq("volumeId", id)),
      );
      if (table === "reviews") for (const row of rows) reviewIds.add(row._id as Id<"reviews">);
    }
  }
  for (const id of volumeIds.filter((id) => !volumes.some((v) => v._id === id))) {
    await count(
      "volumeProgress.mergedVolume",
      ctx.db.query("volumeProgress").withIndex("by_volume", (q) => q.eq("volumeId", id)),
    );
    const comments = await count(
      "comments.mergedVolume",
      ctx.db.query("comments").withIndex("by_volume", (q) => q.eq("volumeId", id)),
    );
    for (const comment of comments) commentIds.add(comment._id);
  }
  for (const id of reviewIds)
    await count(
      "reviewAudit",
      ctx.db.query("reviewAudit").withIndex("by_review", (q) => q.eq("reviewId", id)),
    );
  const comments = [...commentIds];
  for (let i = 0; i < comments.length; i++) {
    if (comments.length > 80) return refuse("Comment dependency closure incomplete.");
    const id = comments[i]!;
    const replies = await count(
      "comments.replies",
      ctx.db.query("comments").withIndex("by_parent", (q) => q.eq("parentId", id)),
    );
    for (const reply of replies)
      if (!commentIds.has(reply._id)) {
        commentIds.add(reply._id);
        comments.push(reply._id);
      }
    await count(
      "commentAudit",
      ctx.db.query("commentAudit").withIndex("by_comment", (q) => q.eq("commentId", id)),
    );
    await count(
      "commentReports",
      ctx.db.query("commentReports").withIndex("by_comment_reporter", (q) => q.eq("commentId", id)),
    );
  }
  // Review/Comment audits and reports retain their parent IDs; supported
  // operations leave these identities untouched. Edition refs and alias
  // closure require separate preservation work and refuse this conversion.
  // Sharing stores user visibility, not a catalog pointer. Keeping Series IDs
  // and all tracking untouched preserves its identity.
  return {
    complete: true,
    counts,
    eligible: Object.entries(counts).every(
      ([name, n]) =>
        n === 0 ||
        name === "collectionEntries.release" ||
        name === "collectionEntries.bundle" ||
        name.startsWith("userSeriesStates.") ||
        name.includes(".series.") ||
        name.includes(".volume.") ||
        name.startsWith("volumeProgress.") ||
        name.startsWith("comments.") ||
        ["reviewAudit", "commentAudit", "commentReports"].includes(name),
    ),
    release,
    edition,
    coverages,
    volumes,
    variants,
  };
}

/** Guard an existing collision's exact box, target and complete member graph. */
export async function conversionState(
  ctx: QueryCtx,
  releaseId: Id<"releases">,
  bundleId: Id<"releaseBundles">,
) {
  const r = reader(ctx);
  const box = (await r.read(releaseId)) ?? refuse("No box Release.");
  const edition = await r.active(box.editionId);
  const bundle = await r.active(bundleId);
  const publisher = await r.active(bundle.publisherId);
  const members = (
    await r.many(
      ctx.db.query("bundleMemberships").withIndex("by_bundle", (q) => q.eq("bundleId", bundleId)),
    )
  ).sort((a, b) => a.order - b.order);
  if (!members.length)
    return refuse("Bundle is empty; exact contents research and membership repair are required.");
  const contents = [];
  for (const member of members) {
    if (member.releaseId === releaseId) return refuse("Box is its own member.");
    const content = await releaseContents(ctx, member.releaseId, r);
    if (content.publisher._id !== publisher._id || content.release.format !== bundle.format)
      return refuse("Member publisher or format differs.");
    contents.push(content);
  }
  const refs = await referenceAudit(ctx, releaseId, bundleId);
  r.facts.push({
    release: refs.release,
    edition: refs.edition,
    coverages: refs.coverages,
    volumes: refs.volumes,
    variants: refs.variants,
    counts: refs.counts,
  });
  const links = await r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_record", (q) =>
        q.eq("recordRef.type", "release").eq("recordRef.id", releaseId),
      ),
  );
  const siblings = await r.many(
    ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
  );
  const claims = [];
  for (const isbn of primaryIsbnsOf(box)) {
    const scope = await isbnScope(ctx, isbn);
    if (scope) return refuse(scope);
    const found = await isbnClaims(ctx, isbn, {
      resolver: claimResolver(ctx, { room: r.room }),
      room: r.room,
    });
    if (
      !found?.complete ||
      found.unresolved.length ||
      found.printed ||
      [...found.owners.values()].some((o) => o.doc._id !== releaseId && o.doc._id !== bundleId)
    )
      return refuse("Conversion ISBN claims are incomplete or have another owner.");
    if (!primaryIsbnsOf(bundle).has(isbn)) return refuse("Box and Bundle ISBNs disagree.");
    claims.push([...found.owners.values()]);
  }
  if (!primaryIsbnsOf(box).size) return refuse("Box has no normalized ISBN.");
  if (
    box.locked ||
    box.status !== "active" ||
    box.format !== bundle.format ||
    box.publisherId !== bundle.publisherId ||
    edition.publisherId !== bundle.publisherId
  )
    return refuse("Box status, lock, format or publisher differs.");
  if (!refs.eligible)
    return refuse(
      `Personal-data preservation required: ${Object.entries(refs.counts)
        .filter(([, n]) => n)
        .map(([name, n]) => `${name}=${n}`)
        .join(", ")}.`,
    );
  r.facts.push(links, siblings, claims);
  for (const ref of [
    { type: "release" as const, id: releaseId },
    { type: "releaseBundle" as const, id: bundleId },
  ])
    r.facts.push(
      await r.many(
        ctx.db
          .query("revisions")
          .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id)),
      ),
    );
  const expected = valueHash({ releaseId, bundleId, facts: r.facts });
  if (new TextEncoder().encode(expected).length > MAX_GUARD_BYTES)
    return refuse("Conversion guard exceeds 256 KiB.");
  return {
    expected,
    box,
    bundle,
    members,
    contents,
    refs,
    linkedSourceCount: links.length,
    sharedEdition: siblings.some((s) => s._id !== releaseId && s.status === "active"),
    placeholderVolumeIds: refs.volumes.map((v) => v._id),
  };
}

/** A conversion remains applicable by exact immutable audit IDs, never latest text/name. */
export async function convertedClaim(
  ctx: QueryCtx,
  release: Doc<"releases">,
  bundle: Doc<"releaseBundles">,
) {
  if (
    bundle.status !== "active" ||
    bundle.locked ||
    release.status !== "hidden" ||
    release.locked ||
    release.format !== bundle.format ||
    release.publisherId !== bundle.publisherId
  )
    return null;
  const rows = await ctx.db
    .query("bundleConversions")
    .withIndex("by_release", (q) => q.eq("releaseId", release._id))
    .take(2);
  const conversion = rows[0];
  if (rows.length !== 1 || conversion?.bundleId !== bundle._id) return null;
  const proposal = await ctx.db.get(conversion.proposalId);
  const revision = await ctx.db.get(conversion.revisionId);
  if (
    proposal?.state !== "approved" ||
    revision?.proposalId !== proposal._id ||
    revision.ref.type !== "release" ||
    revision.ref.id !== release._id ||
    !revision.changes.some((c) => c.field === "convertedToBundle")
  )
    return null;
  if (
    valueHash([...primaryIsbnsOf(release)].sort()) !== conversion.isbnKeys ||
    ![...primaryIsbnsOf(release)].every((key) => primaryIsbnsOf(bundle).has(key))
  )
    return null;
  return { conversion, revisionId: revision._id, proposalId: proposal._id };
}

export type FormatCorrection = {
  releaseId: Id<"releases">;
  from: "physical" | "digital";
  to: "physical" | "digital";
};
/** Exact proposed member graph and format corrections. No identity is hidden, merged or replaced. */
export async function bundleContentsState(
  ctx: QueryCtx,
  bundleId: Id<"releaseBundles">,
  memberIds: Id<"releases">[],
  corrections: FormatCorrection[],
) {
  if (
    !memberIds.length ||
    memberIds.length > 30 ||
    new Set(memberIds).size !== memberIds.length ||
    corrections.length > 8 ||
    new Set(corrections.map((c) => c.releaseId)).size !== corrections.length
  )
    return refuse(
      "Supply 1–30 unique ordered members and at most eight unique format corrections.",
    );
  const r = reader(ctx);
  const bundle = await r.active(bundleId);
  await r.active(bundle.publisherId);
  const members = await r.many(
    ctx.db.query("bundleMemberships").withIndex("by_bundle", (q) => q.eq("bundleId", bundleId)),
  );
  const publicLinks = await r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_record", (q) =>
        q.eq("recordRef.type", "releaseBundle").eq("recordRef.id", bundleId),
      ),
  );
  const owners = await r.many(
    ctx.db.query("collectionEntries").withIndex("by_bundle", (q) => q.eq("bundleId", bundleId)),
  );
  // Membership affects derived ownership/reading. A populated Bundle needs
  // a dedicated transfer workflow; this narrow repair does not alter it.
  if (owners.length)
    return refuse(
      "Bundle has personal collection references; membership repair requires a supported preserving workflow.",
    );
  const contents = [];
  for (const id of new Set([
    ...members.map((m) => m.releaseId),
    ...memberIds,
    ...corrections.map((c) => c.releaseId),
  ])) {
    const content = await releaseContents(ctx, id, r);
    contents.push(content);
    const correction = corrections.find((c) => c.releaseId === id);
    if (correction) {
      if (correction.from === correction.to || content.release.format !== correction.from)
        return refuse("Format correction does not state the current format.");
      const variants = await r.many(
        ctx.db.query("releaseVariants").withIndex("by_release", (q) => q.eq("releaseId", id)),
      );
      if (variants.length)
        return refuse("Format correction has Release Variants; repair their semantics first.");
      await r.many(
        ctx.db
          .query("sourceObservations")
          .withIndex("by_record", (q) => q.eq("recordRef.type", "release").eq("recordRef.id", id)),
      );
    }
    for (const isbn of primaryIsbnsOf(content.release)) {
      const scope = await isbnScope(ctx, isbn);
      if (scope) return refuse(scope);
      const claims = await isbnClaims(ctx, isbn, {
        resolver: claimResolver(ctx, { room: r.room }),
        room: r.room,
      });
      if (
        !claims?.complete ||
        claims.unresolved.length ||
        claims.owners.size !== 1 ||
        !claims.owners.has(id)
      )
        return refuse("Member/correction ISBN has incomplete or ambiguous ownership.");
      r.facts.push([...claims.owners.values()]);
    }
    if (
      memberIds.includes(id) &&
      (content.publisher._id !== bundle.publisherId ||
        (correction?.to ?? content.release.format) !== bundle.format)
    )
      return refuse("Proposed member publisher or format differs from Bundle.");
  }
  const expected = valueHash({ bundleId, memberIds, corrections, facts: r.facts });
  if (new TextEncoder().encode(expected).length > MAX_GUARD_BYTES)
    return refuse("Contents repair guard exceeds 256 KiB.");
  return { expected, bundle, members, contents, linkedSourceCount: publicLinks.length };
}

/** A repeat uses current contents/claims and exact immutable conversion IDs. */
export async function conversionPreview(
  ctx: QueryCtx,
  releaseId: Id<"releases">,
  bundleId: Id<"releaseBundles">,
) {
  const r = reader(ctx);
  const box = await r.read(releaseId);
  if (box?.status !== "hidden")
    return { already: false as const, ...(await conversionState(ctx, releaseId, bundleId)) };
  const bundle = await r.active(bundleId);
  const proof =
    (await convertedClaim(ctx, box, bundle)) ??
    refuse("Hidden box has no applicable exact conversion audit.");
  const members = (
    await r.many(
      ctx.db.query("bundleMemberships").withIndex("by_bundle", (q) => q.eq("bundleId", bundleId)),
    )
  ).sort((a, b) => a.order - b.order);
  if (!members.length) return refuse("Converted Bundle contents are now empty.");
  for (const member of members) {
    const content = await releaseContents(ctx, member.releaseId, r);
    if (content.publisher._id !== bundle.publisherId || content.release.format !== bundle.format)
      return refuse("Converted Bundle member identity drifted.");
  }
  for (const key of primaryIsbnsOf(box)) {
    const claims = await isbnClaims(ctx, key, {
      resolver: claimResolver(ctx, { room: r.room }),
      room: r.room,
    });
    if (
      !claims?.complete ||
      claims.unresolved.length ||
      claims.printed ||
      [...claims.owners.values()].some((o) => o.doc._id !== releaseId && o.doc._id !== bundleId)
    )
      return refuse("Converted box claims are no longer exclusive.");
    r.facts.push([...claims.owners.values()]);
  }
  const sources = await r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_record", (q) =>
        q.eq("recordRef.type", "release").eq("recordRef.id", releaseId),
      ),
  );
  const siblings = await r.many(
    ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", box.editionId)),
  );
  const coverage = await r.many(
    ctx.db
      .query("volumeCoverages")
      .withIndex("by_edition", (q) => q.eq("editionId", box.editionId)),
  );
  const expected = valueHash({ releaseId, bundleId, proof, facts: r.facts });
  if (new TextEncoder().encode(expected).length > MAX_GUARD_BYTES)
    return refuse("Repeat guard exceeds 256 KiB.");
  return {
    already: true as const,
    expected,
    members,
    linkedSourceCount: sources.length,
    sharedEdition: siblings.some(
      (release) => release._id !== releaseId && release.status === "active",
    ),
    placeholderVolumeIds: coverage.map((row) => row.volumeId),
  };
}

/** Hide only a proved out-of-scope Release; retain manga Work/Volume/Edition identities. */
export async function scopedReleaseState(ctx: QueryCtx, releaseId: Id<"releases">) {
  const r = reader(ctx);
  const release = await r.active(releaseId);
  const contents = await releaseContents(ctx, releaseId, r);
  const refs = await referenceAudit(ctx, releaseId);
  if (
    !refs.complete ||
    refs.counts.mergedAliases ||
    refs.counts.releaseProgress ||
    refs.counts["collectionEntries.release"] ||
    Object.entries(refs.counts).some(
      ([name, n]) => name.startsWith("collectionEntries.variant.") && n,
    )
  )
    return refuse(
      "Release-specific tracking or aliases need a personal-data-preserving scope repair.",
    );
  const membership = await r.many(
    ctx.db.query("bundleMemberships").withIndex("by_release", (q) => q.eq("releaseId", releaseId)),
  );
  if (membership.length)
    return refuse("Release remains in a Bundle; review its actual contents before scope repair.");
  const keys = primaryIsbnsOf(release);
  if (!keys.size) return refuse("Scope repair requires an exact valid primary ISBN.");
  for (const isbn of keys) {
    const state = await scopeState(ctx, isbn);
    if (!state.active)
      return refuse("Record a reviewed exact-ISBN scope decision before canonical repair.");
    const proposal = await r.read(state.active.proposalId);
    if (proposal?.state !== "approved") return refuse("Scope decision has no approved audit.");
    r.facts.push(state);
    const claims = await isbnClaims(ctx, isbn, {
      resolver: claimResolver(ctx, { room: r.room }),
      room: r.room,
    });
    if (
      !claims?.complete ||
      claims.unresolved.length ||
      claims.owners.size !== 1 ||
      !claims.owners.has(releaseId)
    )
      return refuse("Scope repair ISBN namespace is incomplete or shared.");
    r.facts.push([...claims.owners.values()]);
  }
  const sources = await r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_record", (q) =>
        q.eq("recordRef.type", "release").eq("recordRef.id", releaseId),
      ),
  );
  const siblings = await r.many(
    ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", release.editionId)),
  );
  r.facts.push(refs.counts, siblings);
  const expected = valueHash({ releaseId, facts: r.facts });
  if (new TextEncoder().encode(expected).length > MAX_GUARD_BYTES)
    return refuse("Scope repair guard exceeds 256 KiB.");
  return {
    expected,
    release,
    contents,
    privateCounts: refs.counts,
    sourceIds: sources.map((s) => s._id),
  };
}
