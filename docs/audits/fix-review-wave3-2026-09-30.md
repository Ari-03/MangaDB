# Review of the latest audit fix commit

Reviewed `cd2ca37`, "Make catalog parsing conservative and harden bundle reconciliation," against its parent `a53a613`, using `git diff a53a613...cd2ca37`. This is the latest commit only, as requested. Nine parallel reviewers checked the changed areas, with independent Standards and Spec reviews. The originating requirements are in `docs/audits/fix-plan-wave3-2026-09-30.md`; the prior findings are in `fix-review-wave2-2026-09-30.md`.

The eleven previously reported triggers now pass. Both transaction-scaling changes and the two optional efficiency improvements are implemented. Three new P2 regressions remain. Two can automatically write incorrect catalog coverage; the third leaves a reading pass under the wrong Series after a successful Split. No application code, live catalog data, or deployments were changed during this review.

## Standards

The independent Standards reviewer found no new documented-standard violation or actionable code smell in the scoped diff.

The old Split user-by-Series Cartesian floor is replaced by per-record, per-surface governance at `convex/lib/sensitiveOps.ts:2033` and `:2098`. Yen Press now reconciles each box in a separate mutation at `convex/yenPress.ts:231`. The Series merge reuses its dependent graph, and cover fallback shares a promise and coverage lookup by Volume at `convex/lib/covers.ts:212`.

The changed TypeScript introduces no new `any`, casting-wrapper pattern, query wall-clock read, or invalid Convex API use. Six scoped Standards checks passed. Total canonical tracking and a single large box can still require substantial reads; these limits are explicitly accepted by the plan rather than new findings.

The cover reviewer measured fourteen coverage queries for twelve ISBN-less borrowers sharing one Volume, compared with twenty-five at the parent commit. Results and donor precedence were identical. Nineteen targeted checks also covered concurrent borrowers, null results, hidden donors, separate Volumes, and cache freshness between queries.

## Spec

The independent Spec reviewer identified one incomplete requirement.

### N01 P2 Title coverage loses later ranges after mixed joins

Location: `convex/lib/bookTitle.ts:332`, `:338`, `:362`.

The Wave 3 plan explicitly names "plus 4-6 and 7-9" and requires the second range to be read or a gap to block coverage. The blurb parser handles this, but the title parser does not.

`Alpha Deluxe Edition 1 (Collecting Vols. 1-3 plus 4-6 and 7-9 in one book)` produces coverage 1 through 6 at HEAD, compared with 1 through 9 at `a53a613`. Changing the last range to 8 through 9 previously produced unknown, gapped coverage; HEAD still accepts 1 through 6 as complete.

`JOINED` consumes `plus 4-6`, leaving `and 7-9 in one book`. The loop only recognizes another plus-style join, and `UNREAD` does not recognize a number followed by a range dash. The remaining numeric evidence becomes prose.

Both real `internal.prh.sync` and `internal.sevenSeas.sync` entrypoints create Volumes 1 through 6, six coverage rows, and an Edition with `coverageUnmapped=false` for either input. Consume ordinary list continuations after the additional range, or reject unread numeric continuations. Include both contiguous and gapped importer tests.

No other confirmed departure was established by the independent Spec pass. The documented tradeoffs listed below were excluded.

## Additional functional review

### N02 P2 Uppercase possessives invent an extra Volume

Location: `convex/lib/coverage.ts:105`, `:196`.

For `Alpha Deluxe Edition 1`, publisher copy `<p>COLLECTS VOLUMES 1-3 AND VOLUME 4’S BONUS CHAPTER.</p>` now produces certain coverage 1 through 4. Both real PRH and Seven Seas syncs create four Volumes and four coverage rows, with `coverageUnmapped=false`. At `a53a613`, the same blurb produces unknown coverage. Straight apostrophe followed by uppercase `S` also reproduces the failure.

The surrounding grammar matches uppercase copy, but the new `POSSESSIVE` expression lacks the `i` flag. The final marked item is therefore treated as an included Volume rather than ambiguous possessive copy. Preserve the ambiguity for unsized books by matching the possessive case-insensitively. A sized 3-in-1 case also changes unnecessarily from safe coverage 1 through 3 at the parent to Unmapped at HEAD. Test both apostrophes and both sized and unsized lines.

### N03 P2 Split does not reverse a repair's reading-pass move

Location: `convex/lib/repair/ops.ts:635`, `:1514`.

A repair `mergeSeries` placement merges a Source Volume into a Survivor Volume while a packaging Volume defers the final Series merge. The new `followVolume` call correctly moves the Source Release's active pass to Survivor. That personal-row write is recorded in `repairTrails`, outside the canonical merge's reversible manifest.

