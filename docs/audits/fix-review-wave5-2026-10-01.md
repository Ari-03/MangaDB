# Review of the latest audit fix commit

Reviewed `4bd97ff`, "Make title coverage parsing reject conflicting statements," against its parent `1f24c44` using `git diff 1f24c44...4bd97ff`. This is the latest commit only. The worktree was clean at the start. Five parallel reviewers checked Standards, Spec, parser behavior, real importer entrypoints, and title identity. The originating requirements are in `fix-plan-wave5-2026-09-30.md`; the prior finding is N04 in `fix-review-wave4-2026-09-30.md`.

N04 is fixed. The original failing assertions now pass unchanged, and actual PRH and Seven Seas imports reject those titles without creating covered Volumes. No new actionable regression was found within the documented scope. All 1,777 committed tests, both TypeScript checks, and the build pass. No application code or live data was changed during this review.

## Standards

The independent Standards review found no new documented-standard violation or meaningful Fowler smell.

`Stated` at `convex/lib/bookTitle.ts:305` distinguishes absent, rejected, and accepted coverage. `agreed` at `:317` combines evidence without replacing rejection with another range. Final assembly at `:763` preserves that distinction and writes `coverageGapped` beside the stored nullable range at `:773`. The validator and inference comments accurately describe the wider rejection rule.

The rewrite adds no `any`, casting wrappers, database queries, wall-clock reads, or Convex API changes. Some paths repeat list or packaging recognition, but this is a small fixed number of passes over title text. No concrete efficiency regression was established. Production throughput was not measured.

## Spec

The independent Spec review found no new missing requirement, incorrect implementation, or scope creep.

The plan requires that "a rejected statement is never replaced by the other's range" at `fix-plan-wave5-2026-09-30.md:109`. That now survives final assembly. Both original examples produce `coverRange: null` with `coverageGapped: true`:

```text
Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)
Alpha, Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 8-9 in one book)
```

Both actual importer entrypoints create no covered Volumes. The first can wait as Unmapped Packaging under its Edition Line. The second has no line, so it creates no Edition. A helpful blurb cannot override either rejected title.

Reverse-direction conflicts and contradictory bracket groups also reject, regardless of bracket order. Agreeing ranges still map, and `Noragami Omnibus 7 (Vol. 19-21)` retains its line position and coverage. The broader phrase-list, carried-subtitle, and line-less subtitle handling matches the documented follow-up, including the real Dragonball title correction.

The owner's documented stopping rule accepts remaining synthetic shapes for human correction at `fix-plan-wave5-2026-09-30.md:291`. Named subtitle-anchor, plain-Volume display, Part/Book, and ANN limits were excluded from new findings. Existing already-linked incorrect coverage is deliberately not repaired by this commit. The review confirms the parser and import behavior, not a migration of historical data.

## Independent verification

- The parent reran the two retained N04 assertions unchanged. Both pass; output is `/tmp/mangadb-wave5-parent-original-gap.log`.
- The parser reviewer passed an additional 37-case matrix covering bracket forms, outer ranges, carried subtitles, reversed contradictions, and blurb fallback rejection. Thirty-two variants differ from the pinned parent as intended.
- A parser differential covered 69,786 distinct exported title fields and 109,708 parses. Sixteen results over four titles differ, matching the documented Dragonball, Walking Cat, and Prince Valiant improvements or neutral outcomes. No other change was found in that dataset.
- A separate title-identity differential covered 66,354 exported titles and 111,497 deduplicated parses, including numeric `seriesNumber` options and generated first-colon subtitle splits. Twenty results differ. All belong to the four documented full titles or carried-subtitle recall improvements for Dragonball, Bleach, and Skip Beat. The generated splits are probes, not evidence of actual OpenLibrary field pairs.
- Sixteen additional identity controls match the parent exactly, including earlier markers, numeric Series names, Roman sequel flags, bracket ordering, and names containing "Omnibus".
- Importer verification passed 37 independent tests with 78 actual PRH and Seven Seas sync calls. Agreement controls still import correctly. Two unchanged-listing Seven Seas replay probes reject stale coverage without duplicate writes or book-detail fetches.

These checks overlap the committed suite and should not be added to its total. The exported data was read locally; production was not queried or changed. No claim is made about every possible title shape.

## Validation and evidence

- `npm test -- --exclude '**/*.recheck.test.ts'`: 76 files and 1,777 tests passed.
- `npm run typecheck` and `tsc --noEmit -p convex/tsconfig.json`: passed.
- `npm run build`: passed. No deployment was performed.
- Original reproduction: `/tmp/mangadb-wave4-parent-gap.recheck.test.ts`.
- Parser evidence: `/tmp/wave5-parser-original.recheck.test.ts`, `/tmp/wave5-parser-matrix.recheck.test.ts`, `/tmp/wave5-parser-base-1f24c44.recheck.ts`, and `/tmp/wave5-parser-real-differences.json`.
- Identity evidence: `/tmp/wave5_identity_real_differential.json`, `/tmp/wave5_identity_real_differential.log`, and retained fixture/baseline modules under `/tmp/wave5_identity*.ts`.
- Importer evidence: `/tmp/wave5_importers.recheck.test.ts` and `/tmp/wave5-importers-recheck.log`.
- Temporary workspace probes were removed after review. Retained fixtures need their original relative import locations when restored. Only this report was added.
- The report was formatted with Prettier 3.6.2, and the worktree whitespace check passes. The reviewed commit's whitespace check reports one cosmetic extra blank line at the end of `fix-plan-wave5-2026-09-30.md:343`. The repository has no configured lint command.

Standards has zero new findings. Spec has zero new findings. Additional parser, importer, and identity checks found no new actionable regression.
