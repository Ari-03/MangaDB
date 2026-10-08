# Operations

Commands an operator runs by hand. Against production, add `--prod` to
`npx convex run`, and only with the owner's fresh yes for that action
([AGENTS.md](../AGENTS.md)). Import commands per source are in
[imports.md](imports.md).

## Dev seed

With `npx convex dev` running, load a small hand-written catalog
(`convex/seed.ts`):

```sh
npx convex run seed:run '{}'
```

It covers the model's corner cases: a Series Family with a sequel edge,
Volumes whose position and label differ ("3.5"), an Edition Line with an
omnibus covering Volumes 1 to 3, a split digital Edition with partial
coverage, a box-set-exclusive Variant and a Bundle that pins it, plus a
plain Series and a oneshot. A few Releases are dated relative to the day
you seed, so the calendar always has a current month. All facts are fake.
The seed runs only on an empty catalog: if any table it writes holds a
row, it refuses and changes nothing.

## Refresh local or staging from production

```sh
npx convex export --prod --path snapshot.zip --include-file-storage
npx convex import --replace-all snapshot.zip                                   # local
npx convex import --replace-all --deployment brave-kingfisher-844 snapshot.zip # staging
```

`--replace-all` destroys what the target holds. Export the target first
unless the owner has said its contents are disposable (AGENTS.md). The
export only reads production.

After a refresh the imported `approvedSources` rows are enabled again,
because they come from production. Disable them on staging from the source
registry (or with `importSources:setEnabledInternal`), so staging never
fetches from publishers.

## Seeding a new catalog

The order used for the launch catalog. Each step also has a button on
`/mod/launch` once an Administrator exists:

```sh
npx convex run importSources:seedRegistry '{}'
npx convex run importSources:setBootstrapModeInternal '{"on":true}'
npx convex run launch:startSeedStageInternal '{"stage":1}'      # ① Seven Seas + Kodansha
# wait for stage 1 to complete (repeat sevenSeas:sync '{"maxDetailFetches":…}'
# for the initial backfill until recordsChanged settles at 0), then:
npx convex run launch:startSeedStageInternal '{"stage":2}'      # ② ANN full mirror (hours at 1 req/s)
npx convex run launch:startSeedStageInternal '{"stage":3}'      # ③ PRH full sweep (needs PRH_API_KEY)
npx convex run launch:startSeedStageInternal '{"stage":4}'      # ④ OpenLibrary dump (needs OPENLIBRARY_DUMP_URL)
```

`launch.startSeedStage` refuses out-of-order starts and requires Bootstrap
Mode. Yen Press and the Kodansha backlist are not stages; they run on
their own cadences once `seedRegistry` has added their rows.

Quality gates on `/mod/launch`, all required before Bootstrap Mode goes
off:

1. A random sample of about 50 Series (`launch.drawQaSample
   {"kind":"random"}`), each checked by hand and marked Verified or Failed.
2. The about 50 Series with the most Releases (`{"kind":"prominent"}`).
3. A duplicate sweep (`launch.runDuplicateSweep`) of Series pairs whose
   normalized titles collide. Each pair is marked Distinct or merged. ANN
   adds a pair to the same list when disjoint ISBNs kept it from linking a
   Series of its entry's title ([imports](imports.md#matching-ladder)).
4. No systemic error pattern. Fix a failed sample's error class
   pipeline-wide, then redraw. There is no numeric threshold.

The launch checklist (`launch.launchChecklist`) also wants the calendar
populated, the five v1 sources enabled and healthy, the correction loop
exercised once for real (a reader's report, fixed, then attested with
`launch.attestCorrectionLoop`), and `/about-the-data` live. Then turn
Bootstrap Mode off for good with `importSources.setBootstrapMode
{"on":false}` and work down `imports.bootstrapBacklog` after launch.

## After deploying a change

Scheduled jobs pick up most changes within six hours. Run these to apply
a change now, or where nothing scheduled will.

