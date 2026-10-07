# Decisions

Choices that are not obvious from the code, and the alternatives ruled
out. The original v1 decisions are in [spec-v1.md](spec-v1.md).

## Comments are native

Comments are two Convex tables and a `/mod/comments` queue, not an embedded
service (researched 2026-09-28). No hosted option put the queue inside
`/mod`, reused `users.role`, and shared the Clerk identity without an
enterprise tier (Disqus SSO is Business-only) or a stateful server
(Remark42, Commento++). Hyvor Talk could share identity through signed SSO
but still gives moderators a second dashboard. Giscus and Utterances need a
GitHub account per commenter. Cusdis is archived. The community Convex
comment components have no pending or hidden states, so the moderation
model would still be ours to build.

Every comparable catalog (MyAnimeList, AniList, MangaUpdates, Goodreads)
post-moderates with reports, so MangaDB does too: publish at once, hold
only the risky slice (new accounts, few approved comments, many links), and
hide on three reports. Comment rows are deleted outright on account
deletion, because a comment body can identify its author.

Deferred: Cloudflare Turnstile on the composer, Akismet or LLM triage of
held comments, reply and moderator notifications, hold thresholds tunable
from `appConfig` without a deploy, a global posting cap, and paging past 60
threads. Google's Perspective API is not an option; it is being shut down.

## Analytics

- **PostHog Cloud, US region.** The audience reads English and the owner is
  not in the EU. A project cannot move regions later. The free tier (1M
  events a month) covers this site.
- **Proxy on the site's own origin at `/_s`.** It lives in the existing
  Worker, so it needs no DNS or extra route and works on staging's
  workers.dev host. The path avoids names ad blockers list, such as
  `/analytics` or `/posthog`.
- **Named events only.** Autocapture, session replay and feature flags are
  off, so the typed `track()` calls are the source of truth and volume
  stays low.
- **Identified by Clerk user id, no email.** The same id reaches Convex as
  the identity subject, so server events land on the same person.
  Cookieless mode was rejected because it disables `identify()`.
- **Server events through `@posthog/convex`.** The first plan skipped server
  capture. PostHog's official Convex component (adopted 2026-09-29) made it
  cheap, and import runs, source health and moderation have no browser call
  site.

## Disjoint ISBNs mean another work

When ANN's entry and a Series of the same title both hold ISBNs in a
shared format and share none, `workMatch` calls them different works
(decided 2026-10-04). It is what keeps a parent off its spinoff (Citrus
off Citrus+, which carries "Citrus Plus" as an alternative title): a
spinoff shares its author, so only the books tell them apart. A wrong "same" lets ANN build Volumes and credits on the wrong
Series, which is hard to undo; a wrong "different" costs a duplicate
Series, which a merge undoes. The case it gets wrong is a work reissued
under new ISBNs, or a Series a publisher feed built from later Volumes than
ANN lists.

When nothing tells them apart, a Series another live ANN entry already
holds is another work as well (decided 2026-10-04). A Series ANN creates
has no book until the page pass after the mirror, so on a fresh seed the
title alone put the Alchemist sequel (ANN 30340) on the first work's
Series. In the production export of 2026-10-02, nine groups of ANN entries
share a title and each entry has its own Series. A shared ISBN still
links. Its cost is an entry whose id ANN replaced, which arrives while the
old entry still holds the Series and gets a duplicate Series beside it.

Both drops are made visible: when either rule drops the only Series of
the entry's title and ANN creates a second Series beside it, the pair goes
on the duplicate list on `/mod/launch` with the reason (no shared ISBN, or
the ANN entry that holds the Series); in steady state the creation
Proposal names the dropped Series and the reason. A candidate dropped
among several Series of the title, or one reached through an alternative
title, leaves no record.

Ruled out: holding such an entry for review instead, which in Bootstrap
Mode would leave its books out of the catalog until a person looked; and
treating disjoint ISBNs as no evidence, which would link namesakes by
title alone.

## Other printings keep their barcodes, recorded by decision

An older or later printing of a Release by the same publisher keeps its
ISBN in `releaseIsbns`, so a reader who scans an old copy lands on the
Release, and the book leaves the Held Books list (the owner decided
2026-10-05). The Release keeps its own ISBN and facts. A row per ISBN,
not an array on the Release, because Convex indexes no array, and both
`/isbn/{isbn}` and the matching ladder look a printing up by ISBN.

A person, or an agent whose decision a reviewer checked, decides each
one, and no importer records one on its own (decided after review,
2026-10-05). A wrong printing is worse than a held book: a light novel
taken for the manga of its name sends a reader who scans the novel to the
manga, and a first edition collected differently gets filed under a
Volume number it does not hold. Two automatic rules were built and
measured on the staging holds. A first, loose rule cleared about 250
holds, and review found light novels, ebooks, parts, hardcovers and
differently collected first editions among them. A strict rule cleared
13 of the 874 books the held-books report marked "another printing years
apart", and a second review still did not pass it. A rule that safe saves
little over judging those books one at a time, so the decided path
(`printings:recordDecidedInternal`) is the only one. It checks the
invariants that keep the data consistent (the Release's Series, its
publisher, a physical book, an ISBN no other Release holds), and refuses a
record whose own statements contradict the decision (another work, more
than one Volume, a novel, statements that disagree), not whether the two
books are the same.

An ISBN with a printing row has one owner (decided after review,
2026-10-05): every current claim on it, the Releases' own ISBNs, printing
rows and Bundles' ISBNs, merges followed and hidden Releases included,
reaches one Release, which may hold it both as its own and as a row after
a promotion. Every write that adds or keeps such a claim reads all of them
and refuses when it cannot, rather than trusting the first it finds; a
Split decides every printing it touches before writing, and refuses a case
it cannot resolve rather than take an ISBN from a third owner. The rule
covers current rows only. A historical reservation would need an ISBN
ledger, and ISBNs without rows keep the older active-only rule.

