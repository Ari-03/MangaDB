# Known issues

Open problems confirmed in the code on 2026-10-02. Remove an entry when it
is fixed.

## Personal data and tracking

- **`volumeProgress.seriesId` is still in the schema.** A read count's
  Series is its Volume's; nothing reads or writes the field, which is
  optional and still set on older rows. Once
  `npx convex run reading:unsetProgressSeries '{}'` has finished on every
  deployment, a later deploy drops the field, its `by_series` and
  `by_user_series` indexes, and the migration itself. Split keeps
  skipping the field in older merge manifests (`RETIRED_FIELDS` in
  `convex/lib/sensitiveOps.ts`). The migration is finished when its log
  line `[reading.unsetProgressSeries] done: N rows cleared` appears, or
  when a rerun logs 0; the value `npx convex run` prints counts only the
  first page. The deploy that made the field optional is one-way: once a
  row without `seriesId` exists, redeploying the earlier code fails schema
  validation. An export taken before the migration ran still holds the
  field, so importing it after the field is dropped fails schema
  validation.
- **Volume Favorites and Comments carry a stored `seriesId` that a Split
  does not re-derive.** Favorites display derives the Series from the
  Volume. Merge bookkeeping, the Comments thread lookup and the titles in
  the Comments moderation queue (`comments.queue`) use the stored value,
  so after merging B into A, commenting on a Volume of B and splitting B,
  the queue labels that comment with A's title.
- **A sign-in without a username cannot be deleted on the site.**
  `users.deleteAccount` refuses an identity with no `users` row: no page
  offers deletion before a username is claimed, and deleting the Clerk
  sign-in alone could not be ordered against a claim landing during the
  request (the claim and its first rows would survive without a sign-in).
  Someone who signed in but never claimed a username can claim one and
  then delete the account on `/me`, or have their sign-in deleted in the
  Clerk dashboard; the Convex database holds nothing for them.