| You changed | Then run |
|---|---|
| The shape of `seriesStats` or `seriesStatsPacks`, including rating fields on library rows | `npx convex run seriesBrowse:rebuild`. Until packs exist, filtered views read every row. |
| The search nickname rule (`seriesSearchText`) | `npx convex run seriesBrowse:rebuild` |
| The Publishers board's shape | Bump `BOARD_VERSION` in `convex/publisher.ts`, then `npx convex run publisher:rebuildBoards` |
| Publisher rows, aliases, imprints or `adultOnly` in `convex/lib/publishers.ts` | `npx convex run launch:seedPublishers '{}'` |
| Mature-title rules, including `BOOK_PAGE_VERSION` in `convex/lib/sevenSeas.ts` | The steps in [Mature evidence after a deploy](#mature-evidence-after-a-deploy). |
| Author credit rules (`convex/people.ts`) | `npx convex run people:rebuild` |
| A new authority column in the registry defaults | `npx convex run importSources:backfillFieldAuthority '{}'` |
| New registry rows | `npx convex run importSources:seedRegistry '{}'`. It adds missing rows only. |
| Description import (ANN pages, Open Library) | `npx convex run ann:backfillDescriptions '{"limit": 300}'` until done, then `npx convex run openLibrary:replayDescriptions '{"limit": 500}'` |
| The ANN description cleaner (`cleanAnnDescription`) | `npx convex run ann:repairDescriptions '{}'`. No fetches; safe to rerun. |
| The Open Library description cleaner (`cleanOlDescription`) | `npx convex run openLibrary:repairDescriptions '{}'`. No fetches. |
| The Held Books list, first deploy | `npx convex run imports:backfillHolds '{}'`. No fetches, no canonical writes; safe to rerun. A failed page ends the chain: rerun it, and it starts from the top. |
| Volume Progress without a stored Series, first deploy | `npx convex run reading:unsetProgressSeries '{}'`. Clears `seriesId` on older `volumeProgress` rows, a page at a time; safe beside live reading and safe to rerun. A failed page ends the chain: rerun it. It is done when the log shows `[reading.unsetProgressSeries] done: N rows cleared`, or a rerun logs 0; what `npx convex run` prints counts only the first page. This deploy is one-way: once a row without `seriesId` exists, redeploying the earlier code fails schema validation. Then the field and its two indexes can be dropped; an export taken before the migration ran still holds the field and fails schema validation if imported after that ([known issues](known-issues.md#personal-data-and-tracking)). |
| Any importer | Before deploying, not after: let running imports finish, or disable the sources and wait until no run is `running`. Required ([imports](imports.md#steady-state), "Deploying import code"). |
| `FEATURES` in `convex/lib/features.ts` | Deploy both Convex and the Worker; both read the constant. |

`seriesBrowse:rebuild` and `people:rebuild` return after their first
action and finish in scheduled continuations; `publisher:rebuildBoards`
runs in one action.

`npx convex run` waits about five minutes for an action. One that runs
longer keeps running on the deployment, but the command prints
`✖ Failed to run function "…": Error` with no message and exits 1. Seen
on staging on 2026-10-04 with `openLibrary:sync`, five minutes after it
started, while its Import Run kept counting records. Do not rerun on
that message alone: look at the Import Run on `/mod/imports`,
or at the deployment's scheduled functions and logs, to see whether the
job is still going.

### Mature evidence after a deploy

For a change to what makes a Series mature: the adult-only list
(`adultOnly` in `convex/lib/publishers.ts`, Steamship among them), which
an observation's imprint is also read against, or the Seven Seas
book-page parser (`BOOK_PAGE_VERSION` in `convex/lib/sevenSeas.ts`). It
is an importer change, so let running imports finish, or disable the
sources, before deploying (the "Any importer" row above). New imports
apply it at once from then on. For what the catalog already holds:

1. Mark the adult-only rows: `npx convex run launch:seedPublishers '{}'`.
   An existing row is listed in `markedAdultOnly` (`["steamship"]`); a
   missing one is created already marked and listed in `created`. A rerun
   lists neither. The hourly import tick runs the same seed, so this only
   saves waiting for it. The seed alone changes no Series.
2. Only where Seven Seas observations exist: re-read the Seven Seas book
   pages stored under an older parser. Production has none (its listing
   answers the importer with HTTP 403, and the source is disabled; see
   [known issues](known-issues.md#catalog-and-imports)), so skip this step
   there, and wherever the source is disabled or blocked. Every sync does
   this within its detail budget, after the books ahead of them in the
   listing (newest-modified first). At the daily run's 200 pages, N books
   read before take about N / 200 runs. To finish sooner, repeat
   `npx convex run sevenSeas:sync '{"maxDetailFetches":1000}'`. That call
   may be ended at Convex's 30-minute action limit: it is one action with
   no time bound, and if each of its 6,500 or so listing mutations and
   1,000 applies took 0.17 s, as an Open Library line did on staging,
   they would take about 21 minutes, and the 0.35 s wait before each of
   1,000 page fetches and up to 1,000 covers about 12 more, before any
   fetch latency ([known issues](known-issues.md#catalog-and-imports)).
   An action ended there leaves its run `running` until the hourly tick
   closes it as stranded; the pages it re-read stay re-read, so repeating
   the call still finishes the backlog. While the backlog lasts, runs
   whose budget runs out withdraw nothing. A re-read page that rates its book Mature or names an
   adult-only imprint makes the Series mature at once; its library row and
   pack entry follow in a scheduled job (`seriesBrowse:projectMature`), and
   the next rebuild sets them if that job failed.

   `"completeSweep": true` does not mean the re-read finished. It means
   the run's budget reached every page waiting for one; a page that could
   not be read keeps its old snapshot, and every later run reads it again,
   at one unit of the budget each time. A page that answers 404 is a
   notice in the run's errors and the run still succeeds; a page without
   its metadata block is an error and fails the run; a page that now reads
   as prose is skipped with no error at all. The re-read is done when no
   stored Seven Seas book snapshot lacks the current `parserVersion` apart
   from such pages. To see that from the runs: two successive runs that
   print `"completeSweep": true` name the same `book <slug>: …` entries in
   their errors (`/mod/imports`, or the `importRuns` row) and nothing else.
   Those pages stay as they are until the site fixes or delists them; a
   delisted book is withdrawn by the next complete sweep.
3. Rebuild: `npx convex run seriesBrowse:rebuild`. This is the step that
   fixes the books PRH files. In the 2026-10-02 production export, 45
   active Series had an adult-only imprint signal and no `mature` flag:
   35 with Editions under the `steamship` row, made mature by the seed's
   mark, and 10 filed under `seven-seas` (nine Ghost Ship, one Steamship)
   whose only sign is the imprint on a linked PRH title, made mature by
   the imprint rule. The rebuild also clears Series whose evidence went
   away. Then `npx convex run publisher:rebuildBoards` (the Publishers
   board) and `npx convex run people:rebuild` (the authors directory). The
   sitemaps follow within their six-hour edge cache.

A Series that is still not mature after these steps has no evidence the
catalog can see: no linked observation rates it 18+ or names an adult-only
imprint, and none of its Editions is under an adult-only Publisher row.
Some routes cannot rate a book by themselves
([known issues](known-issues.md#catalog-and-imports)). A Data Team rating
settles it at once: `contentRating` "mature" on the Series. A Data Team
`general` rating does the opposite: the Series stays non-mature whatever
evidence it has, so check `contentRating` first on a Series that has
evidence and is still listed.

## After deploying the 2026-10 known-issues round

The steps this round's changes need, in order. Each is explained where it
links to.

1. Before deploying: let running imports finish, or disable the sources
   and wait until no run is `running`. The round changes import code
   (the "Any importer" row in [After deploying a change](#after-deploying-a-change)).
   Before disabling any, write down which sources are enabled:
   `npx convex run imports:enabledSources '{}'` lists their keys. Disable
   each with
   `npx convex run importSources:setEnabledInternal '{"key":"…","enabled":false}'`.
2. After deploying, before any sync: enable again exactly the sources
   step 1 disabled, one command per key it wrote down:
   `npx convex run importSources:setEnabledInternal '{"key":"…","enabled":true}'`.
   A source that was disabled before step 1 stays disabled. A sync of a
   disabled source returns `{"skipped": "disabled"}` and does nothing, so
   without this step steps 4 and 8 do nothing. Skip it if step 1 let the
   runs finish instead.
3. Mark the adult-only Publisher rows (Steamship):
   `npx convex run launch:seedPublishers '{}'`. Safe to rerun; a rerun
   reports nothing new. Step 1 of
   [Mature evidence after a deploy](#mature-evidence-after-a-deploy).
4. Only where Seven Seas observations exist (not production): let the
   syncs re-read book pages stored under an older parser, or repeat
   `npx convex run sevenSeas:sync '{"maxDetailFetches":1000}'` until done.
   Each call runs in one action. The command stops waiting after about
   five minutes and prints an error while the action goes on (see
   [After deploying a change](#after-deploying-a-change)); the call has
   finished when its Import Run is no longer `running`, unless the action
   is ended at the 30-minute limit first. Safe to rerun. Step 2
   of the same section says why it can be, and how to tell the re-read is
   done.
5. Rebuild the library: `npx convex run seriesBrowse:rebuild`. It sets
   the mature flags from the evidence (step 3 of the same section) and
   writes each Series card's list of jacket ISBNs (`coverIsbns`); a row
   not yet rebuilt shows its one stored jacket. The command returns after
   its first action, about three minutes, and prints only that action's
   result. A result with `continuedAfter` means rows remain and a
   continuation is scheduled; the rebuild has finished only when an action
   returns `swept`, `blocks` and `counts` instead, after it has also
   swept stale cards and rewritten the packs. Wait until the Convex
   dashboard's scheduled functions (under Schedules) show no
   `seriesBrowse:rebuild` pending or in progress, and its logs show no
   failed one; a failure ends the chain, and running the command again
   starts over. Only then run `npx convex run publisher:rebuildBoards`
   and `npx convex run people:rebuild`. Both read the Series cards the
   library rebuild writes, so either run before it has finished keeps the
   old card facts until its next six-hourly run. `publisher:rebuildBoards`
   runs in one action and has finished when it returns. `people:rebuild`
   continues like the library rebuild: its result says
   `"continued": true` while phases remain, and the last action returns
   `"continued": false`; wait for its scheduled functions the same way.
   All three are safe to rerun, and the six-hourly jobs run them anyway.
6. Fill the Held Books list: `npx convex run imports:backfillHolds '{}'`.
   It continues itself page by page; the command prints only the first
   page's result, with `"done": false` when a continuation is needed, and
   the backfill has finished when the log shows
   `[imports.backfillHolds] done: …`. Safe to rerun; a failed page
   ends the chain, and a rerun starts from the top
   ([Held books](imports.md#held-books)). It reads every observation, ten
   to a page, so it takes hours: on staging's 130,000 observations it ran
   between 170 and 870 observations a minute, slowest through unlinked
   Open Library editions. The list fills as it goes.
7. Clear the stored Series on read counts:
   `npx convex run reading:unsetProgressSeries '{}'`. Safe to rerun, and
   done when the log shows `[reading.unsetProgressSeries] done: N rows
   cleared` or a rerun logs 0. The deploy before it is one-way (the
   "Volume Progress without a stored Series" row in
   [After deploying a change](#after-deploying-a-change), and
   [known issues](known-issues.md#personal-data-and-tracking)).
8. Open Library needs no step of its own. Every sync parses each dump line
   with the current title parser and places an unlinked edition afresh,
   so an edition stored under an older parse (a "Vagabond Definitive
   Edition" read before that line was recognised) is placed or held under
   today's reading on the next sync: the monthly run, or
   `npx convex run openLibrary:sync '{}'`, which continues itself under
   one Import Run and has finished when that run is no longer `running`
   (`/mod/imports`). The command itself prints an error after about five
   minutes while the run goes on (see
   [After deploying a change](#after-deploying-a-change)). How long it
   takes is known only roughly: on staging, 57,766 editions in about two
   hours on 2026-09-27, and about 1,000 dump lines every 2.8 minutes on
   2026-10-04 with the Held Books backfill and a Yen Press sync running
   beside it. The run is a chain of links, each handing off at the first
   line it reaches after ten minutes; a stalled read or a slow download
   can keep one going longer ([Open Library](imports.md#open-library)).
   No run with ten-minute links has yet been seen to finish on staging. A linked edition is reconciled again only when
   today's parse changes its snapshot. Safe to rerun; each run downloads
   the dump ([Open Library](imports.md#open-library)). The backfill in
   step 6 reads stored snapshots, so it classifies such an edition by its
   older parse until that sync. A sync never revisits an edition today's
   parser drops or one no longer in the hosted dump, so a hold on such an
   edition stays ([known issues](known-issues.md#catalog-and-imports)).

## Recording decided other printings

No importer records an Other Printing: ANN's page pass and Open Library
hold such a book under `isbn` ([imports](imports.md#other-printings)).
For a held book that a Data Team member, or an agent whose decision a
reviewer checked, has judged another printing of a Release, the operator
records it:

```sh
npx convex run printings:recordDecidedInternal '{"observationId": "<held record>",
  "releaseId": "<Release it is a printing of>",
  "reason": "VIZ 2002 first printing of vol 1; same contents as the 2007 Release",
  "evidenceUrl": "https://…"}'
```

It is for decisions made one book at a time with their evidence, never
for a bulk guess. It writes the `releaseIsbns` row, the record's link and
`printingIsbn13` mark (which take it off the Held Books list), and an
approved Proposal with an `otherPrinting` Revision on the Release that
carries the reason and cites `evidenceUrl`. The URL is trimmed and must be
an absolute `http(s)` URL; nothing fetches it. An `evidenceUrl` left out,
empty or blank falls back to the record's own URL, which must pass the
same test. A given `evidenceUrl` that fails it is refused, never replaced.
The `observationId` is the held record's (`/mod/imports` shows the source
record; its observation is the one the hold row names), and the
`releaseId` the Release whose slot it is held for.

It does not judge whether two books are the same; the person deciding
does. It checks what the records state and who owns the ISBN, and answers
`{"status": "refused", "reason": "…"}` instead of throwing when a check
fails, so a script can log it and go on. The whole decision runs as a
nested mutation capped at what its transaction has left
(`lib/bounded.ts`): one that would pass any transaction limit (claims too
large to read whole, say) is refused the same way, its writes undone,
with nothing recorded and the book still held. The checks run in this
order:

- the reason is not empty;
- the record is not withdrawn or already linked, and does not call the
  book digital (its format, Binding, ANN designator or title);
- every ISBN the record states (an ANN line's page first, ISBN-13s before
  ISBN-10s, any spelling) is valid and names the same book;
- the citation URL above is usable;
- the Release is active, unlocked and physical;
- the Release's Series, each followed through its merges (at most 8, no
  cycle, no merge into nothing), are all active: a hidden Series, or one
  whose merges end nowhere, has no printings decided for it;
- the book is held under one of those Series, followed the same way;
- the publisher the record names is the Release's, followed through
  merges. The name is ANN's distributor, the first name in Open Library's
  list that resolves, the PRH or Yen Press imprint, or Seven Seas for its
  own feed. A name that resolves to no publisher row is refused. Kodansha's
  records name none, since its feed also lists Vertical's books;
- the contents. The record must read as one Volume of a work titled as one
  of the Release's Series (case and spacing aside: "Citrus+" is not
  "Citrus"). Every statement is read on its own: an ANN line's title, its
  page's designator re-read with today's parser, the page's own title
  (its "Vol. 1" or its "(GN 1)"), its manga entry, and the stored flags.
  Every Volume any of them states must be the same one ("01" is "1");
  statements that disagree, or a designator that no longer reads, are
  refused. ANN numbers every book it lists, so an ANN record that states
  no Volume anywhere is refused as unknown; another source's record
  stating none is left to the person deciding, as before. A Volume the
  importer stored that the kept title does not state (Open Library's
  subtitle "Vol. 1" under the title "Vagabond") stands, and is checked
  like any other. A retained Open Library subtitle is read separately for
  explicit Volume, Binding, format, packaging and scope facts; every fact
  must agree with the main title, stored fields and target. Main-title
  precedence cannot erase a subtitle counterfact. The decision reader also
  reads later technical clauses in joined or main titles, including
  includes/collects/contains statements and repeated Volume designations.
  Distinct contents, conflicting labels and explicit unreadable Volume
  statements refuse on the single-Volume path. Once an explicit contents list
  begins, an unresolved continuation stays unreadable; a parsed prefix cannot
  certify one complete Volume. Opening, closing and nested wrappers retain that
  scope, as do intervening format annotations. Their payload numbers describe
  format, not canonical contents. A connected component after the annotation
  must still be read or refused as incomplete. A connector or range before
  the annotation remains pending until its contents component is read. A
  separate prose clause may end
  the contents scope; punctuation inside an annotation does not. A singular
  Volume designation also survives an intervening format annotation: a later
  list connector establishes a contents expectation for Arabic, Roman and word
  labels, or unresolved components. Remembering the designation alone does not
  make unconnected display prose a contents list. Ranges remain packaging even with equal endpoints;
  repeated normalized equal list labels remain equal. Technical clauses start at
  punctuation/wrappers or another designation; ordinary display prose and
  words inside the authentic work name are not format facts. Subtitle prose
  alone does not change work identity; a joined work name stays in the producer's
  title. Legacy snapshots with a lost subtitle supply no invented facts. A
  title ending in a number with no "Vol." ("Kingdom Hearts II") is
  refused, since the number may be the work's own, and so is anything a
  source files as a novel, as another language, or out of scope (a Seven
  Seas or Yen Press category, a stored `outOfScope`). A Binding the record
  states plainly, including hardback/hardbound and softcover/back/bound,
  in a dedicated field, an independent clause or a format tag ending its
  title ("Vagabond, Vol. 1 (Hardcover)"), that is not the Release's is refused: another Binding is another Release. Statements
  that disagree are refused as unreadable, including opposite tokens in one
  field or clause. Retained raw physical-format text is checked beside its
  normalized Binding. Explicit digital format clauses, including Digital
  Download/Edition/Version, ebook and Kindle, refuse against a physical
  target. Insignificant whitespace before clause punctuation or wrappers cannot
  erase a known Binding or Digital fact. Numbered format payloads retain the
  format without certifying a Volume, including Roman numerals and unreadable
  explicit technical designators; a following explicit Volume marker remains
  independent evidence. Known format clauses use the same separator rules as
  contents clauses, so a slash, ampersand or plus cannot hide the next known
  format. An equal earlier format cannot erase a later contradiction.
  Bare numbered format payloads still supply no canonical Volume contents.
  This reader handles technical clauses, not arbitrary prose embedded in GN/#
  payloads. Unusual source wording still needs bibliographic review; the parser
  is not a certificate that two books have the same contents.
  Decision normalization does not rewrite saved raw source
  fields. Conflicting known target Bindings also refuse. A Binding either
  side leaves unstated is left to the person deciding. Anything that reads as
  packaging is refused for now: a multi-Volume designator or stored range,
  a line name or packaging word in the title, or any bracketed part ("[1st
  Ed]"). The Release's Edition must collect exactly one whole Volume (a
  line member with one Volume counts), active, whose own Series, followed
  through merges, is one of the Release's Series by ID: a Series merely
  titled the same is another work. A Volume the record states must be
  that one;
- ownership, every claim on the ISBN read whole (`lib/releaseIsbns.ts`
  `isbnClaims`: Releases' ISBN-13 and ISBN-10, printing rows, and Release
  Bundles' ISBNs, merges followed, hidden records included). The ISBN may
  not be the Release's own, as its ISBN-13 or ISBN-10 or as the ISBN of a
  Release merged into it: a record of its own printing is linked, not
  recorded, and this comes first even when a row from before a promotion
  also holds the ISBN. No other Release, active or hidden, and no Bundle
  may claim it, and every claim must be readable (at most 20 of each kind)
  and its merges followable (no missing record, no merge with no
  survivor, no cycle, at most 8 merges).

A refusal writes nothing. A new printing answers
`{"status": "recorded", "isbn13": "…"}`. A further record of a printing
the Release already has answers `{"status": "linked", "isbn13": "…",
"releaseId": "…", "proposalId": "…"}`: the record is linked and marked and
its hold goes, with an approved Proposal and a `sourceObservation`
Revision on the Release of its own, and no second row. Nothing takes either
back yet ([known issues](known-issues.md#catalog-and-imports)), so record
only what the evidence settles. The shared writes (`lib/printings.ts`
`recordPrinting` and `linkRecordedPrinting`) throw a `conflict` before they
write or link anything when the row already exists, or when there is no
row of this Release to link to.

With the fixed ANN line reader of PR #66 (`lib/ann.ts` `readAnnLineTitle`,
`lib/matching.ts` `sameWorkTitle`), `printings.ts` `readAnnLine` is the one
place to swap it in, so packaged printings can be compared by line,
position and coverage instead of refused.

### Checking printing consistency

`printings:consistencyInternal` reads the whole catalog's printing claims,
read-only, one native page at a time. Run all four passes from a `null`
cursor to the end, passing each answer's `continueCursor` back, the two
key passes first:

```sh
npx convex run printings:consistencyInternal \
  '{"pass": "releases", "paginationOpts": {"numItems": 100, "cursor": null}}'
npx convex run printings:consistencyInternal \
  '{"pass": "bundles", "paginationOpts": {"numItems": 100, "cursor": null}}'
npx convex run printings:consistencyInternal \
  '{"pass": "rows", "paginationOpts": {"numItems": 100, "cursor": null}}'
npx convex run printings:consistencyInternal \
  '{"pass": "observations", "paginationOpts": {"numItems": 100, "cursor": null}}'
```

Every ownership check, here and in every writer, reads exact keys: a
Release's or Bundle's `isbn13` as the ISBN-13's digits, its `isbn10` as
the ISBN-10's (an upper-case X), a row's `isbn13` as the ISBN-13's. A
claim stored in any other spelling (hyphens, spaces, a lower-case x, an
ISBN-10 kept as `isbn13`) is invisible to them. Every writer stores that
one spelling (the importers' parsers, Proposals, the data repair's
`updateFields`, `createRelease` and Bundle conversions, `lib/isbn.ts`
`isbnFieldValue`, and a Split restoring a removed row), but older rows
may not. A Bundle conversion keeps a box Release's text that is no valid
ISBN as it was; a valid 979 ISBN kept as its `isbn10` becomes the
Bundle's ISBN-13 when that field is free, and is refused beside another
`isbn13` (as are two valid ISBNs naming different books), so a person
corrects the Release first. The `releases` and `bundles`
passes find every such stored ISBN; the `rows` pass finds rows stored so.
Until those report none, or each is corrected (a Release by a repair
`updateFields` entry, a Bundle by a Proposal; a row by hand, since no
audited operation corrects one yet), what the other passes find, and
what a decision or a Split concludes about those ISBNs, is not complete:
do not record printings or replay data on the strength of it.

A page inspects 1 to 100 items (`numItems`). `paginationOpts` goes to the
native page whole: `maximumRowsRead` works as in any native page, and
`maximumBytesRead` may be at most 4 MiB, and is 4 MiB when left out, so
the page itself never spends the transaction its checks need. A page of
large records stops early (`scanned` below `numItems`, `isDone` false)
and its cursor goes on. Each answer has `findings`, `scanned`,
`inspected`, `isDone` and `continueCursor`. A finding's `severity` is:

- `violation`: an ISBN with a printing row has more than one owner, a
  Bundle owner, a claim whose merges cannot be followed, or a non-physical
  owner (a row counts as a claim whatever its spelling); a stored ISBN is
  spelled so no exact read finds it; or a marked record's mark is no ISBN,
  its link cannot be followed, or the one owner of its mark is not the
  Release it links (merges followed: a link to a Release merged into the
  owner is fine);
- `incomplete`: an ISBN had more claims than one read takes, or an item's
  checks could not be afforded: each check reads one document at a time
  while the transaction can still read the largest, and the item it ran
  out on and every item after it on the page are reported by ID (check
  that page again with fewer items);
- `diagnostic`: history, not corruption. A row's evidence record is gone,
  unlinked, or now links another Release; a mark is on an unlinked record,
  or nobody claims its ISBN any more.

The catalog is checked only when all four passes reach `isDone` with no
`incomplete` finding, and clean when there is also no `violation`. It
checks ownership and evidence, never whether two books are the same.

## Reading Server-Timing

App pages and server-function calls answer with a `Server-Timing` header
(`src/server/timing.ts`). It holds span names, fixed outcome words and
integers only:

```
curl -s -o /dev/null -D - https://mangadb-staging.mangadb.workers.dev/ | grep -i server-timing
```

| Span | What it covers |
|---|---|
| `app` | The Start handler, from the call until it returns its Response. Time before the Worker runs our code, the rest of a streaming body, and transfer are not in it. |
| `auth` | Clerk's middleware, until it hands the request on. Absent when Clerk is not configured or answered with a handshake redirect. |
| `cat` | The home page's catalog reads, on a server render. |
| `cov` | The home jacket check: `complete`, `failed` (every read answered, one or more by throwing), `partial` (its 300 ms budget ran out with reads still out or unsent), or `unbound` (no bucket). It ends when the check answers; reads still out then, and its warm-ups, run after it. |
| `covr2` | R2 heads that check sent; 0 when the isolate's memo answered. An ISBN on two shelves is one head. |

A Worker's clock moves only across I/O, so spans are elapsed times as
that clock saw them; CPU time between I/O is not reliably in or out of
them. Render CPU is in Workers Observability. A
slow first byte with a short `app` was spent outside the measured
handler: before it (platform dispatch, a cold isolate) or in transfer.
Cloudflare may add its own entries (`cfL4`, `cfExtPri`) to the header.

### Checking the jacket budget in workerd

`npm test` checks the jacket check's logic under fake timers. Whether
reads still out at the budget survive the response, as `waitUntil` should
make them, only a real Worker runtime shows. `scripts/check-cover-budget.mjs`
runs both the helper and the compiled app in a local workerd, with a
stand-in R2 whose reads answer late on purpose:

```
VITE_CONVEX_URL=https://convex.invalid npm run build
node scripts/check-cover-budget.mjs --root "$PWD" --dist "$PWD/dist"
```

It is not part of `npm test` or CI: it starts workerd and takes about
15 s. It sends nothing off the machine, refuses to run on a `dist` built
for a real Convex deployment, and stops with an error if Miniflare,
esbuild or workerd is missing from `node_modules`. Its stand-in R2 proves
request lifetimes, not R2's latency. Run `npm run build` again afterwards
for a deployable `dist`.

## Account deletion

A user's request (`users.deleteAccount`) sets `deletingSince` on their
`users` row and schedules the rest, in this order, with no operator:

1. `users:purgeUser` deletes their personal rows one at a time, and each
   run stops after 200 or once less than 5 MiB of its 16 MiB read or write
   budget is left, as `ctx.meta.getTransactionMetrics()` reports it. A
   Series Rating whose rank moves is the largest step: it reads the
   Series' library row and its library pack twice each and rewrites both,
   and each may reach 1 MiB. Library rows are a few KB; with today's packs
   (about 380 KB) a run fits about 15 such Ratings, 6 at a 1 MiB pack, and
   3 if the library row is at 1 MiB too. The run that reads every table to
   its end sets `purgedAt` and schedules the next two.
2. `users:redactMergeManifests` drops their rows from merge manifests.
3. `users:deleteClerkIdentity` deletes the Clerk sign-in, retrying five
   times over about seven hours. Once Clerk confirms (a 404 counts), it
   schedules `users:removePurgedUser` 24 hours later, which deletes the
   `users` row and frees the username.

Until the row goes, the identity cannot use the account or claim a new
username. Before Clerk confirms it can still sign in to Clerk; after, a
Convex token issued before the deletion stays valid until it expires (its
lifetime is set on the `convex` JWT template in Clerk), which is what the
24 hours cover. The username stays reserved for that day. A template
lifetime longer than a day would outlast it.

Two states need an operator:

- `deletingSince` set, `purgedAt` unset, for more than a few minutes: a
  purge that stopped. Find the error in the logs, then restart it:
  `npx convex run users:purgeUser '{"userId":"…"}'`. It only acts on a row
  marked deleting and not yet purged, so a rerun is safe.
- `deletingSince` and `purgedAt` both set for more than a day and a half
  (about seven hours of retries plus the day's grace): the Clerk deletion
  or the row removal did not finish. One sign is the log line "Gave up
  deleting Clerk identity" (Clerk refused every attempt), but a scheduled
  action runs at most once, so one that died mid-run (after Clerk
  succeeded but before scheduling the removal, say), or a removal that
  failed, leaves the row this way with no such line. The
  row holds nothing but itself. Once Clerk is reachable (or after deleting
  the user in the Clerk dashboard), run:
  `npx convex run users:deleteClerkIdentity '{"clerkSubject":"…","attempt":0}'`.
  It deletes the identity, treats a 404 as done, schedules the row's
  removal a day later, and retries on its own again if Clerk still fails.
  Before each attempt it checks the subject: unless a `users` row with that
  subject has both `deletingSince` and `purgedAt` set, it logs "Not
  deleting Clerk identity" with the reason and contacts no one. Running it
  for a wrong subject is safe.

A user asking again while their row is marked changes nothing. An identity
with no `users` row (no username claimed) is refused: it can claim a
username and then delete the account, or its sign-in can be deleted in the
Clerk dashboard ([known issues](known-issues.md)).

## Catalog repair tool

A one-time repair of imported catalog data, written after the September
2026 data audit. `convex/repair.ts` holds the internal functions,
`convex/lib/repair/` the entry validators (`entries.ts`), the operations
(`ops.ts`), the audit trail (`audit.ts`) and before-and-after metrics
(`metrics.ts`). `scripts/repair.ts` drives it from a plan file,
`repair-plan.json`, built outside this repo.

```sh
node scripts/repair.ts metrics [label]
node scripts/repair.ts run --plan <repair-plan.json> --stage 3 [--step 3a] [--apply] [--actor ari]
node scripts/repair.ts rebuild            # seriesBrowse:rebuild
```

- `run` is a dry run unless `--apply` is given. A dry run applies each
  entry and rolls it back, so its report is what a real run would do.
- The script refuses any deployment but the local one unless you pass
  `--yes`. Choose another with `--deployment <name|prod>`.
- `run` needs `--plan`; without it the script prints its usage and exits
  before touching any deployment. Run reports go to `runs/` beside the
  plan; metrics, which have no plan, go to `./runs` (gitignored). `--out`
  overrides both.
- Stage 4 needs the plan's packaging research and refuses without it
  unless `--force`.
- `--actor` must be an existing Moderator or Administrator. Each entry that
  writes becomes an approved Proposal by that user, with a public Revision
  per changed record. Personal rows it moves are logged in `repairTrails`.
- Each entry names the state it expects. Drift is skipped and reported,
  never overwritten. An entry with more work than one transaction reports
  `partial`, and the script calls it again until done.
- Entry kinds (`entries.ts` is the reference): `publisherMerge`,
  `publisherParent`, `editionPublisher`, `hideSeries`, `hideRelease`,
  `restoreRecord`, `unlinkObservation`, `withdrawProposal`, `mergeSeries`,
  `remodelEdition`, `setCoverage`, `foldEdition`, `releaseBundle`,
  `updateFields`, `normalizeVolumes`, `splitSeries`, `hideEditionLine`,
  `createRelease`.

`npx convex run repair:metrics` prints the metrics without the script.

## Guarded held-book repairs

Use the explicitly selected deployment and its current full backup, including
file storage. The held-book inventory is an offline research queue. Its 3,846
observations and 3,396 groups describe the October 2026 snapshot, not a count of
executable repairs. Publisher-family acceptance remains deferred. Every
observation needs its own current preview, reviewed disposition and result;
siblings in one ISBN group can need different sequential operations.

`heldBooks:previewInternal` accepts `{observationId, target?, reviewed?, replay?}`.
A target is `{type:"release", id}` or `{type:"bundle", id}`. A reviewed identity
names the exact `isbn13`, canonical `seriesId`, `publisherId`, complete ordered
`volumeIds` and `evidenceUrls`. Optional `sourceTitle` retains an explicitly
reviewed package/work correspondence. It cannot replace missing or contradictory
contents. `umbrellaRouting:{sourceTitle, productTitle, productVolumeLabel}` is a
per-observation ANN routing proof: the current parent must actually list that
exact ISBN/title and multiple distinct Parts, and the product must read as the
reviewed canonical Part and Volume. It never relinks the generic ANN parent.

Keep the returned `expected` string intact. `heldBooks:executeInternal` takes the
same preview arguments plus `actor`, `operation`, `expected`, `reason` and
`evidenceUrls`; `reviewSeries` also takes `seriesId`. Operations are:

- `refreshSource`: dispose of a linked, withdrawn, source-review or exact-scope
  hold, or fill source-derived Series context while retaining its original age.
  An unresolved OL skip/review and a member's placement review stay held.
- `reviewSeries`: change only this hold's routing from reviewed identity evidence.
  A conflicting source parent needs the supported explicit routing proof.
- `link`: attach this source to the exact Release or Bundle. All contents, work,
  extent, format, publisher, current claims and statuses must agree. A Line
  covering one complete canonical Volume can be a single book. An empty Bundle
  always blocks. Links change no canonical contents or Bundle memberships.
- `refreshAnn`: re-read the stored ANN page/title with the accepted shared
  readers. Contradictory ranges, gaps, positions and unreadable inputs refuse.
  Changes preserve source freshness and withdrawal facts; equality writes nothing.
- `replay`: use `replay:true` in both preview and execution. This pins the bounded
  current Volume/Edition/Line/sibling slots and bootstrap mode. Only a stored OL
  free-slot creation or an ANN observation without an existing ISBN owner uses
  its actual placement adapter. It never substitutes an old source snapshot or
  records a fake source sighting. Other adapters require their specific reviewed
  placement route.

Execute one observation per call. A refusal means preview again and review the
changed fact; do not retry the old expected string. The whole mutation runs in a
capped subtransaction, including incidental adapter, projection and audit writes.
Joins stop at 80 rows, merge resolution at eight hops, and expected guards at
256 KiB; byte/query/document/write/scheduling headroom can refuse earlier. Large
or incomplete cases need a separately reviewed operation. The existing printing
APIs keep their old validators, but an old held-link guard without the current
context needs a fresh `printings:linkHeldStateInternal` preview.

`scope:stateInternal({isbn})` returns complete bounded history and `expected`.
`scope:decideInternal({actor,isbn13,reason,evidenceUrls,expected})` creates a durable
exact-ISBN decision. Reasons are `novel`, `merchandise`, `sampler`, `nonEnglish`,
`childrensBook` (picture/board books, not children's manga) and `audio`.
`scope:revokeInternal({actor,decisionId,reason,expected})` retains the original
approved evidence and records revocation. Preview before either operation, even
an identical repeat. A scope decision stops new source/manual/Proposal/repair
placement; it does not silently hide or unlink already linked catalog records.

For a proved canonical prose Release, use
`heldRepair:scopedReleaseStateInternal({releaseId})`, then
`heldRepair:hideScopedReleaseInternal({actor,releaseId,expected,reason,evidenceUrls})`.
This requires an approved exact-ISBN scope decision and complete exclusive claims.
It refuses Release-specific tracking, variant pins, aliases and Bundle membership.
It hides only that Release and retains its Edition, canonical manga Volumes,
Series and historical source reference IDs. It leaves Edition/Volume/Series
personal identities and their dependent histories intact. This is the narrow
route for the confirmed Grimgar novel ISBNs, subject to fresh per-Release guards.
A hidden Release needs a separate reviewed restoration after scope revocation.

`heldRepair:referenceAuditInternal({releaseId,bundleId?})` returns counts and
completeness, never private rows. The bounded audit includes Release/Edition/
Volume/Bundle aliases, variants, collection entries, progress, ratings and
aggregates, favorites, reviews, comments and Series state. Review/comment
moderation history, reports, lists and shares retain their existing parent/user
identities in supported operations. Unsupported references or incomplete joins
block conversion; a historical count-only backup audit cannot approve a later call.

For an existing box collision, preview
`heldRepair:conversionStateInternal({releaseId,bundleId})`, then call
`heldRepair:convertInternal({actor,releaseId,bundleId,expected,reason,evidenceUrls})`.
The guard checks exact ordered complete members and current identity, scope,
locks, claims, revisions and personal-reference counts. Conversion carries
supported collection ownership with its privacy rules and records immutable
Proposal/Revision provenance. An audited already-converted repeat writes nothing.
Source references on the hidden box and retained placeholder Volumes are explicit
outcomes, not automatically retired or relinked.

Correct a proved format error/member replacement first with
`heldRepair:bundleContentsStateInternal({bundleId,memberIds,corrections})`, then
`heldRepair:repairBundleContentsInternal` with those arguments plus the common
actor/expected/reason/evidence fields. Each correction names
`{releaseId,from:"physical"|"digital",to:"physical"|"digital"}`. It preserves Release
and content identities and replaces the full ordered member set. Bundle owners,
variant-dependent corrections, unknown contents and mismatched publishers or
formats block. This supports the proved Attack on Titan Volume 6 eBook correction
and replacement with the existing proper paperback; it supplies no invented
members for the empty Season 3 Part 2 Bundle.

The ordinary `repair:runBatch` `createRelease` route can create researched binding
or digital siblings on existing complete Volumes. `remodelEdition` retains live
`targetSeriesId`/`volumeId` fields and adds optional `groups[].into` with an exact
existing `editionId`, `editionLineId` and `linePosition`. That move requires an
active unlocked empty unmapped target of the same canonical work and publisher;
it leaves source coverage and Series identity intact. There is no top-level
`into` field.

`heldBooks:isbnNamespaceAuditInternal({paginationOpts})` keeps native cursor
semantics and accepts at most 20 roots, with a root-byte cap of 4 MiB or smaller.
Inspect every incomplete/uninspected root before treating a pass as complete.
Run all namespace/printing consistency checks selected by the deployment review;
an offline snapshot certificate is not a live certificate.

Successful held operations record full source/hold before/after metadata and an
approved Proposal in `heldRepairLedger`. Replay records actual new IDs separately
from shared/preexisting Edition/Volume/Line/coverage structure.
`heldBooks:restoreInternal({actor,ledgerId,expectedAfter,reason})` only restores
metadata while the source/hold still equals its recorded after-state. It preserves
hold age/reason and Proposal references; a deleted hold receives a new database
ID, with the original ID returned as provenance. Revoke scope before requeueing.
Maturity already supported by source evidence is not demoted. Replay, printing,
conversion and canonical hiding are not inverted by this API or by blindly hiding
new records: recovery needs the full backup and a reviewed restoration procedure
that accounts for later uses, shared structure and projections.

Initialize the offline disposition ledger without executing or overwriting data:

```sh
node scripts/held-dispositions.mjs report-data.json new-disposition-ledger.json
```

The script retains every group, observation, diagnostic, alias/holder and research
action, checks exact one-time membership, and initializes all dispositions pending.
Record reviewed operation dependencies, fresh guards, actual results and audit IDs
per observation. A group becomes terminal only after all its observations have an
explicit disposition. Count writes, cleared holds and ownership transfers separately.
Citations must be trimmed absolute HTTP(S) URLs with hosts; accepted URL syntax
alone proves neither scope nor contents.
