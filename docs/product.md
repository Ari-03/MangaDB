# Product reference

What each part of the public site and the signed-in library does. The
vocabulary (Series, Volume, Edition, Release, Edition Line and so on) is
defined in [CONTEXT.md](../CONTEXT.md). Moderation tools are in
[moderation.md](moderation.md).

## URLs and redirects

Catalog pages use a numeric public ID plus a slug:
`/series/{id}/{slug}`, `/volume/{id}/{slug}`, `/edition/{id}/{slug}`,
`/bundle/{id}/{slug}` and `/author/{id}/{slug}`. The ID is the identity.
The slug is computed from the current title on each request and never
stored (`src/lib/slug.ts`). A wrong or stale slug, a URL with no slug, and
the ID of a merged record all 301 to the canonical URL. A merged record
keeps its ID and points at the survivor, so no redirects table is needed.

Publishers are the exception: `/publisher/{slug}` uses the slug as the
identity. A renamed publisher's old slug 301s through the
`publisherSlugRedirects` table, and a merged publisher's slug 301s to the
survivor (`convex/publisher.ts`).

Releases have no page. Each one is a row on its Edition page, anchored by
ISBN when it has one, else by document ID. `/isbn/{isbn}` takes a valid
ISBN-10 or ISBN-13 (separators allowed) and 301s to that row. A box-set
ISBN goes to its Bundle page, and a Release match wins a conflict. Unknown
or checksum-invalid ISBNs 404.

## Release calendar

`/releases` lists the current month's releases by date, each row with
cover, Series, volume label, format, binding and publisher. An omnibus
reads "Vol. 1-3" and partial coverage reads "(partial)". `/releases/{yyyy-mm}`
shows any month as a grid, and `?view=agenda` shows that month as the list.
Months are the pagination; there is no `?page=N`.

Filters live in the URL and work in both views: `?format=physical|digital`,
`?publisher={slug}` (old slugs still resolve) and, signed in,
`?followed=true` for followed Series. Followed Series also get a star
marker. A day-unknown date shows in its month as "day to be announced".
Box sets stay off the calendar. The query is one date-window index scan
per page, with status, format and followed filters applied in memory
because Convex cannot index array containment (`convex/releases.ts`).

## Series library

`/series` browses every Series. Filters: publishers (any of several),
volume count (1, 2-5, 6-15, 16+), release timing (upcoming, released in
the last 3, 6 or 12 months, or finished), format, source status, first
letter, and a title search that matches word starts. "Finished" means
nothing announced and no release in a year, unless the source status says
Ongoing or Hiatus. Sorts: title, recently added, most volumes, latest
release, upcoming next, most followed, most collected, top rated. Top
rated ranks the 1-100 rating average and only counts Series with 3 or more
ratings.

Everything is in the URL, for example
`/series?publisher=viz-media,yen-press&volumes=2-5&timing=past-6m&sort=latest`.
Active filters show as removable chips, and the filter panel is a GET form
that works before hydration. The shelf loads more as you scroll.

The library reads `seriesStats`, one row per active Series that
`seriesBrowse:rebuild` refreshes every six hours (`convex/crons.ts`). So
counts and dates lag the catalog by up to six hours. Rating fields are the
exception, because every rating write updates the Series' row at once. The header
of `convex/seriesBrowse.ts` explains the packed documents behind filtered
views and their read limits.

## Series pages

A Series page groups its books into editions: the standard run for each
publisher, then each Edition Line (omnibus, deluxe, box sets and so on),
using `convex/lib/editionGroups.ts`. With more than one edition the page
opens on a picker showing each edition's first book. `?edition={key}` opens
that edition's reading path as a shelf. Standard runs follow canonical
Volume order with gaps marked "not on file". Lines follow the publisher's
own numbering. The standard run's first book is the hero cover and social
card. The Series synopsis shows under the title when one is on file.

