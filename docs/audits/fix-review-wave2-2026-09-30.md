# Review of the last four audit fix commits

The user corrected the review scope to the last three or four commits. This report uses the inclusive four-commit range, `git diff 6108393...a53a613`, covering `5677249`, `defd21a`, `1b859ba`, and `a53a613`. It replaces the earlier two-commit assessment. Eleven reviewers contributed across the initial and expanded checks of the 84 changed files. Only this untracked review report was present when the scope expanded.

Many original triggers are fixed, including the R01 through R18 examples from the previous review. Eleven functional findings remain: eight P2 failures introduced or reintroduced during the fix sequence, and three pre-existing gaps, one P1 and two P2, in the areas the fixes address. The most urgent is W07: merging an omnibus Edition after hiding its private source Series publishes the user's rating. The other failures concern coverage parsing, Split visibility, overlapping bulk actions, Bundle reconciliation, OpenLibrary identity, and repair tracking. The separate Standards review identifies two P2 transaction-scaling concerns.

All 1,517 committed tests across 76 files pass. Both TypeScript checks and the client/Worker build pass. Additional invariant tests fail on the cases below. No application files, live catalog data, or deployments were changed. This report is the only intended repository addition.

## Spec

The requirements come from both fix plans, the previous fix review, `CONTEXT.md`, and the original audit. The independent Spec reviewer retained W01 through W06 as departures from per-Series privacy, explicit coverage precedence, the bare-item ambiguity rule, and the required bulk interaction guard. Further domain review established W07 through W11. Each finding below distinguishes a regression from a pre-existing gap.

No unrelated scope expansion was established. The plan's accepted unsized-copy consequences, deferred staged repair design and imprint counter, ANN gap limitation, and existing Deluxe coverage replay limitation are excluded from new findings. B17's recommendation to revalidate withdrawal evidence at approval remains a useful safeguard. Transactional relisting retirement fixes the demonstrated path; the absent recheck is not counted as another proven bug.

### W01 P2 Split spreads an unrelated private override

Location: `convex/lib/sensitiveOps.ts:1967`, `:1973`, `:1975`.

A user publicly owns a Release whose Volume was merged into another Series. Both Source and Survivor ownership are explicitly public. A Bundle the user does not own contains that Release and a second Release from Gamma, which the user keeps private. Split includes Gamma in the dependency scope, snapshots its override, and applies the combined privacy floor to every returned Series for that user. Source and Survivor ownership become private. The public profile's Owned Release count falls from one to zero, even though the user never owned the Bundle and the merge never narrowed either ownership override.

The same public-API reproduction passes with the `defd21a` implementation and fails on HEAD. This exceeds the accepted rule that Split preserves an override previously narrowed by a merge. Track the governing Series per user, record, and visibility surface, then carry restrictions only along the tracking paths the Split changes. A catalog dependency alone must not make an unrelated private preference govern a directly owned Release.

### W02 P2 Page counts in title statements become Volumes

Location: `convex/lib/bookTitle.ts:319`, `:333`, `:336`.

`Alpha Deluxe Edition 1 (Collecting Vol. 1 plus 16 pages of art)` now produces coverage 1 through 16. The broadened statement recognition passes the entire remaining bracket text into `parseVolumeList`, which reads every number in a span as a coverage endpoint. Both PRH `applyTitle` and Seven Seas `applyBook` create 16 canonical Volumes from this title. `Containing Vol. 1 with 16 pages of art` has the same parsing defect.

At `defd21a`, this title did not produce multi-volume packaging coverage. This is a new corruption path, separate from the documented policy for negative blurb copy. Parse only the Volume designation and its supported joins. Treat page and bonus-item counts as prose; unreadable explicit coverage must remain unknown rather than gaining numeric endpoints from the rest of the title.

### W03 P2 Explicit final Volumes are dropped to fit a line size

Location: `convex/lib/coverage.ts:172`, `:216`.

