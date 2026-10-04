# Known issues

Open problems confirmed in the code on 2026-10-04. Remove an entry when it
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
- **Publisher merges and their preview scan whole tables.** A Publisher
  merge (`transferReferences` in `convex/lib/sensitiveOps.ts`) reads every
  Edition Line, Release Bundle and publisher slug redirect to find the
  loser's, and the impact preview (`impactOf`) reads every Edition Line and
  Release Bundle to count them. None of those tables has a publisher index,
  so both come nearer a transaction's read limits as the catalog grows.
- **A Release Split can leave a Variant pin on another Release.** A
  Release merge moves the loser's Variants to the survivor
  (`transferReferences`), and after it any Collection Entry or Bundle
  Membership on the survivor can be pinned to any of them. `applySplit`
  replays only what the merge's manifest recorded, so a row pinned since
  the merge can end up on one Release pinned to a Variant of the other,
  which pinning itself refuses (`convex/collection.ts`).
- **Three kinds of Held Book have no Data Team route.** "Prepare placement"
  (`convex/placement.ts`) refuses a box set, which is a Release Bundle no
  Proposal can create, and a book whose publisher has no Publisher row,
  which only code creates (an importer's `ensurePublisher`, or the
  canonical list in `convex/lib/publishers.ts`). A single book with a
  non-numeric Volume label and no line cannot be stated: the coverage
  form takes numbers only, so "Side Story" is refused, and Unmapped
  Packaging needs a line. Outside Bootstrap Mode such a book stays held
  until an operator repair (`convex/lib/repair`) creates the Bundle or
  the Volume, or a deploy adds the Publisher.
- **A hold noted during an import's review is listed only once the book
  is applied again.** While an import's Proposal of a book is in review,
  `recordUnplaced` (`convex/lib/observations.ts`) writes the note and no
  Held Books row. Rejecting or withdrawing the Proposal lists nothing. The
  next apply lists the book, and so does `imports:backfillHolds`. When
  that is depends on the importer: PRH applies a title again at its next
  run that lists it (every title at the Sunday full sweep), Open Library at
  each monthly run, Seven Seas only when the book's page changes or an
  older parser read it (`noteListing` in `convex/sevenSeas.ts`), and Yen
  Press and Kodansha's
  back catalog when the book is next due for a fetch.
- **A lock hold stays listed after the unlock until the importer places
  the book again.** Seven Seas, Kodansha, PRH and Yen Press drop a lock
  hold (`Series N is locked.`) at the first apply that finds the Series
  unlocked and reaches the placement tail or a box set's branch
  (`holdUnderLock` in `convex/lib/unmatched.ts`), and nothing else drops
  it: lifting the lock writes no hold, "Prepare placement" refuses a
  `series` hold, and `imports:backfillHolds` keeps an existing row. Until
  then the book is listed as held by a lock that no longer exists. PRH
  applies a title again at its next run that lists it (every title at the
  Sunday full sweep), and the Kodansha calendar applies each volume in its
  window daily. Yen Press re-reads a backlist page only when it is due,
  180 days after the last read (`BACKLIST_REFRESH_MS` in
  `convex/yenPress.ts`), and the Kodansha back catalog re-crawls a series
  whole after 180 days (`FULL_REFRESH_MS` in `convex/lib/kodansha.ts`) or
  when its listing stamp changes; both re-read weekly a book that is
  undated or dated within the last 60 days or later. Seven Seas applies an
  unlinked book again only when its page changes, an older parser read
  it, a forced run reads it, or `staleVerdict` matches its note
  (`noteListing` in `convex/sevenSeas.ts`), which a lock's note never
  does, so a Seven Seas book can stay listed as locked indefinitely. A
  book that is out of scope when next read keeps its lock hold and note
  at least until a read finds it in scope again, whichever source lists
  it.
  Kodansha and Yen Press apply it, but the apply returns at its scope gate
  (an `outOfScope` such as `"novel"`: `applyVolume` in
  `convex/kodansha.ts`, `applyTitle` in `convex/yenPress.ts`) before
  anything that drops the hold. PRH and Seven Seas never apply it:
  `parseTitleList` (`convex/lib/prh.ts`) drops the entry, which
  `prh.notePresent` only marks seen, and the Seven Seas sync skips a book
  `isMangaBook` rejects. A fix is for lifting the lock to drop the lock
  holds that name the Series, leaving each book to its importer's next
  apply, and for an out-of-scope read to clear an obsolete placement
  hold: at the Kodansha and Yen Press scope gates, in `prh.notePresent`,
  and where the Seven Seas sync skips the book. Lifting the lock should
  match a row's `seriesId` and also the note (`LOCK_NOTE` in
  `convex/lib/unmatched.ts`, which names the Series' public id): a row
  `imports:backfillHolds` rebuilt from a note carries no `seriesId`.
