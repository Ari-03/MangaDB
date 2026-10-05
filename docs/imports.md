# Imports

How catalog data gets in from outside sources, and how to run and set up
each source. Terms (Approved Source, Source Observation, Field Authority,
Bootstrap Mode and so on) are defined in [CONTEXT.md](../CONTEXT.md).
Commands to rerun after a deploy are collected in
[operations.md](operations.md#after-deploying-a-change).

## The pipeline

Each source has an adapter (fetch and parse) and a row in the Approved
Source registry (`approvedSources`, `convex/importSources.ts`). The row
holds the source's scope, a per-field authority map (authoritative,
standard or weak), its cadence, whether it is enabled, and the attribution
string for its covers. Scope, authority and cadence are data. Change them
with the Administrator-only `importSources.upsert` mutation or the Convex
dashboard, with no code change. A row without an adapter does nothing.

`seedRegistry` inserts the seven default rows and never overwrites an
existing one. `backfillFieldAuthority` adds authority categories a stored
row lacks (such as `description`, added 2026-09) without changing ones
already set:

```sh
npx convex run importSources:seedRegistry '{}'
npx convex run importSources:backfillFieldAuthority '{}'
```

| Key | Source | Cadence |
|---|---|---|
| `sevenseas` | Seven Seas | daily |
| `kodansha` | Kodansha release calendar | daily |
| `kodansha-backlist` | Kodansha back catalog crawl | weekly |
| `prh` | Penguin Random House API | daily, full sweep on UTC Sundays |
| `ann` | Anime News Network Encyclopedia | weekly |
| `openlibrary` | Open Library bulk dump | monthly |
| `yenpress` | Yen Press | daily |

Every fetched record becomes a Source Observation keyed by (source, source
record id) (`convex/lib/observations.ts`). Its `snapshot` holds the latest
normalized form, and every earlier snapshot is kept in
`observationSnapshots`. An unchanged fetch only bumps `lastSeenAt`.
Observations never write the catalog directly. Reconciliation reads them and
writes through Proposals, so every import change is a Revision that cites
the source name and record URL. Each record applies in its own mutation,
and write conflicts retry (`convex/lib/occ.ts`). The shared logic is in
`convex/lib/pipeline.ts`, `matching.ts`, `authority.ts`, `reconcile.ts`,
`catalogTitle.ts` and `unmatched.ts`.

## Matching ladder

`convex/lib/matching.ts`, strongest first:

1. The stored source-id link on the observation. A rename at the source is
   then a field conflict, never a failed match.
2. Exact ISBN-13, with a title-similarity check. A dissimilar title goes to
   review.
3. Publisher, normalized Series title, volume label and format, against
   Editions covering exactly that Volume. Automatic only with exactly one
   candidate that has no Human Override and no lock. A candidate that
   differs only in format is a sibling Release of the same Edition.
4. Title only: always review.
5. No match: the creation path.

Two plausible candidates anywhere queue a review. The importer never
merges. Multi-volume books skip rungs 3 and 4.

A title names the active Series with that primary title. An active Series
that carries it as an alternative title counts only when no Series, active
or hidden, has it as its primary title, so a book of a hidden "Kingdom
Hearts II" is held rather than filed under a parent listing that name. A
title ending in a roman numeral ("BARBARITIES II") is read as the whole
name first, and as the base Series' Volume only when an active base Series
exists and no Series has the whole name; when a hidden Series has it, the
book is held (`resolveBaseSeries` in `convex/lib/catalogTitle.ts`). So
merge a duplicate Series into the one you keep rather than hiding it: a
merged Series' title leads new books to its survivor, while a hidden one's
title holds them, even when an active Series carries that title as an
alternative.

