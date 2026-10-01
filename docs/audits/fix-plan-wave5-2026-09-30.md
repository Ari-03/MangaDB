# Fix plan, wave 5 (finding N04 from `fix-review-wave4-2026-09-30.md`)

Starting point `1f24c44`. One lane, three stages: a Fable 5.1 architect
reproduced the finding through both real importers and wrote the plan below,
an Opus 5.5 builder implemented it test-first, and a Fable 5.1 verifier tried
to refute it with new probes and a differential against the previous parser.

## Validation

N04 real: yes. Severity agreed: yes.

N04 is real. I reproduced it at HEAD 1f24c44 at the parser and through both real importers, then confirmed a prototype fixes it.

Parser level (temporary matrix probe, 11 outer designations x 11 brackets, since deleted):
- "Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)" -> coverRange {1,9}, no coverageGapped. Same with the straight apostrophe and the &#8217; entity.
- "Alpha, Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 8-9 in one book)" -> coverRange {1,9}, no coverageGapped.
- Same result for every outer form: "Alpha Omnibus 1-9", "Alpha (Omnibus) Vol. 1-9", "Alpha 3-in-1 Edition, Vol. 1-9", "Alpha Vol. 1-9 Box Set", the OpenLibrary subtitle option ("Vol. 1-9"), and a seriesNumber-licensed bare "Alpha 1-9".
- Same for a rejected bracket range: "... Vol. 1-9 (Vol. 1 & 3)" and "(Contains Vol. 7.5)" -> {1,9}.