- **An import's Proposal queued before its Series was locked can still be
  approved.** An import queues a guess under an open Series (an omnibus
  outside Bootstrap Mode, a ladder flag), an Editor locks the Series, and
  the next run notes the lock on the observation, which is not listed
  while the Proposal is in review. Approval still creates the Volumes,
  Edition and Release under the locked Series: reproduced for Seven Seas,
  PRH and Yen Press. Kodansha queues under an existing Series only for a
  ladder flag, whose approval takes the same check. `unavailableCreateRefs`
  (`convex/lib/proposalCreates.ts`) treats a locked Series as stale only
  for a member's placement Proposal; for any other create op it checks
  only that a record the op names is active. The fix is to treat a create
  under a locked Series as stale, as `staleRecordsOf` (`convex/proposals.ts`)
  treats an edit to a locked record.
- **Approving an import's Proposal queued before an Editor hid the work
  creates the Series again.** An import queues a book whose Series is new
  (steady state), then an Editor hides a Series of that work. The next run
  of any of the four publisher sources notes the hidden work on the
  observation (`removedSeriesFor` in `convex/lib/pipeline.ts`), but the
  note is not listed while the Proposal is in review, and nothing on the
  Proposal says so. Approval creates a second active Series of that title
  beside the hidden one. The fix is for approval to check an import's
  new-Series guess against the hidden-work rule (`removedSeriesFor`), or
  for the placement tail to withdraw its own Proposal when it finds the
  hidden work.
- **A conflict or cancellation review hides an unlinked book.**
  `proposalInReview` (`convex/lib/observations.ts`) counts any import's
  Proposal in review that `queuedProposalId` points at, not only a
  creation Proposal. A field conflict or possible-cancellation review is
  queued on a linked book, and if the observation is unlinked while it is
  open (the repair op `unlinkObservation`, for one), the book stays off
  the Held Books list until that review is decided.
- **The repair op `withdrawProposal` leaves a book in no list.** Withdrawing
  an import's creation Proposal (`withdrawProposal` in
  `convex/lib/repair/ops.ts`) unsets the observation's `queuedProposalId`
  and writes no hold. Queuing the Proposal had removed the book's hold and
  note, so the book is neither in the review queue nor a Held Book until
  its importer applies it again (see above for when each does).
- **Seven Seas never replays an outdated packaging verdict once a Proposal
  pointed at the book.** `noteListing` (`convex/sevenSeas.ts`) replays an
  unplaced book's stored snapshot when its note is an older planner's
  (`staleVerdict`), but only while `queuedProposalId` is unset. The field
  stays after its Proposal is decided, and a member's placement Draft sets
  it too, so such a book keeps the older verdict until its page changes.
- **Some routes cannot tell that a book is for adults.** A Series is
  mature only from evidence the catalog holds (`convex/lib/mature.ts`).
  An ANN entry with no Objectionable-content rating and no erotica or
  hentai genre carries none, so a Series ANN alone built under a parent
  publisher stays listed. Open Library names only publishers, so a record
  that names the parent ("Seven Seas Entertainment") and not the imprint
  files its Release under the parent with no evidence. Either is mature
  only once another source rates or names the imprint, an Edition sits
  under an adult-only Publisher row, or the Data Team rates the Series.
