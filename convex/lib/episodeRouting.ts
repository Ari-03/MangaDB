import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { AnnReleaseSnapshot } from "../ann";
import { bookFacts } from "./bookFacts";
import { outOfScopeReason } from "./bookTitle";
import { toIsbn13 } from "./isbn";

/** Operator-reviewed facts from this ISBN's selected publisher product, not a sibling SKU. */
export const episodeRoutingValidator = v.object({
  parentObservationId: v.id("sourceObservations"),
  sourceTitle: v.string(),
  productTitle: v.string(),
  productVolumeLabel: v.string(),
  sourceGlobalLabel: v.string(),
  productIsbn13: v.string(),
  productFormat: v.union(v.literal("physical"), v.literal("digital")),
  productBinding: v.union(v.literal("paperback"), v.literal("digital")),
  publisherName: v.string(),
  publisherSeriesTitle: v.string(),
  productUrl: v.string(),
});
export type EpisodeRouting = Infer<typeof episodeRoutingValidator>;
const fold = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const ROOT = "umineko when they cry";

/** Full Episode and arc identity. No aliases, bare numbers, Part titles or extra clauses. */
export function episodeTitle(text: string) {
  const match =
    /^(Umineko\s+When\s+They\s+Cry)\s+Episode\s+([1-8]):\s+([a-z]+(?:\s+[a-z]+)*?)(?:,?\s+(?:Volume|Vol\.)\s+([1-9]\d*))?$/i.exec(
      text,
    );
  if (!match || outOfScopeReason(text)) return null;
  const work = `${match[1]} Episode ${match[2]}: ${match[3]}`;
  const facts = bookFacts(text, [work]);
  if (facts.packaging.length || facts.unreadable.length || facts.bindings.length || facts.digital)
    return null;
  return { work, episode: match[2]!, arc: fold(match[3]!), local: match[4] };
}
const sameEpisode = (a: ReturnType<typeof episodeTitle>, b: ReturnType<typeof episodeTitle>) =>
  !!a && !!b && a.episode === b.episode && a.arc === b.arc;

/** All inputs have already been read through heldState's bounded, hashed reader.
 * Global ordinals certify ANN bibliography membership; explicit local Volumes certify contents.
 * The publisher attestation is reviewed evidence, not a network fetch inside a transaction.
 */
