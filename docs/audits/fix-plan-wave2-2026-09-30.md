# Fix plan, wave 2 (findings from `fix-review-2026-09-30.md`)

Validity check: R01, R02, R04, R06, R10, R12 and R18 were re-read against
the code at `5677249` and confirmed. The others have retained reproductions
under `/tmp`; each builder must reproduce its finding through the real
entry point (public API, importer mutation or action) before fixing it.

The review's main lesson: wave 1 tested helpers, and production callers
bypassed them. Wave 2 regressions therefore go through real callers, every
verifier greps all call sites, and every leg ends with a full-suite run.

| Lane | Legs (serial within a lane) | Owned files |
| ---- | --------------------------- | ----------- |
| P privacy in canonical ops | 1: R01, R02, R04, S2. 2: R03, R05, R16. 3: S1 | `convex/lib/sensitiveOps.ts`, `convex/lib/repair/ops.ts`, `convex/lib/repair/audit.ts`, `convex/repair.ts` |
| R importer wiring | 1: R06, R07. 2: R08, R09. 3: R10, R13. 4: R12 | `convex/kodansha.ts`, `convex/lib/kodansha.ts`, `convex/sevenSeas.ts`, `convex/lib/catalogTitle.ts`, `convex/openLibrary.ts`, `convex/lib/openLibrary.ts`, `convex/prh.ts`, `convex/lib/pipeline.ts`, `convex/lib/observations.ts`, `convex/lib/coverage.ts`, `convex/lib/bookTitle.ts` |
| S proposal ISBN invariant | R11 | `convex/lib/proposalCreates.ts`, `convex/proposals.ts` |
| U mature content | R14, R15 | `convex/catalogPages.ts`, `convex/seo.ts` |
| V frontend interaction | R17, R18 | `src/lib/quickActions.tsx`, `src/lib/editForm.tsx`, `src/routes/mod.edit.$type.$key.tsx` |

S1 and S2 are the two Standards findings (bounded personal repair work;
imprint count). Opus 5.5 builds, Fable 5.1 verifies, up to two repair
rounds per leg.

## Outcome

All ten legs ended approved, across the main run (36 agents), a follow-up
on the two rejected legs (10 agents), and a third round on R12 (2 agents).
Every finding reproduced through its real entry point before any fix.

- R01, R02, R04 needed three rounds. Merge and Split now share one
  enumeration of affected users that walks the current dependent records
  (Volumes, Edition Lines, Editions, Releases, Bundles and every tracking
  surface on them), and Split re-derives Release Series from coverage after
  replay. The verifier fuzzed about 45,000 random merge and split sequences
  with no visibility widening. Two decisions were made: Split never widens
  an override a merge narrowed (the user re-shares by hand), and a tracked
  Release or Bundle with no Series cannot gain one by merge.
- R12 needed three rounds. The word-allowlist approach was replaced by
  seven fixed rules (nearest collect-verb governs, explicit evidence beats
  the line size, only a bare final list item is ambiguous, recall anchors
  from `5677249` must pass). The verifier approved but listed rule
  consequences on unsized lines that still create Volumes from copy such
  as "does not contain volumes 4-6", "the collected volumes 4-6", and
  "Includes a preview. Volumes 4-6 out now." Those are owner decisions,
  recorded in the run output, not regressions of the seven rules.
- Standards 2 (imprint count) is deferred: the preview read is bounded, a
  true counter needs a schema field. Standards 1 is bounded where it could
  be; the fully staged redesign is deferred with a design note.
- Still open outside these lanes: `convex/ann.ts` ignores gapped coverage
  evidence, and re-syncing an already-covered Deluxe with a gapped blurb
  keeps its old coverage.

Final gate on the combined tree: 76 test files, 1,517 tests passing (up
from 1,160 at the start of wave 2); `tsc` clean for `src/` and `convex/`;
`npm run build` succeeds. Not deployed anywhere.