`Collects volumes 1-3 and volume 4 in one book.` is treated as two possible readings, 1 through 4 or 1 through 3. A 3-in-1 line selects the shortened reading and both importers create only Volumes 1, 2, and 3. The parser retains whether an item is a singleton but discards whether it has its own `volume`, `Vol.`, or `#` marker. At `defd21a`, inference returned 1 through 4.

The plan expressly limits this ambiguity to a bare final list item. Under its current conservative rules, four explicitly collected Volumes contradicting a three-Volume line should leave the book Unmapped. Preserve marker information and distinguish a collected Volume from possessive references such as `volume 4's bonus chapter`.

### W04 P2 A later plus range disappears before ordinary prose

Location: `convex/lib/coverage.ts:66`.

`Collects volumes 1-3 plus 5-6 in one book.` now returns coverage 1 through 3 and PRH creates those three Volumes as complete coverage. The optional additional item is consumed only if statement-ending punctuation follows it. With ordinary prose afterward, the later range is omitted completely. At `defd21a`, the gapped statement returned null. A contiguous variant, `plus 4-6 in one book`, similarly shrinks from 1 through 6 to 1 through 3.

The plan says a range does not become ambiguous because copy follows it. Read joined ranges before classifying trailing prose, and block inference when the full list has a gap. Keep the valid distinction between an additional range and an unrelated singleton count such as `plus 16 pages of art`.

### W05 P2 Series title punctuation hides an explicit statement

Location: `convex/lib/coverage.ts:72`.

For `Negima! 3-in-1 Edition Vol. 13`, flap copy `Collects Negima! Volumes 37-38.` is split after the Series title's exclamation mark. The collect verb is separated from its list, so inference falls back to the line size and PRH creates Volumes 37, 38, and 39. The previous parser returned 37 through 38. Lowercasing `volumes` prevents the split and correctly leaves the contradictory statement Unmapped under the new rules.

Sentence detection needs to preserve punctuation inside the collected Series title. Add a sized-line importer regression; the existing unsized title-punctuation test does not expose fallback to an invented Volume.

### W06 P2 A finishing bulk run clears another run's claims

Location: `src/lib/quickActions.tsx:421`. Introduced in `defd21a` and now inside the corrected review scope.

Run A finishes its first batch and releases those claims while awaiting its second batch. Run B reuses one of A's released books in B's later batch. When A finishes, its `finally` block clears claims for all A's original items, including that book's current claim owned by B. The cover control becomes enabled and accepts a newer Ordered choice, which B's later Wanted batch overwrites. The reproduction uses the real components and Convex mutations; the parent independently confirmed it.

The original R17 inter-batch race is blocked, but this overlapping-run variant remains. Cleanup should release only claims still owned by the finishing run, using an owner token or equivalent bookkeeping.

### W07 P1 A hidden source Series bypasses rating privacy carry

Location: `convex/lib/sensitiveOps.ts:751`, `:1438`. Remaining privacy gap related to B02; reproduced on both `6108393` and HEAD.

A user has public reading defaults, an explicit private override on Source, and an omnibus Edition rating of 37. The public profile has no Ratings. An administrator hides Source and then merges its still-active Edition into a public-Series omnibus. The public profile now publishes the moved rating. Hiding Source alone does not publish it, and the restrictive Source override still exists.

`editionGovernance` uses `primaryVolumeSeries`, which filters hidden Series and Volumes for display. That returns no source Series, so the new rating-visibility carry is skipped. The parent independently reproduced the empty-profile invariant failing with the public score of 37. Determine underlying privacy governance before filtering display content, or refuse the transfer when it cannot be resolved. Similar display-filtered lookups in `carryEditionTracking` should use the same corrected governance helper.

### W08 P2 Late Bundle filling ignores source identity changes

Location: `convex/lib/catalogTitle.ts:205`, `convex/lib/pipeline.ts:1273`, `:1283`. Regression relative to the four-commit baseline.

