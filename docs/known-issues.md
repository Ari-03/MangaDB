# Known issues

Open problems confirmed in the code on 2026-10-02. Remove an entry when it
is fixed.

## Personal data and tracking

- **Reading Undo depends on current coverage.** `reading.undoCompletion`
  decrements the Volumes the Edition covers completely now, not the ones
  the completion counted, and always restores the pass at 100%. A
  completion that touched only partial coverage cannot be undone, and a
  coverage change after completion leaves its reads behind. The fix is a
  stored completion event with the original pass and Volume ids.
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
- **A sign-in without a username cannot be deleted on the site.**
  `users.deleteAccount` refuses an identity with no `users` row: no page
  offers deletion before a username is claimed, and deleting the Clerk
  sign-in alone could not be ordered against a claim landing during the
  request (the claim and its first rows would survive without a sign-in).
  Someone who signed in but never claimed a username must have their
  sign-in deleted in the Clerk dashboard; the Convex database holds
  nothing for them.

## Catalog and imports

- **Human Overrides cannot be lifted.** Approving a `clearOverride` op fails
  with `unsupportedOp` (`convex/proposals.ts`).
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
- **Three copies of the apply ladder.** `applyBook` in
  `convex/sevenSeas.ts`, its mirror in `convex/kodansha.ts` and
  `applyCatalogTitle` in `convex/lib/catalogTitle.ts` run the same
  sequence and have drifted once already (Seven Seas lacked the
  removed-Series check). They should become one ladder with per-source
  options.

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
