# Moderation

How the Data Team (Editors, Moderators, Administrators) changes the
catalog, and how a signed-in reader suggests a change for them to review.
Every human and automated change goes through a Proposal, and every
approved change leaves a public Revision. Terms are defined in
[CONTEXT.md](../CONTEXT.md).

## The workroom

Every `/mod` tool page (review queue, imports, catalog gaps, your
proposals, launch, comments while they are on, and roles for Moderators)
sits in one frame (`src/lib/modShell.tsx`): a breadcrumb, a tab strip of
the tools, the page title and one line of hint. The queue tab counts
In-Review proposals, and Imports gets a red dot while any source is
unhealthy (`workroom.counts`; each count reads at most 101 rows and shows
"100+" past 100). Explanations of how a page works sit in a closed "How
this works" under the panel they explain. A page body that fails to load
shows the error and a Reload button inside the frame. The edit, propose
and manage forms keep their own layout.

The frame's right end links the MangaDB Discord and opens "Report a bug",
a dialog with the page address, your role, theme, window size, browser and
the time (and the proposal id on a proposal page), plus three questions to
answer. Copy it and paste it into the Discord server's channel for bugs
and feedback. Nothing is sent from the site. The invite lives in one
constant, `DISCORD_INVITE_URL` in `src/lib/community.tsx`; the site
footer's Community column and the About page's Corrections section link
it too.

## Roles