The claim reads use exact keys, so every writer stores an ISBN in its
field's one spelling (`lib/isbn.ts` `isbnFieldValue`: the ISBN-13's
digits, the ISBN-10's digits with an upper-case X), and the consistency
check finds any older stored ISBN spelled otherwise (decided in review,
2026-10-05). A normalized index or a backfill of every Release was ruled
out: the check finds the few such rows in four paged passes, they are
corrected one by one, and until then no catalog-wide clean result or
replay of data is trusted (operations.md). An ordinary write reads one
index range for an ISBN with no printing row and reads every claim only
when a row exists.

A merge's manifest keeps each moved printing row's ISBN (`mergeManifests`
`repointed[].isbn13`, optional, so older manifests stay valid and the
deploy needs no backfill), so a Split replays only the printing the merge
moved: a row whose ISBN changed since stays, and a row moved by an older
merge refuses the Split, since nothing else shows what that merge moved.

Ruled out: a Release per printing, which splits one book's owners,
ratings and dates across rows; recording every same-slot ISBN, which
takes ebook ISBNs filed as print and same-named novels; and an automatic
rule, for the reasons above.

## Cover art sources

Covers come from Penguin Random House's distribution CDN first and the
Open Library Covers API second. A sample of the catalog's ISBNs in
September 2026 found art at PRH for about 86% and at Open Library for
another 8.5%, leaving about 5% with none. The gap is mostly Yen Press print,
books with no art announced yet, and older Tokyopop and VIZ backlist.

Ruled out:

- **Google Books.** The keyless quota is zero, and its terms require a
  "Powered by Google" mark and a link on every result.
- **VIZ and Yen Press websites.** Their terms forbid reuse of site
  material, and Yen's images are signed URLs.
- **Open Library by edition key.** It found nothing the ISBN lookup missed.

## Open Library continuations read the dump from the start

Each continuation of `openLibrary:sync` downloads the filtered dump again
from byte zero and skips the lines earlier links processed (decided
2026-10-04). A run is monthly, and starting over needs no stored byte
offset and no host that answers range requests, so any static URL can
serve the dump. Continuing from a byte offset with HTTP Range, or
splitting the dump into separate files, would save the repeated download.

A link hands off at the first line it reaches after ten minutes
([imports](imports.md#open-library)), so a run makes about one download
per ten minutes it runs. For today's dump of 57,766 editions that is
about 12 or 13 downloads at the pace of the runs of 2026-09-26 and 27
(111 and 126 minutes) and about 26 at the pace of 2026-10-04 (6,295
editions in 28 minutes, about four and a quarter hours for the whole
dump), where 20,000-line links made four or five. Each download stops
where its link stops, so together they read about half as many whole
dumps.

The design's limit: if downloading and skipping the prefix alone takes
longer than ten minutes, every link applies exactly one line and
downloads the prefix again, so the run crawls. It keeps going only while
each link also applies its line and hands off before Convex's 30-minute
limit; a link that does not is ended there and the run is stranded. The
decision changes if the
dump grows until reading it up to a late link's first line takes much of
that link's ten minutes, or if Open Library offers range requests.

## Transitive module preloads

Each route's `modulepreload` list covers every chunk its scripts import
statically, at any depth (2026-10-05). TanStack Start lists a chunk and its
direct imports only, so `value`, `validator` and `useParams`, two imports
below the entry, were found only after their importers ran: one more round
trip before hydration on every route, 49–128 ms in browser traces of
staging and production. A Vite plugin pair (`build/transitivePreloads.ts`)
shows TanStack's manifest capture the whole closure and gives every other
hook Rolldown's own lists, so client files stay byte-identical; it fails
the build if the hooks are reordered or a chunk changes in between.
`build/checkPreloads.ts` checks every route's closure after each build.

Ruled out: one `$initial` chunk group (any app change re-downloads about
177 KB gzipped instead of about 54 KB), a vendor group (its hash still
changes with app code, and it pulls feature chunks into every page),
Rollup's `hoistTransitiveImports` (Rolldown does not support it), patching
`node_modules`, and re-exports in app source (they cannot reach `value`,
which the Convex client imports, or `useParams`, which TanStack does).
Delete the pair once TanStack's preloads follow static imports.

## Home jacket check: a budget, and unknown counts as art

The home page asks R2 which shelf candidates have a jacket
(`coversOnFile` in `src/server/covers.ts`) and waits at most 300 ms for
the answers (2026-10-05). Before, it waited for every read with no
deadline, so one stalled read held the whole page, and a read that threw
counted as "no jacket": an R2 outage emptied the shelves and sent the
warm-up to the upstreams for every book.

Now each read's answer is kept as it lands. When the budget runs out, a
candidate is kept off its shelf only if R2 said, in this request or
recently enough for the isolate to remember, that its jacket is absent. A
read that failed, is still out, or was never sent counts as art, as every
ISBN does when no bucket is bound, so the book may show its cloth
placeholder. No read starts after the budget. Reads still out are owned
by `waitUntil` and remembered for the next request if they finish within
the platform's limit; nothing promises they do. Only jackets known absent
are warmed, at most 8 per call.

300 ms is a starting value, not a measured one: a Worker has at most six
requests waiting for headers at once, and a cold home page sends about
fifty reads. Tune it from the `cov` span (docs/operations.md), minding
that a `partial` check hides how long it would have taken. Counting an
unknown as absent was ruled out: it empties the shelves in an outage.

## Staging

One shared staging environment instead of a deployment per branch. The
reasons are in [deployment.md](deployment.md#why-it-is-built-this-way).
