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

## Decisions waiting on the owner

- **Disjoint ISBNs as proof of another work.** `workMatch`
  (`convex/lib/matching.ts`) calls a title match a different work when both
  sides hold ISBNs in a shared format and share none. That is a policy
  choice, not a fact.

## Operator tools

- **`seed:run '{"wipe":true}'` has no guard.** It deletes every catalog
  table on any deployment it is pointed at.
- **`scripts/repair.ts` defaults to a `/tmp` plan.** `--plan` defaults to
  `/tmp/mangadb-audit/plan/repair-plan.json`, a path from the machine the
  repair was built on. Always pass `--plan`.