Public `splitRecord` then successfully restores the Source Volume and the Release's `seriesIds` to Source. The active pass stays under Survivor, and public `myReading` displays it under the wrong work. The parent reviewer independently reproduced this mismatch. The identical reversal invariant passes when only `repair/ops.ts` is restored to `a53a613`, confirming a regression introduced by this commit.

Record the merge-related personal writes in its reversible operation, or recompute affected pass Series during Split while preserving visibility and later user edits. Add a repair-merge followed by public-Split test alongside the two original W11 cases.

## Status of the prior findings

| Finding | Verified result at `cd2ca37`                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| W01     | Split preserves public direct Release ownership despite an unowned Bundle's private Series.                                                          |
| W02     | `Vol. 1 plus 16 pages of art` no longer invents sixteen covered Volumes.                                                                             |
| W03     | A separately marked fourth Volume prevents a 3-in-1 from accepting shortened coverage.                                                               |
| W04     | The original later joined, gapped range remains unknown. N01 covers a new mixed-join title case.                                                     |
| W05     | The original `Negima!` punctuation example does not invent a thirty-ninth Volume.                                                                    |
| W06     | Overlapping bulk-action cleanup preserves another run's claims. Success, failure, duplicate Releases, and concurrent ownership/reading were checked. |
| W07     | A hidden source Series's explicit private override continues protecting the moved omnibus rating.                                                    |
| W08     | Linked boxes reject incompatible Series or Format changes without adding members.                                                                    |
| W09     | Inserting a missing member repairs generated compact legacy ordering and preserves deliberate ordering.                                              |
| W10     | Joined OpenLibrary title/subtitle identity selects the sequel rather than the parent's Volume.                                                       |
| W11     | `setCoverage` and deferred cross-move placements refile active passes correctly. N03 concerns reversing a merge-into placement.                      |

Privacy fixtures were compared with an independent `a53a613` archive: W01 and W07 fail there and pass at HEAD. Five retained privacy invariants and ten focused existing checks pass. Frontend verification passed twenty-five targeted checks. Bundle/Yen verification passed twenty committed checks and six independent probes. OpenLibrary verification passed fifty-eight checks, including nine additional importer probes. These counts overlap the full suite and should not be added to its total.

The plan explicitly accepts conservative crossover-rating behavior, remaining stock cross-Series merge tracking gaps, named title punctuation limitations, observation-only Bundle conflicts, uncertainty about empty Bundle Series identity, already-corrupted duplicate orders with no missing member, hidden OpenLibrary sequel fallback, and manual repair of previously mislinked ISBNs. Those are not counted again as new findings.

## Validation and evidence

- The committed suite was run twice with `npm test -- --exclude '**/*.recheck.test.ts'`. Both runs had 1,592 passes and one failure across 76 files and 1,593 tests. The failure is the unchanged event-delivery ordering assertion at `convex/analytics.test.ts:136`, also observed in the earlier audit. Its isolated suite passes all eight tests. The complete suite is therefore not green in this environment.
- `npm run typecheck`, `tsc --noEmit -p convex/tsconfig.json`, and `npm run build` passed.
- The parent independently reran six parser/importer probes. They pass assertions documenting the incorrect HEAD outputs and exact baseline differences. Source is retained at `/tmp/mangadb-source-b-cd2ca37/failures.recheck.test.ts`, with baseline parser copies beside it; output is `/tmp/mangadb-wave3-parent-parser.log`.
- The parent independently reran the three repair invariants. Both original W11 assertions pass; the new Split reversal assertion fails. Source is retained at `/tmp/mangadb-proposals-repairs-wave3.recheck.test.ts`; output is `/tmp/mangadb-wave3-parent-repair-split.log`.
- Other retained evidence includes `/tmp/privacy_wave3_hidden.recheck.test.ts`, `/tmp/privacy_wave3_bundle.recheck.test.ts`, `/tmp/frontend_personal-cd2ca37-overlap.recheck.test.ts`, `/tmp/frontend_personal-cd2ca37-claims.recheck.test.ts`, `/tmp/import_pipeline_wave3.recheck.test.ts`, `/tmp/mangadb-source_adapters_a-wave3.recheck.test.ts`, and `/tmp/mangadb-catalog-cover-wave3-cd2ca37.recheck.test.ts`. Relative imports require restoring each fixture to its original repository directory.
- Temporary workspace probes were removed. This report was formatted with Prettier 3.6.2 and checked with `git diff --check`. The repository has no configured lint command. Source prevalence and production throughput were not measured.

Standards has no new findings. Spec has one P2 incomplete requirement. Additional functional review has two P2 regressions involving possessive coverage and repair reversal.
