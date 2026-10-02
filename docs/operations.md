# Operations

Commands an operator runs by hand. Against production, add `--prod` to
`npx convex run`, and only with the owner's fresh yes for that action
([AGENTS.md](../AGENTS.md)). Import commands per source are in
[imports.md](imports.md).

## Dev seed

With `npx convex dev` running, load a small hand-written catalog
(`convex/seed.ts`):

```sh
npx convex run seed:run '{}'            # only when the catalog is empty
npx convex run seed:run '{"wipe":true}' # wipe catalog tables and reseed
```

It covers the model's corner cases: a Series Family with a sequel edge,
Volumes whose position and label differ ("3.5"), an Edition Line with an
omnibus covering Volumes 1 to 3, a split digital Edition with partial
coverage, a box-set-exclusive Variant and a Bundle that pins it, plus a
plain Series and a oneshot. A few Releases are dated relative to the day
you seed, so the calendar always has a current month. All facts are fake.
`{"wipe":true}` deletes every catalog table on whatever deployment you
point it at, and nothing stops you running it on a real one.

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
   normalized titles collide. Each pair is marked Distinct or merged.
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
| Mature-title rules | `launch:seedPublishers`, then `seriesBrowse:rebuild` and `publisher:rebuildBoards`. Seven Seas re-reads ratings at about 200 books a run; `npx convex run sevenSeas:sync '{"maxDetailFetches":2000}'` finishes sooner. |
| Author credit rules (`convex/people.ts`) | `npx convex run people:rebuild` |
| A new authority column in the registry defaults | `npx convex run importSources:backfillFieldAuthority '{}'` |
| New registry rows | `npx convex run importSources:seedRegistry '{}'`. It adds missing rows only. |
| Description import (ANN pages, Open Library) | `npx convex run ann:backfillDescriptions '{"limit": 300}'` until done, then `npx convex run openLibrary:replayDescriptions '{"limit": 500}'` |
| Any importer | Before deploying, disable the sources and let running imports finish. |
| `FEATURES` in `convex/lib/features.ts` | Deploy both Convex and the Worker; both read the constant. |

`seriesBrowse:rebuild`, `publisher:rebuildBoards` and `people:rebuild`
return after their first action and finish in scheduled continuations.

## Catalog repair tool

A one-time repair of imported catalog data, written after the September
2026 data audit. `convex/repair.ts` holds the internal functions,
`convex/lib/repair/` the entry validators (`entries.ts`), the operations
(`ops.ts`), the audit trail (`audit.ts`) and before-and-after metrics
(`metrics.ts`). `scripts/repair.ts` drives it from a plan file,
`repair-plan.json`, built outside this repo.

```sh
node scripts/repair.ts metrics [label]
node scripts/repair.ts run --stage 3 [--step 3a] [--apply] [--actor ari]
node scripts/repair.ts rebuild            # seriesBrowse:rebuild
```

- `run` is a dry run unless `--apply` is given. A dry run applies each
  entry and rolls it back, so its report is what a real run would do.
- The script refuses any deployment but the local one unless you pass
  `--yes`. Choose another with `--deployment <name|prod>`.
- `--plan` defaults to `/tmp/mangadb-audit/plan/repair-plan.json`. Pass the
  real path. Reports go to `runs/` beside the plan (`--out` to change).
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