A Series whose Volumes exist but which has no book at all is flagged
bookless by the library rebuild (see [imports](imports.md#bookless-series)).
It drops out of browse, search, the home shelf and the sitemap, and its
page shows a notice.

## Volume, Edition and Bundle pages

**Volume page.** Lists every Release that covers the Volume, grouped by
Edition and split into complete and partial coverage. An omnibus shows its
full coverage as chips. Canonical Volume numbering stays visibly separate
from Edition Line numbering. Under the title sits one description: the
Volume Synopsis, else the blurb of an ordinary single-volume Edition of
this Volume ("From the {publisher} edition", a still-publishing publisher
ahead of a defunct one), else the Series synopsis labelled "About {series}".
Omnibuses, split parts and Edition Line packaging never lend their blurb.

**Edition page.** The book detail page. It shows one Edition Description
in the header, then one row per Release with ISBN-13 and ISBN-10, date,
price, its Release Variants and the Bundles that contain it. Releases still
store their own descriptions. The page picks one at query time
(`convex/lib/descriptions.ts`): a Human Override first, then physical before
digital, then earliest date, then longest text. An Edition of one whole
Volume with no blurb falls back to the Volume Synopsis. Anything else falls
back to the Series synopsis labelled "About {series}". Editions have no
stored name. The title is composed from Series, Edition Line and position
or covered Volumes (`convex/lib/titles.ts`).

**Bundle page.** A box set's own facts (ISBN, date, price) and its member
Releases in order, each linking to its Edition row and naming the pinned
Variant when the box set specifies one.

## Publishers

`/publisher/{slug}` is a publisher profile with catalog facts, the next
three months of releases (at most 72 books, shown a dozen at a time) and a
link into the calendar filtered to that publisher.

`/publishers` shows what every publisher releases in the current UTC month,
and `/publishers/{yyyy-mm}` any other month. Each card shows the release
count, the physical and digital split, new and continuing Series, the
change from the previous month, a strip of covers and a link to the
filtered calendar. Imprints get their own cards and name their parent. A
"new series" is one whose Volume 1 first publishes this month in a standard
Edition. Below the board, every active publisher is listed A to Z with
imprints nested under their parent.

Boards are precomputed into `publisherBoards` for January of last year
through December two years out. Last month through three months out
rebuild hourly, the rest every six hours (`publisher:rebuildBoards`). Other
months, and a month stored under an older `BOARD_VERSION`, compute live.
Bump `BOARD_VERSION` in `convex/publisher.ts` when the board's shape changes.

## Authors

`/authors` lists everyone credited on a Series, the most prolific first,
each with the jacket of their biggest Series. `/author/{id}/{slug}` lists
every Series a person worked on, latest release first, with their role on
each. Credits come from ANN where ANN credits the Series, else from
publisher snapshots (see [imports](imports.md#author-credits)). Pages for
ANN-credited people credit and link ANN, as its terms require.

## Search

`/search?q=` and the header box search Series and publishers. There is no
Volume or Bundle text search. Search pages are noindex.

- Series match on title and alternate titles, plus derived nickname keys:
  word initials ("aot", "sxf", "kny") and the words run together
  ("chainsawman"). Initials count only when typed whole. "×" reads as "x".
  Fan nicknames that are not initials ("JJK") work once added as an
  alternate title. Hidden and merged Series never appear.
- Publishers match when every query word starts a word of the name, with
  aliases from `convex/lib/publishers.ts` ("Shonen Jump" finds VIZ Media)
  and merged publishers' old names.
- The header box is a typeahead (`src/lib/searchSuggest.tsx`) showing up to
  six Series, up to three publishers and a "See all results" row. Without
  Convex or before hydration it is a plain GET form.
- When no Series contains every typed word and the query names no
  publisher, both the typeahead and the page offer "Did you mean" titles
  ("berzerk" finds Berserk). A typo in the first three letters of a
  one-word query is out of reach.
- A query that is a valid ISBN runs no text search. It redirects through
  `/isbn/{isbn}`. The dev seed's ISBNs are checksum-valid, so
  `978-1-9990001-0-3` works locally.

A change to the nickname rule (`seriesSearchText` in
`convex/lib/searchMatch.ts`) reaches older rows on the next
`seriesBrowse:rebuild`.

## Collection

Signed in, every Release row and every Bundle page offers Wanted, Ordered
and Owned. An entry holds one state. Picking another replaces it, picking
the current one removes it, and nothing changes state as a side effect.
A Release with Variants asks which one you own. Owning a Bundle marks its
members "Owned via {bundle}" at read time without storing anything, and
removing the Bundle entry never removes a direct entry. Volume ownership is
never stored either. The Volume page computes it from owned Releases.

Covers on Series shelves and in the library show Want, Order, Own and Mark
read on hover (`src/lib/quickActions.tsx`). Above every reading path sit
Want all, Order all, Own all and Read all, capped at 200 books per click.
Nothing removes entries in bulk.

`/me` is the library, with tabs Collection, Reading, Upcoming, Favorites
and Settings. Collection shelves entries by Series and reading path, one
shelf per state (`?shelf=owned|ordered|wanted`). "Add the other N" opens
the rest of a run with unmarked books faded.

## Reading

Reading is three separate things (`convex/reading.ts`):

- **Series Reading Status** (Plan to Read, Reading, Paused, Dropped,
  Completed) changes only when you pick it, or confirm a prompt.
- **Release Progress** is an active pass on one Release, with an optional
  0-100% slider. Reaching 100% only opens a prompt. The pass completes when
  you confirm.
- **Volume Progress** is a read count per Volume. Confirming a pass adds
  one read to every Volume the Edition covers completely, never partially.
  Another pass is a reread. Undo reverses the latest completion. The
  Volume page edits the count directly, and the Mark read toggle on a cover
  gives each completely covered Volume its first read.

Prompts never act on their own. Starting a pass suggests "Reading". A
completion that finishes every Volume of a Series suggests "Completed".
`/me` Reading lists each Series you read with its status, progress and
active passes.

## Follows and upcoming releases

Following a Series is its own toggle on the Series page, separate from
reading and collecting. The first Collection Entry in a Series offers a
one-time prompt to follow it. "Don't ask again" ends prompts for that
Series. Follows are always private.

`/me` Upcoming shows followed Series as a rail, then My Upcoming Releases:
future releases from followed Series in your preferred format (physical,
digital or both), plus every future Wanted or Ordered Release and Bundle
regardless of format. Owned items, direct or through a Bundle, drop out.
It is computed on every read.

## Visibility and profiles

Tracking is private by default. Ownership and Reading each have a default
(Settings, Sharing) and per-Series overrides (the Sharing button on a
Series page). `/u/{username}` is a public profile built by one public query
(`sharing.publicProfile`) that enforces visibility on the server and looks
the same to everyone, its owner included.

- Public Ownership shows Owned Releases with their Variant, Owned Bundles
  and their members. Wanted and Ordered never show.
- Public Reading shows reading statuses, active pass percentages and read
  counts.
- Follows never show.
- An entry covering several Series shows only when every one of them is
  public for that user.

Profiles are noindex, absent from sitemaps, and show current state only,
with no activity feed. A suspended user's profile is not found until they
are reinstated.

## Account deletion

Settings, Account deletes the account. The request is recorded first;
from then on the user counts as gone: the profile returns not found, every
personal page treats them as signed out, and the browser signs out. Their
collection, reading, follows, ratings, reviews, favorites, comments and
reports are then deleted in batches, the user row last, which frees the
username. The Clerk sign-in is deleted alongside, with retries. If those
fail, the person can sign in to an empty account and delete it again. The
last active Administrator is refused until they appoint another.
Revisions, Proposals and audit rows stay, credited to a deleted account.

## Ratings and reviews

A rating is a whole number from 1 to 100, one per user per Series, Volume
or omnibus Edition. A single-volume Edition rates its Volume. An omnibus is
rated as one book. Unmapped Packaging carries no rating. The number is
private. Pages show the target's average and count in the header.

Each user picks a rating format under Settings, Rating format. The stored
score never changes with the format.

| Format | Control | Stored as | Shown as |
|---|---|---|---|
| `point10` (default) | number /10 | n × 10 | max(1, round(score / 10)) |
| `star5` | number /5 | n × 20 | max(1, round(score / 20)) |
| `point100` | number /100 | n | score |
| `smiley3` | Bad, OK, Good | 35, 60, 85 | up to 49, 50 to 74, 75 and up |

Smiley users and signed-out visitors see averages out of 10.

A review is 20 to 5,000 characters of plain text, optionally marked as a
spoiler, one per user per rating target. Reviews are private for now
(`FEATURES.publicReviews` is `false`), so only the author reads theirs.
Moderators can hide a review, and every change writes a `reviewAudit` row.
Rate limits: 120 ratings and 20 review saves an hour per user.

When an Edition's coverage drops to one Volume, its ratings, reviews and
favorites move to that Volume, and the Volume's row wins a clash
(`collapseEditionTakes` in `convex/lib/sensitiveOps.ts`). A Volume merge
records the move so Split can reverse it.

To turn public reviews on, set `publicReviews: true` in
`convex/lib/features.ts` and deploy both Convex and the Worker. Staff the
moderation first.

## Favorites

A favorite is a private mark on a Series, Volume or omnibus Edition, toggled
from the panel under the cover. `/me` Favorites lists the newest 200.
Nobody else sees favorites, and profiles never show them. Merges move them,
Split moves them back, and account deletion deletes them.

## Comments

Comments on Series and Volume pages are built and switched off
(`FEATURES.comments` is `false`). Every write throws, every read answers
empty, the pages skip the section, and `/mod/comments` says comments are
off. Deleting your own comment and the account purge still work.

When on: plain text up to 2,000 characters, one level of replies, newest
threads first. A comment publishes at once unless a hold rule sends it to
the queue: an account younger than 7 days, fewer than 3 approved comments,
or more than 2 links. Three distinct reports hide a comment. Moderators
work Pending, Reported, Hidden and Removed tabs at `/mod/comments`, and can
shadow a user so their comments look published only to them. Every
decision writes a `commentAudit` row. Rate limits: 20 posts and 10 reports
an hour per user. The policy numbers are in `COMMENT_POLICY` in
`convex/comments.ts`.

To turn comments on, set `comments: true` in `convex/lib/features.ts` and
deploy both halves. Staff the queue first.

## Mature titles

A Mature Series (see CONTEXT.md) stays out of browse, search, the calendar,
the Publishers board, author shelves and the sitemap until the viewer opts
in. The home page's shelves leave it and its books out even then; the
header search still follows the viewer's choice. Its own pages still load.
For a viewer who has not opted in they lead with a notice and draw every
cover as an 18+ cloth binding without requesting the art. They also carry
`<meta name="rating" content="adult">` and no cover-led social card.

The Series library and Series pages ask "Allow mature content?" once per
browser and store the answer in the `mangadb-mature` cookie. The choice can
change later in the Series filters, Settings, or the notice on a mature
page, each behind an "I'm 18 or older" check. Your own library always
shows your own books.

The library rebuild derives `series.mature`, so it lags by up to one
rebuild. Evidence, strongest first:

| Evidence | Source |
|---|---|
| Data Team call | `series.contentRating` ("mature" or "general") wins over everything |
| Adult-only publisher | `publishers.contentRating = "mature"`, from `adultOnly` in `convex/lib/publishers.ts` |
| Kodansha | `age_rating` 18 or over on the backlist listing |
| Seven Seas | the book page's mature age-rating block |
| Yen Press | the "Age Rating" detail ("18+ M (Mature)", "18 & Up") |
| ANN | objectionable content MA or AO, or an erotica or hentai genre |

PRH and Open Library carry no age rating for manga.

## SEO

All titles and descriptions come from per-page templates in
`src/lib/seo.ts`. A page's meta description falls back to its own
description only when that text is the book's own, never the Series
synopsis fallback. Every page goes through `pageHead()`, which adds the
canonical link and an Open Graph card led by the page's cover.

JSON-LD: BreadcrumbList on every catalog page, BookSeries on Series, one
Book per Release row on Edition pages, Organization on publishers, ItemList
on unfiltered month pages. No ratings markup.

Indexable: catalog pages, `/releases`, month views and `/authors`. Filtered
calendar views are `noindex, follow` with a canonical to the unfiltered
URL. Never indexed: `/search`, `/me`, `/mod`, auth pages, `/claim-username`
and `/u/{username}`.

The Worker serves `/sitemap.xml`, an index of
`/sitemaps/{series,volumes,editions,publishers,bundles,months}.xml`, and
`/robots.txt`, which disallows `/me`, `/mod` and `/claim-username`
(`src/server/seoRoutes.ts`). `lastmod` comes from each record's latest
Revision. Absolute URLs use `VITE_SITE_URL`, default `https://mangadb.org`.

## Cover art

`/covers/{isbn13}.jpg` (`src/server/covers.ts`) serves jacket art for any
Release with an ISBN-13. It tries the edge cache, then the `mangadb-covers`
R2 bucket, then Penguin Random House's distribution CDN, then the Open
Library Covers API. Known "no image" and "coming soon" stand-ins are
rejected, so those books stay cloth. A miss everywhere is remembered for a
day. An upstream that is down or rate-limiting gives a five-minute miss.

Only Kodansha and Seven Seas art lives in Convex file storage, stored once
per Edition and image URL. A Release wears its Edition's jacket, physical
ISBNs before digital (`convex/lib/covers.ts`). Every page draws covers with
`<Cover>` from `src/lib/cover.tsx`, which shows a cloth binding with the
title when no art loads. Why these two sources, and which were ruled out:
[decisions](decisions.md#cover-art-sources).

## About the data

`/about-the-data`, linked from the footer, lists the sources, notes that
physical coverage is complete and digital coverage partial, gives the
attribution ANN's license requires, and names the cover takedown contact,
`data@mangadb.org`. Someone has to read that mailbox.

## Look and feel

The site uses the "Bookshelf" look: a warm dark theme by default and a
light paper theme behind the header toggle, stored in `localStorage` (the
OS preference is ignored). Display type is Fraunces, text is Nunito Sans.
Styles are split by concern under `src/styles/`: `tokens.css`, `shell.css`,
`covers.css`, then one file per page group.
