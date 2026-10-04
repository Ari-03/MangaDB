# Moderation

How the Data Team (Editors, Moderators, Administrators) changes the
catalog. Every human and automated change goes through a Proposal, and
every approved change leaves a public Revision. Terms are defined in
[CONTEXT.md](../CONTEXT.md).

## Roles

Administrators appoint Moderators. Moderators appoint Editors. Editors
propose changes; Moderators and Administrators approve them
(`convex/roles.ts`, `convex/lib/roles.ts`). Every appointment, revocation,
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
comment and the source citation. Pending and rejected proposals stay
private to the Data Team.

**Human Overrides.** An approved human change to a field whose latest
Revision came from an import adds that field to the record's
`overriddenFields`. Imports may then report conflicts on it but never
overwrite it. The schema has a `clearOverride` op to lift an override, but
approval refuses it today (see [known issues](known-issues.md)).

## Proposals and the review queue

Any Data Team member drafts a Proposal (`proposals.saveDraft`) and submits
it (`submitProposal`). Submission needs a change comment. Factual changes
need source evidence, a URL or a Source Observation; editorial prose such
as synopses does not. Warnings (a new Series, more than 10 ops, partial
coverage) must be acknowledged. Submitting freezes the draft into an
immutable Proposal Version.

A Moderator then approves (applies every op in one transaction), rejects
with a reason, or requests changes with a reason, which returns it to
Draft. Resubmitting creates the next version. Authors can withdraw from
Draft or In Review. Reviewers never edit a version.

A Proposal an import wrote cannot be sent back for changes: no one can
revise an import's Draft, and no list shows one, so the book would be in
neither the review queue nor the held list. `requestChanges` refuses it
and the Proposal page does not offer the button. Approve it, reject it,
or edit the record directly.

Every update op records the record's base Revision. If any base moves
before approval, approval applies nothing and marks the proposal stale.
The author rebases it (`rebaseProposal`), reviews and resubmits. There is
no silent rebase.

One Proposal can create several records at once. Create ops may refer to
earlier create ops by temp-ID, so a Volume, Edition, coverage and Release
arrive together. The `/mod/propose-new/{seriesPublicId}` wizard builds
such a proposal. Imports use the same machinery for the creations they
queue.

Pages:

- `/mod/queue`: In-Review proposals, oldest first, filterable by operation,
  record type, author, warnings, staleness and age. Claiming signals who is
  looking and never locks.
- `/mod/proposal/{id}`: every version with before and after per record,
  bases, evidence, and internal discussion notes.
- `/mod/proposals`: your own proposals.
- `/mod/propose/{type}/{key}`: the Editor form, linked as "Propose a
  change" on record pages.

Limits, per user, through `@convex-dev/rate-limiter`: 30 submissions an
hour (burst 5) and 120 draft saves an hour (burst 20). A proposal holds at
most 25 ops.

Signed-in readers can report a problem from a Series page. The report
becomes a zero-op In-Review Proposal in the same queue (10 an hour, burst
3; `convex/reports.ts`).

## Hide, restore, merge, split and locks

`/mod/manage/{type}/{key}` ("Manage" on record pages) runs the sensitive
operations (`convex/sensitiveOps.ts`, engine in `convex/lib/sensitiveOps.ts`).
Each needs a written reason, shows an impact preview (observations,
revisions, relationships, child records, tracking) and needs explicit
confirmation, checked again on the server. Each applies as an immediately
approved Proposal, so the reason lands in public history.

- **Hide** sets `status` to `hidden`. The record leaves public discovery
  but keeps its ID, history and every tracking reference. **Restore**
  brings it back. Restore never undoes a merge.
- **Merge** moves everything from the loser to a survivor: observations,
  relationships, child records, user tracking (the survivor's row wins
  where a user tracked both), ratings, reviews, favorites and comments.
  The loser keeps its ID and points at the survivor, so its URLs 301.
  Release Variants merge only within one Release, so merge the Releases
  first. A variant merge moves at most 4,000 pins (Collection Entries and
  Bundle Memberships naming the variant), because Split replays them from
  one manifest document. The merge form shows either refusal before you
  confirm.
- **Split** is the only way back from a merge. Every merge stores a
  `mergeManifests` row with each moved reference and removed row. Split
  replays it backwards, skipping references changed since, and reactivates
  the loser.
- **Lock** closes an active record to edits during a dispute; unlock when
  it is resolved. Hidden and merged records are locked by their status.
  Hide and merge refuse a locked record until it is unlocked.

## Packaging, bookless Series and held books

`/mod/packaging` (`convex/packaging.ts`) lists Unmapped Packaging, which a
Moderator maps to Volumes (writing coverage and a Revision), and bookless
Series with the ANN entry that built each one. The duplicate-Series queue
lives on `/mod/launch`. See [imports](imports.md) for how both arise.

The "Held books" section of `/mod/imports` (`imports.heldBooks`) lists the
books an import observed but could not place, newest first, filtered by
kind and source. Each row shows the source's own title, link and ISBN, the
Series and label it proposes, the matched Series, and the reason. A book
leaves the list when an importer links its observation, queues a creation
Proposal for it (it is then in the review queue), or its source stops
listing it. Books no one can place or that are out of scope are not
listed. The rows have no actions yet; see [imports](imports.md#held-books)
for the kinds.