PRH imports Alpha Volume 1, Beta Volume 1, and an Alpha Box Set. In steady state, the same box ISBN is observed with a Beta title. Reconciliation resolves the incoming Series and adds its members to the existing Bundle. The canonical Bundle keeps its Alpha name but now contains both Alpha and Beta books, without a proposal awaiting review. A second reproduction changes a physical box's observed format to digital; its canonical physical Bundle gains a digital member while retaining its physical member.

The baseline linked-observation path did not alter Bundle members. The new path validates neither incoming Series nor format against the canonical identity before automatic insertion. Membership grants derived ownership, so this changes users' collection results as well as catalog content. Restrict automatic late filling to compatible canonical identity and send incompatible source changes for review.

### W09 P2 Late members collide with legacy Bundle ordering

Location: `convex/lib/pipeline.ts:1237`, `:1278`. Regression affecting valid records created before these fixes.

The original importer could create a Volume 1 through 2 box with only Volume 2 available, assigning that sole member `order: 1`. After Volume 1 arrives, the repaired reconciliation assigns the new member its label position, also `order: 1`, while preserving the old row. Both members now have the same order, and Bundle pages sorting by order list Volume 2 before Volume 1. The fixture models the baseline-generated compact order; it does not require a malformed row.

The parent independently reproduced the duplicate-order invariant. Reconcile generated legacy order values when filling missing members, while preserving deliberately edited ordering. Include a migration case in the late-member regression tests.

### W10 P2 Split title metadata loses OpenLibrary identity candidates

Location: `convex/lib/openLibrary.ts:247`, `:269`, `convex/openLibrary.ts:379`. Pre-existing title-resolution gap adjacent to B20; reproduced through both the current and baseline importer/parser paths.

OpenLibrary supplies `title: "Kingdom"` and `subtitle: "Hearts II"`. The catalog already has both Kingdom Hearts with Volume 2 and the separate Kingdom Hearts II Series. The joined title is parsed as a provisional Roman designation, but the adapter sets `provisional` false and omits `bareRoman`. The downstream resolver receives the incomplete raw title, Kingdom, and the sequel's ISBN fills the parent Series' Volume 2 Release.

B20's original Chainsaw Man bare-number trigger is fixed. Conservative resolution remains incomplete when the relevant identity spans title and subtitle. Preserve the joined full-title candidate and its provisional flags so the existing full-name Series can claim it before a parent-volume split is accepted.

### W11 P2 Other repair callers still leave passes under the old Series

Location: `convex/lib/repair/ops.ts:635`, `:2018`. Pre-existing B10 caller gap; both cases also fail with the baseline repair implementation.

`setCoverage` changes a Release's canonical Series from Source to Survivor, but its active pass remains grouped under Source in the public `myReading` query. A deferred `mergeSeries` placement similarly reparents a Volume and its Release while retaining the pass's old denormalized Series. Both were exercised through `internal.repair.runBatch` and public reading queries; the parent independently confirmed them.

The repaired Split paths update dependent tracking, and these other paths now carry privacy, but they still omit the tracking denormalization helpers. Apply `followEdition` or `followVolume` when these callers move coverage or Volumes, with the same audit and privacy guarantees as Split.

## Standards

The expanded independent Standards review identifies two new P2 transaction-scaling concerns, separate from the deferred repair staging and imprint counter. Both conflict with the bounded-mutation rule in `convex/_generated/ai/guidelines.md:335`. These are static complexity estimates, not reproduced production-limit failures.

1. **Bound Split's user-by-Series work.** `convex/lib/sensitiveOps.ts:1927` snapshots every governing Series for every affected user. Protection at `:1969` and `:1975` revisits those combinations and can write equally many overrides. One hundred users and one hundred touched Series produce ten thousand combinations before dependency discovery or manifest replay. Add a preflight cap or a staged design that keeps privacy intact throughout the operation. Ordinary scheduled batches would expose intermediate state.
2. **Reconcile Yen Press boxes in separate transactions.** The new loop at `convex/yenPress.ts:120` handles every supplied ISBN in one mutation. Its normal caller sends up to one hundred fresh ISBNs at `:224`. Each linked box reads its Series' entire Volume list at `convex/lib/pipeline.ts:1206`, then discovers coverage and Releases. One hundred boxes with two hundred Volumes each imply twenty thousand Volume-row reads before the remaining work. Use one atomic box transaction at a time, or a transaction-budget continuation.