Before ANN links an entry to a Series by title, `workMatch` checks that it
is the same work. A candidate is dropped when both sides know their
creators (ANN person ids) and share none, or both hold ISBNs in a shared
format and share none. A shared creator never proves a match, since a
spinoff shares its author. When neither tells, a candidate that another
live ANN entry is already linked to is dropped too, whether a title or an
alternative title named it: a Series ANN creates has no book until the
page pass, and in production no two ANN entries of one title share a
Series. A shared ISBN still links. When either rule drops the only Series
of the entry's title and ANN creates the entry's Series (Bootstrap Mode),
it records the two as a duplicate candidate with the reason, listed with
the duplicate sweep's pairs on `/mod/launch` (`launch.duplicateQueue`). In
steady state the queued creation Proposal names the dropped Series and the
reason in its comment. The cost is an entry whose id ANN replaced: the old
entry is withdrawn only when a complete mirror ends, so the new id arrives
while the old one still holds the Series, and unless that Series has one
of its ISBNs the new id does not link to it. In Bootstrap Mode it gets a
Series of its own, with a duplicate candidate only when its title named
the held Series; in steady state it gets a creation Proposal instead. A
stored link is never revisited, so entries already on one Series stay
there. The reasons are in [decisions.md](decisions.md#disjoint-isbns-mean-another-work).

## Authority rules

For each field, the incumbent is whoever wrote the latest Revision touching
it. Both ranks come from the live registry, so a registry edit changes the
next run.

- Strictly higher authority updates automatically.
- Equal authority queues a conflict Proposal, one open per observation.
- Lower authority is recorded on the observation (`conflicts`) only.
- A consistent, more precise date refines at equal or higher authority. A
  less precise date never replaces a more precise one.
- Any source may fill a blank field it has authority over.
- A source updating its own earlier value updates.
- Human Overrides are never overwritten. A conflicting import queues at any
  authority.
- Two different weak records disagreeing about a description never queue.
  The first text stays and the other is recorded.

Rejecting an import conflict writes a `conflictSuppressions` row keyed on
(record, field, source, offered value), so the same conflict never queues
again. It lifts when the source offers a different value, the observation
is withdrawn, or the rules route the field elsewhere.

## Creating records

In steady state an import creates a single-Volume Release under a Series it
is already linked to. A new Series, multi-Volume coverage, or Edition Line
packaging queues an In-Review Proposal pre-filled with the parsed guess, so
a correct guess is one click. `sourceObservations.queuedProposalId` keeps
one open queue item per observation.

Bootstrap Mode lifts both creation gates for initial seeding. Records that
steady state would have queued are created and tagged
`bootstrapUnreviewed` (`imports.bootstrapBacklog` lists them). Matching
ambiguity still goes to review. Turn it on with
`importSources.setBootstrapMode` (Administrator) or, before an Administrator
exists:

```sh
npx convex run importSources:setBootstrapModeInternal '{"on":true}'
```

**Packaging.** Omnibus, deluxe and n-in-1 books become Edition Line members
of the base Series only with known coverage: the title's own range first,
then the publisher blurb (`convex/lib/coverage.ts`), then a line name with
a fixed size (`FIXED_LINE_SIZES`, such as VIZBIG; ANN uses that size only
away from the line's end, below). Box sets become Release
Bundles under the same rule, in Bootstrap Mode only; any other box set is
held, and Kodansha places none. In Bootstrap Mode a named line's member
with no usable coverage is created as Unmapped Packaging, which a
Moderator maps at `/mod/packaging`.
Outside Bootstrap Mode such a book stays on its observation for an Editor,
as a Held Book (below).

**One path for unmatched books.** Seven Seas (`applyBook`), Kodansha
(`applyVolume`), and PRH and Yen Press (`applyCatalogTitle` in
`convex/lib/catalogTitle.ts`) hand a book that matched no Release to one
function, `placeUnmatched` in `convex/lib/unmatched.ts`. In order, it holds
packaging with no usable coverage, holds a book whose Series is locked
(`series`, in Bootstrap Mode too, with nothing created or queued, unless the
book has no publisher), queues a ladder flag for review, records a book with
no publisher, queues a title that names several Series, queues what a
steady-state gate stops (but holds a book whose new Series would recreate a
hidden work, even when its Proposal is already in review), and otherwise
creates the records. Queuing
first creates the publisher row if it is missing, or takes a merged row's
survivor, so approval finds it; a hidden row stays hidden, and approval
finds the Proposal stale. Each adapter keeps its parsing, its own series
links, the reconcile of an already linked record, covers and blurbs,
publisher resolution and box sets, and passes the note it holds packaging
with. Two differences are options of the function:

- Seven Seas, PRH and Yen Press create Unmapped Packaging in Bootstrap Mode.
  Kodansha's adapter does not place packaging: it passes no labels for it,
  so every such book is held, with a note that says so and quotes the
  coverage the book's own title states, else, when neither the title nor
  the series name states any Volumes (no range, no gapped list), its line's
  size. Kodansha reads a book's packaging from its series name, which every
  member of the line shares, so the note never quotes a range from it. The
  calendar titles a book "{series name} Volume N", so a title range equal
  to the series name's is not quoted either, even from a volume page whose
  own title repeats it, and the note then quotes no coverage at all. Under
  a series name that states Volumes the line's size is never quoted, since
  some spellings of that range ("… Vol. 1-3") are not read from the
  composed title, and the size could contradict the range it shows. The
  rule covers the ranges the title parser reads: a range spelled in words
  ("… Vol. 1 to 3") is read by neither, and the size is quoted beside it.
- A queued ambiguity quotes the book's title with the reason "ambiguous
  series" (PRH, Yen Press), or the Series title with the count (Seven Seas,
  Kodansha).

An apply that reaches this function, or a box set's placement, and does
not hold the book for a lock removes a lock hold an earlier apply left,
whichever way it ends from there (`holdUnderLock`), so the hold goes with
the lock the next time the importer places the book. An apply its adapter
ends earlier, at a scope gate, keeps the hold, and so does a record its
sync drops before any apply
([known issues](known-issues.md#catalog-and-imports)). Seven Seas, PRH
and Yen Press hold a box set the same way, with the same note, where
Bootstrap Mode would otherwise make it a Release Bundle under a locked
Series. A box set already placed as a Release Bundle still takes members
that arrive later when its Series is locked: like a linked Release, only the
bundle's own lock stops that.

A book already linked to a Release under a locked Series does not reach
this function. Its adapter reconciles the Release's fields as for any
linked book, unless the Release itself is locked. Seven Seas and Kodansha,
which keep series links, leave a locked Series' own title and blurb alone
(`reconcileLinkedSeries` in `convex/lib/pipeline.ts`).

`convex/unmatched.test.ts` runs the same book through all four sources for
each case.

### Bookless Series

A Series with Volumes and no book at all (usually an ANN backbone whose
releases could not be placed) is flagged `bookless` by the six-hourly
library rebuild. It leaves browse, search, the home shelf and the sitemap.
Its page still loads with a notice. Imports keep working on it, and the
flag clears on the next rebuild after a book attaches. `/mod/packaging`
lists the current set.

### Held books

A book an import observed but could not place, and that a person could,
is a Held Book. The importer records why as a `placement` note on its
observation, and lists the book in `placementHolds` with a kind while the
observation is unlinked, not withdrawn, and has no import's Proposal in
review:

| Kind | Meaning | Recorded by |
|---|---|---|
| `volumeMissing` | The Volume it names does not exist under a known Series and Publisher | ANN's page pass, Open Library |
| `packaging` | Packaging with no stated coverage or a Volume list no range holds, or a line member or box set steady state leaves to an Editor | Seven Seas, Kodansha, PRH and Yen Press, ANN's page pass, Open Library |
| `series` | No single active Series: hidden, ambiguous, locked or not linked | every importer |
| `isbn` | Its ISBN is on a hidden Release or another Series' Release, or its Volume already has the publisher's Release in that format | ANN's page pass, Open Library |
| `other` | ANN names no distributor, or one that resolves to no publisher row | ANN's page pass |

A book no one can place, or that is out of scope, keeps its note for the
record but is not listed: an ANN line with no ISBN, a variant cover, a
prose imprint or a foreign-language distributor, and the Open Library
editions described under "Open Library" below.

While an import's Proposal of a book is in review, the book is the review
queue's: queuing a creation Proposal removes the hold and its note, and a
hold recorded meanwhile is a note only. The observation's
`queuedProposalId` stays after the Proposal is decided (and conflict and
cancellation reviews set it too), so only the Proposal's state counts:
once it is approved, rejected or withdrawn, the next hold lists the book
again. A Data Team member's placement Proposal (below) works differently:
the book stays listed, marked by that Proposal's state, so a rejection
leaves it held at once.

A hold keeps the time it was first held while the importer sees the same
kind again, and moves to the top when its kind changes. Linking the
observation to a record (`linkObservation` in
`convex/lib/observations.ts`, which every importer and repair uses) removes
the hold and its note, and so does withdrawal; a withdrawn book that
returns is held again at its next placement. A linked box set whose
Release Bundle names another Series keeps its note but is not held. A
lock hold goes at the importer's next placement of the book after the
unlock, not at the unlock itself, and until then the book stays listed
under a lock that no longer exists; for Seven Seas, or a book that has
since gone out of scope, that can be indefinitely
([known issues](known-issues.md#catalog-and-imports)).

`/mod/imports` lists Held Books newest first (`imports.heldBooks`, Data
Team), filtered by kind and source, with the source's title, link and
ISBN, the Series and label the source proposes, the matched Series, the
reason, and when it was first held and last listed.

**Prepare placement.** Each row has a "Prepare placement" button
(`placement.preparePlacement`) that writes a Draft creation Proposal
authored by the member, citing the observation, and opens it. The ops come
from the importers' own builder (`creationOps` in
`convex/lib/pipeline.ts`): any Volume the book needs that the Series lacks,
the Edition (in the line the source names, created if the Series has no
such line from that publisher) and the Release with the source's ISBN,
format, binding, date, price and blurb. It applies to a `volumeMissing` or
`packaging` hold whose Series is active and unlocked, whose publisher
resolves to a Publisher row, whose ISBN no active Release holds, and that
its adapter's own checks keep in scope (a rebinder's copy, a variant cover,
a box set, a prose imprint ANN names, or a title Yen Press holds out of
scope are refused). Open Library drops only a title that says it is a
novel, and Yen Press's out-of-scope ISBNs, so a light novel whose title
does not say so can reach the list under a manga of the same name: the
member checks it. Anything else is refused with the reason and keeps its hold:
`series` holds need a Series chosen, unlocked or merged first, `isbn` holds
a correction or merge of the Release that has the ISBN or slot, and
`other` holds a Publisher row. It never creates a Series or a Publisher.

Every Draft starts with its coverage unstated; the member states it on
the Proposal page (`placement.setPlacement`): a range of canonical
Volumes, one Volume, or Unmapped Packaging under its line. Until then the
Draft cannot be submitted. A source's number is not proof of one Volume:
VIZ's English Alice in Borderland books are two-in-one with no line word
in their titles. The page suggests one Volume, which the member must
accept, only when today's title parser, run over the stored title beside
the snapshot's stored flags, reads an ordinary single book (no line, no
packaging or multi-volume signal, not a novel), its label is a plain
number, and that number is at most one past the Series' highest numbered
active Volume or fills a gap below it. Every placement shows a caution to
check that the book is the manga, not a novel of the same title, and that
its number is its Volume number. A book number on a line is a position in
the line, so "Vagabond Definitive Edition, Vol. 4" never becomes Volume 4,
and the line's name never sizes the range. An ANN book's line is read as
the page pass reads it, against the title of the Series it is held under
and its manga entry's, so a missing, renamed or relinked entry never makes
"Makunouchi Deluxe [VIZBIG Edition]" a Deluxe book under Makunouchi
Deluxe; a title still unclear ("Alpha [VIZBIG Edition] [Omnibus]") leaves
the line unselected for the member to name. A range that would need more
than 25 ops is refused, as any Proposal over the cap is.

Only `convex/placement.ts` writes a placement: `saveDraft` refuses a
create op carrying `placement`, and refuses to replace a placement
Draft's ops (`placementDraft`). One check (`placeable`) decides whether a
book can be placed, when the Draft is prepared, when its coverage is
stated, at submission and at approval. Besides the conditions above, the
Proposal must be the one the observation's `queuedProposalId` points at,
its one placed Release must carry the book's ISBN-13, ISBN-10 and format
under the Series the hold names, every Volume and line it creates or
covers must be in that Series, and the Edition it joins must not already
hold a Release in that format (the slot an `isbn` hold guards).

The observation's `queuedProposalId` points at the Draft. A second click
by its author, or by anyone once it is in review, opens it; another
member's click withdraws an unsubmitted Draft, notes why on it, writes
their own and points the observation at it. Approval creates the records
and links the observation to the new Release in the same transaction
(`linkObservation`), which removes the hold and applies the book's 18+
evidence. If an import created the same records while the Proposal
waited, approval reuses a Volume of the same label and an Edition with
the same publisher, line, position and coverage. A matching record it may
not join (a hidden Volume or one merged away, a hidden, merged or locked
Edition, a hidden or merged line) makes the Proposal stale, as does a
Series hidden, merged or locked meanwhile. When the book was withdrawn,
re-held as another kind or under another Series, given another ISBN,
linked, or its slot taken, approval refuses (`invalidCreate`) and writes
nothing. Rejecting or withdrawing the Proposal leaves the book held, ready
to prepare again; after a rejection the import does not queue its own
creation Proposal for the book until its snapshot changes
(`alreadyHandled`).

Holds recorded before the list existed, and Open Library editions skipped
without a note, reach it through a backfill. It pages over every
observation, ten at a time, continues itself, fetches nothing and writes
no canonical record. An observation that already has a hold keeps it as
its importer wrote it (kind, first-held time, matched Series). Otherwise
the backfill holds unlinked notes under the kind their reason names and
leaves the unlisted ones as notes, classifies unlinked Open Library
editions as the next run would, and drops `placement` notes left on
linked observations (not on a Release Bundle). It removes only holds that
are no longer held: a book whose import's Proposal is in review, an ANN line no one
can place or that its stored title or page puts out of scope (a variant
cover, a prose imprint, a foreign-language distributor), or an Open Library
edition the next run would skip or leave to the ladder's flag. The book in
review and the Open Library edition lose their `placement` note too, on
the first run as on any other, and the ANN line's note is rewritten to
say why it is out of scope. Withdrawn
observations are left alone. Run it once after deploying the list; it is
safe to rerun:

```sh
npx convex run imports:backfillHolds '{}'
```

A page that fails (a transaction limit, say) ends the chain, and the
error is in the function's logs. Rerun the command: it starts again from
the first observation, and redoing the pages already done is harmless.

## Descriptions

Publisher blurbs import as the Release Description and the Series synopsis
under the `description` authority column. Seven Seas, Kodansha and Yen
Press are authoritative, PRH is standard, ANN and Open Library are weak and
only fill blanks. Pages show one description per book (see
[product](product.md#volume-edition-and-bundle-pages)). Seven Seas rereads a
book whose description an aggregator wrote, so its own blurb replaces it.

ANN's release pages carry publisher copy that ANN contributors entered, the
only approved source of blurbs for VIZ. Open Library editions carry
contributor-written descriptions of uneven quality. Two operator commands
fill existing Releases (details under each source below). Run the ANN
backfill before the Open Library replay. The first weak text to fill a
blank keeps it, and ANN's text is the better one.

## Author credits

`people.rebuild` (`convex/people.ts`) derives `people` and `seriesCredits`
from stored observations every six hours, with no network access. ANN's
staff credits come first, with roles and stable person ids. For a Series
ANN does not credit, PRH's `author` line supplies names and roles. For a
Series neither credits, Kodansha's and Seven Seas' role-less creator names
do. PRH credits are unioned across a Series' volumes, and near spellings
of one name collapse to the most used. When ANN starts crediting a Series,
its publisher-derived rows go, and ANN adopts a publisher-named person
with a matching name key. A name-only person left uncredited by two
successful rebuilds in a row is pruned. Publisher credits never count as
evidence in `workMatch`.

The rebuild runs in phases (rekey, ANN, publishers, sweep, settle roles,
prune, stats)
and hands off to a fresh action after five minutes. A run marks each
credit it derives, and keeps its PRH tallies, in `seriesCreditRuns`, not
on the credit. Every Series page reads its credits, so a credit row is
written only when its person or role changes, and a run that finds
nothing new invalidates no page. The sweep deletes the credits whose run
row is older than the run. Rows written before that table existed carry
their marks themselves. The first run to derive one moves the marks off
it, and one that no run derives is swept by its own mark. A run cut off
by the deploy that brought the table starts over when its next action
begins, since its settle step would miss the rows it had already marked
the old way. An action already running when that deploy lands can still
finish its settle step without those rows; a role it should have lowered
or a spelling it should have folded then waits for the next 6-hourly run,
which settles it. `npx convex run
people:rebuild` returns after the first action. For ANN observations stored
before credits were kept, `npx convex run people:backfillAnnCredits`
fetches them at ANN's rate and then rebuilds.

## Sources

### Seven Seas

`convex/sevenSeas.ts`, parsers in `convex/lib/sevenSeas.ts`. Pages through
the WordPress REST API (`wp-json/wp/v2/books`), using `modified_gmt` as the
change signal, and fetches the book page only for new or changed records.
Skips light novels and audiobooks. Covers are stored in Convex file
storage. A run fetches at most 200 book pages, newest-modified first, so
the first backfill takes several runs.

The parser reads the age-rating badge and the imprint block that sit
between the book's cover and its metadata, and nothing elsewhere on the
page. The snapshot's `mature` is the badge alone: true for Mature (18+),
false for Teen and Older Teen. It keeps the badge's id as `ageRating`, the
imprint as `imprint`, and the version of the parser that read the page; a
run re-reads pages an older version read, within its 200-page budget. An
adult-only imprint (Ghost Ship, Steamship) makes the Series mature
whatever the badge says, as it does on a PRH title, while the Edition
stays under Seven Seas ([product](product.md#mature-titles)). After a
deploy that changes any of this, follow
[Mature evidence after a deploy](operations.md#mature-evidence-after-a-deploy).

```sh
npx convex run sevenSeas:sync '{}'                        # full sweep, ≤200 detail fetches
npx convex run sevenSeas:sync '{"maxDetailFetches":1000}' # bigger backfill bite
npx convex run sevenSeas:sync '{"maxListingPages":1}'     # quick smoke (no withdrawal pass)
```

### Kodansha

`convex/kodansha.ts`, parsers in `convex/lib/kodansha.ts`. Two feeds share
one observation per (volume, format) and one apply path, and one announced
volume becomes one Release per format under a shared Edition. A shared
scope gate (`outOfScopeReason` in `convex/lib/bookTitle.ts`) keeps novels,
picture books and other non-manga products observed only. Neither feed
withdraws.

- **Release calendar** (`kodansha:sync`, row `kodansha`). First-party JSON
  for about eight weeks of releases plus this week's new releases. No ISBNs
  or prices. Covers are stored.
- **Back catalog** (`kodansha:backlistSync`, row `kodansha-backlist`).
  Crawls the series listing, each series page and each volume page at one
  request a second. A volume page's JSON-LD gives ISBN, date and US price
  per format. The ISBN runs the ladder first, so the crawl links Releases
  PRH or ANN already created. Packaging pages map onto the base Series by
  ISBN or stay on the observation. No covers are stored.

The crawl is incremental. A series is crawled whole when new, when its
listing stamp changes, or after 180 days, and otherwise only its upcoming,
recent, undated and failed volume pages are rechecked. A series is marked
crawled even when one of its volumes failed to apply, so rerun specific
series by slug:

```sh
npx convex run kodansha:sync '{}'
npx convex run kodansha:backlistSync '{}'
npx convex run kodansha:backlistSync '{"onlySeries":["blue-lock","initial-d"]}'
```

### Anime News Network

`convex/ann.ts`, parsers in `convex/lib/ann.ts`. The all-publisher
backbone of Series and Volumes, including VIZ and Square Enix, whose sites
are never scraped. It mirrors the Encyclopedia API at one request a second
(50 entries per request), chaining itself under one Import Run. One manga
entry is one Series, and its "(GN n)" and "(eBook n)" release lines define
Volumes. Each line links to the Release with its ISBN, else to the one
same-label, same-format Release under the linked Series. The plot summary
fills a blank Series synopsis.

A completed mirror chains the release-page pass (`ann:syncReleasePages`).
Each unlinked line's page (distributor, ISBN, date, price, description) is
fetched once and stored. The line then links by ISBN, or becomes a leaf
Release under an existing Volume when the distributor matches a publisher
row. It never creates a Series, Volume, publisher, variant cover, prose
imprint, or a second same-format Release of a Volume from one publisher.
Packaging (an Edition Line member placed by its stated range, else its
line's size, else as Unmapped Packaging) is created only in Bootstrap Mode
and held in steady state; box sets only link by ISBN. Lines it cannot
place are Held Books, except lines no one can place or that are out of
scope (no ISBN, a variant cover, packaging whose title marks a novel, a
prose imprint, a foreign-language distributor), which keep only their
note. Scope is
checked right after the ISBN link, before any other hold, so an
out-of-scope line is never held for its packaging, its Series or its ISBN.

A line's coverage is what its designator says after the format marker
(GN, OGN, graphic novel, eBook) and a "box" or "ex" qualifier, up to an
"/ N" total; a number before the marker ("(2nd Edition GN 1-3)", "(3-in-1
Edition GN 1)") is never coverage. One number is the line's Volume. More
is read whole with the shared list grammar (`statedList` in
`convex/lib/bookTitle.ts`): a range ("(GN 97-99)") or a contiguous list
("(GN 1, 2, 3)", "(GN 1 & 2)") covers the Volumes it spans. A list no
range holds (a gap such as "(GN 1, 3)" or "(GN 1, 2, and 4)", a numbered
extra such as "(GN 1-2 + 3)", a number smaller than the one before it, a
dash chain, or text the grammar does not read) marks the line
`coverageGapped`, never a shorter list or a single Volume: it is
multi-volume with no label, adds no Volume to the backbone, and the page
pass holds it as `packaging`, quoting the page's designator, instead of
sizing it from its line name ("3-in-1") or placing it on a Volume. It
still links by ISBN to a Release of its Series. A line with no number
("(GN)") is an unnumbered book, as before. The hold goes when a later
mirror reads the line as a range and the page pass places it, or when
someone links it. A line already linked keeps its link, since an import
never moves one. Lines the line-size rule placed before this check are
not reported; after one mirror their `release:` observations carry
`coverageGapped: true` beside a `recordRef`, which is how to find them.

A line is packaging when its designator says so ("(Omnibus GN 1-3)",
"(GN box 2)") or its title names an Edition Line, bracketed or not
("Vagabond [VIZBIG Edition]", "Attack on Titan [Colossal Edition]",
"Death Note - Library Edition"). The line names are the shared title
parser's (`EDITION_LINE_NAME` in `convex/lib/bookTitle.ts`). A line word
the manga entry's own title accounts for is the work's, not a line:
"Makunouchi Deluxe (GN 2)" is a Volume, while "Makunouchi Deluxe [VIZBIG
Edition] (GN 1)" and "The Omnibus Club [Colossal Edition] (GN 1)" are
VIZBIG and Colossal books (`readAnnLineTitle` in `convex/lib/ann.ts`). An
article before the line's name is the line's: "Dark Metro - The Ultimate
Edition" is Dark Metro's Ultimate Edition, while "The Dark Metro" keeps its
own. The line adds no Volume to the backbone. The line's name is the
recognized name alone, with any words its bracket adds that hold no number
("[Side Story VIZBIG Edition]"); a number beside it is never part of it, so
"Alpha [VIZBIG Edition Vol. 2]" is VIZBIG Edition. Its book's position is
every number or upper-case Roman numeral the title states for it: right
after the line's name or inside its bracket ("Alpha VIZBIG Edition 2",
"Alpha [VIZBIG Edition] II", "Alpha [VIZBIG Edition Vol. 2]", "One Piece -
[Omnibus] 33 - Wano"), or marked in a tag ("(Vol. II)", "[Book 3]", "(GN
12)"), and the designator's single number: "Vagabond [VIZBIG Edition] (GN
1)" is VIZBIG Edition 1, which the line's size places on Volumes 1–3. A
designator's range is the book's coverage, never its position, and so is
any list in the title. Positions that differ ("Alpha VIZBIG Edition 2 (GN
1)", "Alpha [VIZBIG Edition] (Vol. II) (GN 1)"), or one the grammar cannot
read ("(Vol. ii)", "(Vol. two)", "(Vol. -2)", "Book Two"), hold the book;
the designator's number never stands in for them. A line the title names
stays that line even where the general parser reads no position for it.

What the book collects comes from its explicit coverage first, else from
its line's size (`packagingOf` in `convex/lib/ann.ts` reads every
statement together). The statements are the designator's list, a Volume
statement in brackets at the end of the title ("Rurouni Kenshin - VIZBIG
Edition [13-15] (GN 5)" is VIZBIG Edition 5 covering 13–15), and every
statement in the line's own segment, each read whole: a list inside its
bracket, after its name or in a tag ("Alpha [VIZBIG Edition Vols. 4-6] (GN
1)", "Alpha VIZBIG Edition 4-6 (GN 1)"), and a collect statement in a
subtitle or tag, read by the blurb grammar to its end ("Alpha VIZBIG
Edition 1: Includes Vols. 4-6 (GN 1)" covers 4–6, "...: Includes Vols. 1-3
plus 4-6" 1–6). A plain multi-volume line's own bracketed range is
coverage too: "Alpha [1-3] (GN 1-3)" is an Omnibus covering 1–3, unless
the Series' or entry's own name ends in that bracket. A statement no range
holds holds the line as a gapped designator does, whatever other statement
is valid, and is never replaced by the line's size: a gap ("[1, 3]", "[1
and Vol. 3]", "Includes Vols. 1-3 plus 7-9"), a dash chain ("VIZBIG
Edition 1-3-5"), a backwards range ("6-4"), a range Coverage cannot list
("1.5-3.5", "1-80"), a statement read only in part ("Includes Vols. 4-6
and Volume 7 of Beta"), two that differ ("[4-6]" or "Includes Vols. 4-6"
beside "(GN 1-3)"), or a number in the segment read as neither position
nor coverage ("(Part 2)"). Only a reissue or binding tag ("[2nd Edition]",
"(Hardcover)") and words with no number are passed over. A box set's name
("[Box Set - Part 1]") is the bundle's, never read so. The mirror stores
a rejection in the line's `coverageGapped`, and the page pass reads the
title again, so a line stored before reads the same; a stored range
Coverage cannot list is held too, never left unmapped. A valid explicit range places its
book wherever it falls, a shorter
last book included ("[7-8]" as the last book of a Series ending at 8). An
"n-in-1" name states its size and keeps it to the end. Coverage inferred
only from a size the name implies (VIZBIG 3, Colossal 5 and the other
`FIXED_LINE_SIZES`) is used only when size − 1 books follow the book, both
by the Series' highest active Volume and by ANN's own count of the line's
books when the page gives one ("(GN 5 / 5)"); the last books of a line may
hold more or fewer. VIZ put Inuyasha's 56 Volumes in 18 VIZBIG books, 17
and 18 holding four each, so those two, like any book that near the end,
go unsized. Nothing checks that the Series is finished: a backbone still
growing, or a line abandoned before the Series' end, only leaves more
books unsized. Where implied sizing declines, Bootstrap Mode creates the
book as Unmapped Packaging, and steady state holds it for review, as it
does every packaging creation. These endpoint checks are ANN's; other
importers size a line's books from the name alone.

Some packaging is held as `packaging` for an Editor, never placed:

- A line whose work is not the Series' own. The work is the title before
  the line's name, every number and mark kept ("Kingdom Hearts II [VIZBIG
  Edition]" is Kingdom Hearts II, "Alpha 2 [VIZBIG Edition]" Alpha 2), and
  it must name the Series' title up to case, accents, full-width forms,
  entities, apostrophe and dash glyphs, "&"/"and" and spacing
  (`sameWorkTitle` in `convex/lib/matching.ts`): Citrus+ is not Citrus,
  Bastard!! not Bastard, E'S not ES, and "Dragon Ball Z [VIZBIG Edition]"
  in ANN's Dragon Ball entry numbers Z's Volumes, stated or not. The
  entry's own title is no anchor: its Series link may be an old, wrong
  one. A renamed Series, or another spelling than these, holds too.
- A line whose title leaves its work unclear: two line names beyond the
  entry's own ("Makunouchi Deluxe [VIZBIG Edition]" in an entry of another
  name), no work before the line's name, or words after it that no
  position, tag or subtitle explains.
- A line whose title and designator name different positions, or whose
  statements of coverage no range holds or disagree (above).
- A line's last book by ANN's count ("(GN 9 / 9)") whose stated range
  ends before the Series' highest Volume, since the last book takes what
  is left ("Rurouni Kenshin - VIZBIG Edition [25-27]" collects 25–28). A
  stated range is never extended.

Packaging whose title marks a novel ("Alpha (Light Novel) [VIZBIG
Edition]") is out of scope and keeps only its note, whatever its
distributor. A line with no known size ("[Library Edition]") places as
Unmapped Packaging. A reissue, binding or variant tag names no line
("[2nd Edition]", "[2nd Ed]", "[Revised Edition]", "[Hardcover]",
"[Limited Edition]"), and neither does an anniversary reprint, which ANN
numbers by Volume ("NANA - [25th Anniversary Edition] (GN 2)"): those
lines stay single Volumes, and one whose Volume already has the
publisher's Release in its format is held as a reprint (`isbn`). A line
held as a reprint before this rule is read again by the next mirror, and
the page pass after it handles the line as packaging. A line linked to a
Release before then keeps its link: this rule never moves or unlinks one.

The page's description fills
a blank Release Description at weak authority, and the pass refetches up
to 2,000 linked pages a run to read descriptions. Citations link the
Encyclopedia, as ANN's license requires.

```sh
npx convex run ann:sync '{}'
npx convex run ann:sync '{"releasePages": false}'          # skip the chained page pass
npx convex run ann:backfillDescriptions '{"limit": 300}'   # fill existing Releases now
npx convex run ann:backfillDescriptions '{"annIds": ["10948", "23227"]}'
npx convex run ann:repairDescriptions '{}'                  # re-clean stored text, no fetches
npx convex run ann:listRefreshCandidates '{}'               # ids whose stored text needs a refetch
npx convex run ann:backfillDescriptions '{"annIds": ["10948"], "refresh": true}'
```

`ann:backfillDescriptions` fetches at one request a second, continues
itself, and runs even when the source is disabled. It refuses to start
while an ANN Import Run is running, unless that run is stranded (see
"Stranded runs" below), which it ignores. It stops after 5 failed fetches
in a row, logs why it stopped, and never touches a withdrawn line.

Every ANN description goes through one cleaner (`cleanAnnDescription` in
`convex/lib/ann.ts`). It removes ANN's review link, its "Notes:" section,
mojibake and C1 control characters, stray entities, and the credit ANN
appends ("Story by X and Art by Y."), which the byline already shows. A
credit goes only when it opens a sentence, or is the fused "Story and art
by" glued to the text, so "…based on the series created by X and written
by Y." stays whole. A text that is only retail or listing junk ("Book is
in like-new condition.", "Book by Buronson") becomes no description. The
page fetch decodes bytes itself, so a Windows-1252 byte in ANN's UTF-8
page becomes its character, not U+FFFD.

`ann:repairDescriptions` applies today's cleaner to text stored before the
cleaner changed. It makes no network requests, updates or clears a Release
only when ANN wrote its current text from that line, continues itself, and
logs its counts at every hand-off and at the end. It is safe to rerun and
safe beside a running backfill.

Text a past cleaner cut short cannot be repaired offline.
`ann:listRefreshCandidates` lists the ANN ids by reason (`danglingEnd`,
`replacementChar`, `c1Control`). `ann:backfillDescriptions` with those
`annIds` and `"refresh": true` refetches exactly those pages and replaces
the text ANN wrote, never a publisher's, Open Library's or a human's. It
only replaces: a page with no description, or with text under half as
long, is counted as `held` and left alone unless `"allowClear": true` is
also passed.

### Penguin Random House

`convex/prh.ts`, parsers in `convex/lib/prh.ts`. The authoritative date,
ISBN and price overlay for books PRH distributes. Every request uses the
imprint path `/imprints/{code}/titles`, because the flat `/titles` endpoint
ignores its `imprint` and `onsaleFrom` parameters. Daily runs page each
imprint newest first and stop at the first title dated before today. UTC
Sunday runs, or `{"mode":"full"}`, sweep each configured imprint's whole
catalog. `{"imprints":["XO"]}` sweeps a subset. Only a complete full sweep
withdraws. Run errors never include the API key.

Unmatched titles follow the creation rules under the imprint's publisher
row from `convex/lib/publishers.ts`. Prose, merchandise, samplers and
non-English editions are dropped, and the "Vertical" prose and "Waves of
Color" imprints are refused.

Setup (no live key is stored in this repo):

```sh
# 1. Request a key at developer.penguinrandomhouse.com (manual activation).
# 2. Once active, list imprint codes:
#    curl "https://api.penguinrandomhouse.com/resources/v2/title/domains/PRH.US/imprints?api_key=KEY"
#    and pick the manga imprints. As of 2026-09: XO Seven Seas, XP Ghost
#    Ship, 123 Steamship, KM Kodansha Comics, V4 Vertical Comics, 41 Square
#    Enix Manga, KN Dark Horse Manga, 334 Dark Horse Manhwa, 140 Titan
#    Manga, 209/206/210/344 TOKYOPOP (+LoveLove, Classics, Kids), 204 Disney
#    Manga, 205 International Women of Manga. Never the plain "Vertical"
#    (VT) imprint, which is Vertical's prose line, nor 182 Manga UP! (single
#    digital chapters) or XR Airship (light novels).
npx convex env set PRH_API_KEY <key>
npx convex env set PRH_IMPRINT_CODES CODE1,CODE2,CODE3
npx convex run prh:sync '{"mode":"full"}'
```

PRH needs the key and a non-empty imprint list (`PRH_IMPRINT_CODES`, or
an `imprints` argument). Without them a fresh call skips as
"unconfigured" and opens no run. A link handed off mid-run carries its
imprint list, so removing `PRH_IMPRINT_CODES` has no effect on it.
Removing `PRH_API_KEY` mid-run closes the run as `failed` at its next
link, with one exception: an automatic run whose source is also disabled
closes as `stopped` (see "Disabling a source" below).

### Open Library

`convex/openLibrary.ts`, parsers in `convex/lib/openLibrary.ts`. Fills
ISBNs (standard), dates (weak), binding (standard) and a blank description
(weak) on records that already exist. It never defines Series structure.
An unmatched record may create only a leaf Release under a Series, Volume
and publisher that all exist already, which is how most VIZ print Releases
appear under the ANN backbone. It never queues reviews and never
withdraws. An edition a person could place, with a known publisher and at
least one active Series of its title, is a Held Book (`placeEdition`): its
title names several Series, or names one whose Volume is missing, whose
Series is locked, or whose Volume already has that publisher's Release in
its format; its packaging cannot be mapped; or the matching ladder flagged
it (`isbn` for its ISBN or a taken slot, `series` for a same-titled
Series), in which case the flag also stays on the observation as a `match`
note. So is an edition with a known publisher whose title names no active
Series but a hidden one, unless that Series' books are all from another
house (`series`, as the catalog feeds hold it). The `match` note lasts
only while the ladder flags the edition, and the observation's other notes
stay beside it. An edition with no Series match, an unknown publisher, or an ISBN
Yen Press holds out of scope is skipped and listed nowhere; a ladder flag
on such an edition stays only as its `match` note. Library rebinds (Turtleback, Perfection Learning) never count
as publishers. A Volume gets at most one Open Library leaf per (publisher,
format). Only English editions enter: a non-English language, a
non-English ISBN group (978-4 and the like), or no language and no
English-market ISBN (978-0, 978-1, 979-8) is skipped, as are novels.

The raw editions dump is about 10 GB, so filter it offline (publisher
allowlist, ISBN required) and host the result at any static URL:

```sh
curl -sL https://openlibrary.org/data/ol_dump_editions_latest.txt.gz \
  | node scripts/filter-openlibrary-dump.mjs > filtered.txt
# host filtered.txt (any static URL), then:
npx convex env set OPENLIBRARY_DUMP_URL https://…/filtered.txt
npx convex run openLibrary:sync '{}'   # streams + self-continues to the end
```

Without `OPENLIBRARY_DUMP_URL`, runs skip as "unconfigured".

A run is a chain of links under one Import Run. A link hands off to the
next at the first line it reaches ten minutes after its start, or after
20,000 dump lines, whichever comes first (`LINK_BUDGET_MS` and
`DEFAULT_MAX_LINES` in `convex/openLibrary.ts`), and applies at least one
line first. Ten minutes is not a maximum. Time is checked only between
lines, so a link overruns it by the line it is applying and a gate check,
and by the next stream read. Neither a stream read nor the skip of the
lines earlier links processed has a deadline: a stalled read, or a slow
download of that prefix, can carry a link to Convex's 30-minute limit. A
line bound alone was not enough: on staging on 2026-10-04 a link read
about 1,000 dump lines every 2.8 minutes beside the Held Books backfill
and a Yen Press sync, so 20,000 lines would have needed about 56
minutes. The link stamped its last gate 28 minutes in and never handed
off, and its run stayed `running`.

Each continuation downloads the dump again from its first byte and skips
the lines earlier links processed, and that download counts toward its
ten minutes. The cost is accepted
([decisions](decisions.md#open-library-continuations-read-the-dump-from-the-start)).

`maxLines` lowers the line bound for every link of the run. With
`noContinue: true` the sync closes its run after one link, ended by
`maxLines` or its ten minutes, instead of scheduling the next, and its
result's `nextLine` says where it stopped: a one-link probe of a new
dump is `npx convex run openLibrary:sync '{"maxLines": 200, "noContinue":
true}'`. `startLine` (0-based) starts at a given line, to reprocess from the
line a run's error names (`dump line N`).

An edition observed before its Release existed stays unlinked, so its
description never reaches the Release on its own. The replay re-applies
stored, unlinked editions that carry a description and whose ISBN an active
Release now holds, with no network access. They link by ISBN and fill a
blank description; nothing is created. Run it after the ANN backfill:

```sh
npx convex run openLibrary:replayDescriptions '{"limit": 500}'
```

Open Library descriptions go through `cleanOlDescription`
(`convex/lib/openLibrary.ts`). A cataloguer's physical description
("1 volume (unpaged) : 19 cm") is no description, and a trailing citation
(`"--P. [4] of cover.`, `"--Back cover.`) is dropped with the quote it
closed. `npx convex run openLibrary:repairDescriptions '{}'` fixes stored
text with no network access. It rewrites a Release only when Open Library
wrote its current text from that edition.

### Yen Press

`convex/yenPress.ts`, parsers in `convex/lib/yenPress.ts`. Yen is
distributed by Hachette, so PRH never carried it. `yenpress.com/sitemap.xml`
lists every title page. A run fetches, at one request a second, only books
that are new or due: weekly while the date is upcoming or within 60 days,
every 180 days otherwise. Each page gives one snapshot per format, placed
like PRH's titles at own-catalog authority. Yen On, Yen Audio, JY, light
novels, audio, single chapters and Western comics stay observed only,
except Ize Press manhwa. The sitemap has no lastmod, so this adapter never
withdraws.

```sh
npx convex run yenPress:sync '{}'
```

## Publisher rows

`launch:seedPublishers` (`convex/lib/publishers.ts`) writes the canonical
publisher rows, including defunct distributors ANN names and imprints
under their parents. ANN's release pages and Open Library resolve a
distributor name against these rows and create nothing for an unknown one.
The hourly import tick runs it before starting any source, so a fresh
deployment gets the rows on its first tick. It also marks the adult-only
publishers (`adultOnly`).

## Steady state

`convex/crons.ts` runs `imports.runScheduled` every hour. It reads the
registry and starts every enabled source that is due by its cadence string
(`daily`, `weekly`, `monthly`), so cadence edits apply on the next tick.
A source whose last run is still `running` is skipped, unless that run is
stranded. A failed run resumes at the next cadence.

**Stranded runs.** A chain can die without closing its run: an action
ended at Convex's 30-minute limit for actions in its default runtime, where
every adapter runs, a crash outside the adapter's error handling, a
continuation that fails validation after a deploy. A run records
`lastActivityAt` when it opens, at every gate check (listed below), and
when a link schedules its continuation; each gate check and hand-off also
stores the run's counts and errors so far. Inside a link, the longest gap
between two stamps is bounded by the action limit, since no fetch has a
timeout of its own. Between links, it is the scheduler's delay in starting
the next one, normally seconds. A `running` run with no activity for 60
minutes, the action limit with 30 minutes to spare, has lost its chain. The
next hourly tick closes it as `failed`, with the counts and errors it last
stored, an error saying it was stranded and when it was last active, and
starts the source if it is due. The failure counts toward the source's
health like any other, so a chain that keeps dying raises the unhealthy
alert. The tick reads enabled sources only: a disabled source's stranded
run is closed once it is enabled again. The ANN description backfill uses
the same test.

The 60 minutes is a rule, not proof. A chain whose hand-off is delayed past
it is closed although it was alive: its continuation then stops at the
gate and writes nothing, and the source records one failure.

A run opened before `lastActivityAt` existed has none and counts as
stranded only once it is 12 hours old. An action deployed before then
never stamps: its run gets its first stamp only at the first link that runs
the newer code, after the old action has handed off.

**Deploying import code.** Let running imports finish before deploying a
change to import code, or disable the sources and wait until no run is
`running`. This is a requirement. An action keeps executing the code it
started with after a deploy, so a run older than 12 hours with no heartbeat
can be closed while an old-version action is still executing it, and a
continuation the old action schedules must pass the new code's validators.
To toggle a source without signing in as an Administrator:

```sh
npx convex run importSources:setEnabledInternal '{"key":"sevenseas","enabled":false}'
```

**Disabling a source** follows one rule for every source, enforced by the
gate in `convex/lib/importRuns.ts`:

- A scheduled call on a disabled source does not start a run. A run a
  sync opens itself (the hourly tick's, or a bare `sync '{}'`) is marked
  `automatic`.
- Every sync checks the gate at each link, at page or batch boundaries
  inside a link, and before a withdrawal pass. Seven Seas checks before
  each listing page, the Kodansha calendar every 50 records, the Kodansha
  backlist before each series, ANN before each report page and each batch
  of release pages, Open Library every 1,000 dump lines, Yen Press every
  100 titles, and PRH before each list page.
- A disable is not an instant stop. The page or batch already under way
  finishes and writes; the automatic run stops at the next check and closes
  as `stopped` with its counts and errors. A stopped run does not count
  toward the source's failures or its unhealthy alert, and a stopped sweep
  never withdraws anything. A source disabled and enabled again between
  two checks is not interrupted.
- An operator forces a run with `imports:startRun`, then the sync with
  that run id, promptly: on an enabled source, a run with no activity for
  60 minutes counts as stranded. A forced run carries on and imports while
  the source is disabled, for every source, and withdraws only after a
  complete sweep.
- The gate also stops a chain whose run is missing, closed (finished, or
  closed as stranded), or belongs to another source key, such as a
  `kodansha` run id passed to the backlist. It writes nothing then: the
  run stays as it is and no source's health changes. A closed run never
  reaches a withdrawal pass.
- The flag gates runs, never applies. Direct calls to an apply mutation
  and the operator backfills write on a disabled source. The Kodansha
  backlist is gated on its own row, `kodansha-backlist`, not `kodansha`.

PRH's missing configuration is checked after the gate. A run that loses
`PRH_API_KEY` closes as `failed` when its source is enabled, and when it
is a forced run on a disabled source. An automatic run on a disabled source
that has also lost its key closes as `stopped`: the gate comes first, so
the runs a disable stops never raise a failure alert.

**Rerunning skipped records.** If a run reports skipped records, run that
source again with `npx convex run <source>:sync '{}'`. Every adapter fetches
only what it has not observed. For the Kodansha backlist, target series
with `onlySeries` as shown above.

**Retraction.** A record missing from a complete listing sweep marks its
observation withdrawn (`imports.markWithdrawn`). Nothing is deleted and no
canonical field changes. When the linked Release is still future-dated,
one In-Review Proposal queues with a `hide` op. Approving it hides
the release and rejecting it keeps the release. If the listing returns, the observation stops
being withdrawn and an open cancellation review is retired. Past-dated
records are untouched.

**Health alerts.** Three failed runs in a row mark a source unhealthy, and
the first success marks it healthy again. Each transition emails the
Administrator once (`convex/lib/email.ts`, `imports.healthAlert`). The
unhealthy email carries the latest run's errors. Sending uses Resend.
Without its variables, alerts are logged and skipped and the run is
unaffected. Setup is in [configuration.md](configuration.md#convex-deployment).

**Dashboard.** `/mod/imports` (Data Team) lists every source with its
cadence, health and last run, unhealthy first, the Held Books (see
"Held books" above), and run history with errors.