Administrators appoint Moderators. Moderators appoint Editors. Editors
propose changes; Moderators and Administrators approve them
(`convex/roles.ts`, `convex/lib/roles.ts`). Any other signed-in User with
a username, not suspended and not deleting their account, is a reader: a
reader holds no data-team privilege but may write
[Suggestions](#suggestions). Every appointment, revocation,
suspension and reinstatement writes a permanent `roleAudit` row that
survives account deletion. Revoking or suspending someone removes their
privileges but never rewrites what they authored. A suspended user also
cannot track, change their username or post, and their public profile is
hidden; reinstating them restores it with their sharing choices unchanged.
The last active Administrator (not suspended, not deleting their account)
cannot be revoked, moved to another role, or delete their account; appoint
another first. `/mod/roles` shows the roster, the actions and the audit
trail.

The first Administrator is appointed once, by the operator, after that
person has signed in and claimed a username:

```sh
npx convex run roles:bootstrapAdministrator '{"username":"yourname"}'
```

## Direct edits and history

A Moderator or Administrator edits a record at `/mod/edit/{type}/{key}`,
linked from Series, Volume, Edition (and each Release row) and Bundle
pages. The form
comes from the field registry in `convex/lib/moderationFields.ts` and needs
a change comment. Saving creates an immediately approved Proposal and one
public Revision per changed record (`moderation.submitDirectEdit`). If the
record changed since the form loaded, the save is refused as stale.
Reload and edit again. Hidden, merged and locked records refuse edits.

Each record page shows its public history: the diff, the author and their
role at the time (or the import source), the approver, the time, the
comment and the source citation. It sits in a closed History disclosure
that loads the first time it is opened. Pending and rejected proposals
stay private to the Data Team.

**Human Overrides.** An approved human change to a field whose latest
Revision came from an import adds that field to the record's
`overriddenFields`. Imports may then report conflicts on it but never
overwrite it.

A `clearOverride` op lifts one override: it names a record and one
editable field on that record's `overriddenFields`, and carries the
record's base Revision like an update. A Moderator clears directly with
"Clear" beside the field on the edit page, giving a reason
(`moderation.submitDirectClear`, an immediately approved Proposal like a
direct edit). An Editor ticks the field on the propose page, and the clear
goes to review in that Proposal. Either way `applyClearOverride` takes the
field off the list and writes one public Revision recording
`overriddenFields` before and after, with the reason as its comment. Both
pages hold the state the person looked at: the Clear dialog captures the
base, value and author when it opens, and the propose page pins its values
at the first edit or tick. If the record changes before confirming, the
page says so and waits for an explicit reload.

Clearing removes only the sticky flag. The field keeps its value, and the
Revisions that wrote it are unchanged. Imports then follow the usual Field
Authority rules: replacing a value a person wrote (or that nothing records
who wrote) still needs review, and a value a source wrote may update
automatically. Not every differing offer reaches review, though. A less
precise date that agrees with the current one and an offer from a source
with no authority over the field are skipped or only recorded on the
observation, and an offer a reviewer already rejected is not queued again.
That rejection only keeps the offer out of review: where the source may
update the field automatically, as when it wrote the current value, a
value once rejected can still apply. An empty field that no one
wrote can be filled by an import. Clearing replays no stored observation:
an import changes the field only when its source offers a value again.

To take a value a source already offered, approve that source's conflict
Proposal first, then clear the override if it should go. A clear writes a
Revision, which moves the record's base: a conflict Proposal still open at
that moment goes stale, cannot be rebased (a source wrote it), and is
replaced only when the source record next changes. The Clear control on
the edit page says so when such a Proposal is waiting. Clearing a
description override changes which Release speaks for an Edition or Volume
at the next page read.

A Proposal may clear overrides beside other ops, on the same record or
others, and applies all of them or none. It may not both change a field
and clear that field's override: the change is itself a human correction.

### Covers

Release and Bundle forms have a Cover section (`#cover`), where a person
drops, chooses or pastes a JPEG, PNG or WebP (2 KB to 10 MB, at least 300
px wide), reuses art an Edition sibling or a containing Bundle stores, or
removes the stored art. The file uploads first: `coverUploads.uploadUrl`
issues a URL on this deployment's `/cover-upload` HTTP action
(`convex/http.ts`) carrying the upload's id and token, the action stores
the file and records the blob on that upload, and `coverUploads.uploaded`
checks it. A Data Team member may start 50 uploads a day, a reader 5, as
token buckets of the rate limiter counted when the URL is issued, so
neither the sweep keeping a pending upload nor a refused file gives one
back. An upload can only name a blob it stored, so no one can claim,
or have deleted, art they did not upload. The cover is then one more
field of the same Save or Proposal:
`coverImage`. Only the uploader, or art the catalog already shows or
History names, can go into a change; for a reader, only art a record the
public catalog shows holds ([Suggestions](#suggestions)).

A person's cover change, removal included, is always a Human Override on
`coverImage`, since importers attach art without a Revision.
`imports.attachCover` refuses a Release with that override until it is
cleared. No blob is deleted while a Release, Bundle or Variant shows it, a
Revision names it, or a Draft or In-Review Proposal names it (`coverRefs`,
`convex/lib/coverRefs.ts`). An hourly sweep deletes uploads nothing came to
use a day after upload. Revisions written before `coverRefs` existed get
their pins from `coverUploads.pinRevisionCovers`, which a ten-minute cron
starts after a deploy and restarts if it stalls (its cursor is the
`coverPinBackfill` row). Until it is done, neither `attachCover` nor the
sweep deletes any cover art.

### Description sources

The Description section (`#description`) shows the text with a preview of
the page, the sources' own blurbs with "Use this description", and a
choice of source: keep the current one, a blurb used from a source, another
page (a name and an https URL), or original prose. The choice is the
`update` op's `citation` and lands on the Revision with `citedField`. A
source change with the text unchanged is a change of its own, tied to the
text it was chosen for (`citedText`): if that text changes before the
Proposal is approved, submission and approval refuse it and a rebase drops
the source, so it has to be chosen again. Public pages
end each blurb with `Source: …` from `convex/lib/attribution.ts`: the
newest Revision that wrote or cited the text decides it, a person's edit
that stated nothing credits nobody, and text no Revision wrote is credited
only when exactly one source's linked record offers exactly that text.

## Proposals and the review queue

Any Data Team member drafts a Proposal (`proposals.saveDraft`) and submits
it (`submitProposal`); a reader does the same with a narrower
[Suggestion](#suggestions). Submission needs a change comment. Factual changes
need source evidence, a URL or a Source Observation; editorial prose such
as synopses does not. Warnings (a new Series, more than 10 ops, partial
coverage) must be acknowledged. Submitting freezes the draft into an
immutable Proposal Version.

What a person writes is bounded, for everyone (`convex/lib/evidence.ts`,
`overLength` in `convex/lib/moderationFields.ts`): at most 10 evidence
rows, an evidence URL or note at most 2,000 characters each, a change
comment at most 2,000, and a value they change at most 500 characters in
a one-line field or a list entry, 10,000 in a description or synopsis, and
100 entries in a list. A repeated evidence row is stored once. Text a
record already holds, and what imports write, is never refused for its
length. The direct edit holds to the same bounds.

A Moderator then approves (applies every op in one transaction), rejects
with a reason, or requests changes with a reason, which returns it to
Draft. Resubmitting creates the next version. Authors can withdraw from
Draft or In Review, whatever their role now. Reviewers never edit a
version.

A Proposal an import wrote cannot be sent back for changes: no one can
revise an import's Draft, and no list shows one, so the book would be in
neither the review queue nor the held list. `requestChanges` refuses it
and the Proposal page does not offer the button. Approve it, reject it,
or edit the record directly.

Every update and clearOverride op records the record's base Revision. If
any base moves before approval, or a field a clear names is no longer
overridden, approval applies nothing and marks the proposal stale. The
author rebases it (`rebaseProposal`), which drops a clear with nothing left
to clear, reviews and resubmits. There is no silent rebase.

One Proposal can create several records at once. Create ops may refer to
earlier create ops by temp-ID, so a Volume, Edition, coverage and Release
arrive together. The `/mod/propose-new/{seriesPublicId}` wizard builds
such a proposal, and so does "Prepare placement" on a held book (below).
Imports use the same machinery for the creations they queue.

Pages:

- `/mod/queue`: In-Review proposals, oldest submission first. Each row
  names the record the proposal changes (its title, a small jacket, its
  type) and what changes: up to three fields with before and after, what
  it creates, the overrides it clears, or a report's message. A person's
  change comment sits under that line. An importer's standing sentence
  does not; the proposal page still shows the full comment. Filters cover
  change kind (operation), record type, kind (import offer, import
  creation, field change, new records, merge/hide/lock, report,
  suggestion), author kind, author or source name, waiting time, warnings
  and staleness. A reader's name reads "(reader)" where a member's reads
  their role. Six views (All, Import offers, People, Suggestions, Reports,
  Stale) set those filters.
  Filters and views live in the URL, so a view can be shared as a link.
  The list loads 25 proposals at a time (`proposals.reviewQueuePage` is
  paginated, at most 50 a page) and says how many it has checked and how
  many match; "Check the next 25" reads further. The age filter measures
  from your browser's clock. Claiming signals who is looking and never
  locks. The older `proposals.reviewQueue` (no paging, an array with
  `ageMs`) stays for clients built before the paged one and filters by the
  same rules.
- `/mod/proposal/{id}`: the newest 50 versions with before and after per
  record, bases, evidence, and internal discussion notes. A reader can
  resubmit without a Moderator, so older versions are not shown; the page
  says "Showing the newest 50 of N versions" then. The current version is
  always among them.
- `/mod/proposals`: your own proposals, titled by their change comment,
  with the same change line as the queue.
- `/mod/propose/{type}/{key}`: the Editor form, linked as "Propose a
  change" on record pages. It is `src/lib/proposeForm.tsx`, which
  `/suggest` shares.

Limits, per user, through `@convex-dev/rate-limiter`: 30 submissions an
hour (burst 5) and 120 draft saves an hour (burst 20). A proposal holds at
most 25 ops. Readers have their own, smaller limits
([Suggestions](#suggestions)).

`reports.submit` files a signed-in reader's report on a Series as a
zero-op In-Review Proposal in the same queue (10 an hour, burst 3;
`convex/reports.ts`). The Series page itself now sends readers to the
Discord. A report has nothing to revise, so `requestChanges` refuses it
and the proposal page does not offer the button: approve it or reject it.

## Suggestions

A Suggestion is a reader's Proposal: one whose author held no data-team
role when they wrote it. It goes through the same `saveDraft`,
`submitProposal`, `rebaseProposal` and `withdrawProposal` as anyone's, with
these limits (`checkSuggestionOps` and the reader buckets in
`convex/proposals.ts`):

- Only `update` ops on existing records the public catalog shows, over the
  fields of `convex/lib/moderationFields.ts`, covers included. No
  creations, no override clears, no placements, nothing from the manage
  page. Saving and submitting refuse a record the public does not see as
  not found.
- At most 10 ops; 10 submissions an hour (burst 3) and 60 draft saves an
  hour (burst 10); at most 20 open (Draft or In Review) at once.
- At most 64 KiB stored (`MAX_SUGGESTION_BYTES`: ops with their before-
  and after-values, evidence and comment), so `mine` and the review queue,
  which read many rows at once, stay well inside a query's read limit.
- Five cover uploads a day (see [Covers](#covers)).
- Evidence as for anyone: a factual change needs a source URL, a
  description or a cover does not. A Source Observation must be linked to
  a record the public catalog shows (`observationPublic` in
  `convex/lib/publicRecords.ts`), as the blurbs "Use this description"
  cites are; saving and submitting check it.
- A cover is the reader's own upload, the record's own art, or art a
  record the public catalog shows holds: a Release, Bundle or Variant
  showing it, or one whose History names it (`publicArt` in
  `convex/lib/coverRefs.ts`). The Data Team may reuse any art a record
  shows or History names.

Saving, submitting and rebasing check the author's role now, so a Draft
someone wrote while on the Data Team goes no further once they are off it
unless it is a Suggestion. They can still withdraw it. A Suggestion stays
one whatever role its author holds later (`isSuggestion`): appointed to
the Data Team, they still save, submit and rebase it under these rules,
and what they start there is theirs as an Editor.

Catalog pages show a signed-in reader the Data Team's links beside a
cover, a description and the Release rows, leading to
`/suggest/{type}/{key}` instead, and "Suggest an edit" where an Editor
sees "Propose a change". Signed-out visitors see none of them. `/suggest`
is the propose form in the site's own page, without override clears;
signed out, it asks for a sign-in that returns there. For a reader,
`moderation.editForm` and `moderation.sourceBlurbs` answer only for a
record the public catalog shows (`publiclyVisible` in
`convex/lib/publicRecords.ts`, the rule the page queries in
`convex/catalogPages.ts` follow): it is active, and so is a Volume's
Series, a Release's Edition and a Variant's Release. A Hidden or Merged
Record, or a Volume of a hidden Series, stays the Data Team's. An Edition
whose Series is hidden stays public, as its page does. `editForm` says
nothing about import Proposals waiting on the record. Like the public
pages, these queries send a Mature Series' art and titles to anyone; the
public pages conceal the art in the browser for viewers who have not
opted in, and the cover section of the form does not yet.

A reader reads only their own Suggestions (`convex/suggestions.ts`):
Proposals they wrote holding no data-team role, the queue's `suggestion`
kind, and reports they filed as a reader. `mine` lists the newest 50 on
the Suggestions tab of `/me`, read from each state's newest 50, and
`detail` backs `/me/suggestions/{id}`. They show the ops with before and
after, the evidence, the change comment, when it was submitted and
closed, and the reason for each rejection or request for changes. A
Proposal page shows the newest 50 versions and the newest 100 decisions;
the current version and the standing decision are always among them.
The internal discussion, the claim and who decided stay on
`/mod/proposal`, and a Proposal someone wrote on the Data Team is read
there, not here. Another person's Proposal reads as not found. A record
the public catalog no longer shows is named "A record that is no longer
public", with no link, ISBN, art, current or before values: only what the
reader wrote of it (the new values, citation, evidence and comment). A
Source Observation cited as evidence whose record is no longer public
reads "(not public)", without its page, and a cover only a non-public
record holds is named without its art; the Data Team's page shows both.
An op other than an update, which a Suggestion saved before the rules
above held might carry, reads "A change a suggestion cannot make", naming
no record (`readerOps`).

An open Suggestion is stale when a record it changes has a newer Revision
or has left ordinary editing, judged from its working ops: the Draft's
when it has one, else the submitted version. Its page then offers
Rebase, which a Draft of several records needs too, having no form to
reopen in; the rebased Draft can be edited where the form shows it, and
submitted.

A Draft, including one sent back for changes, opens in
`/suggest/{type}/{key}?draft={id}` with its values and saves back into
the same Proposal, when the form can show all of it: one update of that
record. A Draft with more (several records, or changes made through the
API) is not opened there, since saving would drop the rest; its page
still submits or withdraws it. The resumed form keeps the Draft's
evidence as saved, apart from the source controls, until the reader
removes a row, so a fact backed by a source record does not lose it.

Review is unchanged. In the queue a Suggestion's kind is "Suggestion". A
Moderator approves, rejects or requests changes, and approval applies it
through `applyUpdate` like any person's change: the reader is the
Revision's author, and a field an import wrote, or a cover, becomes a
Human Override.

## Hide, restore, merge, split and locks

`/mod/manage/{type}/{key}` ("Manage" on record pages) runs the sensitive
operations (`convex/sensitiveOps.ts`, engine in `convex/lib/sensitiveOps.ts`).
Each needs a written reason, shows an impact preview (observations,
revisions, relationships, child records, tracking) and needs explicit
confirmation, checked again on the server. Each applies as an immediately
approved Proposal, so the reason lands in public history.

- **Hide** sets `status` to `hidden`. The record leaves public discovery
  but keeps its ID, history and every tracking reference. A hidden
  Release's Other Printings find nothing on `/isbn/{isbn}` either, and an
  import treats their ISBNs as the hidden Release's. **Restore** brings it
  back. Restore never undoes a merge, and refuses a Release whose ISBNs are
  someone else's now: an ISBN with Other Printings may have no other owner,
  active or hidden, and no Bundle; any other ISBN no other active Release.
  A Release with more than 100 printings is left to an administrator. A
  Bundle whose ISBN is now a printing is refused too. Merge or correct the
  other record first.
- **Merge** moves everything from the loser to a survivor: observations,
  relationships, child records, a Release's Other Printings (an ISBN the
  survivor already carries as its ISBN-13 or a printing stays the
  survivor's; one it has only as its ISBN-10 moves, so the ISBN-13 still
  finds it; at most 100 printings per Release), user tracking (the
  survivor's row wins where a user tracked both), ratings, reviews,
  favorites and comments.
  The loser keeps its ID and points at the survivor, so its URLs 301.
  A Release with Other Printings merges only into a physical Release,
  since only a physical Release has them. Release Variants merge only
  within one Release, so merge the Releases first. A variant merge moves at
  most 250 pins (Collection Entries and
  Bundle Memberships naming the variant). Split puts every pin back in one
  transaction, which reads several index ranges per pin; 250 pins of Owned
  entries, of memberships of one-Release Bundles, or of both, can be split.
  A merge that moved a membership of a Bundle with very many owners or many
  Releases can still be too large to Split
  ([known issues](known-issues.md#catalog-and-imports)). The merge form
  shows any of these refusals before you confirm.
- **Split** is the only way back from a merge. Every merge stores a
  `mergeManifests` row with each moved reference and removed row. Split
  replays it backwards, skipping references changed since, and reactivates
  the loser. A Release's Split decides its Other Printings first, writing
  nothing until each one has an answer: a printing row returns to the
  loser when nobody but the loser would claim its ISBN, stays with the
  survivor when the survivor claims it now (it took the ISBN as its own, or
  the merge found it a duplicate), and the Split is refused when anyone
  else claims it, when an ISBN coming back with the loser (its own, or that
  of a Release merged into it) would collide with a survivor's row, or when
  a claim cannot be followed. A merge's manifest keeps each moved row's
  ISBN: a row whose ISBN was changed since (not merely respelled) is a
  later decision and stays where it is (`changedSinceMerge`), and a row
  moved by a merge recorded before manifests kept the ISBN refuses the
  Split, since nothing shows the row still carries what the merge moved.
  Records of a printing go where the printing goes, including records
  linked to the survivor since the merge, with their mark and maturity as
  a link gives them; a record the survivor keeps keeps its mark. A record
  is a printing's when it is marked, or when the ISBN its snapshot states
  now has a printing row: a record linked as its Release's own printing
  goes with that printing once a correction makes it another one. A
  removed row comes back stored under its ISBN-13, whatever spelling the
  merge's manifest kept, so the barcode lookup and every check find it.
  A record
  that was unlinked or relinked by an audited decision since the merge,
  on the survivor or on any other Release it was linked to meanwhile (a
  repair unlink, a reviewed link that was not the record's first), refuses
  the Split, naming the Revision, because nothing can tell that link from
  the merge's: every Revision written since the merge is read once to find
  them. Both Revisions list each printing (`otherPrintings`: restored,
  kept on the survivor, or changed since the merge) and each record
  (`sourceObservations`: from, to, mark before and after). A Release Split
  decides at most 40 ISBNs, reads at most 400 of the survivor's records and
  1,000 Revisions written since the merge, moves at most 100 records,
  replays at most 4,000 manifest entries, and keeps each audit under 64
  KiB. It reads only the latest merge's manifests, never an earlier one
  already split. Every read it makes, of manifests, printing rows, claims
  and their merges, records and history, is one document at a time and
  only while the transaction can still read the largest document and keep
  its reserve; before writing it checks room for its writes, that reserve,
  and the fresh ownership check it makes after them (measured while it
  planned). Past any of these it refuses with the count or the metric,
  writing nothing, rather than meeting the platform's limit. The whole
  Split (finding who tracks what, planning, the replay, the Series,
  visibility, rating and maturity work after it, and the fresh check) runs
  as one nested mutation capped at what the transaction has left
  (`lib/bounded.ts`): past any of the seven limits anywhere in it, it is
  undone and refused as `badSplit`, never the platform's abort. Every
  Split, of any record, runs this way. A Series many records answer to is
  read once for all of them.
- **Lock** closes an active record to edits during a dispute; unlock when
  it is resolved. Hidden and merged records are locked by their status.
  Hide and merge refuse a locked record until it is unlocked.

## Combining reading paths

On a Series page, **Combine reading paths** opens the Reading paths section
of its Manage page. A Moderator or Administrator can select two to eight
standard publisher runs and show them as one shelf, in canonical volume
order. Choose a lead publisher, review the volume and gap preview, give a
reason, and confirm the change. Existing links to either run open the
combined shelf. Omnibus and deluxe Edition Lines stay separate.

This is a display choice for one Series. Editions, publisher attribution,
Releases, ISBNs, collection entries, and reading progress keep their original
identities. The personal library uses the same combined path. Runs with
overlapping volume coverage cannot be combined; any overlap imported later
remains visible on the shelf and in the moderator preview.

Each save creates an approved Proposal and a public Revision on the Series.
Competing changes to the grouping require reloading the choices. **Undo
combination** restores the separate publisher shelves and records its own
reason in history. A locked Series must be unlocked before either action.

## Packaging, bookless Series and held books

`/mod/packaging` ("Catalog gaps", `convex/packaging.ts`) has two panels,
kept in the URL. "Series without books" lists bookless Series with the ANN
entry that built each one. Each row offers "Add a release" (the
`/mod/propose-new` wizard), "Open series", and for Moderators "Hide or
merge…" (the manage page). Its search box and sort act on the rows loaded,
the oldest 100, and the panel says when more follow. "Unmapped packaging"
lists Unmapped Packaging, which a Moderator maps to Volumes (writing
coverage and a Revision). The duplicate-Series queue lives on
`/mod/launch`. See [imports](imports.md) for how both arise.

`/mod/imports` has three panels, kept in the URL: Sources, Held books and
Run history. Sources shows each source's health (healthy, or unhealthy
after three failed runs in a row) and its schedule (its cadence, or Paused
when it is switched off) in separate columns, unhealthy sources first.

The "Held books" panel of `/mod/imports` (`imports.heldBooks`) lists the
books an import observed but could not place, newest first, filtered by
kind and source. Each row shows the source's own title, link and ISBN, the
Series and label it proposes, the matched Series, and the reason. A book
leaves the list when an importer links its observation, queues a creation
Proposal for it (it is then in the review queue), or its source stops
listing it, and when the operator records it as another printing of a
Release ([operations](operations.md#recording-decided-other-printings)).
Books no one can place or that are out of scope are not listed. See [imports](imports.md#held-books) for the kinds.

"Prepare placement" on a row (`convex/placement.ts`) drafts a creation
Proposal for the book under its Series, authored by you and citing the
source's record, and opens it on `/mod/proposal/{id}`. That page shows what
the source says (title, label, line, publisher, ISBN, date, link) beside
what approval creates under the Series (the Volumes it covers, those it
creates marked new, the Edition and its line, the Release). Every Draft
arrives with no coverage: state the canonical Volumes it collects, first to
last (one Volume is a range of one), or mark it Unmapped Packaging under
its line, and save. A source's number does not prove one Volume (VIZ's
Alice in Borderland books are two-in-one), and a line's book number is not
a Volume number. For an ordinary book whose number fits the Series (at
most one past its last Volume, or a gap) the page suggests that Volume;
it is saved only if you accept it. Check that the book is the manga, not a
novel of the same title, and that its number is its Volume number. Until
the coverage is stated the Draft cannot be submitted. Then submit it like
any Proposal: an Editor's waits for a Moderator, and a Moderator may
approve their own, as with any Proposal. Readers cannot prepare. A
placement Draft is edited only on that page; the ordinary draft save
refuses it, and refuses a hand-written placement or an op marked to join
an existing record.

Approval refuses a placement whose source now names another work, line
or publisher than when you stated it (the Proposal shows as stale): ask
for changes and state it again against the source as it stands. A
position or coverage the source restates differently later does not
refuse it when the title's work and line can be read. For an unclear title,
its complete text must still match the reviewed source; a change requires
stating the placement again.

It does nothing for a book whose hold needs another decision first, and
says why: no single active, unlocked Series (link, unlock or merge it), an
ISBN or slot another Release holds (correct or merge that Release), a
publisher with no Publisher row, a box set, a book its source no longer
lists, or a book its source's checks put out of scope (a prose imprint, a
rebinder's copy). It never creates a Series or a Publisher.

While the Proposal is open the row stays, marked "Placement Draft" or
"Placement awaiting review" with a link. Your own Draft, or any Proposal
in review, opens on a second click; preparing a book another member has
an unsubmitted placement Draft for (one sent back by "request changes" is
a Draft again) withdraws their Draft, with a note saying why. A Draft the
book points at that does not place it is left as it is, and the book gets
a new Draft.
Approval creates the records and links the source's record to the new
Release, which takes the book off the list. The new Release's fields count
as human-authored, so a later differing value from the source (a date
slip, a binding change) queues a review Proposal instead of updating it.
If an import placed the same book meanwhile, approval reuses its Volume
and its matching Edition, and refuses rather than duplicate a Release with
the same ISBN. It refuses, writing nothing, when the book was withdrawn,
held as another kind or under another Series, given another ISBN or
format, linked, or the Edition it joins already has a Release in its
format, and it refuses a Release placed under a stored Edition instead of
one the Proposal creates or joins. It marks the Proposal stale when it
would join a hidden or merged Volume, when its Edition Line or exact
member cannot resolve to one active, unlocked identity, or when its Series
was hidden, merged or locked. Compatible merged lines and members join
their surviving identity; a locked active Volume can still be joined. After a
rejection the book is held again and can be prepared anew; its import
does not queue a creation Proposal of its own for it until its source's
record changes.
