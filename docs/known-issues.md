# Known issues

Open problems confirmed in the code on 2026-10-02. Remove an entry when it
is fixed.

## Deployment

- The production deploy from Actions on 2026-10-02 failed at
  `wrangler deploy` with "Could not find zone for `mangadb.org`", after
  Convex had been pushed and the Worker uploaded. The production token
  passed the credentials check, so it can read the Worker but not the
  `mangadb.org` zone. Add zone access for `mangadb.org` to that token
  ([deployment](deployment.md#one-time-setup), step 2).
- The `staging` GitHub environment has no `CLOUDFLARE_API_TOKEN` secret, so
  staging deploys from Actions stop at the secrets check.

## Personal data and tracking

- **Reading Undo depends on current coverage.** `reading.undoCompletion`
  decrements the Volumes the Edition covers completely now, not the ones
  the completion counted, and always restores the pass at 100%. A
  completion that touched only partial coverage cannot be undone, and a
  coverage change after completion leaves its reads behind. The fix is a
  stored completion event with the original pass and Volume ids.
- **Account deletion is not durable.** `users.deleteAccount` deletes the
  Clerk identity first, then runs `purgeUser` as one unbounded transaction.
  If the purge fails, personal rows stay and the user can no longer sign in
  to retry. It needs a deletion job recorded before the Clerk call and
  processed in bounded batches.
- **Library badges run full queries.** Each tab label on `/me` subscribes
  to its tab's full query (`collection.myLibrary`, `reading.myReading`,
  `follows.myUpcoming`, `favorites.mine`) just to show a count, including
  while Settings is open. Maintained counters would fix it.
- **No analytics opt-out.** posthog-js honours Do Not Track, but there is
  no opt-out toggle in Settings.
- **`volumeProgress.seriesId` goes stale after a Split.** The field is set
  when a row is inserted, and Split (`applySplit` in
  `convex/lib/sensitiveOps.ts`) reverts only the repoints its merge
  recorded. Merge Series B into A, read a Volume of B, then split B: the
  row still names A. A Volume merge inside the merged Series followed by
  the Split goes wrong the other way: the surviving Volume's row is put
  back under B. `reading.myReading` groups read Volumes by this field, so
  `/me` files the reading row under the wrong Series. Reads per Volume
  (`seriesTracking`) are right. The `by_user_series` index on
  `volumeProgress` cannot be trusted until Split re-derives the field from
  each Volume's Series and existing rows are backfilled.

## Catalog and imports

- **A stranded run blocks its source.** `imports.runScheduled` skips any
  source whose last run is `running`, however old. If a chain dies without
  closing its run, that source never runs on schedule again, and its health
  never changes because no run finishes. Only `ann:backfillDescriptions` treats a run
  older than 12 hours as stranded, and only for its own start check.
- **Human Overrides cannot be lifted.** Approving a `clearOverride` op fails
  with `unsupportedOp` (`convex/proposals.ts`).
- **Placement holds are invisible.** Books an import could not place are
  recorded on their observation (`recordUnplaced`), but no Data Team page
  or query lists them.
- **A hidden sequel can lose its ISBN to the parent Series.**
  `resolveBaseSeries` (`convex/lib/catalogTitle.ts`) only considers active
  Series. With "Kingdom Hearts II" hidden, an Open Library record titled
  "Kingdom" with subtitle "Hearts II" resolves to Kingdom Hearts Volume 2.
  Observations already linked this way need a manual fix.
- **ANN's title splitter has no rejected state.** `convex/lib/ann.ts` reads
  "(GN 97-99)" ranges but cannot mark a statement as unreadable, so a
  gapped list such as "(GN 1, 3)" on a 3-in-1 line is placed by the line's
  size. The shared parser in `convex/lib/bookTitle.ts` rejects such lists.
- **Open Library continuations re-download the dump.** `openLibrary:sync`
  restarts each continuation from byte zero and skips lines it already
  processed. Byte-offset continuation with HTTP Range, or a dump split into
  separate files, would avoid it.
- **Variant merges scan whole tables.** Merging a Release Variant, and its
  impact preview, collect all of `collectionEntries` and
  `bundleMemberships` (`convex/lib/sensitiveOps.ts`), because variant pins
  have no index.
- **Stored cover art never refreshes.** `src/server/covers.ts` writes
  `fetchedAt` into each R2 object's metadata and never reads it. A copy in
  R2 is served indefinitely, so a publisher's corrected jacket does not
  reach the site without deleting the object.

- **A disabled source can keep writing for the rest of a run.** Seven Seas,
  Kodansha, ANN and Open Library check the registry flag only when a link
  starts, so a link already running when the source is disabled keeps
  writing to its end. Kodansha's, ANN's and Open Library's apply mutations
  also serve the backlist crawl and the operator backfills, which must
  ignore the flag. The fix passes the run id into the apply mutation and
  stops only scheduled runs.
- **A forced Yen Press run on a disabled source reports success.** The
  shared gate (`runToContinue` in `convex/lib/importRuns.ts`) lets the
  forced run through, and `applyCatalogTitle` (`convex/lib/catalogTitle.ts`)
  refuses every apply while the source is disabled. The run fetches every
  page, imports nothing and closes as `succeeded`. The fix is to carry the
  run's automatic or forced state to the apply mutation.
- **Disabling PRH inside the final link of a scheduled full sweep withdraws
  what it was listing.** `applyCatalogTitle` refuses the rest of that
  link's applies, so their observations never get a new last-seen time,
  but `prh.sync` still runs `imports.markWithdrawn` at the end of a
  complete sweep. Those observations are marked withdrawn, and a
  future-dated Release among them gets a hide Proposal. The run closes as
  `succeeded`. The fix is to skip the withdrawal pass when an apply was
  refused. PRH runs carry no automatic flag, and a forced PRH run on a
  disabled source is already refused before any fetch.
- **Disabling PRH mid-run counts as a failure.** A PRH link that finds its
  source disabled closes the run as `failed` (`convex/prh.ts`), not
  `stopped` as the shared gate does for the other chained sources, so the
  source's `consecutiveFailures` goes up. Three such disables in a row raise
  the unhealthy alert. This is `main`'s behaviour, kept on purpose when the
  branch for PR #61 briefly moved PRH onto the shared gate.
- **Three copies of the apply ladder.** `applyBook` in
  `convex/sevenSeas.ts`, its mirror in `convex/kodansha.ts` and
  `applyCatalogTitle` in `convex/lib/catalogTitle.ts` run the same
  sequence and have drifted once already (Seven Seas lacked the
  removed-Series check). They should become one ladder with per-source
  options.

## Moderation

- **The last-Administrator guard in `roles.suspend` cannot fire.**
  Self-suspension is refused first, so the acting Administrator always
  stays active. The guard is dead code, or the rule it was meant to
  enforce (for example on role revocation) is missing.
- **A suspended user's public profile still shows.** `sharing.publicProfile`
  has no suspension check.

## Decisions waiting on the owner

- **Disjoint ISBNs as proof of another work.** `workMatch`
  (`convex/lib/matching.ts`) calls a title match a different work when both
  sides hold ISBNs in a shared format and share none. That is a policy
  choice, not a fact.
- **One-time code that may have finished.** The operator backfills
  `people:backfillAnnCredits`, `ann:backfillDescriptions` and
  `openLibrary:replayDescriptions`, the repair entry kinds used only by
  the sandbox plan, and the dev seed (`convex/seed.ts`) can go once the
  owner confirms they are no longer needed.
- **The "Convex not configured" mode.** About 38 components guard against
  a missing `VITE_CONVEX_URL`, although every environment sets it and
  `/mod/packaging` already crashes without it. Failing at boot would
  remove the guards.
- **No formatter or linter.** Line width runs from 80 to 200 columns.
- **Reads on Volumes of a hidden Series.** Ratings refuse a Volume whose
  Series is hidden (`activeVolume` in `convex/lib/ratings.ts`). Reading
  does not: `reading.setVolumeReadCount`, `adjustVolumeReadCount`,
  `setEditionRead`, `completePass` and `undoCompletion` all write such
  Volumes. Whether reads on them should stay editable is the owner's call.

## Operator tools

- **`seed:run '{"wipe":true}'` has no guard.** It deletes every catalog
  table on any deployment it is pointed at.
- **`scripts/repair.ts` defaults to a `/tmp` plan.** `--plan` defaults to
  `/tmp/mangadb-audit/plan/repair-plan.json`, a path from the machine the
  repair was built on. Always pass `--plan`.
