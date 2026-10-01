# Review of the latest audit fix commit

Reviewed `1f24c44`, "Unify coverage parsing and keep merged passes reversible," against its parent `cd2ca37` using `git diff cd2ca37...1f24c44`. This review covers the latest commit only. The worktree was clean at the start. Six parallel reviewers checked Standards, Spec, parser behavior, real importers, repair reversal, and privacy. The requirements are in `fix-plan-wave4-2026-09-30.md`, and the prior findings are in `fix-review-wave3-2026-09-30.md`.

The original N01, N02, and N03 examples are fixed. The analytics test now checks delivered event identity and payload without requiring arrival order. One P2 integration gap remains in N01: an unreadable bracket statement can fall back to an outer range and automatically import extra Volumes. All 1,622 committed tests pass, as do both TypeScript checks and the build.

## Standards

The independent Standards review found no new documented-standard violation or actionable code smell.

The shared parser removes competing statement grammar at `convex/lib/bookTitle.ts:335`. The reverse import remains type-only at `convex/lib/coverage.ts:44`, avoiding a runtime cycle. Integer validation makes the replacement of `canonicalLabel(String(...))` with `String(...)` equivalent.

Pass refiling uses the existing mutation and reversible `repoint` mechanism at `convex/lib/sensitiveOps.ts:350`. Only actual field changes enter the manifest. Split retains its field-value replay guard and recomputes passes from restored coverage at `:2216`. Comments describe the changes, and the helper uses typed IDs and `MutationCtx` without introducing `any` or casting wrappers.

The new indexed pass scan adds reads proportional to passes on affected Releases. The plan expressly accepts that canonical transaction limit; it is not a new unacknowledged scaling finding. No other new efficiency concern was established in this diff.

## Spec

The independent Spec review found one partial requirement. No additional scope creep or incorrect implementation was established.

### N04 P2 Unknown bracket coverage falls back to an outer range

Locations: `convex/lib/bookTitle.ts:337` and `:652`.

The plan at `fix-plan-wave4-2026-09-30.md:35` requires that a gap "leaves the coverage unknown, never a guess" and says `multiVolume → coverageGapped → Unmapped` is the intended result. Line 36 also requires a possessive statement to produce `coverRange null, coverageGapped true`.

The shared reader now correctly returns null for the bracket in this title:

```text
Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)
```

But final assembly uses `peel.coverRange ?? range`. That treats explicitly unknown bracket coverage as absent and substitutes the outer 1 through 9 designation. The resulting Packaging has complete coverage 1 through 9 and no `coverageGapped` flag. Both actual PRH and Seven Seas syncs create nine Volumes and nine complete coverage rows. The required outcome is Unmapped.

The gapped variant also fails:

```text
Alpha, Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 8-9 in one book)
```

Both importers accept complete coverage 1 through 9, inventing Volume 7 despite the explicit gap. Independent comparisons pinned to `cd2ca37` show that the possessive variant previously returned 1 through 3 and the mixed-join variant returned 1 through 6. Those previous outputs also failed the intended conservative policy; the latest change newly routes these statements through the existing null fallback and widens their coverage further. This is a partial fix with a newly widened incorrect result, rather than a newly introduced fallback expression.

Preserve the distinction between absent coverage and rejected coverage when combining bracket statements with outer designations. A rejected statement must keep `coverRange: null` and `coverageGapped: true` through final Packaging assembly. Add importer tests combining the gapped and possessive brackets with an outer range. The committed new tests only exercise those statements without that conflicting outer range.

The parent independently ran two assertions for the required unknown result. Both fail with coverage 1 through 9. Three additional importer probes document the incorrect stored result. These are one finding because they share the same fallback mechanism.

## Prior findings checked

| Finding            | Result at `1f24c44`                                                                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N01                | The original contiguous mixed joins map 1 through 9; the original gapped version stays Unmapped. Comma, ampersand, marked continuations, and sized/unsized variants pass. N04 identifies the remaining outer-range integration gap. |
| N02                | Uppercase possessives stay ambiguous. Unsized Deluxe books are Unmapped; a 3-in-1 settles to coverage 1 through 3. Straight, curly, and entity-encoded apostrophes pass through both real importers.                                |
| N03                | Repair merge-into placements record pass moves in the canonical merge manifest, and public Split restores the pass to its Source Series. Subsequent percentage edits and later coverage corrections survive.                        |
| Analytics ordering | The test preserves scheduling-order checks and validates all four distinct delivered payloads plus the total count. It no longer assumes concurrent POSTs arrive in scheduling order. The full suite passes.                        |

Repair verification passed eight checks covering the original fixture, direct Volume/Edition/Line merges and Split, multiple Releases, changed percentages, later coverage corrections, nested Series merges, and passes started after merging. The parent independently reran the original three-case repair fixture unchanged; all three pass.

Privacy verification passed eight independent checks. Missing source state, explicit private overrides, and hidden source Series keep `publicProfile.reading` empty throughout merge, percentage edit, and Split. The three new filing invariants fail on an independent `cd2ca37` baseline and pass here. Earlier R01/R02/R04/W07 controls remain green.

Importer verification passed thirteen independent checks covering thirty real PRH and Seven Seas sync calls, plus twenty selected committed importer tests. Three of the independent checks assert the incorrect N04 output. The parser reviewer also checked 291 additional title/format combinations and found no second high-confidence issue. These counts overlap the committed suite and should not be added to its total.

Explicitly accepted limits remain excluded: stale pass Series privacy before Volume/Edition/Line merges, total canonical tracking reads, public-survivor behavior for passes started after a merge, conservative title outcomes for fractional or unreadable numbers, and the unchanged subtitle gate. No production prevalence was measured.

## Validation and retained evidence

- `npm test -- --exclude '**/*.recheck.test.ts'`: 76 files, 1,622 tests passed.
- `npm run typecheck` and `tsc --noEmit -p convex/tsconfig.json`: passed.
- `npm run build`: passed. No deployment was performed.
- Original repair source: `/tmp/mangadb-proposals-repairs-wave3.recheck.test.ts`; passing parent output: `/tmp/mangadb-wave4-parent-original-repair.log`.
- New failing parent coverage invariants: `/tmp/mangadb-wave4-parent-gap.recheck.test.ts`; output: `/tmp/mangadb-wave4-parent-gap.log`.
- Parser differential evidence: `/tmp/mangadb-source-b-1f24c44/probes.recheck.test.ts`, with baseline implementations beside it.
- Real importer evidence: `/tmp/import_pipeline_wave4.recheck.test.ts`.
- Additional repair and privacy evidence: `/tmp/mangadb-proposals-repairs-wave4.recheck.test.ts` and `/tmp/privacy_wave4_pass.recheck.test.ts`. Privacy baseline: `/tmp/mangadb-privacy-basecd2ca37`.
- Retained fixtures require their original relative import locations when restored to the repository. Temporary workspace probes were removed after review. Only this report was added; no application files or live data were changed.
- The report was formatted with Prettier 3.6.2. `git diff --check` passes. The repository has no configured lint command.

Standards has zero new findings. Spec has one P2 finding, the remaining N01 integration gap. No separate repair or privacy regression was found.
