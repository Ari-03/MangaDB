# Reviewed tools for the held-book pass

These tools change no catalog data until an operator supplies a researched
plan to `repair:runBatch`. Use `dryRun: true` first, then the same entry and
actor with `dryRun: false`. A dry run rolls back its audit, receipt and data
writes together. Entry schemas are in `convex/lib/repair/entries.ts`.

- `createPublisher`: `key`, `reason`, `name`, `slug`, `parentPublisherId`
  or null, and `sources`. Refuses normalized-name, alias, slug and redirect
  collisions, including hidden or merged Publishers. An imprint's parent
  must be an active unlocked company. No nested imprints.
- `releaseVariant`: `key`, `reason`, `observationId`, `releaseId`, `name`,
  `expected`, `publisherId`, `binding`, exact ordered `coverage`, `sources`,
  and `printingRowId` or null. Read `repairTools:variantStateInternal`
  first for current target facts and `expected`. Evidence must establish
  that the visual cover is the only difference. A wrongly routed source
  can be attached to the researched target without changing its snapshot.
  Null `printingRowId` requires an unlinked held record and unclaimed ISBN;
  a row ID converts that base Release's plain Other Printing in place.
  Existing marked records stay marked, and their facts stay suppressed.
- `otherPrinting`: the same preview and evidence arguments as a Variant,
  without `name` or `printingRowId`, plus `sourceReleaseId` and
  `expectedSource`, both null for a held reprint with an unclaimed ISBN.
  Evidence states exact complete coverage, Publisher and Binding, including
  omnibus contents. A standalone Release filed in error can be retired by
  naming it and the hash from `repairTools:printingSourceStateInternal`.
  That source must be isolated: no collection, progress, variant, Bundle,
  secondary ISBN, Edition take or merged-alias dependencies, no other
  Release in its Edition, no Human Overrides. Its linked observations must
  describe the same ISBN. It loses its primary ISBNs, is hidden with its
  Edition, and its observations link to the base Release, with an audit
  for the ISBN removal and every status change. The source's Publication
  Date stays on the new Other Printing row.
- `amendProposalEvidence`: `key`, `reason`, `proposalId`,
  `expectedVersionNo`, and `replacements` of `{before, after}` URLs.
  Only approved Proposals at that version are accepted. Old versions
  remain immutable; the next version has the same approved operations,
  corrected evidence and an actor-attributed note naming the audit Proposal.
- `releaseBundle` now accepts a member from its Publisher's direct imprint,
  or the reverse. Unrelated companies, sibling imprints and Format
  mismatches remain refused. No parent ancestry is inferred from names.
- `restoreRecord` accepts an empty-coverage Edition only when it is flagged
  Unmapped Packaging in an active unlocked Edition Line of the same
  Publisher whose Series is active afterwards. This allows restoring
  Pokémon BW's hidden box before its existing Bundle conversion. It does
  not release the hidden box's ISBN claim to an unrelated creation.
- `heldBooks:linkByIsbnInternal` also accepts `protectFields: ["format"]`,
  alone or with `"binding"`, to preserve verified facts against future sync.

## Books these tools can place after evidence review

Publisher creation covers Reptilia, 9781600100413, IDW; Kafka,
9781782279846, Pushkin Press; Somari 1–2, 9781641654456 and 9781641654463,
North Stars Pictures; Living Corpse, DH Publishing; Case Closed 8,
9780575078345, Gollancz; Shuna's Journey, 9781250846525, First Second;
The Four Immigrants Manga, 9781880656334, Stone Bridge Press; Tank Tankuro,
9784903090245, Presspop. Che Guevara, 9780143118169, needs a scope decision
before its missing Penguin row is created, since biographies are excluded.

Parent/imprint Bundles cover Solo Leveling 1–5, 9781975349899, held
observation `n974p6njf0pt5cm8wp6myj7zbx8f4efa`, Yen Press with Ize Press
members. BW restore covers 9781421550053, ANN
`n97a45ar5xbwvwx0675hehkfms8f57fe` and OL
`n97a8rpx8mwsmb6z8z368nq1ts8f5fpg`. Its hidden Release is
`mn7103apj5ypx1qbd590ek0b618fvt9p` and Edition
`k1740rxh4r132hkrah0gscz0md8ftxd2`; re-read IDs and facts before execution.
The eight mini members can remain Unmapped Packaging.

Variants cover I Hear the Sunspot: Four Seasons 1–2 Kinokuniya,
9781642732719 and 9781642734096, held observations
`n97136y2s95m3xs12vee3h81858f5w3f` and
`n976gcz1em6tgw2b3wbkta3ezn8f58e5`; Kaiju No. 8 1 Crunchyroll,
9781974749874, incorrectly recorded as an Other Printing; and Clockwork
Planet 1 Loot Anime, 9781632365262. The Sunspot reports say "appears to be",
so store evidence still needs confirmation before applying.

Reviewed Other Printings cover Drops of God omnibuses 1–4,
9781935654278, 9781935654292, 9781935654360 and 9781935654391. New World's
2026 reprint 9781647294793 can become a printing of 9781935654520 if the
standalone Release has no refused dependencies. Exact evidence can also
settle title-heuristic refusals such as Maximum Ride 3, 9780316131131;
Ragnarok 1, 9781595327420; Ranma 1, 9780929279930; Disney Fairies,
9781427857026; and Hetalia 2 print on demand, 9781427845849. A changed
cover such as Death Note 20th Anniversary, 9781974742790, belongs on the
Variant route if publication characteristics are otherwise unchanged.

Evidence correction repairs the Dragon Ball complete-box Proposal for
9781974708710 and the VIZBIG 3 Proposal for 9781421520612. Their replacement
URLs are recorded in `franchises/leftovers-applied.md`. Format protection
covers verified ebooks whose held observations misstate physical Format,
including Shield Hero 6/24, ROLL OVER AND DIE 1/4 and Hinamatsuri records.

## Gaps left for separate work

Boxes containing books with no individual ISBNs need member identities and
an explicit modelling decision: Nausicaä, Rayearth anniversary boxes and
Orange's exclusive singles. No synthetic member ISBNs are introduced.
Kodansha observations missing ISBNs, including Witch Hat Atelier Grimoire 3
and Gachiakuta's Dumpster box, need a supported source refresh or a separate
evidence-backed non-ISBN linkage. Unknown publication, content, file format
or cancellation remains an evidence gap. Existing `alternateEbooks` tools
already address alternate ebook ISBNs when their identity guards and own-ISBN
evidence are satisfied; this change does not loosen those guards. Printing
conversion with personal or other refused dependencies needs preservation
work before it can proceed.