export function episodeRoute(input: {
  observation: Doc<"sourceObservations">;
  parent: Doc<"sourceObservations"> | null;
  umbrella: Doc<"series"> | null;
  isbn13: string | null;
  proof: EpisodeRouting;
  evidenceUrls: string[];
  series: Doc<"series">;
  publisher: Doc<"publishers">;
  release: Doc<"releases">;
  volume: Doc<"volumes">;
}) {
  const { observation, parent, umbrella, proof, series, publisher, release, volume } = input;
  const fail = (reason: string): never => {
    throw new Error(`Episode routing: ${reason}`);
  };
  if (
    observation.sourceKey !== "ann" ||
    observation.sourceRecordId !== `release:${(observation.snapshot as AnnReleaseSnapshot).annId}`
  )
    return fail("requires the exact ANN child record.");
  const line = observation.snapshot as AnnReleaseSnapshot;
  const source = episodeTitle(line.title);
  const product = episodeTitle(proof.productTitle);
  const canonical = episodeTitle(series.title);
  const page = line.page;
  const pageTitle = page?.title ? episodeTitle(page.title) : null;
  if (
    proof.sourceTitle !== line.title ||
    !sameEpisode(source, product) ||
    !sameEpisode(source, canonical) ||
    !sameEpisode(source, pageTitle) ||
    canonical?.local !== undefined
  )
    return fail("source, page, publisher and canonical Episode/arc must agree explicitly.");
  if (
    !source?.local ||
    source.local !== product?.local ||
    source.local !== pageTitle?.local ||
    source.local !== proof.productVolumeLabel ||
    source.local !== volume.label ||
    volume.position !== Number(source.local)
  )
    return fail("explicit local Volume statements and complete canonical Volume disagree.");
  const global = page?.volume?.match(/^(GN|eBook) ([1-9]\d*)$/);
  if (
    line.kind !== "annRelease" ||
    line.mangaId !== "11729" ||
    page?.status !== "ok" ||
    page.mangaId !== line.mangaId ||
    !global ||
    global[2] !== line.label ||
    global[2] !== proof.sourceGlobalLabel
  )
    return fail("requires the current Umineko page and independent global ordinal.");
  if (
    toIsbn13(line.isbn13) !== input.isbn13 ||
    toIsbn13(page.isbn13) !== input.isbn13 ||
    toIsbn13(proof.productIsbn13) !== input.isbn13 ||
    toIsbn13(release.isbn13) !== input.isbn13
  )
    return fail("source, page, publisher SKU and target primary ISBN must agree.");
  if (page.isbn10 && toIsbn13(page.isbn10) !== input.isbn13)
    return fail("page ISBN-10 contradicts the exact SKU.");
  if (
    line.format !== proof.productFormat ||
    release.format !== proof.productFormat ||
    (global[1] === "GN" ? "physical" : "digital") !== proof.productFormat ||
    release.language !== "en" ||
    (proof.productFormat === "physical"
      ? proof.productBinding !== "paperback" || release.binding !== "paperback"
      : proof.productBinding !== "digital" || release.binding !== undefined)
  )
    return fail("source/page/SKU/target format, language or binding differs.");
  if (
    proof.publisherName !== "Yen Press" ||
    publisher.name !== "Yen Press" ||
    release.publisherId !== publisher._id ||
    !["Yen Press", ...(line.format === "digital" ? ["Orbit"] : [])].includes(page.distributor ?? "")
  )
    return fail("exact Yen Press imprint proof or known ANN distributor disagrees.");
  const url = new URL(proof.productUrl);
  if (
    url.origin !== "https://yenpress.com" ||
    !url.pathname.startsWith(`/titles/${input.isbn13}-`) ||
    url.search ||
    url.hash ||
    !input.evidenceUrls.includes(proof.productUrl) ||
    !input.evidenceUrls.includes(line.url) ||
    !input.evidenceUrls.includes("https://www.animenewsnetwork.com/encyclopedia/manga.php?id=11729")
  )
    return fail("requires the own-ISBN publisher URL and exact ANN child/parent evidence.");
  if (
    line.url !== `https://www.animenewsnetwork.com/encyclopedia/releases.php?id=${line.annId}` ||
    line.multi ||
    line.editionLineHint ||
    line.coverRange ||
    line.coverageGapped
  )
    return fail("packaged, ranged or unrelated products do not qualify.");
  const snapshot = parent?.snapshot as
    | { kind?: string; id?: string; title?: string; releases?: AnnReleaseSnapshot[] }
    | undefined;
  if (
    !parent ||
    parent._id !== proof.parentObservationId ||
    parent.sourceKey !== "ann" ||
    parent.sourceRecordId !== "manga:11729" ||
    snapshot?.kind !== "annManga" ||
    snapshot.id !== line.mangaId ||
    !snapshot.title ||
    fold(snapshot.title) !== ROOT ||
    !umbrella ||
    fold(umbrella.title) !== ROOT ||
    fold(proof.publisherSeriesTitle) !== ROOT ||
    !Array.isArray(snapshot.releases)
  )
    return fail("the exact current umbrella parent must preserve membership.");
  const members = snapshot.releases.filter(
    (member) => member.annId === line.annId || toIsbn13(member.isbn13) === input.isbn13,
  );
  if (members.length !== 1) return fail("parent child/ISBN membership is absent or duplicated.");
  const member = members[0]!;
  if (
    member.annId !== line.annId ||
    member.title !== line.title ||
    toIsbn13(member.isbn13) !== input.isbn13 ||
    member.label !== line.label ||
    member.format !== line.format ||
    member.multi ||
    member.editionLineHint ||
    member.coverRange ||
    member.coverageGapped
  )
    return fail("parent's exact annId/title/ISBN/format/global tuple changed.");
  const episodes = new Set(
    snapshot.releases.flatMap((member) => episodeTitle(member.title)?.episode ?? []),
  );
  if (episodes.size < 2) return fail("parent is not a multi-Episode bibliography.");
  // Every member at this ordinal must certify the same single local Volume.
  // Parse failures cannot make a foreign, ambiguous or ranged sibling disappear.
  for (const member of snapshot.releases) {
    const other = episodeTitle(member.title);
    if (member.label === line.label) {
      if (!other?.local || !sameEpisode(source, other) || source.local !== other.local)
        return fail(
          "parent contains ambiguous or contradictory identity at the selected global ordinal.",
        );
      if (member.multi || member.editionLineHint || member.coverRange || member.coverageGapped)
        return fail(
          "parent contains packaged, ranged or gapped coverage at the selected global ordinal.",
        );
    } else if (sameEpisode(source, other) && source.local === other?.local) {
      return fail("parent contains contradictory local/global numbering.");
    }
  }
  return {
    kind: "episode" as const,
    sourceWork: source.work,
    rootWork: "Umineko When They Cry",
    localLabel: source.local,
    globalLabel: global[2]!,
  };
}