The changed TypeScript introduces no `any`, casting wrappers, query wall-clock reads, or invalid Convex API use. Comments describe the new parser rules. Existing deferred repair batching and imprint counting concerns remain acknowledged limitations.

One optional efficiency improvement is a possible Duplicated Code smell. The Series merge at `convex/lib/sensitiveOps.ts:1096` calls `withDependents` solely to get Editions, but the helper also reads every dependent Release and Bundle membership. Before anything moves, `guardSurvivorOverrides` at `:827` can rebuild that same graph through `trackersOf`. Share the already resolved scope, or stop the first traversal at Editions. This is repeated database work verified from the code, not a measured production bottleneck or a separate correctness failure.

An additional P3 optimization remains at `convex/lib/covers.ts:222`. Distinct ISBN-less Editions covering one Volume each repeat its `by_volume` coverage scan. A measured fixture with twelve borrowers and one donor repeated the thirteen-row scan twelve times, reading 156 coverage rows. Results were correct, and the original E05 per-Edition sibling lookup is fixed. Cache this shared scan by Volume ID. This behavior also existed at the baseline and is not a regression.

## Earlier findings checked on the current tree

The expanded scope includes both implementation waves. These checks confirm the earlier reported triggers on the current tree; W07, W10, and W11 identify additional pre-existing gaps in those areas.

| Earlier findings   | Current assessment                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01, R02, R04      | Public-API reproductions pass. Missing loser state, later changes to public defaults, and cross-Series passes retain privacy.                                                                         |
| R03, R05, R16      | Bundle-only ownership, box conversion privacy, and preserving a later public choice on repair reruns pass five targeted regression checks.                                                            |
| R06, R07           | Real Kodansha imports preserve mismatched ISBN-less Releases and route legacy corrupted observations to the correct ISBN holder. Three safe-state checks pass.                                        |
| R08, R09, R10, R13 | Edition Line metadata reaches proposal queues, linked Bundles reconcile late members, relisting retires cancellations, and unlinked legacy packaging replays. Nineteen selected importer checks pass. |
| R11                | The original mixed create/update duplicate-ISBN proposal is rejected.                                                                                                                                 |
| R12                | Partially fixed. The original gapped title and blurb triggers remain unknown through actual imports. W02 through W05 expose additional parser cases.                                                  |
| R14, R15           | Hidden mature Bundle members and hidden line-Series fallback preserve maturity and sitemap exclusion. Together with R11, 30 targeted checks pass.                                                     |
| R18                | Pending save disables fields and blocks draft changes. The original data-loss reproduction passes.                                                                                                    |
| R17                | The original 205-book overwrite is blocked, but overlapping runs retain the W06 cleanup race.                                                                                                         |

The original triggers for R01 through R18 have passing coverage on the current tree. R12 and R17 remain partial because the additional cases above fail. The frontend verification passed 32 checks before the overlapping-run invariant failed.

The expanded checks also confirm the original B05 stale-base rejection, B29 field clearing through serialization, B27 and B28 pin preservation, B31 atomic read deltas, and E01 batch suggestion efficiency. The catalog checks confirm B32 credit priority, B34 and B35 maturity, B36 hidden Favorite art, and the original E05 cover fallback trigger. Worker changes are unchanged since the first fix wave; their earlier native verification still supports B01, B39, E07, and E08, with no additional confirmed Worker defect. Reading Undo, stored projection freshness, shelf cache policy, durable cover refresh, and other explicitly deferred work remain outside new findings.