- **Author listings learn that a Series became mature up to six hours
  late.** The Authors directory (`people.authors` in `convex/people.ts`)
  and author search (`authorHits` in `convex/catalog.ts`) read each
  author's stored jacket and `matureOnly`, which `people:rebuild` refreshes
  every six hours (`statsBatch`). Until then, an author whose biggest Series
  became mature still shows that Series' jacket in the general directory,
  and an author whose every Series is now mature is still listed there and
  in search.
- **`prh.notePresent` has no read bound for a relisted page.** It marks
  seen the listed ISBNs whose entry produced no snapshot (the entries
  `parseTitleList` in `convex/lib/prh.ts` drops as malformed or out of
  scope); a parsed entry is marked by its own apply. A dropped book that
  was withdrawn and is listed again applies its 18+ evidence (`markSeen`,
  `applyMatureEvidence` in `convex/lib/mature.ts`), reading every Series
  on its Release. A page of 200 such entries, each on a Release spanning
  about 20 Series, would pass the 4,096 index ranges a transaction may
  read. Real Releases span 1 to 4 Series.
- **A Seven Seas book page that cannot be read is read again every run.**
  A listed book whose stored snapshot predates the current parser, or
  that was never read, is fetched on every run until a read succeeds. A
  page that answers 404 (a notice), lacks its metadata block (an error
  that fails the run) or now reads as prose (skipped with no error) never
  succeeds, so it costs one unit of the 200-page budget on every run
  while it stays listed.
- **The Seven Seas listing answers the importer with HTTP 403 in
  production.** The site serves a Cloudflare challenge to scripted
  requests. Both Seven Seas runs in the 2026-10-02 production export
  failed with HTTP 403 on the listing, and the export holds no Seven Seas
  observation; requests made while saving the parser fixtures
  (`convex/lib/__fixtures__/sevenSeas`) got the same challenge, which is
  why those fixtures come from the Internet Archive. The source has
  imported nothing in production and is disabled. No fix is proposed
  here.
- **Some Open Library holds are never revisited by a sync.** A sync
  applies only the dump lines today's parser reads (`parseDumpLine` and
  `parseEditionJson` in `convex/lib/openLibrary.ts`). A line it now drops
  (out of scope by title, not English, an audiobook) never reaches
  `applyEdition`, so a hold written from an older parse of that edition
  stays. An edition no longer in the hosted dump is never applied again,
  and the sync withdraws nothing, since the dump is a filtered slice.
  `imports:backfillHolds` classifies the stored snapshot, the older parse,
  with `placeEdition`: it keeps the row while that snapshot would still be
  held or would now match or be created, and drops it only for a skip or
  a review. `openLibrary:replayDescriptions` reaches only described
  editions whose ISBN an active Release holds. A fix is for the sync to
  drop the hold of an edition today's parser rejects, and for the backfill
  to drop an Open Library hold `placeEdition` would no longer write.
