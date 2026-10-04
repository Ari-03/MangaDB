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

`seriesBrowse:rebuild`, `publisher:rebuildBoards` and `people:rebuild`
return after their first action and finish in scheduled continuations.

### Mature evidence after a deploy

For a change to what makes a Series mature: the adult-only list
(`adultOnly` in `convex/lib/publishers.ts`, Steamship among them) or the
Seven Seas book-page parser (`BOOK_PAGE_VERSION` in
`convex/lib/sevenSeas.ts`). It is an importer change, so let running
imports finish, or disable the sources, before deploying (the "Any
importer" row above). Then:

1. Mark the adult-only rows: `npx convex run launch:seedPublishers '{}'`.
   An existing row is listed in `markedAdultOnly` (`["steamship"]`); a
   missing one is created already marked and listed in `created`. A rerun
   lists neither. The hourly import tick runs the same seed, so this only
   saves waiting for it.
2. Re-read the Seven Seas book pages stored under an older parser. Every
   sync does this within its detail budget, after the books ahead of them
   in the listing (newest-modified first), and a page read once with the
   current parser is not read again for this reason. At the daily run's
   200 pages, N books read before take about N / 200 runs, a few weeks for
   the whole catalog. To finish sooner, repeat
   `npx convex run sevenSeas:sync '{"maxDetailFetches":1000}'` until it
   prints `"completeSweep": true`; a run whose budget ran out prints
   `false`, and so does one with an invalid listing item, which its errors
   name. At the 350 ms pace 1,000 pages take ten minutes or more, inside
   the 30-minute action limit. While the backlog lasts, runs whose budget
   runs out withdraw nothing. A page that rates its book Mature or
   names an adult-only imprint (Ghost Ship, Steamship) makes the Series
   mature at once, with its library row, so it leaves the home page and the
   library without a rebuild. A Data Team rating on the Series stands.
3. Rebuild the projections that are not updated at once:
   `npx convex run seriesBrowse:rebuild` (Series with an Edition under an
   adult-only Publisher row, such as the Steamship books PRH files under
   Steamship, and Series whose evidence went away), then
   `npx convex run publisher:rebuildBoards` (the Publishers board) and
   `npx convex run people:rebuild` (the authors directory). The sitemaps
   follow within their six-hour edge cache.

A Series that is still not mature after these steps has no linked
evidence: its Seven Seas book may be held or in review rather than linked
to the Release (the Held Books list and the review queue on
`/mod/imports`). A Data Team rating (`contentRating` "mature" on the
Series) settles it at once.

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