The Wave 2 plan also explicitly leaves two coverage limitations open: ANN does not respect gapped coverage evidence when using its line-size fallback, and re-syncing an already-covered Deluxe with a gapped blurb retains its old coverage. These acknowledged limitations are not counted again among W01 through W11.

## Validation and retained evidence

- `npm test -- --exclude '**/*.recheck.test.ts'`: 76 files and 1,517 tests passed.
- `npm run typecheck` and `tsc --noEmit -p convex/tsconfig.json`: passed before temporary reproductions were added.
- `npm run build`: passed. No deployment was performed.
- Parent independently reproduced W01 through W05 with assertions for the intended behavior. All five assertions failed as described. Importer reviewers additionally exercised PRH and Seven Seas for the coverage cases.
- Parent independently reran W06's R17 component/backend fixture. Its interaction-lock assertion failed, confirming that Ordered was accepted and then overwritten with Wanted. Output is retained at `/tmp/mangadb-wave2-parent-overlap-repro.log`.
- Comparisons with `defd21a` used immutable source snapshots or an isolated fixture. Baseline behavior is stated separately from the expected behavior under the new conservative rules.
- Parent parser sources are retained at `/tmp/mangadb-wave2-parent.recheck.test.ts` and `/tmp/mangadb-wave2-parent-sentence.recheck.test.ts`. Parent output is in `/tmp/mangadb-wave2-parent-repro.log`, `/tmp/mangadb-wave2-parent-sentence-repro.log`, and `/tmp/mangadb-wave2-parent-split-repro.log`.
- Reviewer reproduction sources are retained under `/tmp`; their relative imports require restoring them to the corresponding `convex/` or `src/lib/` directory. Temporary workspace tests were removed after review.
- W01 is retained at `/tmp/mangadb-proposals-repairs-lasttwo.recheck.test.ts`. W02 and W03 are in `/tmp/import_wave2_latest.recheck.test.ts`, alongside their `bookTitle_wave2_base.recheck.test.ts` and `coverage_wave2_base.recheck.test.ts` imports. W04 and W05 are in `/tmp/mangadb-source-b-lasttwo/failures.recheck.test.ts`, with the base implementations in the same directory. The W06 fixture is `/tmp/frontend_personal-a53a613-overlap.recheck.test.ts`.
- Parent independently reproduced W07's private-profile assertion failing, W08's incompatible membership insertion, W09's duplicate ordering, and both W11 repair grouping failures. Output logs are `/tmp/mangadb-four-commit-parent-hidden-rating.log`, `/tmp/mangadb-four-commit-parent-bundle-reconcile.log`, and `/tmp/mangadb-four-commit-parent-repair-follow.log`.
- Expanded evidence includes `/tmp/privacy_hidden_omnibus_invariant.recheck.test.ts`, `/tmp/import_pipeline_fourcommits.recheck.test.ts`, and `/tmp/mangadb-proposals-repairs-fourcommits.recheck.test.ts`. The OpenLibrary baseline comparison uses the exact baseline parser and registered importer. The whole original privacy baseline is retained at `/tmp/mangadb-privacy-base6108393/`.
- Parent independently confirmed W10 by asserting that the parent Series' Release must retain its missing ISBN. That assertion failed with the sequel's ISBN. Output is `/tmp/mangadb-four-commit-parent-ol-subtitle.log`; source is `/tmp/mangadb-four-commit-parent-ol-subtitle.recheck.test.ts`, with baseline parser/importer dependencies in the reviewer's `/tmp/mangadb-source_adapters_a_610_*` files.
- Expanded targeted passing suites include 67 tracking checks, 41 catalog checks, 26 sharing/users checks, 24 importer/proposal checks, and two new editor API checks. These counts overlap the committed suite and are not added to its total.
- Source prevalence and deployed throughput were not measured. The findings establish concrete failing inputs and user interactions, not how often those cases occur in production.

Standards has two P2 scaling concerns and two optional efficiency improvements. Spec and functional review have eleven findings, one P1 and ten P2, led by the remaining private-rating exposure. These are separate review axes.