- **An existing Release Bundle takes members under a locked Series.** A
  box set already linked to a Release Bundle adds the member Releases that
  arrive later, with an importer Revision of the bundle's members, while
  its Series is locked: Seven Seas (`reconcileBoxMembers`), PRH and Yen
  Press (`reconcileCatalogBox`) through `addLateBundleMembers` in
  `convex/lib/pipeline.ts`, which stops only for a locked, inactive or
  overridden bundle. This matches a linked Release, which only its own
  lock stops ([imports](imports.md#creating-records)); if a Series lock is
  to stop it too, `addLateBundleMembers` should check the Series.
- **PRH and Yen Press made empty Release Bundles of box sets with no
  stated coverage.** Until such a box set was held, PRH and Yen Press in
  Bootstrap Mode made a box set whose title, blurbs and line's size give
  no range of Volumes ("… Box Set", or a title whose statements disagree)
  a Release Bundle with no members, and linked the box's observation to
  it. A linked box adds only the members its record covers
  (`reconcileCatalogBox` in `convex/lib/catalogTitle.ts`), so the bundle
  stays empty, and the box unheld, while its record states no usable
  coverage. Once the snapshot yields usable coverage, a later apply can
  add the matching Releases that exist, under the usual bundle
  reconciliation checks (`reconcileCatalogBox`, `addLateBundleMembers` in
  `convex/lib/pipeline.ts`): it adds none while they do not exist yet or
  the bundle is locked, and a title with a gapped list ("(Vol. 1 & 3)")
  keeps a blurb from supplying coverage. Such a bundle is marked
  Bootstrap-Unreviewed (the `by_bootstrap` index on `releaseBundles`), has
  no `bundleMemberships` row, is linked from a `prh` or `yenpress`
  observation, and that observation's snapshot gives no coverage. The
  first three also fit a healthy bundle, a box stating Volumes that have
  no Releases yet; the fourth tells them apart. No Proposal or edit form
  changes a bundle's members, so an Editor can only report it. A
  Moderator can merge it into a bundle that has its members, or hide it,
  from its Manage page
  ([moderation](moderation.md#hide-restore-merge-split-and-locks)); a
  hidden bundle keeps the box's observation linked, so the box is not
  held either. The operator's one-time repair can fill one
  (`repair:runBatch`, a `releaseBundle` entry naming the bundle and its
  members' ISBNs). A fix is a repair that, for each bundle with all four
  properties and only those, unlinks the box's observation, hides the
  bundle and clears its ISBN-13, so the next apply holds the box. A box
  finds an existing bundle by its ISBN-13 whatever the bundle's status
  (`createReleaseBundle` in `convex/lib/pipeline.ts`), so with the ISBN
  kept, a repaired box whose record later states a range in Bootstrap
  Mode would link the hidden bundle again and be neither held nor shown;
  with it cleared, it gets a bundle of its own. Applied to a healthy
  bundle the repair would do harm: it hides a bundle that would fill as
  its box's Volumes arrive, and the box is then held or given a new
  bundle.
- **Two packaging notes give the wrong reason.** In Bootstrap Mode PRH and
  Yen Press hold a box set with one base Series, stated coverage and no
  imprint with the note `Box set "…" is a Release Bundle — steady state
  leaves bundles to review.` (`applyCatalogTitle` in
  `convex/lib/catalogTitle.ts`); what holds it is the missing publisher.
  A title that lists its Volumes with a gap ("… (Vol. 4 & 6)") is, when
  held, held with a note that the title does not state its covered
  Volumes (the packaging `hold` in `applyCatalogTitle`; Seven Seas'
  `unplacedNote` in `convex/sevenSeas.ts` says neither the title, the
  blurb, nor the line name states them), though the title does. It is
  held in steady state or with no line name; in Bootstrap Mode a gapped
  title with a line name, a publisher and no ambiguous Series is created
  as Unmapped Packaging instead, with no note (`placeUnmatched` in
  `convex/lib/unmatched.ts`). A fix is a note of its own for a box set
  with no publisher, and for a gapped title one saying it states no
  contiguous range. `storedHoldKind` (`convex/imports.ts`) classifies
  stored notes by their text, so it must keep matching a reworded note's
  old wording, which stays on a book until its importer applies it again.
  Seven Seas' `staleVerdict` (`convex/sevenSeas.ts`) also matches notes
  by exact text, two older wordings it replays once. Short of a page
  change or a forced run, a reworded `unplacedNote` reaches the books it
  already holds only if its current wording is added to `staleVerdict` or
  `BOOK_PAGE_VERSION` (`convex/lib/sevenSeas.ts`) is raised, and the new
  wording must not match `staleVerdict`, or the book is replayed every
  run (the lock-hold entry above lists when Seven Seas applies an
  unlinked book again).
- **Due covers are asked about again every hour during an outage.** While
  Open Library or another upstream does not answer, every viewed cover
  that is due for its 90-day check is asked about again roughly once an
  hour per Cloudflare location (`src/server/covers.ts`), with no backoff.
  When many covers fall due together this can pass Open Library's limit
  of about 100 lookups per 5 minutes.

## Review queue

- **Request Changes on a reader's report makes a Draft the reader cannot
  open.** A report (`reports.submit`) is an In-Review Proposal authored by
  any signed-in user. `proposals.requestChanges` turns it back into a Draft
  for its author, but `proposalDetail`, `myProposals` ("My Proposals"),
  `saveDraft`, `submitProposal` and `withdrawProposal` all need Data Team
  membership, so a reader who is not on the team cannot open, resubmit or
  withdraw it, and no Moderator can decide a Draft.
- **Import Proposals put back to Draft before the refusal stay there.**
  `requestChanges` now refuses an import's Proposal, but ones it returned
  to Draft before that check existed have no author who can resubmit or
  withdraw them. An operator finds them as `proposals` in state `draft`
  whose `author.kind` is `source`.
- **The stale notice promises a rebase nobody can make on an import's
  Proposal.** The Proposal page (`src/routes/mod.proposal.$id.tsx`) says
  approval is blocked "until the author explicitly rebases and resubmits"
  whatever the author, and an import's Proposal has no author who can
  rebase it (`rebaseProposal` needs the author). A Moderator can only
  reject it.

## Tests

- **Thirty-two tests leave scheduled functions pending when they end.**
  Counted on 2026-10-04 by checking every `makeT` backend after each test:
  thirteen that purge a user (`users:redactMergeManifests`, and in
  `convex/users.test.ts` further purge passes and the Clerk deletion), ten
  that make a Series mature (`seriesBrowse:projectMature`), four
  stranded-run tests in `convex/imports.test.ts` (every source's sync), two
  in `convex/people.test.ts` (`people:rebuild`), two in
  `convex/analytics.test.ts` (PostHog's capture) and one in
  `convex/ann.test.ts` (`ann:sync`). It is harmless while the setup refuses
  unstubbed network requests, but in shuffled order a leaked job can run
  under the next test's stubs.

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
- **`npm run dev` without `.env.local` reads production's catalog.** In
  dev the Worker's `process.env` comes from the top-level `vars` in
  `wrangler.jsonc`, which hold production's Convex URL, and `convexUrl()`
  (`src/lib/convexUrl.ts`) falls back to it, so the dev server renders
  production's public catalog. Nothing is written. Stopping it means moving
  the production values out of the top-level `vars`, which changes the
  deploy commands.
- **Production runs on a Clerk development instance.** `wrangler.jsonc`
  sets production's `VITE_CLERK_PUBLISHABLE_KEY` to a `pk_test_` key, the
  same one staging uses, and `scripts/check-deploy-target.mjs` stops a
  production build whose key differs. Moving production to a Clerk
  production instance is the owner's step.
- **Kodansha holds every unmatched packaged volume.** Its adapter passes
  the placement tail no Volumes for packaging (`applyVolume` in
  `convex/kodansha.ts`), so an omnibus, box set or line member that matched
  no Release is held for an Editor even when its title states its range or
  its line declares its size, and in Bootstrap Mode it is never created as
  Unmapped Packaging. Seven Seas, PRH and Yen Press place such books.
  Letting Kodansha place them changes what it creates.
- **Volumes for two-in-one English editions.** The catalog's Volumes for
  "Alice in Borderland" follow VIZ's English two-in-one numbering (the
  existing Volume 4). Whether such a Series should instead carry the
  original Volumes, with each English book covering two, is a modelling
  choice the Data Team needs before it places the held books.
- **Search text reaches PostHog.** `search_performed` carries only the
  query's length and the result count, but posthog-js adds the page
  address to every event (`$current_url`, with `?q=…`) and the page title
  to pageviews, and the `/search` title names the query. A session that
  begins on a search page also carries its address as `$session_entry_url`
  on every later event.
  [configuration.md](configuration.md#analytics-posthog) says so for
  operators, and nothing tells a reader. Stripping the query from what
  posthog-js sends, or disclosing it, is the owner's call.