Importer level (temporary convex/zz_n04arch.sync.test.ts using internal.prh.sync and internal.sevenSeas.sync on an empty catalog in Bootstrap Mode, since deleted). At HEAD both syncs stored:
- Deluxe "Vol. 1-9" + possessive bracket (', ’ and &#8217;): Volumes 1-9, 9 coverage rows, unmapped [false].
- Deluxe "Vol. 1-9" + gapped bracket (1-3 plus 4-6 and 8-9): Volumes 1-9 (Volume 7 invented).
- "Alpha, Vol. 1-9" + gapped or possessive bracket: Volumes 1-9.
- "Alpha 3-in-1 Edition, Vol. 1-3" + possessive or gapped bracket: Volumes 1-3, unmapped [false].
- Rejected title + blurb "Collects volumes 1-9.": Volumes 1-9.

Root cause confirmed at convex/lib/bookTitle.ts:652 (`const coverRange = peel.coverRange ?? range`): a bracket statement that was read and rejected leaves peel.coverRange null, the same value as "no bracket", so the outer range is substituted and the flag at :661 is never set.

What HEAD does when both give ranges and disagree: the bracket silently wins ("Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3)" -> 1-3 through both syncs; "Alpha 3-in-1 Edition, Vol. 1-3 (Collects Vols. 1-6)" -> Volumes 1-6). No committed test relies on it: with a prototype that rejects disagreement, all 441 tests in the six named suites and all 1,622 committed tests still pass unchanged. No real title relies on it either: I extracted the 66,347 distinct source titles from the newest export (~/mangadb-audit/before19/sourceObservations, read only; PRH, OpenLibrary, ANN, Yen, Kodansha, Seven Seas) and parsed each with HEAD and with the prototype: 0 of 66,347 parse differently (2,372 are packaging). 218 real titles carry bracket coverage ("Noragami Omnibus 7 (Vol. 19-21)" shape); none also has an outer list.

Prototype results (then reverted): 31 planned regression tests added to the four test files; 27 fail at HEAD, all pass with the change (the 4 that pass at HEAD are the agreeing controls). Six named suites 472/472; full suite 76 files, 1,653 tests pass; `npx tsc --noEmit -p convex/tsconfig.json` and `npm run typecheck` clean. Recall anchors from `git show 5677249:convex/lib/coverage.test.ts` 7/7. Reviewer's /tmp/mangadb-wave4-parent-gap.recheck.test.ts 2/2 pass. Reviewer's /tmp/import_pipeline_wave4.recheck.test.ts 10/13: the 3 failures are the probes that assert the wrong N04 output (placed 1-9), which is the intended flip. I did not run /tmp/mangadb-source-b-1f24c44/probes.recheck.test.ts against the prototype; its two N04 tests assert the HEAD output and will fail the same way.

Cleanup: convex/lib/bookTitle.ts and the four test files restored from byte copies (sha256 of bookTitle.ts and coverage.ts equal the starting values), every temporary test deleted, `git status --short` shows only the pre-existing `?? docs/audits/fix-review-wave4-2026-09-30.md`, `git diff` empty. No git state changes, no deployment. Two reference files remain outside the repo for the builder: /tmp/n04arch/proto.diff (the parser change) and /tmp/n04arch/tests.diff (the regression tests); the plan below is complete without them.

## Plan, as written by the architect

ROOT CAUSE
convex/lib/bookTitle.ts carries "what the title states it collects" as two loose variables per source (`coverRange: CoverRange | null` plus a `multiVolume` boolean) in three places: Peeled (brackets), TrailingPackaging (the list after a packaging phrase), and parseBookTitle's locals `range` / `multiVolume` (the outer designation). Null means both "said nothing" and "said something no range holds", and the two only stay apart while every reader also consults the boolean. Final assembly (:652) does not: `peel.coverRange ?? range` treats a rejected bracket as absent. The same representation makes bracket groups overwrite each other (:338, :363) and lets the subtitle gate (:648) skip a statement whenever any other source gave a range.

MODEL CHANGE (convex/lib/bookTitle.ts only; exported signatures unchanged: parseBookTitle, parseVolumeList, Packaging, ParsedBookTitle)
Use the three-state value coverage.ts blurbCoverage already uses (undefined = silence, null = rejected, a range), one value per source, combined by one function. `parseVolumeList(x)?.coverRange` already yields exactly these three states, so no adapter is needed.

1. Above `type Peeled` add:
/**
 * What one place in a title says the book collects: undefined when it says
 * nothing, a range, or null for coverage it states but no range holds (a
 * gapped list, a statement that reads two ways). The same three states as a
 * blurb's reading (lib/coverage.ts blurbCoverage). Silence and a rejected
 * statement are different facts, so these values meet only in `agreed`,
 * never through `??`.
 */
type Stated = CoverRange | null | undefined;

/**
 * Everything a title states about its coverage, as one reading. A bracket
 * statement, a bracket range, a subtitle statement and the designation after
 * a marker or a packaging phrase are all the title's own explicit evidence,
 * and none outranks another: silence yields to whatever the other states; a
 * statement no range holds stands against any range; and two ranges that
 * differ ("Vol. 1-9 (Collects Vols. 1-3)") contradict each other, so neither
 * is taken. Picking one would be a guess.
 */
function agreed(a: Stated, b: Stated): Stated {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a !== null && b !== null && a.from === b.from && a.to === b.to ? a : null;
}

2. Peeled: replace `coverRange` and `multiVolume` with
  /** What the bracket groups, and a packaged book's subtitle, state it collects. */
  stated: Stated;
emptyPeel: `stated: undefined`.

3. absorbStatement body:
  if (!STATEMENT.test(text)) return false;
  // The text states coverage, so a list left unread is rejected, never silence.
  peel.stated = agreed(peel.stated, coverageFromText(text));
  return true;
(Its doc comment stays accurate.)

4. absorbGroup coverage branch: replace the three lines (`const listed = ...; peel.coverRange = ...; peel.multiVolume ||= ...`) with
    peel.stated = agreed(peel.stated, parseVolumeList(coverage[1]!)?.coverRange);

5. TrailingPackaging: replace `range` and `multiVolume` with
  /** The Volumes listed after the phrase ("Omnibus 5-6"); a gapped list is null. */
  listed: Stated;
In trailingPackaging: `const listed = m[3] !== undefined ? parseVolumeList(m[3])?.coverRange : undefined;`, delete `const range`, change the position test to `listed === undefined && m[3] !== undefined`, and return `listed` in place of `range, multiVolume`.

6. parseBookTitle locals: delete `let range` and `let multiVolume` (and its comment); add
  // The Volumes a designation lists outside the brackets ("Vol. 1-3",
  // "Omnibus 5-6"): packaging even when a gap leaves it null.
  let listed: Stated = undefined;
Then mechanically (`!multiVolume` becomes `listed === undefined`, `multiVolume` becomes `listed !== undefined`):
- packaged block: `listed = packaged.listed;`; second phrase test `more.position === null && more.listed === undefined`.
- marker block guard `linePosition === null && listed === undefined`; inside:
      listed = PLUS_EXTRA_RE.test(designation) ? undefined : parseVolumeList(designation)?.coverRange;
      if (listed === undefined) volumeLabel = canonicalLabel(designation);
- bare-number block: `const list = parseVolumeList(designation)?.coverRange;`, `(list !== undefined ? sameNumber(...) || sameNumber(...) : sameNumber(designation, ...))`, in the licensed branch `listed = list; if (list === undefined) volumeLabel = canonicalLabel(designation);`, and `else if (list === undefined) { bareSplit = ... }`.
- noteLabel, options.subtitle and bare-roman guards, and `if (volumeLabel !== null || listed !== undefined) bareSplit = null;`.
- options.subtitle block: `listed = parseVolumeList(sub[1]!)?.coverRange; if (listed === undefined) volumeLabel = canonicalLabel(sub[1]!);`

7. Assembly (replaces :646-662):
  // "Alpha (3-in-1 Edition), Vol. 1: Includes Vols. 1 & 3": a packaged
  // book's subtitle may state its coverage too.
  if (lineName !== null && volumeSubtitle !== null && STATED_SUBTITLE.test(volumeSubtitle)) {
    absorbStatement(volumeSubtitle, peel);
  }
  // Brackets and the designation outside them must agree (see `agreed`): a
  // rejected statement is never replaced by the other's range.
  const stated = agreed(peel.stated, listed);
  let packaging: Packaging | null = null;
  if (lineName !== null || stated !== undefined || peel.isBox) {
    packaging = {
      lineName: lineName ?? (peel.isBox ? "Box Set" : null),
      // A single number next to packaging is its line position, never a Volume.
      linePosition: linePosition ?? volumeLabel,
      // The stored shape: silence is a null range alone, a rejection carries the flag.
      coverRange: stated ?? null,
      ...(stated === null ? { coverageGapped: true } : {}),
    };
    volumeLabel = null;
  }
The `unstated` gate goes: the subtitle statement is one more reading and joins through `agreed`.

8. packagingValidator comments: coverRange "null when the title never says, or says it in a way no range holds (`coverageGapped`)"; coverageGapped "The title states its coverage, but no range holds it: a list with a gap ("Vol. 1 & 3"), a statement that reads two ways, or two statements that disagree ("Vol. 1-9 (Collects Vols. 1-3)"). Neither a blurb nor the line's declared size may stand in for it (lib/coverage.ts inferCoverage)."

9. convex/lib/coverage.ts: no code change. inferCoverage (:333) already tells absent from rejected through coverageGapped. Only its doc comment: change "a gapped list in the title or the deciding blurb" to "a title whose own statements are rejected or disagree (`coverageGapped`), a gapped list in the deciding blurb".

THE RULE FOR A DISAGREEING OUTER DESIGNATION (decision: tighten)
HEAD lets the bracket win, and among several brackets the leftmost wins by overwrite: an accident of assignment order, not a recorded policy. No committed test and none of 66,347 real titles depends on it. Both statements are the title's own explicit evidence, so "explicit beats weaker" ranks neither, and "never guess" decides: two ranges that differ leave coverRange null with coverageGapped true; two that agree map. A single number beside a bracket ("Noragami Omnibus 7 (Vol. 19-21)", "Alpha, Vol. 1 (Collects Vols. 1-3)") is a line position, not a statement, and is unchanged. The rule is stated in the `agreed` doc comment above.

REGRESSION TESTS (all verified: red at HEAD except the agreeing controls, green with the change)

A. convex/lib/bookTitle.test.ts, at the end of describe "parseBookTitle — packaging" (helper `packaging`), two tests under the comment "// N04: everything a title states about its coverage must agree. A statement no range holds (a gap, a possessive) is never replaced by a range stated elsewhere in the title, and two ranges that differ are no range at all: the book stays unknown, never on a guess."
it("never lets a designation outside the brackets stand in for a rejected bracket statement"): const REJECTED = { coverRange: null, coverageGapped: true }. For each outer in ["Alpha, Vol. 1-9", "Alpha Deluxe Edition Vol. 1-9", "Alpha Omnibus 1-9", "Alpha (Omnibus) Vol. 1-9", "Alpha 3-in-1 Edition Vol. 1-9", "Alpha Vol. 1-9 Box Set"]:
 - toMatchObject(REJECTED) for `${outer} ${bracket}` with bracket in: "(Collects Vols. 1-3 plus Vol. 4's bonus chapter)", "(Collects Vols. 1-3 plus Vol. 4’s bonus chapter)", "(Collects Vols. 1-3 plus Vol. 4&#8217;s bonus chapter)", "(Collects Vols. 1-3 plus 4-6 and 8-9 in one book)", "(Vol. 1 & 3)", and the disagreeing ranges "(Collects Vols. 1-3)", "(Vol. 1-3)", "(Collects Vol. 5)".
 - coverRange toEqual { from: "1", to: "9" } and coverageGapped undefined for bracket in: "(Collects Vols. 1-3 plus 4-6 and 7-9 in one book)", "(Collects Vols. 1-9)", "(Vol. 1-9)".
 Then the review's own titles: packaging("Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)").packaging toEqual { lineName: "Deluxe Edition", linePosition: null, ...REJECTED }; packaging("Alpha, Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 8-9 in one book)") toEqual { seriesTitle: "Alpha", volumeLabel: null, packaging: { lineName: null, linePosition: null, ...REJECTED }, isBox: false }.
it("holds every other pair of coverage statements in a title to the same rule"): toMatchObject(REJECTED) for "Alpha, Vol. 1 & 3 (Collects Vols. 1-3)", "Alpha Omnibus 1 & 3 (Vol. 1-3)", "Alpha Deluxe Edition 1 (Vol. 1-3) (Collects Vols. 1 and 3)", "Alpha Deluxe Edition 1 (Collects Vols. 1 and 3) (Vol. 1-3)", "Alpha Deluxe Edition 1 (Vol. 1-3) (Vol. 4-6)", "Alpha (Collects Vols. 1 & 3) Vol. 1-3", "Alpha (3-in-1 Edition), Vol. 1-3: Includes Vols. 1 & 3", "Alpha (3-in-1 Edition), Vol. 1-3: Includes Vols. 1-6". With bracket = "(Collects Vols. 1-3 plus Vol. 4's bonus chapter)": parseBookTitle(`Alpha Deluxe Edition ${bracket}`, { subtitle: "Vol. 1-9" }).packaging and packaging(`Alpha 1-9 ${bracket}`, 1).packaging both toMatchObject(REJECTED). Controls: packaging("Alpha Deluxe Edition 1 (Vol. 1-3) (Collects Vols. 1-3)").packaging toEqual { lineName: "Deluxe Edition", linePosition: "1", coverRange: { from: "1", to: "3" } }; "Alpha (3-in-1 Edition), Vol. 1-3: Includes Vols. 1-3" coverRange {1,3}; packaging("Noragami Omnibus 7 (Vol. 19-21)", 7).packaging toEqual { lineName: "Omnibus", linePosition: "7", coverRange: { from: "19", to: "21" } }.

B. convex/lib/coverage.test.ts: add `import { parseBookTitle } from "./bookTitle";`; in describe "inferCoverage — precedence", after the R12 test, it("never places a title whose own coverage statements are rejected or disagree") under "// N04: a title that rejects its own statement, or states two ranges, arrives gapped, so no blurb and no line size stands in for it.": for each of "Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-3 plus Vol. 4's bonus chapter)", "Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1 and 3)", "Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-6)", "Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)", "Alpha, Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 8-9 in one book)": inferCoverage(parseBookTitle(title).packaging!, []) and inferCoverage(..., ["Collects volumes 1-3."]) are null. Control: inferCoverage(parseBookTitle("Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-3)").packaging!, ["Collects volumes 4-6."]) toEqual { from: "1", to: "3" }.

C. convex/prh.test.ts (entry point internal.prh.sync via syncFresh), in describe "prh.sync — a gapped coverage statement is never widened (R12)", after the N02 it.each and before the W05 comment; uses the existing FRESH_UNMAPPED, onlyCovering, ONE_TO_NINE:
it.each([...])("a title stating its coverage twice (%s) maps only when both agree", async (title, expected) => expect(await syncFresh(title)).toEqual(expected)) with rows:
 "Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4's bonus chapter)" -> FRESH_UNMAPPED
 "Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)" -> FRESH_UNMAPPED
 "Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 8-9 in one book)" -> FRESH_UNMAPPED
 "Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3)" -> FRESH_UNMAPPED
 "Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 7-9 in one book)" -> onlyCovering(ONE_TO_NINE)
 "Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-3 plus Vol. 4's bonus chapter)" -> FRESH_UNMAPPED
 "Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)" -> FRESH_UNMAPPED
 "Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1 and 3)" -> FRESH_UNMAPPED
 "Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-6)" -> FRESH_UNMAPPED
 "Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-3)" -> onlyCovering(["1", "2", "3"])
 "Alpha Deluxe Edition Vol. 1 & 3 (Collects Vols. 1-3)" -> FRESH_UNMAPPED (the reverse direction)
it.each(["Alpha, Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 8-9 in one book)", "Alpha, Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)"])("a bare range beside a rejected bracket statement (%s) creates no Volume") -> syncFresh(title) toEqual { volumes: [], covered: [], unmapped: [] }. Note the expected shape: with no Edition Line there is nothing to wait under, so no Edition is created at all (unmapped is [], not [true]); the observation waits for an Editor.
it("a blurb never stands in for a title statement the outer range contradicts"): syncFresh("Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)", "<p>Collects volumes 1-9.</p>") toEqual FRESH_UNMAPPED.

D. convex/sevenSeas.test.ts (entry point internal.sevenSeas.sync via syncOne), same position in the matching describe; uses DELUXE, THREE_IN_1, UNMAPPED, PLACED_1_3, onlyCovering, ONE_TO_NINE. Rows are [book, title, expected], run as `syncOne({ ...book, title }, "")`, title format "(%#)": the same eleven titles as C with DELUXE for the Deluxe rows and THREE_IN_1 for the 3-in-1 rows; UNMAPPED where C has FRESH_UNMAPPED, onlyCovering(ONE_TO_NINE) and PLACED_1_3 for the two agreeing rows. The two line-less titles run with `{ ...DELUXE, title, seriesSlug: "alpha", seriesTitle: "Alpha" }` and expect { volumes: [], coverages: 0, unmapped: [] }. The blurb test: syncOne({ ...DELUXE, title }, "<p>Collects volumes 1-9.</p>") toEqual UNMAPPED.

Each block carries a short comment naming N04 and the rule, in the style of the neighbouring N01/N02 blocks.

BUILDER CHECKLIST
1. Add the tests first and watch 27 fail (the agreeing controls pass at HEAD).
2. Apply the model change; `grep -n "multiVolume\|peel.coverRange" convex/lib/bookTitle.ts` must return nothing.
3. Run: npx vitest run convex/lib/bookTitle.test.ts convex/lib/coverage.test.ts convex/prh.test.ts convex/sevenSeas.test.ts convex/yenPress.test.ts convex/reconcile.test.ts --maxWorkers=2 (expect 472 passing), then npx tsc --noEmit -p convex/tsconfig.json and npm run typecheck.
4. Recall anchors: `git show 5677249:convex/lib/coverage.test.ts` as a temporary file in convex/lib/ must pass 7/7; delete it afterwards.
5. No existing expectation changes. If one does, the change was applied differently from this plan.
6. Do not run Prettier on these files (the repo tracks no config; files are hand-kept near 120 columns).
Optional references outside the repo: /tmp/n04arch/proto.diff and /tmp/n04arch/tests.diff are the exact prototype diffs.

Risks: 1. Recall cost of the tightened rule: a title whose outer list is really line positions while the bracket gives the coverage (a hypothetical "Alpha Omnibus 1-2 (Vol. 1-6)") now lands Unmapped instead of taking the bracket's range. None exists among 66,347 exported titles (218 have bracket coverage, none also has an outer list), and the cost is a Moderator mapping, not wrong data. If such a shape appears, the right fix is teaching the outer reading that those numbers are positions, not reinstating bracket-wins.

2. The subtitle gate is removed, so a packaged book's stated subtitle is always read and must agree with the rest ("Alpha (3-in-1 Edition), Vol. 1-3: Includes Vols. 1-6" becomes Unmapped; at HEAD the subtitle was ignored and the book placed at 1-3). This is the same rule applied once more; keeping the gate would leave a gapped subtitle beside an outer range silently ignored. Zero real titles change.

3. A rejected title with no Edition Line ("Alpha, Vol. 1-9 (...)") creates no Edition at all, so the importer tests expect unmapped [] rather than [true]. This is how a bare gapped list ("Alpha Vol. 1 & 3") already behaves; CONTEXT.md defines Unmapped Packaging as an Edition Line member. The review text says "the required outcome is Unmapped"; at the parser that is coverRange null with coverageGapped true, which the tests pin.

4. `coverageGapped` now also marks two-way statements and disagreement, not only gaps. The stored field name and validator are unchanged (no schema or migration impact); only its doc comment widens. convex/sevenSeas.ts unplacedVerdict (read-only) words every unplaced packaging as "neither the title, the blurb, nor the line name states", which was already loose for gapped titles.

5. Existing data is not repaired: a book already placed from the wrong outer range keeps its coverage rows, because linked records are not re-resolved. The export holds no title of this shape, so nothing known needs repair.

6. The reviewer's retained probes that assert the wrong HEAD output will fail after the fix, as intended: three in /tmp/import_pipeline_wave4.recheck.test.ts ("outer title designation overrides...") and two in /tmp/mangadb-source-b-1f24c44/probes.recheck.test.ts. I ran the first file against the prototype (10/13, those three failing); I did not run the second.

7. One `??` remains on a Stated value, at the final projection (`coverRange: stated ?? null`), where the flag beside it carries the rejection. Any new combination must go through `agreed`; the type comment says so, but TypeScript does not enforce it.

8. `coverageFromText` still folds silence into null. In absorbStatement that is deliberate: text that passed the STATEMENT gate and yields no list ("Collects Vol. 1000") is unread, so rejected. The comment in absorbStatement records it.

9. ANN is not covered by this fix (see siblingGaps); its files are read-only in this lane.

10. I left two reference diffs in /tmp/n04arch/ (proto.diff, tests.diff). Nothing of mine remains in the worktree.

### Sibling sites checked

- convex/lib/bookTitle.ts:652 (editable, fixed by the plan): `peel.coverRange ?? range` - the reported site; a rejected bracket statement is replaced by the outer range.
- convex/lib/bookTitle.ts:652 reverse direction (editable, fixed): an outer designation read and rejected is replaced by a bracket range and the gap flag is dropped. 'Alpha Deluxe Edition Vol. 1 & 3 (Collects Vols. 1-3)' stores Volumes 1-3 through both syncs at HEAD.
- convex/lib/bookTitle.ts:338 and :363 (editable, fixed): absorbStatement and absorbGroup assign peel.coverRange, so bracket groups overwrite each other and the leftmost wins. 'Alpha Deluxe Edition 1 (Vol. 1-3) (Collects Vols. 1 and 3)' stores Volumes 1-3 at HEAD; the same two brackets in the other order are gapped. :363 also writes `listed?.coverRange ?? null`.
- convex/lib/bookTitle.ts:648-650 (editable, fixed): the `unstated` gate (`!multiVolume && !peel.multiVolume && peel.coverRange === null`) skips a packaged book's subtitle statement whenever another source gave a range. 'Alpha (3-in-1 Edition), Vol. 1-3: Includes Vols. 1 & 3' stores Volumes 1-3 at HEAD.
- convex/lib/bookTitle.ts:652 two ranges that disagree (editable, tightened by the plan): the bracket silently wins. 'Alpha 3-in-1 Edition, Vol. 1-3 (Collects Vols. 1-6)' stores Volumes 1-6 at HEAD.
- convex/lib/bookTitle.ts:454-455, :469, :549-553, :597-600, :620-624 (editable, folded into the model change): each carries the three states as a `?? null` range plus a separate multiVolume boolean. Correct today only because every reader also checks the boolean; this is the representation that let :652 go wrong.
- convex/lib/coverage.ts:333 inferCoverage (editable, no code change): `if (packaging.coverRange || packaging.coverageGapped) return packaging.coverRange` already separates absent from rejected. Doc comment only.
- convex/lib/coverage.ts:278 coverageFromText (editable, no change): `blurbCoverage(text, null) ?? null` folds silence into null. Its only non-test caller is absorbStatement, where gate-passed text that yields no list is deliberately rejected. :244 (`agreeing ... ?? null`) and :261 are correct: a statement the size contradicts is a rejection.
- convex/ann.ts:1227 with convex/lib/ann.ts:218-230 (read-only, real gap, not fixed): `line.coverRange ?? coverageFromLine(...)`. splitReleaseTitle has no rejected state: '(GN 1, 3)' and '(GN 1 & 3)' become label 1 with no coverRange, so a 3-in-1 line is then placed by its size; '(GN 1-3, 5)' is shortened to 1-3 and '(GN 1-2-3)' to 1-2. No such designator exists among the 32,042 ANN release observations in the before19 export.
- convex/ann.ts:873 packagingOf (read-only, latent gap): reads only `parsed.packaging?.lineName` from parseBookTitle, dropping coverRange and coverageGapped, so a rejected statement in an ANN line title would not block the size at :1227.
- convex/lib/prh.ts:249 and :265, convex/lib/yenPress.ts:267 and :281, convex/lib/openLibrary.ts:259 and :271 (read-only, no behaviour effect today): snapshot `multiVolume` is derived from `parsed.packaging?.coverRange ?? null`, so it is false for a rejected list of several Volumes. The only reader, convex/openLibrary.ts:378, ORs it with `snapshot.packaging !== undefined`; convex/lib/catalogTitle.ts:376 uses `packaging !== null`. The stored flag is misleading but nothing acts on it alone.
- convex/lib/prh.ts:279 (read-only, harmless): coverageHints are stored whenever `packaging.coverRange === null`, including rejected titles; inferCoverage returns before reading them.
- convex/lib/catalogTitle.ts:176-180 and convex/sevenSeas.ts:511-512 (read-only, no gap): both take `inferCoverage(...)` and map null to no labels; neither falls back to another source.
- convex/lib/kodansha.ts:198 and :248, convex/kodansha.ts:851-857, convex/lib/yenPress.ts:283 (read-only, no gap): they build or spread a Packaging with coverRange null meaning absent; Kodansha packaging links by ISBN only and never infers coverage.

## Outcome

Status: approved. N04 is fixed in /home/ari/.t3/worktrees/MangaDB/t3code-eccfd885/convex/lib/bookTitle.ts by changing the model, as the plan asked. Each place in a title that states coverage now yields one three-state `Stated` value: undefined means silence, null means a statement was made but was rejected, and a range means a readable statement. These are the same states lib/coverage.ts blurbCoverage uses. All of them are combined through a single `agreed()` function. Its doc comment states the rule. Silence yields to whatever the other place states. A rejected statement stands against any range. Two ranges that differ are a contradiction, so the result is coverRange null with coverageGapped true. Two ranges that agree map normally.

The change replaced these pieces:
- Peeled.coverRange and Peeled.multiVolume became `stated`.
- TrailingPackaging.range and TrailingPackaging.multiVolume became `listed`.
- parseBookTitle's locals `range` and `multiVolume` became `listed`.
- absorbStatement and absorbGroup now combine through `agreed()` instead of overwriting.
- The `unstated` subtitle gate is gone.
- Final assembly is now `agreed(peel.stated, listed)`. The old `peel.coverRange ?? range` is gone.

`grep multiVolume|peel.coverRange` on the file returns nothing. Exported signatures are unchanged, and the packagingValidator doc comments now describe the wider meaning of coverageGapped. In /home/ari/.t3/worktrees/MangaDB/t3code-eccfd885/convex/lib/coverage.ts only the inferCoverage doc comment changed. Its code already separates a missing statement from a rejected one through coverageGapped.

Tests were written first: 27 new regression tests failed at HEAD for the N04 reason (the outer range replacing the rejected or disagreeing bracket), and 4 agreeing controls passed. All 31 pass after the change.

For two ranges that disagree, I tightened the rule. HEAD let the leftmost bracket win by overwrite. That was an accident of assignment order, and no committed test relies on it. The architect found no real title that relies on it either: none of 66,347 exported titles parse differently.

### Behaviour changes versus `1f24c44`

- Outer range + possessive bracket, e.g. 'Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)' (', ’ and &#8217;): before coverRange 1-9, 9 Volumes and 9 coverage rows via PRH/Seven Seas; after coverRange null, coverageGapped true, Unmapped Packaging with no coverage
- Outer range + gapped bracket, e.g. 'Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 8-9 in one book)', '... (Vol. 1 & 3)': before 1-9 (Volume 7 invented); after null + coverageGapped, Unmapped
- Line-less outer range + rejected bracket, e.g. 'Alpha, Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 8-9 in one book)' or '... Vol. 4’s bonus chapter)': before Volumes 1-9 created and covered; after packaging {lineName null, coverRange null, coverageGapped true}; importers create no Volume and no Edition (unmapped [])
- 3-in-1 outer range + possessive or gapped bracket, e.g. 'Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-3 plus Vol. 4's bonus chapter)', '... (Collects Vols. 1 and 3)': before placed at 1-3; after Unmapped
- Outer range + disagreeing bracket range, e.g. 'Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3)', '... (Vol. 1-3)', '... (Collects Vol. 5)', 'Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-6)': before the bracket won (1-3, 1-3, 5, 1-6); after null + coverageGapped, Unmapped
- Reverse direction: gapped outer designation + bracket range, e.g. 'Alpha Deluxe Edition Vol. 1 & 3 (Collects Vols. 1-3)', 'Alpha, Vol. 1 & 3 (Collects Vols. 1-3)', 'Alpha Omnibus 1 & 3 (Vol. 1-3)': before bracket range 1-3 with the gap flag dropped; after null + coverageGapped
- Two bracket groups that disagree, in either order, e.g. 'Alpha Deluxe Edition 1 (Vol. 1-3) (Collects Vols. 1 and 3)' (before 1-3), 'Alpha Deluxe Edition 1 (Vol. 1-3) (Vol. 4-6)' (before the leftmost, 1-3): after null + coverageGapped
- Bracket before the designation, 'Alpha (Collects Vols. 1 & 3) Vol. 1-3': before 1-3; after null + coverageGapped
- Packaged book subtitle statement beside an outer range (the subtitle gate is gone), e.g. 'Alpha (3-in-1 Edition), Vol. 1-3: Includes Vols. 1 & 3' and '...: Includes Vols. 1-6': before 1-3 (subtitle ignored); after null + coverageGapped. An agreeing subtitle ('Includes Vols. 1-3') still maps 1-3
- OpenLibrary carried subtitle range or seriesNumber-licensed bare range + rejected or disagreeing bracket, e.g. parseBookTitle('Alpha Deluxe Edition (Collects Vols. 1-3 plus Vol. 4's bonus chapter)', {subtitle: 'Vol. 1-9'}), 'Alpha 1-9 (...)' with seriesNumber 1: before 1-9; after null + coverageGapped
- A blurb beside any of the above, e.g. 'Collects volumes 1-9.': before the title's wrong range decided anyway; after the title is gapped, so inferCoverage returns null and the blurb never stands in
- Unchanged (pinned by controls): agreeing pairs ('Vol. 1-9 (Collects Vols. 1-9)', '(Vol. 1-9)', '(Collects Vols. 1-3 plus 4-6 and 7-9 in one book)', 'Alpha Deluxe Edition 1 (Vol. 1-3) (Collects Vols. 1-3)', 'Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-3)') still map; a single line position beside a bracket ('Noragami Omnibus 7 (Vol. 19-21)', 'Alpha, Vol. 1 (Collects Vols. 1-3)') is a position, not a second statement, and still maps

### Verifier

 N04 is fixed and I could not refute it. No blocking issues; two pre-existing sibling gaps of the same class remain and are listed as non-blocking.

**What I checked**

- **Model, not a patch.** `/home/ari/.t3/worktrees/MangaDB/t3code-eccfd885/convex/lib/bookTitle.ts` now carries one three-state `Stated` value (undefined = silence, null = rejected, a range) from brackets, the packaging-phrase list, the marker list, the bare list and the carried subtitle. They meet only in `agreed()`. `peel.coverRange ?? range`, both `multiVolume` booleans and the `unstated` gate are gone. The one remaining `??` is the final projection, with `coverageGapped` set beside it.
- **Rule for disagreeing ranges.** It is stated in the `agreed` doc comment and tightened: two ranges that differ give `coverRange: null, coverageGapped: true`. No committed expectation changed; the four test files have 0 deleted lines.
- **Tests fail on HEAD through the real importers.** In an isolated copy with HEAD's parser, 27 of the new tests fail: 3 unit, 12 through `internal.prh.sync`, 12 through `internal.sevenSeas.sync`. The agreeing controls pass. All pass on the fixed tree.
- **Differential, generated shapes.** Over 24,180 titles (6,045 shapes), 2,853 shapes differ from HEAD. In every one the only change is the coverage becoming null with `coverageGapped`; every other parsed field is identical, and the fix never yields a range HEAD did not. I read the differences by group. All are two or more title statements where one is rejected or two disagree: bracket, outer list, two brackets, subtitle statement, or carried subtitle.
- **Differential, real titles.** 66,347 distinct exported titles, 106,778 parses (each number in the title as `seriesNumber`, plus the Yen subtitle cut): 0 differences.
- **Importer probes.** 330 new probes through both syncs pass on the fixed tree; 156 of them fail on the HEAD copy. Comparing stored results, 473 cells differ, and in none does the fix store more Volumes, coverage rows or bundle members than HEAD.
- **Suites.** Lane suites 472/472, full suite 76 files 1,653/1,653, both typechecks clean, recall anchors from `5677249` 7/7.
- **Reviewer reproductions.** Parent-gap 2/2; pipeline 10/13 and source-b 3/5, where the 5 failures are the probes asserting HEAD's wrong N04 output.

**Differences not spelled out in the builder's list, same rule**

- A subtitle statement against a bracket range: "Alpha 3-in-1 Edition, Vol. 1: Includes Vols. 1-3 (Vol. 1-9)" was 1-9, now rejected.
- A single-Volume subtitle against an outer range: "Alpha Omnibus Vol. 1-3: Collects Vol. 1" was 1-3, now rejected.
- A Seven Seas box set with a rejected pair over an existing Series ("Alpha Vol. 1-6 Box Set (Collects Vols. 1 and 3)") no longer creates an empty Release Bundle. This matches how a box with one gapped statement already behaved.

One of my own control expectations was wrong and I corrected it: "Alpha 3-in-1 Edition, Vol. 2" with a blurb that contradicts the size stays Unmapped, which is existing behaviour.

**Cleanup**

All my probe files are deleted and `/tmp/n04verify` is removed. `git status` shows only the six lane files and the pre-existing audit doc; their sha256 values are unchanged from when I started. The reviewer's `differential.json` and `matrix.json` were backed up and restored byte-identical. No git state changes, no deployment.

Non-blocking notes:

- Sibling gap, unchanged from HEAD: convex/lib/bookTitle.ts:577-584 discards `inner.listed`. A list after a packaging phrase that is followed by a marker never reaches `agreed`. 'Alpha 3-in-1 Edition 1 & 3, Vol. 1' stores Volumes 1-3 by line size through both syncs (expected under the rule: coverRange null, coverageGapped true); 'Alpha Omnibus 1-3 Vol. 4-6' stores 4-6. Suggested fix: `listed = agreed(listed, inner.listed);` after `linePosition ??= inner.position;`. That change alters 0 of 69,720 real title strings. The builder's claim that every statement site meets in `agreed` is not true for this one.
- Sibling gap, unchanged from HEAD: convex/lib/bookTitle.ts:656 reads a stated subtitle only when `lineName !== null`. A line-less multi-volume book ignores it: 'Alpha, Vol. 1-3: Includes Vols. 1 & 3' and '...: Includes Vols. 1-6' store Volumes 1-3 through both syncs. Suggested fix: gate on `lineName !== null || listed !== undefined`. I did not block on it because fix-review-wave4 lists the subtitle gate as an accepted limit; the comment 'a packaged book's subtitle' is accurate only for lined books.
- Accepted limit still in place: STATED_SUBTITLE's `$` anchor. 'Alpha (3-in-1 Edition), Vol. 1: Includes Vols. 1-3 plus Vol. 4's bonus chapter' and '..., Vol. 1-3: Includes Vols. 1-3 plus 4-6' are not read as statements and place 1-3.
- A carried OpenLibrary subtitle is read only when the title has no designation of its own: 'Alpha Omnibus Vol. 1-3' with subtitle 'Vol. 1 & 3' stays 1-3. Unchanged from HEAD.
- Recall cost of the tightened rule: an outer 'Part 1-2' or 'Book 1-2' beside a bracket range ('Alpha Part 1-2 (Vol. 1-3)') was 1-3 at HEAD by the bracket winning and is now Unmapped. Same for 'Alpha Omnibus 1-2 (Vol. 1-6)'. No real title has either shape.
- The bracket-range reader and the statement reader differ on a run-on: '(Vol. 1-2-3)' reads as 1-3 and agrees with an outer 'Vol. 1-3', while '(Collects Vols. 1-2-3)' is rejected. Pre-existing; all three Volumes are named, so nothing is invented.
- Two outcomes the builder's list does not spell out but that follow the same rule: a subtitle statement against a bracket range, and a rejected Seven Seas box set over an existing Series no longer creating an empty Release Bundle.
- CONTEXT.md still defines Unmapped Packaging as a source that 'never stated' its Volumes; rejected and disagreeing titles now land there too. Out of lane, wording only.
- Left outside the repo by earlier stages, not mine: /tmp/n04arch/proto.diff and tests.diff.


## Follow-up on sibling gaps, and where it stopped

After N04 was approved, a follow-up closed two more sites of the same class
in `convex/lib/bookTitle.ts`: a list after a packaging phrase that is
followed by a marker ("Alpha 3-in-1 Edition 1 & 3, Vol. 1"), and a stated
subtitle on a book with no line ("Alpha, Vol. 1-3: Includes Vols. 1 & 3").
Both now reject instead of placing Volumes.

The follow-up was stopped by the owner's decision: real titles are the
acceptance bar, and synthetic shapes that still misparse are left for a
human to fix. Final state of the tree:

- 76 test files, 1,777 tests passing; `tsc` clean for `src/` and `convex/`;
  `npm run build` succeeds. Not deployed.
- Real-title comparison against the committed parser at `1f24c44`: 79,311
  distinct titles from `~/mangadb-audit/before19` (read only), 119,535
  parses including each number as `seriesNumber`. Twelve parses differ,
  over four titles, all improvements or neutral:
  - "Dragonball 3-in-1 Edition 1: Includes vols. 1, 2 & 3" and the Edition 3
    title: Series is now "Dragonball" with line "3-in-1 Edition" and its
    position; coverage unchanged.
  - "The Walking Cat: ... (Omnibus Vol. 1-3)": line is now "Omnibus" with
    coverage 1-3; before, the line name swallowed the range and nothing was
    placed.
  - "Prince Valiant Vols. 19-21, Gift Box Set": gains the gapped flag; no
    placement either way.

### Known synthetic leftovers (for a human)

From the last full verification, over four million generated title shapes.
None occurs in the real export. A repair for these was in progress when the
work was stopped, so some may already be closed; re-check before fixing.

- (d) statement split over an earlier marker | 'Alpha, Vol. 2: Deluxe Edition 1: Includes Vols. 1-3' {} | HEAD: Series 'Alpha', plain Volume 2, subtitle 'Deluxe Edition 1: Includes Vols. 1-3'; both syncs store Alpha Volume 2 | TREE: Series 'Alpha, Vol. 2', line 'Deluxe Edition' position 1, coverRange 1-3; both syncs create Series 'Alpha, Vol. 2' with Volumes 1-3
- (d) same site | 'Alpha, Vol. 2 - 3-in-1 Edition 1: Includes Vols. 1-3' {} | HEAD: Series 'Alpha', Volume 2 | TREE: Series 'Alpha, Vol. 2', 3-in-1 Edition 1, coverRange 1-3; both syncs store Volumes 1-3 under 'Alpha, Vol. 2'
- (d) same site | 'Alpha, Vol. 2: Omnibus 1 - Includes Vols. 4-6' {} | HEAD: Series 'Alpha', Volume 2 | TREE: Series 'Alpha, Vol. 2', Omnibus 1, coverRange 4-6; both syncs store Volumes 4-6 under 'Alpha, Vol. 2'
- (d) same site, rejected outcome | 'Alpha, Vol. 2: Deluxe Edition 1: Includes Vols. 1 & 3' {} | HEAD: Series 'Alpha', Volume 2 stored | TREE: Series 'Alpha, Vol. 2', Deluxe Edition 1, coverRange null, coverageGapped; both syncs create Series 'Alpha, Vol. 2' with an Unmapped Edition and no Volume
- (d) same site, Part marker | 'Alpha Part 2: Omnibus 1: Includes Vols. 1-3' {} | HEAD: Series 'Alpha', Volume 2 | TREE: Series 'Alpha Part 2', Omnibus 1, coverRange 1-3; both syncs store Volumes 1-3 under 'Alpha Part 2'
- (d) same site, Part marker | 'Alpha: Part 4 - Diamond Deluxe Edition 1: Includes Vols. 1-3' {} | HEAD: Series 'Alpha', Volume 4 | TREE: Series 'Alpha: Part 4 - Diamond', Deluxe Edition 1, coverRange 1-3; both syncs store Volumes 1-3 under 'Alpha: Part 4 - Diamond'
- (d) same site, Book list | 'Alpha Book 1-2: Deluxe Edition 1-3: Includes Vols. 1-3' {} | HEAD: Series 'Alpha', no line, coverRange 1-2 | TREE: Series 'Alpha Book 1-2', line 'Deluxe Edition', coverRange 1-3; both syncs store Volumes 1-3 under 'Alpha Book 1-2'
- (d) same site, box | 'Alpha Vol. 3: Box Set 1: Includes Vols. 1-3' {} | HEAD: Series 'Alpha', Volume 3 stored | TREE: Series 'Alpha Vol. 3', Box Set position 1, coverRange 1-3, isBox; a fresh sync stores no Volume
- (d) same site, generated | 'Catch-22, Volume Two: Omnibus 2 (Vol. 2): Contains Volumes 1, 2, and 3' {} | HEAD: Series 'Catch-22', Volume 2 | TREE: Series 'Catch-22, Volume Two', Omnibus 2, coverRange 1-3
- (d) same site, generated | 'Blade Runner 2049: Vol. 4-6: Complete 3: Includes Vol. 4 (Vol. 4-6)' {} | HEAD: Series 'Blade Runner 2049', coverRange 4-6 | TREE: Series 'Blade Runner 2049: Vol. 4-6', line 'Complete' position 3, coverRange null, coverageGapped
- (d) statement split, Series loses a phrase | 'Alpha Omnibus Omnibus Vol. 1-3: Includes Vols. 1-3' {} | HEAD: Series 'Alpha Omnibus', line 'Omnibus', coverRange 1-3; both syncs store 1-3 under 'Alpha Omnibus' | TREE: Series 'Alpha', line 'Omnibus', coverRange 1-3; both syncs store 1-3 under 'Alpha'
- (d) same site | 'Alpha 3-in-1 Edition Omnibus Vol. 1-3: Includes Vols. 1-3' {} | HEAD: Series 'Alpha 3-in-1 Edition', line 'Omnibus', coverRange 1-3 | TREE: Series 'Alpha', line 'Omnibus', coverRange 1-3; both syncs store 1-3 under 'Alpha'
- (d) same site, box flag flips | 'Alpha Box Set Omnibus Vol. 1-3: Includes Vols. 1-3' {} | HEAD: Series 'Alpha Box Set', line 'Omnibus', coverRange 1-3, isBox false; both syncs store Volumes 1-3 under 'Alpha Box Set' | TREE: Series 'Alpha', line 'Omnibus', coverRange 1-3, isBox true; a fresh sync stores no Series and no Volume
- (e) dash chain in a subtitle list | 'Alpha Omnibus, Vol. 2: Vol. 2 - 4-6' {} | HEAD: Omnibus 2, coverRange null, no flag; both syncs leave it Unmapped | TREE: Omnibus 2, coverRange 2-6; both syncs store Volumes 2, 3, 4, 5, 6
- (e) same site | 'Alpha (Omnibus) Vol. 2: Vols. 4-6-8' {} | HEAD: Omnibus 2, coverRange null; Unmapped | TREE: coverRange 4-8; both syncs store Volumes 4-8
- (e) same site | 'Alpha 3-in-1 Edition, Vol. 1: Vols. 1-2-5' {} | HEAD: 3-in-1 Edition 1, coverRange null, line size places 1-3 | TREE: coverRange 1-5; both syncs store Volumes 1-5
- (e) carried subtitle, line 694 | 'Alpha (Omnibus) Volume 2' {subtitle: 'Vol. 4-6-8'} | HEAD: Omnibus 2, coverRange null | TREE: coverRange 4-8. Also {subtitle: 'Vol. 2 - 4-6'} gives 2-6
- (e) same site, generated | 'Area 51, Omnibus Book 2: Vol. 2 - 4-6' {} | HEAD: Omnibus 2, coverRange null | TREE: coverRange 2-6
- (e) same site, generated | 'Alpha, Omnibus Book 2 - Vol. 1-3 - Vol.2' {} | HEAD: Omnibus 2, coverRange null | TREE: coverRange 1-2
- (e) same site, generated | 'Blade Runner 2049 Omnibus Book 2 - Vol. 1 + Vol. 2 - Vol. 4-6' {} | HEAD: Omnibus 2, coverRange null | TREE: coverRange 1-6
- (d) parser level only, novel titles | 'Alpha 2 Omnibus (Light Novel) 1 & 3' {} | HEAD: Series 'Alpha', Omnibus position 2, coverRange null, isNovel | TREE: Series 'Alpha 2', Omnibus, no position, coverRange null, coverageGapped, isNovel. Both syncs drop the title as a novel and store nothing
- (d) same site, generated | 'Area 51, Omnibus Vol. 1-3 (Light Novel), 1 & 3 (Hardcover)' {} | HEAD: Series 'Area', Omnibus position 51, coverRange null, isNovel | TREE: Series 'Area 51', Omnibus, coverRange null, coverageGapped, isNovel

Other limits the verifiers recorded and nobody changed: the
`STATED_SUBTITLE` end anchor, a plain Volume's subtitle staying display
text, Part and Book lists beside packaging, and `convex/ann.ts` having no
rejected state in its own title splitter ("(GN 1, 3)" on a 3-in-1 line is
placed by size).