- **A sign-in deleted in Clerk directly leaves its account behind.** The
  site is not told when a sign-in is deleted from the Clerk dashboard, or
  from the "Delete account" button in `<UserButton />`'s "Manage account"
  window, which Clerk shows while the instance setting "Allow users to
  delete their accounts" is on ([configuration](configuration.md#clerk)).
  The `users` row, its username and every row the purge would delete
  (public Ratings, Reviews and Comments among them) stay, with no sign-in
  that can remove them, until an operator purges them: in
  the Convex dashboard set `deletingSince` to the current time in
  milliseconds on the `users` row whose `clerkSubject` is the deleted
  Clerk user id, then run
  `npx convex run users:purgeUser '{"userId":"…"}'`. The deletion then
  finishes as one asked for on `/me` ([operations](operations.md#account-deletion));
  Clerk answers the identity's deletion with a 404, which counts as done.
- **Account deletion leaves the PostHog person.** `users.purgeUser` makes
  no PostHog call, so the person PostHog holds under the deleted user's
  Clerk id, with its username, role and past events, stays until someone
  deletes it in PostHog. Opting out of analytics in Settings stops new
  events only.
- **A page opened while Off can reach PostHog after another tab opts
  in.** posthog-js stores its opt-out in localStorage, shared by every
  tab, so another tab of the same browser opting in (switching On,
  signing out) turns capturing back on in a tab that is Off or still
  loading its choice. With one account in every tab that lasts until
  Convex pushes the tab the changed choice or Clerk syncs a sign-out;
  with Clerk's multi-session mode, a tab whose account is Off can record
  this state for as long as another tab's account is On. `before_send` in
  `src/lib/analyticsClient.tsx` drops the events of that moment, but
  posthog-js has already updated its state from them. Once sending
  resumes, the tab's events carry a dropped pageview as the previous page
  (`$pageview_id` until the next pageview, then `$prev_pageview_*` on
  that pageview or a `$pageleave`: pathname, id, duration, scroll and
  content) and its campaign parameters as `utm_*` until a reload; and a
  session that began on a dropped event (the first after 30 minutes idle
  or 24 hours into a session, or the browser's first) carries that
  event's address, query string and fragment included, as
  `$session_entry_url`, with `$session_entry_utm_*`, on every later event
  of the session, across reloads. A fix needs a consent store not shared
  between tabs, or clearing posthog-js's previous-page and session state,
  which its public API does not offer: `reset()` starts a new session but
  keeps the previous page and replaces the anonymous id. A test in
  `src/lib/analyticsClient.test.ts` pins the session case.

## Catalog and imports

- **Releases ANN put on a same-titled Series stay there.** Before ANN
  told same-titled entries apart (`workMatch` in `convex/lib/matching.ts`,
  commit aa9a0d6), an entry could link by title to another work's Series,
  and its lines became Releases on that Series' Volumes. An import keeps
  an existing source link, so they stay until a Data Team member moves
  them. The known case is ANN entry 30340, the Alchemist sequel ("… II:
  Cycle of the Elixir"): ISBNs 9781975393489 and 9781975396923 sit on the
  first Alchemist Series (publicId 1229) on staging; production's were
  repaired by hand on 2026-09-28. A new import no longer links such an
  entry to a Series another live ANN entry holds unless they share an
  ISBN; entries already linked keep their link
  ([imports](imports.md#matching-ladder)). A Series no ANN entry holds (a
  publisher feed's) with no ISBN in a format the entry lists still takes
  the entry by title.
- **Open Library continuations re-download the dump.** `openLibrary:sync`
  restarts each continuation from byte zero and skips lines it already
  processed. Byte-offset continuation with HTTP Range, or a dump split into
  separate files, would avoid it.
- **Three copies of the apply ladder.** `applyBook` in
  `convex/sevenSeas.ts`, its mirror in `convex/kodansha.ts` and
  `applyCatalogTitle` in `convex/lib/catalogTitle.ts` run the same
  sequence and have drifted once already (Seven Seas lacked the
  removed-Series check). They should become one ladder with per-source
  options.
- **A large merge cannot be Split.** `applySplit`
  (`convex/lib/sensitiveOps.ts`) runs as one transaction. It reads several
  index ranges for every row the merge moved and for every owner of every
  Bundle the merge touched, so a merge that moved many rows, or touched a
  Bundle owned by many users (about 1,400 with nothing else), passes the
  4,096 ranges a transaction may read and cannot be Split. Release
  Variant merges stop at 250 pins, which covers only Owned entries and
  memberships of one-Release Bundles. Release, Bundle and Series merges
  log every moved row into one manifest document with no bound at all.
  The fix is a Split, and a merge manifest, that work in batches.
- **Due covers are asked about again every hour during an outage.** While
  Open Library or another upstream does not answer, every viewed cover
  that is due for its 90-day check is asked about again roughly once an
  hour per Cloudflare location (`src/server/covers.ts`), with no backoff.
  When many covers fall due together this can pass Open Library's limit
  of about 100 lookups per 5 minutes.

## Decisions waiting on the owner

- **One-time code that may have finished.** The operator backfills
  `people:backfillAnnCredits`, `ann:backfillDescriptions` and
  `openLibrary:replayDescriptions`, the repair entry kinds used only by
  the sandbox plan, and the dev seed (`convex/seed.ts`) can go once the
  owner confirms they are no longer needed.
- **No formatter or linter.** Line width runs from 80 to 200 columns.
- **Reads on Volumes of a hidden Series.** Ratings refuse a Volume whose
  Series is hidden (`activeVolume` in `convex/lib/ratings.ts`). Reading
  does not: `reading.setVolumeReadCount`, `adjustVolumeReadCount`,
  `setEditionRead`, `completePass` and `undoCompletion` all write such
  Volumes. Whether reads on them should stay editable is the owner's call.
