# MangaDB

A public website for tracking English manga **volume** releases: what volumes
exist, when each edition comes out, and which ones you own, want, or have read.

**Stack:** [TanStack Start](https://tanstack.com/start) (SSR) +
[Convex](https://convex.dev) backend + [Clerk](https://clerk.com) auth,
deployed to **Cloudflare Workers** at `mangadb.org`.

The authoritative v1 spec lives at [`.scratch/v1-spec/spec.md`](.scratch/v1-spec/spec.md);
the ubiquitous-language glossary at [`CONTEXT.md`](CONTEXT.md).

## Layout

| Path | What |
|---|---|
| `src/routes/` | File-based routes (`__root.tsx` is the document shell; `releases.index.tsx` + `releases.$month.tsx` are the Releases browser; `series.$publicId.$slug.tsx`, `volume.…`, `edition.…`, and `bundle.…` are the public catalog pages; `publisher.$slug.tsx` is the Publisher Spotlight; `isbn.$isbn.tsx` is the ISBN entry point; `search.tsx` is v1 search; `me.tsx` is the gated shell; `sign-in.$`/`sign-up.$` host Clerk's UI; `claim-username.tsx` is the forced first-sign-in step; `mod.edit.…` + `mod.roles.tsx` are the moderation surfaces from #31) |
| `src/router.tsx` | Router factory (`getRouter`) |
| `src/lib/` | Isomorphic helpers (computed slugs + public-ID parsing for catalog URLs; ISBN recognition for search; month arithmetic + the shared Releases-browser UI; `collection.tsx` is the signed-in collection overlay from #27; `reading.tsx` is the signed-in reading-tracking overlay from #28) |
| `src/start.ts` | Global Start config: Clerk request middleware (only when credentials exist) |
| `src/providers.tsx` | Client wiring: `<ClerkProvider>` + `ConvexProviderWithClerk`, site header |
| `src/server.ts` | Custom Workers entry: canonical-host redirect, then the Start handler |
| `src/server/` | Server-only code (canonical-host policy, SSR Convex client, SSR Clerk auth/token) |
| `convex/` | Convex schema + functions (`schema.ts` is the v1 schema from wayfinder #11; `catalog.ts` public catalog reads; `releases.ts` the Releases-browser month window from #24; `seed.ts` the dev seed from #22; `users.ts` + `lib/` are accounts from #26; `moderation.ts` + `roles.ts` are the moderation core from #31; `collection.ts` is the personal collection from #27; `reading.ts` is reading tracking from #28; `importSources.ts` + `imports.ts` + `sevenSeas.ts` + `crons.ts` are the import foundation from #34) |
| `wrangler.jsonc` | Workers config (`nodejs_compat`, custom entry, vars) |
| `vite.config.ts` | Start + Cloudflare + React plugins |

## Local development

```sh
npm install

# Terminal 1 — Convex dev deployment (pushes convex/, regenerates convex/_generated).
# First run walks you through login/project creation and writes .env.local
# (CONVEX_DEPLOYMENT + VITE_CONVEX_URL). No account? An anonymous local
# deployment also works: CONVEX_AGENT_MODE=anonymous npx convex dev
npx convex dev

# Terminal 2 — the app (SSR runs inside workerd via the Cloudflare Vite plugin)
npm run dev
```

Everything auth-related is optional locally: without Clerk credentials the app
runs signed-out-only and the public catalog works end to end. The auth pages
render a setup notice instead of crashing.

### Dev seed

With `npx convex dev` running, populate a small hand-authored catalog that
exercises the domain model's corners (ticket #22):

```sh
npx convex run seed:run '{}'            # only when the catalog is empty
npx convex run seed:run '{"wipe":true}' # wipe catalog tables and reseed
```

It creates a Series Family (Tokyo Ghoul → Tokyo Ghoul:re, typed sequel edge),
Volumes whose hidden Position and public Label diverge (position 4 is labeled
"3.5"), the "Monster Edition" Edition Line with an omnibus Edition covering
Volumes 1–3, a split digital Edition with partial Coverage, physical + digital
Releases, a box-set-exclusive Release Variant, a Release Bundle that pins that
Variant — plus a deliberately simple Series and a oneshot that use none of
those concepts. All publication facts are fake. Public IDs come from the
`counters` table exactly like production writes (`convex/lib/publicIds.ts`).

The seed also dates a handful of Releases relative to the clock at seed time —
this month, last month, next month, plus one month-precision "day TBA" date —
so the Releases browser always has a populated current window to demo.

## Releases browser

The main public browse surface (ticket #24, spec §10, prototype #8): two
sibling views over the same month window of Canonical Releases.

- **`/releases` — Release Agenda**, the first-visit default: a cover-led
  chronological list of the current month, grouped and anchored by publication
  date; each row shows cover, Series link, Volume label (composed from the
  Edition's Coverage — "Vol. 1–3" for an omnibus, "(partial)" when partial),
  Format + Binding, and Publisher.
- **`/releases/{yyyy-mm}` — Month Grid**: the same data month-at-a-glance,
  each Release on its date; `?view=agenda` renders the Agenda for that month
  instead, so any month is browsable in either view. Month URLs are also the
  browser's pagination (spec §11 — never `?page=N`).
- **Shared filters, all state in the URL:** `?format=physical|digital` and
  `?publisher={slug}` work identically in both views (a renamed publisher's
  old slug still resolves via `publisherSlugRedirects`), so every view +
  filter combination is a shareable link. Unfiltered `/releases` and month
  pages are indexable; any query param makes the page `noindex, follow` with
  a canonical to the unfiltered URL (spec §11).
- **Query shape** (`convex/releases.ts`, the recorded spec §8 trade-off): one
  date-window index scan per page — `by_publisher_date` when the Publisher
  filter is set, else `by_date` — with status and Format refined in memory
  afterwards, because Convex can't index array containment and a month window
  holds hundreds of rows. A month-precision date (`sort` = `yyyymm00`) lands
  in its month's window and renders as "day to be announced".

Releases only — Release Bundles stay off the browser (spec §10), and the
followed-Series filter arrives with Series Follows (ticket #29).

## Series pages

`/series/{id}/{slug}` (spec §11) server-renders the **Reading Path** hierarchy
validated by prototype #16: the canonical Volume sequence leads (ordered by
hidden Volume Position — the publisher-facing Label is display-only, never the
sort key), and each Volume reveals every covering Edition with its Edition
Line membership, ordered Volume Coverage (complete/partial), Releases,
Variants, and Bundle cross-links. Simple Series show none of the empty
concepts.

The `{id}` is the per-entity sequential public ID; the slug is cosmetic and
computed from the current title at request time, never stored
(`src/lib/slug.ts`). A wrong or stale slug, a slugless URL, and the old ID of
a merged Series (merged docs keep their public ID and point at the survivor)
all 301 to the canonical URL. The same ID+slug policy applies to every
catalog page below.

## Volume, Edition, and Bundle pages + `/isbn` (ticket #23)

The rest of the public catalog surface (spec §2, §10, §11), served by the
queries in `convex/catalogPages.ts` through `src/server/catalogPages.ts`:

- **`/volume/{id}/{slug}`** reveals every Release covering that Volume,
  grouped under its Edition and split into **Complete releases** vs
  **Partial coverage** by the Edition's extent for *this* Volume. The
  omnibus case shows the Edition's full ordered Coverage (chips linking each
  covered Volume), and canonical Volume numbering (hidden Position + public
  Label) stays visibly separate from Edition Line numbering throughout.
- **`/edition/{id}/{slug}`** is the book detail page: Release rows differing
  only in Format/Binding, each with ISBN-13/10, date, price, Release
  Description, its Release Variants beneath, and links to containing
  Bundles. Editions have no stored name — the page title is composed from
  series + Edition Line + position or covered Volumes (`convex/lib/titles.ts`),
  and the slug is computed from that composed title. Releases have no page
  of their own (spec §11): each row anchors by ISBN when present, else
  document ID.
- **`/bundle/{id}/{slug}`** lists a Release Bundle's own publication facts
  (box-set ISBN, date, price) and its member Releases in order, each
  linking back to its Edition page anchored at the Release row and naming
  the pinned Release Variant when the box set specifies one. Release rows
  on Volume/Edition/Series pages link back to their containing Bundles.
- **`/isbn/{isbn}`** 301s a valid ISBN-10/13 (separators tolerated) to the
  owning Edition page anchored at the matching Release row; a box-set ISBN
  301s to its Bundle page, and a Release match wins any conflict. Unknown
  or checksum-invalid ISBNs 404.

## Publisher Spotlight pages (ticket #25)

`/publisher/{slug}` (spec §10/§11, prototype #17) is the **Publisher
Spotlight**: a publisher-led profile — name, description, catalog facts —
followed by a **bounded upcoming-Releases lane** (the next ~3 months, capped
at 12 rows, grouped by month with the browser's Agenda treatment) and a clear
route into the main Releases browser pre-filtered to that Publisher
(`/releases?publisher={slug}`). There is deliberately no cross-publisher
overview page; that comparison lives in the browser.

Publishers are the slug-only URL exception (spec §8): the slug is the
identity, so a **renamed Publisher's old slug 301s** to the new one via the
`publisherSlugRedirects` table, and a merged Publisher's slug 301s to its
survivor's (`convex/publisher.ts` resolves both; the route issues the
redirect). The dev seed includes one redirect —
`/publisher/seven-seas-entertainment` 301s to `/publisher/seven-seas`.

## Search

`/search?q=…` (spec §8/§11, ticket #38) is v1 search, reachable from the box
in the site header. It is deliberately narrow:

- **Series** are matched through the `search_title` search index on
  `searchText` — the title and every alternate title concatenated on write —
  so "Toukyou Kushu" finds Tokyo Ghoul. Results link the canonical
  `/series/{id}/{slug}` pages; hidden and merged records never appear (a
  merged Series is findable through its survivor).
- **Publishers** resolve by case-insensitive name match over the small
  publisher list, linking their `/publisher/{slug}` Spotlight pages.
- **ISBNs**: a query recognized as a valid ISBN-10/13 (`src/lib/isbn.ts` —
  checksum-verified, separators ignored) never runs a text search; the loader
  302s through `/isbn/{isbn}`, the route that owns resolution to the owning
  Edition page anchored at the Release (or the Bundle page) with a 301
  (ticket #23). The dev seed's fake ISBNs are checksum-valid so this is
  demoable locally — try `978-1-9990001-0-3`.

No Volume or Bundle text search in v1, and search pages are noindex — they
are not in the spec's indexable set.

## Personal collection (ticket #27)

Spec §3: a signed-in user tracks what they own, want, and have ordered
(`convex/collection.ts`; UI overlay in `src/lib/collection.tsx`). The
controls render as a client-side overlay on the public catalog pages and
disappear entirely signed out.

- **Collection Entry** — every Release row (Series, Volume, and Edition
  pages) and every Bundle page offers Wanted / Ordered / Owned toggles. An
  entry holds exactly one state; picking another replaces it, picking the
  current one removes the entry. All transitions are explicit clicks —
  nothing changes state as a side effect.
- **Variant pinning** — a Release entry with Variants shows a picker to
  identify the owned Release Variant (or "Standard cover").
- **Derived Ownership** — owning a Bundle marks its member Releases as
  "Owned via {bundle}" (with the bundle-pinned Variant named), computed at
  read time and never stored. It coexists with direct entries, so removing
  the Bundle entry never erases a direct entry.
- **Volume ownership is never stored** — the Volume page shows an "In your
  collection" summary computed from the owned Releases covering it, direct
  or derived, with partial coverage labeled.

`/me` → Collection lists every entry grouped by state (Owned / Ordered /
Wanted); an Owned box set lists its derived member Releases beneath it.

## Reading tracking (ticket #28)

Spec §3: a signed-in user tracks reading as three separate things —
**Series Reading Status**, **Release Progress** passes, and **Volume
Progress** read counts (`convex/reading.ts`; UI overlay in
`src/lib/reading.tsx`). The controls render as a client-side overlay on the
public catalog pages and disappear entirely signed out.

- **Series Reading Status** (Plan to Read | Reading | Paused | Dropped |
  Completed) is set only by explicit choice: the picker on the Series page,
  or a confirmed prompt. `setSeriesReadingStatus` is the single write path;
  nothing else ever touches it.
- **Release Progress** is an active pass on a Release row (Series, Volume,
  and Edition pages), at most one per (user, release), with an optional
  0–100% slider. Hitting 100% only opens the completion prompt — the pass
  completes solely through the confirmed `completePass` mutation; "Not yet"
  and "Stop without finishing" change no counts.
- **Confirmed completion** increments the read count of every Volume the
  Release's Edition covers *completely* — partial coverage is untouched —
  stamped with one shared `completedAt`. Another completed pass is a reread
  (count 2, 3, …). **Undo** reverses the most recent completion: it
  decrements exactly the Volumes whose latest completion still carries that
  stamp (a newer reread makes an older undo a no-op) and restores the pass
  at 100%.
- **Prompts never act**: starting a pass suggests "Reading", and a
  completion that leaves every Volume of a Series read suggests
  "Completed" — both render inline, and only their confirm buttons write
  the status. Declining changes nothing.
- **Volume Progress is edition-independent and directly editable**
  (CONTEXT.md): each Volume row shows "Read ×N" with mark-read/+1/−1
  controls, so offline reads are recordable without a pass.

`/me` → Reading lists the chosen statuses (with volumes-read progress per
Series) and every active pass, linking back to the Edition row.

## Series Follows + My Upcoming Releases (ticket #29)

Spec §3: future-release interest is a **Series Follow**, separate from
owning and reading (`convex/follows.ts`; UI in `src/lib/follows.tsx`).
Follows are always private in v1 — the profile never shows them.

- **Explicit follow toggle** on the Series page. `setSeriesFollow` is the
  single write path; nothing follows a Series as a side effect of anything.
- **One post-first-entry prompt per Series**: inserting a user's first
  Collection Entry in a Series returns a `suggestFollow` from the collection
  mutations, rendered as a non-blocking inline prompt. Only its Follow
  button creates the follow; "Don't ask again" dismisses permanently
  (`dismissFollowPrompt` — later entries in that Series never prompt again);
  ignoring it changes nothing.
- **My Upcoming Releases** (`/me` → Upcoming) implements the spec formula,
  computed live on every read and never stored: announced future Canonical
  Releases from followed Series matching the viewer's Physical/Digital/Both
  preference (settable right in the section via `users.setFormatPreference`),
  plus every future Wanted/Ordered Release **and Bundle** regardless of
  preference — deduplicated (one row per Release however many clauses match)
  and with anything Owned excluded, whether owned directly or derived
  through an Owned Bundle. "Future" follows the publisher-lane convention:
  dated today-or-later, plus day-TBA releases of the current month onward;
  an undated Bundle is not announced and never appears.
- **Releases browser overlay**: followed Series get a subtle ★ marker and a
  "Followed series" filter in both the Agenda and the Month Grid — never a
  separate section. The month window stays a public SSR query; the marker
  and the `?followed=true` filter are a signed-in client-side overlay
  (`follows.followedSeries`), applied in memory per the recorded spec §8
  trade-off. Followed-filtered views are noindex with a canonical pointing
  at the unfiltered browser, so they are never indexed (spec §11).

## Tracking visibility + public profiles (ticket #30)

Spec §3: personal tracking is **private by default**, with separate
visibility defaults for Ownership and Reading plus per-Series overrides
(`convex/sharing.ts`; UI in `src/lib/sharing.tsx`; profile page at
`src/routes/u.$username.tsx` reading through `src/server/profile.ts`).

- **Defaults** live on the User (`ownershipVisibility` /
  `readingVisibility`, both `private` at account creation). `/me` → Sharing
  holds the two selects; `sharing.setDefaultVisibility` is the write path.
- **Per-Series overrides** live on the per-user-per-series state row
  (`userSeriesStates`). The Series page shows a "Sharing for this series"
  panel (signed-in only) whose selects call `sharing.setSeriesVisibility`;
  picking "Default" clears the override back to the account default.
- **`/u/{username}`** is a current-state public profile — a public Convex
  read (`sharing.publicProfile`, no auth) that enforces visibility
  server-side and renders the same to everyone, owner included:
  - Public **Ownership** shows Owned Releases (with the selected Variant),
    Owned Bundles, and their derived member ownership. **Wanted/Ordered
    entries are never exposed** at any visibility.
  - Public **Reading** shows Series Reading Status, active Release
    percentage, and Volume read counts.
  - **Series Follows always stay private in v1** — the query never reads
    the follow fields into the result.
  - An entry covering several Series shows only when *every* covered Series
    is effectively public: one private override hides the whole entry (and
    a box set containing it), because showing it would reveal that Series.
- **Public but noindex** (spec §11): the page carries `robots: noindex`,
  profiles are excluded from every sitemap, and there is no activity feed —
  the profile is a snapshot of current state, never a history.

## Moderation core (ticket #31)

Spec §4/§5: immutable, versioned **Proposals** are the single write path for
catalog changes. This slice covers roles, direct edits, public revision
history, and implicit Human Overrides; Editor submission and the review queue
are ticket #32 below.

**Roles.** `convex/roles.ts` + `convex/lib/roles.ts`. Administrators appoint
Moderators (and anything else); Moderators appoint Editors; Editors propose
(ticket #32). Every appointment, revocation, suspension, and reinstatement
writes a permanent row to `roleAudit` — append-only, surviving even account
deletion. Revocation/suspension removes privileges only: Revisions and
Proposals record the author's role at authorship and are never rewritten.
The initial Administrator is appointed by the operator, once, after that
person has signed in and claimed a username:

```sh
npx convex run roles:bootstrapAdministrator '{"username":"yourname"}'
```

The `/mod/roles` page (Moderator+) shows the roster, the
appoint/revoke/suspend/reinstate actions, and the audit trail.

**Direct edits.** A Moderator or Administrator edits a record through
`/mod/edit/{type}/{key}` — linked from the Series, Volume, Edition (including
per-Release links), and Bundle pages when the viewer holds the role. The
form renders from the field registry in `convex/lib/moderationFields.ts`,
requires a change comment, and its save
(`convex/moderation.ts#submitDirectEdit`) is an immediately approved Proposal
Version: a `proposals` row (state `approved`, self-approved), an immutable
`proposalVersions` row with the update op, and one immutable public
`revisions` row per affected record. The op carries the record's base
Revision; if the record changed since the form loaded, the save is refused as
stale — reload and re-edit, never a silent rebase. Hidden, merged, and locked
records refuse direct edits.

**Public history.** Each Series/Volume/Edition/Bundle page shows the
record's history (`moderation.recordHistory`, public): final diff, author
(with role at authorship, or the import source), approver, timestamp, change
comment, and source citation. Pending/rejected proposals stay private.

**Human Overrides.** Any approved human change to an import-authored field —
one whose latest Revision was source-authored — implicitly joins the record's
sticky `overriddenFields` list (spec §4): imports may report conflicts but
never overwrite it; only an explicit Moderator `clearOverride` (a later
slice) removes an entry. The overridden fields are listed on the edit form
and in the public history section.

## Editor Proposals and the review queue (ticket #32)

Spec §5, built on the #31 core: `convex/proposals.ts` + the creation
registry `convex/lib/proposalCreates.ts`.

**Lifecycle.** Any data-team member drafts a Proposal (`saveDraft` — a
mutable working copy on the `proposals` row) and submits it
(`submitProposal`): validation runs, a change comment is required, factual
changes (anything but editorial prose like descriptions/synopses) require
source evidence (a URL or a Source Observation), and computed warnings
(new Series, bulk >10 ops, partial coverage) must be explicitly
acknowledged. Submission freezes the draft into an immutable
`proposalVersions` row — `Draft → In Review`. A Moderator then approves
(`approveProposal` — applies every op in one mutation through the same
`applyUpdate` path as direct edits, one public Revision per affected
record), rejects (`rejectProposal`, reason required), or requests changes
(`requestChanges`, reason required — back to Draft, seeded with the
reviewed version; resubmission mints the next immutable version). Authors
can `withdrawProposal` from Draft or In Review. Reviewers never edit a
version.

**Stale-base detection.** Every update op records its record's base
Revision. If any base moves before approval (someone else's change landed
first), approval is blocked: `approveProposal` flags the proposal stale and
reports which records moved instead of applying anything. The author must
explicitly `rebaseProposal` — back to Draft re-anchored on today's bases,
with already-made changes dropped as no-ops — review, and resubmit. There
is no silent rebase.

**Temp-IDs.** One Proposal can atomically create several records: create
ops for `series`/`volumes`/`editions`/`releases` may reference the temp-ID
of an earlier create op (a volume's `seriesId`, an edition's coverage rows,
a release's `editionId`). Approval applies them in order, allocating public
IDs, computing Volume Position, inserting `volumeCoverages`, and deriving
Release denorms. The same machinery approves the In-Review creation
proposals the Seven Seas importer queues in steady state. The
`/mod/propose-new/{seriesPublicId}` wizard (linked from Series pages for
the data team) drafts a volume + edition + coverage + release in one
proposal.

**The queue.** `/mod/queue` (Data-Team-visible only) lists In-Review
proposals oldest first, filterable by operation, record type, author
(imports vs humans, or one name), warnings, staleness, and age. Claiming
(`claimProposal`) signals who is looking but never locks — any Moderator
can still decide. `/mod/proposal/{id}` is the review page: every immutable
version with grouped before/after per record, base Revisions and per-record
staleness, evidence beside the changes, structural summaries of creates,
the Draft working copy, and the internal (never public) discussion notes.
`/mod/proposals` lists the viewer's own proposals; Editors reach the update
form at `/mod/propose/{type}/{key}` via the "Propose a change" links on
record pages.

**Rate limits and bulk caps.** The official Convex rate-limiter component
(`@convex-dev/rate-limiter`, registered in `convex/convex.config.ts` — no
extra setup beyond `npx convex dev` pushing it) enforces per-user token
buckets: 30 submissions/hour (burst 5) and 120 draft saves/hour (burst 20).
A single proposal carries at most 25 operations (`bulkCap`).

## Merge, split, hide, restore, and locks (ticket #33)

Spec §5's sensitive catalog operations: the engine in
`convex/lib/sensitiveOps.ts`, the Moderator surface in
`convex/sensitiveOps.ts`, and the panel at `/mod/manage/{type}/{key}`
(reached via "Manage (hide / merge / lock)" on record pages). Every
operation demands a written reason, shows an impact preview (observation,
revision, relationship, child-record, and tracking counts), and requires an
explicit confirmation — enforced again server-side. Each applies as an
immediately approved Proposal, so the reason and the state change land in
the record's public history; `approveProposal` applies the same op kinds
through the same engine if they arrive via the review queue.

**Hide / Restore.** Hide flips `status` to `hidden` — the record leaves
public discovery (queries read hidden records as absent) while its
identity, public ID, revision history, and every tracking reference stay
untouched. Restore flips it back. Restore never reverses a merge.

**Merge.** Picks a survivor and transfers everything from the loser:
Source Observations and conflict suppressions repoint; compatible
relationships repoint (self-edges and edges the survivor already carries
are dropped); child records move (a Series' Volumes append after the
survivor's reading path, Edition coverage and Bundle memberships dedupe on
their natural keys); user tracking transfers with the survivor's row
winning wherever a user tracked both duplicates; release denorms
(`seriesIds`/`publisherId`) recompute. The loser keeps its public ID and
history and points at the winner (`status: "merged"` + `mergedIntoId`), so
every losing-ID URL 301s permanently through the existing route resolution —
no redirects table.

**Split.** The only reversal of a mistaken merge. Every merge persists a
`mergeManifests` row (each repointed reference with its prior value, each
deduped row's contents, each inserted row); Split replays it backward —
skipping references the world re-aimed since — reactivates the loser, and
consumes the manifest.

**Locks.** Hidden and Merged records reject ordinary edits by status
(direct edits, proposal drafts, and approvals all refuse them). Moderators
can additionally `lockRecord` an active record during a dispute — same
refusals — and `unlockRecord` when it resolves. Hide and Merge refuse
temporarily locked records; unlock first, deliberately.

## Import foundation (ticket #34)

Spec §6/§7: the hybrid data strategy's automated half, proven end to end on
one source — Seven Seas Entertainment, the lowest-friction publisher source
(first-party WP REST JSON API, open robots.txt, no scraping-hostile ToS).

**Approved Source registry — data, not code** (`convex/importSources.ts`).
Each `approvedSources` row carries scope, the per-field authority map
(authoritative / standard / weak), cadence, enablement, and the attribution
string used on imported covers. Adding or editing a source's scope,
authority, or cadence is a plain data write — the Administrator-gated
`importSources.upsert` mutation or the Convex dashboard — with no schema or
code change. Only the adapter (fetch + parse) is code; a registry row
without an adapter is inert until one ships. Seed the five v1 sources from
the spec's authority table (inserts missing keys only, never overwrites
edits):

```sh
npx convex run importSources:seedRegistry '{}'
```

All five rows seed enabled — every adapter exists (tickets #34/#36). PRH
and OpenLibrary additionally need environment configuration and skip runs
as "unconfigured" until it is set (see "Remaining sources" below). On a
deployment seeded before ticket #36, flip the four newer rows on via
`importSources.upsert` or the dashboard (`seedRegistry` never overwrites an
existing row).

**Source Observations** (`convex/lib/observations.ts`). External facts are
observations, never direct writes: identity is (source, source-record-id),
`snapshot` holds the latest normalized form read by reconciliation, and
every superseded snapshot is retained append-only in `observationSnapshots`.
An unchanged fetch bumps `lastSeenAt` only. A record that disappears from a
**complete** listing sweep is marked withdrawn — retained, never deleted;
absence is never evidence, and a partial sweep never withdraws anything.

**Import Runs & health** (`convex/imports.ts`). Every run logs source,
timing, counts, and errors in `importRuns`. Fetches back off exponentially
within a run; three consecutive failed runs flip the source unhealthy in
the registry (first success flips it back). The Admin email on transition
awaits an email provider.

**Cadence** (`convex/crons.ts`). One hourly cron tick reads the registry
and starts every enabled source that is due per its cadence string
(`daily` / `weekly` / `monthly`), so cadence edits take effect without a
deploy. A still-running run defers its source.

**The Seven Seas adapter** (`convex/sevenSeas.ts`, parsers in
`convex/lib/sevenSeas.ts`). `sevenSeas:sync` pages through
`wp-json/wp/v2/books` (identity + title + `modified_gmt` as the change
signal), fetches the book page for new/changed records only (the
`#volume-meta` block carries series, creators, release date, price, format,
ISBN, cover), skips non-manga records (light novels, audiobooks),
normalizes, and reconciles each snapshot atomically:

- **Matching ladder**: the full five rungs, shared with every future
  adapter — see "Import reconciliation (ticket #35)" below.
- **Creation** goes through the same Proposal machinery as humans (spec §5):
  a system-authored, immediately approved Proposal creates
  Series → Volume → Edition (+ coverage) → Release, with one public
  importer-authored **Revision per record citing the source name + record
  URL**. Marketing descriptions are never imported (spec §6).
- **Steady state** auto-creates a single-volume Release under an
  already-linked Series; a brand-new Series, multi-volume coverage, or an
  Edition-Line-shaped release (deluxe/omnibus/box-set packaging) queues an
  In-Review Proposal pre-filled with the parsed guess instead.
- **Bootstrap Mode** (spec §7) lifts both gates: those records are created
  directly and tagged `bootstrapUnreviewed` — exactly what steady state
  would have queued — queryable as the post-launch backlog via
  `imports.bootstrapBacklog`. Toggle (Administrator mutation
  `importSources.setBootstrapMode`, or the operator escape hatch before an
  Administrator exists):

  ```sh
  npx convex run importSources:setBootstrapModeInternal '{"on":true}'
  ```

- **Updates** to a linked Release reconcile field-by-field under the
  authority conflict rules (next section); a Series rename at the source is
  a field conflict on the linked Series, never a failed match.
- **Covers** land in Convex file storage as
  `{storageId, sourceUrl, attribution}`, with the attribution string from
  the registry row.

Run it manually against a dev deployment (the polite defaults pause between
requests and cap book-page fetches per run, so the initial backfill
converges over repeated runs — newest-modified first):

```sh
npx convex run sevenSeas:sync '{}'                        # full sweep, ≤200 detail fetches
npx convex run sevenSeas:sync '{"maxDetailFetches":1000}' # bigger backfill bite
npx convex run sevenSeas:sync '{"maxListingPages":1}'     # quick smoke (no withdrawal pass)
```

Bootstrap seeding order for this source: `seedRegistry` → turn Bootstrap
Mode on → repeat `sevenSeas:sync` until `recordsChanged` settles at 0. The
`imports.recentRuns` query (Moderator+) shows run history; Bootstrap Mode is
switched off permanently before launch (spec §7).

## Import reconciliation: matching ladder + authority rules (ticket #35)

Spec §6, source-agnostic: every adapter funnels through the same three
modules, so Kodansha/PRH/ANN/OpenLibrary inherit the whole rulebook.

**The five-rung matching ladder** (`convex/lib/matching.ts`), strongest
first, resolved top-down:

1. **Stored source-id link** — the observation's `recordRef` (the adapter's
   fast path). A rename at the source is then a field conflict on the
   linked record, never a failed match.
2. **ISBN-13 exact** with a title-similarity sanity check; a hit with a
   dissimilar title flags for review.
3. **Publisher + normalized series title + volume label + format**, against
   editions covering exactly that one volume — auto ONLY with exactly one
   candidate carrying no Human Override and no lock.
4. **Title-only** plausible candidates: always review.
5. **No match**: the creation path.

Two plausible candidates anywhere queue a flagged In-Review Proposal
(pre-filled with the creation guess and the ambiguity in its change
comment); the importer never initiates a merge. Multi-volume facts (omnibus
ranges) skip rungs ③/④ — ISBN or the creation path.

**Authority conflict rules** (`convex/lib/authority.ts` pure decisions,
`convex/lib/reconcile.ts` applies them). For each offered field, the
incumbent is whoever authored the latest Revision touching it; both sides'
ranks come from the **live** registry, so a registry edit ("rules change")
re-routes the next run with no code change:

- **Strictly higher authority** auto-updates (approved system Proposal +
  public importer-authored Revision citing the source).
- **Equal authority** queues an In-Review conflict Proposal — one open
  conflict per observation; a stale or outdated open conflict is withdrawn
  and replaced by the importer itself.
- **Lower authority** is recorded on the observation only
  (`sourceObservations.conflicts`).
- **Dates**: a consistent more-precise date auto-refines at equal-or-higher
  authority; less precise never replaces more precise (not even a conflict).
- **Human Overrides stay sticky**: a conflicting import queues at ANY
  authority and never overwrites; human-authored values without an override
  mark queue too. A source updating its own previously imported fact
  auto-updates (not a cross-source disagreement).
- The `price` authority column extends the spec table as plain registry
  data (own-catalog sources + PRH authoritative).

**Suppression** (spec §6): rejecting a source-authored conflict Proposal
(`proposals.rejectProposal`) writes a `conflictSuppressions` row per
rejected field, keyed exactly on (record, field, source, offered value) —
the identical conflict never re-queues. It lifts when the source offers a
different value (different hash), the observation is withdrawn (the sweep
deletes that record's suppressions from that source), or registry rules
re-route the field away from the queue.

**Steady-state creation boundaries**: a single-Volume Release under an
already-linked Series auto-creates; a brand-new Series, multi-Volume
Coverage, or an Edition-Line-shaped release
(omnibus/deluxe/box-set/collector's packaging) queues pre-filled so a
correct guess is one click. Bootstrap Mode lifts the creation gates —
matching ambiguity still reviews even in Bootstrap Mode. Queue dedup rides
`sourceObservations.queuedProposalId`: one open queue item per observation,
and a rejected one never re-queues until the snapshot changes.

Tests: `convex/lib/authority.test.ts` (the decision table),
`convex/lib/matching.test.ts` (the ladder against a hand-built catalog),
`convex/reconcile.test.ts` (end to end through the Seven Seas pipeline on a
stubbed site: overrides, suppression, source-vs-source conflicts, precision
refinement, rungs ③/④, the Edition-Line gate, withdrawal).

## Remaining sources: Kodansha, ANN, PRH, OpenLibrary (ticket #36)

Spec §6/§7: the other four v1 sources as registry rows through the same
pipeline. The apply machinery shared with Seven Seas now lives in
`convex/lib/pipeline.ts` (creation path, review-queue path, series-link
reconciliation, queue dedup) and `convex/lib/http.ts` (polite fetch); each
adapter is only fetch + parse + the source's own shape decisions. One
ladder refinement landed with this ticket: a candidate matching the full
publisher+title+label key but differing **only in Format** is a sibling
Release of the same Edition (spec §2), so it takes the creation path and
attaches to the sibling's Edition instead of queueing a review.

**Kodansha** (`convex/kodansha.ts`, parsers `convex/lib/kodansha.ts`;
daily). First-party JSON only — `wp-json/kodansha/v1/release-calendar`
(~8 weekly buckets keyed by Tuesday) + `/new-releases` (this week, exact
ISO dates, `series_type` scoping to comics). One catalog item announcing
`["digital","print"]` yields one observation and one Release **per
format**, sharing a single Edition. The endpoints expose no ISBNs or
prices; the PRH overlay supplies those later (Kodansha is
PRH-distributed). A rolling window is not a catalog sweep, so this adapter
never withdraws. `npx convex run kodansha:sync '{}'`

**ANN Encyclopedia** (`convex/ann.ts`, parsers `convex/lib/ann.ts`;
weekly). The full mirror that builds the all-publisher, series-structured
**Series/Volume backbone** — including VIZ and Square Enix, whose sites are
never scraped. Enumerates `reports.xml?id=155` and batch-fetches
`api.xml?manga=…` 50 ids at a time at **1 req/s** (1.1 s pause before every
request); one action invocation processes a bounded number of batches and
schedules itself to continue, so the ~40k-entry mirror chains across
Convex's action time limit under one Import Run — withdrawal fires only
when the final link reaches the end. ANN's API carries no publisher and no
ISBN, so ANN never creates Editions or Releases: one manga entry = one
Series (standard-authority title), "(GN n)"/"(eBook n)" designators define
the Volumes, and each release line is an observation keyed on ANN's own
release id that links to the canonical Release once another source creates
it (series link + label + format is the full key under a linked Series) —
from then on ANN dates reconcile in at standard authority, which is how
VIZ dates stay fresh. Citations link the Encyclopedia entry, satisfying
ANN's attribution license. `npx convex run ann:sync '{}'`

**PRH API** (`convex/prh.ts`, parsers `convex/lib/prh.ts`; daily +
weekly full sweep). The authoritative date/ISBN/price overlay on
PRH-distributed records — scope is inherent, the API only returns titles
PRH distributes. Daily runs fetch future-dated titles (`onsaleFrom`
today); UTC-Sunday runs (or `{"mode":"full"}`) sweep each configured
imprint's catalog, and only a complete full sweep withdraws. Unmatched
titles follow the standard creation boundaries under the imprint's
publisher (e.g. "Kodansha Comics", "Denpa"). Setup (no live key exists in
this repo):

```sh
# 1. Request a key at developer.penguinrandomhouse.com (manual activation).
# 2. Once active, list imprint codes:
#    curl "https://api.penguinrandomhouse.com/resources/v2/title/domains/PRH.US/imprints?api_key=KEY"
#    and pick the manga imprints (Kodansha, Seven Seas, Dark Horse Manga,
#    Square Enix Manga, Denpa, Vertical, …).
npx convex env set PRH_API_KEY <key>
npx convex env set PRH_IMPRINT_CODES CODE1,CODE2,CODE3
npx convex run prh:sync '{"mode":"full"}'
```

**OpenLibrary** (`convex/openLibrary.ts`, parsers
`convex/lib/openLibrary.ts`; monthly). The bulk-dump ISBN fill (seeding
stage ④): flat records match *into* the existing skeleton and **never
define Series structure** — a match fills ISBNs (standard), dates (weak),
binding (standard); an unmatched record may create at most a **leaf**
Release under a Series, Volume, and Publisher that all already exist (how
VIZ physical releases materialize under the ANN backbone), and it never
creates Series/Volumes/Publishers, never queues review proposals, and
never withdraws. The raw editions dump is ~10 GB, so filter it offline and
host the result anywhere fetchable:

```sh
curl -sL https://openlibrary.org/data/ol_dump_editions_latest.txt.gz \
  | node scripts/filter-openlibrary-dump.mjs > filtered.txt
# host filtered.txt (any static URL), then:
npx convex env set OPENLIBRARY_DUMP_URL https://…/filtered.txt
npx convex run openLibrary:sync '{}'   # streams + self-continues to the end
```

**Seeding order** (spec §7): `seedRegistry` → Bootstrap Mode on → ①
`sevenSeas:sync` + `kodansha:sync` until settled → ② `ann:sync` (the
backbone; hours at 1 req/s) → ③ `prh:sync '{"mode":"full"}'` → ④
`openLibrary:sync` → quality gates → Bootstrap Mode off, permanently.

Tests: `convex/lib/{kodansha,ann,prh,openLibrary}.test.ts` (parsers against
captured live payloads / documented shapes) and
`convex/{kodansha,ann,prh,openLibrary}.test.ts` (each adapter end to end
against a stubbed source: creation, per-format Edition sharing, backbone
building, linking + authority reconciliation, overlay fills + conflicts,
leaf-only creation, continuation chaining, withdrawal, steady-state gates).

## SEO: metadata, JSON-LD, Open Graph, sitemaps (ticket #39)

Spec §11. All metadata is formula-generated — no hand-written metadata in v1.

**Titles & descriptions.** `src/lib/seo.ts` holds the per-page-type templates
(Series "{Title} – English Manga Volumes & Release Dates | MangaDB", Volume
"{Series} Vol. {Label} – …", Edition "{Composed title} ({Publisher}) – ISBN &
Release Date | MangaDB", Publisher, Month, browser, Bundle). Descriptions are
assembled from facts, falling back to a truncated Volume Synopsis / Release
Description. Every page's `head()` goes through `pageHead()`, which also
emits the canonical link and the **cover-led OG/Twitter card** — the
representative release cover picked at query time (spec §8) upgrades the
card to `summary_large_image`.

**JSON-LD.** BreadcrumbList on every catalog page; BookSeries on Series;
one Book per Release row on Edition pages (URL = the Edition page anchored
at the row — Releases have no page of their own); Organization on Publisher;
ItemList on unfiltered month pages. No ratings markup. Builders live in
`src/lib/seo.ts`, unit-tested in `src/lib/seo.test.ts`.

**Indexing policy.** Catalog pages, `/releases`, and month views are
indexable and always carry an absolute canonical. Filtered browser views
(format/publisher/view params) are `noindex, follow` with the canonical
pointing at the unfiltered URL. `/search`, `/me/…`, `/mod/…`, auth pages,
and `/claim-username` are never indexed (meta robots; `/u/{username}` gets
the same treatment when profiles land). No `?page=N` is ever indexed: entity
pages don't paginate, the browser paginates by month URL, and the
always-present canonical strips any stray query string.

**Sitemaps & robots.** The custom Worker entry (`src/server.ts` →
`src/server/seoRoutes.ts`) serves `/sitemap.xml` — an index of per-entity
children (`/sitemaps/{series,volumes,editions,publishers,bundles,months}.xml`)
containing exactly the indexable canonical URLs — plus `/robots.txt`.
`lastmod` comes from each record's latest Revision (`convex/seo.ts`,
paginated), falling back to creation time; everything is generated on demand
with `Cache-Control` headers — no cron. `robots.txt` disallows only the
pure-app surfaces (`/me`, `/mod`, `/claim-username`) so noindex-carrying
pages stay fetchable, and links the sitemap index.

**Canonical origin.** Absolute URLs (canonical links, OG URLs, sitemap locs)
use `VITE_SITE_URL` when set, defaulting to `https://mangadb.org`; the
runtime `CANONICAL_HOST` var continues to drive the www/HTTPS 301s.

## Auth (Clerk) — how it works

Spec §9. Clerk owns credentials and sessions (Google OAuth + verified
email/password). The Convex `User` is created **just in time**: the first
sign-in lands on `/me`, which bounces to `/claim-username`; claiming the
required username atomically inserts the `users` row, keyed by the stable
Clerk subject — never email — so changing the email keeps the same User.
Usernames are case-insensitively unique (normalized copy + index), checked
against the reserved list in `convex/lib/usernames.ts`, and changeable with
immediate release of the old name. Account deletion (`/me` → Account) is one
Convex action that deletes the Clerk identity via the Backend API, then purges
every MangaDB record. The catalog stays fully public signed out; personal
functions authorize in Convex via `ctx.auth.getUserIdentity()`
(`convex/lib/auth.ts` has the `requireUser` gate for the tracking slices).

Requests flow: `clerkMiddleware()` (`src/start.ts`) authenticates every server
request → the root route's `beforeLoad` server function exposes
`{ userId, convexToken }` (a JWT minted from the Clerk template named
`convex`) → SSR loaders put that token on the Convex HTTP client
(`convexServerClient(token)`), while the browser uses
`ConvexProviderWithClerk` (`src/providers.tsx`). Convex validates both via
OIDC (`convex/auth.config.ts`).

### One-time Clerk setup

1. Create a Clerk application ([dashboard.clerk.com](https://dashboard.clerk.com)).
   Enable **Google** OAuth and **Email/password** with email verification
   under *User & Authentication*; no other methods are needed for v1.
2. Create a **JWT template named `convex`** (Clerk has a Convex preset) and
   note its issuer domain (`https://<slug>.clerk.accounts.dev` in dev).
3. Wire the environment variables below.

### Environment variables

App:

- `VITE_CLERK_PUBLISHABLE_KEY` — Clerk publishable key (`pk_…`). Public;
  ships in the client bundle. Unset → auth UI disabled.
  Dev: `.env.local`. Deploy: build env + `vars` in `wrangler.jsonc`.
- `CLERK_SECRET_KEY` — Clerk secret key (`sk_…`). Server-only; enables
  `clerkMiddleware()` and SSR auth. Unset → app treats everyone as signed out.
  Dev: `.dev.vars` (workerd reads Worker secrets from there, not `.env.local`).
  Deploy: `npx wrangler secret put CLERK_SECRET_KEY`.
- `VITE_SITE_URL` — canonical public origin for SEO URLs (canonical links,
  OG URLs, sitemap locs). Unset → `https://mangadb.org` (spec §11's apex).
  Set it only for preview environments that should self-reference.

Convex deployment (Convex dashboard → Settings → Environment Variables, or
`npx convex env set`):

- `CLERK_JWT_ISSUER_DOMAIN` — issuer domain of the Clerk JWT template named
  `convex` (see `convex/auth.config.ts`). Until Clerk is provisioned, any
  placeholder value (e.g. `https://placeholder.clerk.accounts.dev`) unblocks
  deploys; nothing calls it until authed features land.
- `CLERK_SECRET_KEY` — same secret key again; used by the account-deletion
  action to delete the Clerk identity through Clerk's Backend API.

Other commands:

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest (canonical-host + slug + ISBN + title + SEO metadata/JSON-LD/sitemap policy; seed, series/volume/edition/bundle pages, isbn lookup, search, accounts, reading tracking, sitemap queries, source registry + Seven Seas import pipeline via convex-test with fixture responses)
npm run build       # production client + Worker bundles into dist/
npm run preview     # serve the production build locally in workerd
```

## Deployment

One command deploys both halves — Convex first (schema + functions), which
then injects the deployment URL into the Worker build, then Workers:

```sh
npm run deploy
```

which runs:

```sh
convex deploy --cmd-url-env-var-name VITE_CONVEX_URL --cmd "npm run build" && wrangler deploy
```

One-time setup:

1. **Convex** — create a production deployment (`npx convex dev` once, or the
   [dashboard](https://dashboard.convex.dev)); set `CLERK_JWT_ISSUER_DOMAIN`
   on it (see above). `convex deploy` reads `CONVEX_DEPLOY_KEY` in CI.
2. **Cloudflare** — `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` in CI).
   Set the Worker's runtime Convex URL once:
   `npx wrangler secret put VITE_CONVEX_URL` (or add it under `vars` in
   `wrangler.jsonc`) — the value is the production `https://<name>.convex.cloud`
   URL. It is public (it ships in the client bundle), not a secret.
3. **Clerk** — set `npx wrangler secret put CLERK_SECRET_KEY`, and add
   `VITE_CLERK_PUBLISHABLE_KEY` under `vars` in `wrangler.jsonc`. Both
   `VITE_*` values must also be present in the **build** environment (`npm run
   build` inlines them into the client bundle); the Convex-side variables are
   listed under Auth above. In the Clerk dashboard add the production domain
   (`mangadb.org`) to the app's allowed origins.
4. **Domain** — in the Cloudflare dashboard attach `mangadb.org` and
   `www.mangadb.org` as custom domains for the Worker (or uncomment `routes`
   in `wrangler.jsonc`). `src/server.ts` then enforces the canonical-host
   policy from the spec (§11): apex canonical, `www` 301s to it, HTTPS-only.
   The `CANONICAL_HOST` var in `wrangler.jsonc` controls this; `*.workers.dev`
   preview hosts are never redirected.

## Verifying a deploy

Visit the deployed URL: the home page is server-rendered on Workers and shows
live catalog counts fetched from Convex during SSR — a full
SSR → Convex round-trip on every request.
