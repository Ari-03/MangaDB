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
`convex/lib/pipeline.ts`, `matching.ts`, `authority.ts`, `reconcile.ts` and
`catalogTitle.ts`.

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

Before ANN links an entry to a Series by title, `workMatch` checks that it
is the same work. A candidate is dropped when both sides know their
creators (ANN person ids) and share none, or both hold ISBNs in a shared
format and share none. A shared creator never proves a match, since a
spinoff shares its author.

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
a fixed size (`FIXED_LINE_SIZES`, such as VIZBIG). Box sets become Release
Bundles. In Bootstrap Mode a named line's member with no usable coverage is
created as Unmapped Packaging, which a Moderator maps at `/mod/packaging`.
Outside Bootstrap Mode such a book stays on its observation for an Editor.

### Bookless Series

A Series with Volumes and no book at all (usually an ANN backbone whose
releases could not be placed) is flagged `bookless` by the six-hourly
library rebuild. It leaves browse, search, the home shelf and the sitemap.
Its page still loads with a notice. Imports keep working on it, and the
flag clears on the next rebuild after a book attaches. `/mod/packaging`
lists the current set.

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
and hands off to a fresh action after five minutes. `npx convex run
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
row. It never creates a Series, Volume, publisher, packaging, variant
cover, prose imprint, or a second same-format Release of a Volume from one
publisher. Held lines keep a `placement` note. The page's description fills
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
while an ANN Import Run is running (a run older than 12 hours counts as
stranded and is ignored). It stops after 5 failed fetches in a row, logs
why it stopped, and never touches a withdrawn line.

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

Without both variables, PRH runs skip as "unconfigured".

### Open Library

`convex/openLibrary.ts`, parsers in `convex/lib/openLibrary.ts`. Fills
ISBNs (standard), dates (weak), binding (standard) and a blank description
(weak) on records that already exist. It never defines Series structure.
An unmatched record may create only a leaf Release under a Series, Volume
and publisher that all exist already, which is how most VIZ print Releases
appear under the ANN backbone. It never queues reviews and never
withdraws. Library rebinds (Turtleback, Perfection Learning) never count
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
A source whose last run is still `running` is skipped. A failed run
resumes at the next cadence.

**Disabling a source** stops its scheduled chain at the next link (ANN, PRH,
Yen Press, Open Library and the Kodansha backlist share the gate in
`convex/lib/importRuns.ts`). Runs a sync opens itself are marked
`automatic`, and a continuation that finds its source disabled closes the
run as `stopped`. A run an operator forces with `imports:startRun`, then
the sync with that run id, finishes regardless. Before deploying importer
changes, disable the sources and let running imports finish. To toggle a
source without signing in as an Administrator:

```sh
npx convex run importSources:setEnabledInternal '{"key":"sevenseas","enabled":false}'
```

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
cadence, health and last run, unhealthy first, plus run history with
errors.
