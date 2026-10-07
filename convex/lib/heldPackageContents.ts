import type { Id, Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { reader, refuse, MAX_GUARD_BYTES, heldState, publisherMatch } from "./heldBooks";
import { bundleContentsState } from "./heldRepair";
import { claimResolver, isbnClaims, primaryIsbnsOf, statedIsbns } from "./releaseIsbns";
import { toIsbn13 } from "./isbn";
import { isbnScope } from "./scope";
import { valueHash } from "./values";

/** Add whole books to an existing unowned Bundle; never reinterpret Edition coverage. */
export async function heldPackageContentsState(
  ctx: QueryCtx,
  observationId: Id<"sourceObservations">,
  bundleId: Id<"releaseBundles">,
  memberIds: Id<"releases">[],
) {
  const sourceState = await heldState(ctx, observationId);
  if (!sourceState.eligible || sourceState.scopeReason || !sourceState.source.series)
    return refuse("Source needs an independently reviewed canonical work.");
  const r = reader(ctx);
  r.facts.push(sourceState.expected);
  const observation = (await r.read(observationId)) ?? refuse("Missing held observation.");
  if (observation.withdrawn || observation.recordRef)
    return refuse("Observation must remain unlinked and current.");
  const holds = await r.many(
    ctx.db
      .query("placementHolds")
      .withIndex("by_observation", (q) => q.eq("observationId", observationId)),
  );
  if (holds.length !== 1 || holds[0]?.kind !== "packaging")
    return refuse("Exactly one packaging hold is required.");
  const state = await bundleContentsState(ctx, bundleId, memberIds, []);
  const sourceFormat = (sourceState.effective.snapshot as { format?: unknown }).format;
  if (sourceFormat !== state.bundle.format) return refuse("Source and Bundle formats differ.");
  if (state.bundle._id !== bundleId) return refuse("Bundle alias is not accepted.");
  await publisherMatch(ctx, observation, state.bundle.publisherId);
  const aliases = await r.many(
    ctx.db
      .query("releaseBundles")
      .withIndex("by_mergedInto", (q) => q.eq("mergedIntoId", bundleId)),
  );
  if (aliases.length)
    return refuse("Bundle aliases need separate personal-reference preservation review.");
  const stated = statedIsbns(observation.snapshot).map(toIsbn13);
  if (!stated.length || stated.some((isbn) => !isbn || !primaryIsbnsOf(state.bundle).has(isbn)))
    return refuse("Every source ISBN must identify this Bundle.");
  for (const isbn of primaryIsbnsOf(state.bundle)) {
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
      !claims.owners.has(bundleId)
    )
      return refuse("Bundle ISBN ownership is incomplete or ambiguous.");
    r.facts.push([...claims.owners.values()]);
  }
  // A missing member is additive. Removing or moving any existing member needs another workflow.
  if (state.members.some((member) => memberIds[member.order - 1] !== member.releaseId))
    return refuse("Existing membership IDs and order must be preserved.");
  let seriesId: Id<"series"> | undefined;
  for (const id of memberIds) {
    const content = state.contents.find((c) => c.release._id === id);
    if (!content || content.series.length !== 1)
      return refuse("Each exact member must have one unchanged work identity.");
    const work = content.series[0]!._id;
    if (seriesId && seriesId !== work) return refuse("Mixed works need separate review.");
    seriesId = work;
  }
  if (
    seriesId !== sourceState.source.series._id ||
    (sourceState.heldSeries && sourceState.heldSeries._id !== seriesId)
  )
    return refuse("Source parent/held work differs from whole-book member work.");
  const snapshot = {
    observation,
    hold: holds[0]!,
    bundle: state.bundle,
    members: [...state.members].sort((a, b) => a.order - b.order),
  };
  const expected = valueHash({ snapshot, contentsExpected: state.expected, facts: r.facts });
  if (new TextEncoder().encode(expected).length > MAX_GUARD_BYTES)
    return refuse("Contents guard exceeds 256 KiB.");
  return { state, snapshot, expected };
}

/** Ledger records preserve the raw observation and exact native membership rows. */
export function packageLedgerState(snapshot: {
  observation: Doc<"sourceObservations">;
  hold: Doc<"placementHolds">;
  bundle: Doc<"releaseBundles">;
  members: Doc<"bundleMemberships">[];
}) {
  const serialized = valueHash(snapshot);
  if (new TextEncoder().encode(serialized).length > MAX_GUARD_BYTES)
    return refuse("Contents ledger exceeds 256 KiB.");
  return serialized;
}
