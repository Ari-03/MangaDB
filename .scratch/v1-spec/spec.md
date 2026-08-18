# MangaDB v1 Specification

A public website for tracking English manga **volume** releases: what volumes exist, when each edition comes out, and which ones you own, want, or have read. Browse/calendar plus personal tracking with accounts, public from day one.

This document assembles every decision resolved on [Map: MangaDB v1 spec](https://github.com/Ari-03/MangaDB/issues/1) (wayfinder effort, 2026-08-12 → 2026-08-18). Each section links the ticket that holds its full rationale; the authoritative decision record is the `## Resolution` comment on each closed ticket. The ubiquitous language lives in repo-root [`CONTEXT.md`](../../CONTEXT.md); the runnable schema draft in [`convex/schema.ts`](../../convex/schema.ts).

**Stack (user-fixed):** TanStack Start (SSR) + Convex. **Auth:** Clerk. **Hosting:** Cloudflare Workers Paid at `mangadb.org`.

---

## 1. Product scope

From the charting session and [catalog scope](https://github.com/Ari-03/MangaDB/issues/15):

- **v1 features:** release calendar/browse + personal tracking (collection, reading, following). Public catalog from day one; accounts only for personal features.
- **English-first:** every Release carries a language from day one; v1 populates and surfaces English only.
- **Formats:** physical + digital releases. Physical-complete, digital-partial at launch, honestly labeled (see §7).
- **Volumes, not chapters:** chapter-level tracking is AniList/MangaUpdates territory.

**Out of scope for v1** (recorded on the map): notifications/release alerts; purchase links & retailer prices; audio releases; populating non-English data (schema supports it); chapter-level tracking; Publication Wishes for unannounced editions and demand voting; user-created custom lists; chronological/social activity feeds.

**Open, non-blocking:** project name and branding — working title "MangaDB"; metadata templates retitle without structural change ([routes & SEO](https://github.com/Ari-03/MangaDB/issues/19)).

## 2. Domain model

Full definitions in [`CONTEXT.md`](../../CONTEXT.md). Decided in [edition modeling](https://github.com/Ari-03/MangaDB/issues/6), refined by [routes & SEO](https://github.com/Ari-03/MangaDB/issues/19) (the Edition entity) and [the schema](https://github.com/Ari-03/MangaDB/issues/11); modeling instincts borrowed from [RanobeDB research](https://github.com/Ari-03/MangaDB/issues/4).

Source-content identity is stable; publisher packaging is modeled separately:

- **Series** — a separately named work with one canonical Volume sequence. A sequel/reboot/spinoff with its own numbering is another Series; republishing or renumbering the same work is not. Carries **Source Status** (ongoing | completed | hiatus | cancelled — describes the source work, imported like any fact).
- **Series Family** — optional, non-nestable umbrella shown only when ≥2 Series belong together; typed **Series Relationships** (`sequel | prequel | spinoff | reboot | sideStory | other`, note required for `other`; stored once per edge as "from is a {type} of to", reverse rendered).
- **Volume** — stable source collected-content unit. Hidden consecutive **Volume Position** (identity/sort) + public **Volume Label** ("7.5", "Side Story"). Oneshots are Series with one unnumbered Volume. Optional editor-curated **Volume Synopsis**.
- **Edition** — first-class stored entity with its own public ID: a publisher's packaging of specific content — one Publisher, one ordered **Volume Coverage** (complete/partial per Volume), one **Edition Line** membership or none, with **Edition Line Position** ("Omnibus 1") independent of the covered Volumes. Realized by Releases that differ only in Format and Binding. The book detail page is per Edition.
- **Release** — a specific purchasable publication of an Edition: Format (`physical | digital`), Binding where applicable (open vocabulary: paperback, hardcover…), one language, optional ISBN-10/13. Unchanged reprints and the same digital publication at other retailers keep their identity; a change to those characteristics creates another Release. Carries the publisher-provided **Release Description**.
- **Release Variant** — a visually distinct form (alternate/box-set-exclusive cover) with otherwise unchanged characteristics; browsed beneath its Release, referenceable by collection entries and bundle memberships.
- **Release Bundle** — purchasable, non-nestable package (box set) of existing Releases, optionally pinning a member's Variant; has its own publication facts and box-set ISBN.

**Edge cases verified against the schema draft** ([schema resolution](https://github.com/Ari-03/MangaDB/issues/11)): box sets, oneshots, omnibus/deluxe lines, split/merged/reordered English editions (ordered coverage with `partial` extent + note), relaunches (same Series), spinoffs (new Series + relationship edge), bundle-exclusive covers.

## 3. Personal tracking

Decided in [the personal tracking model](https://github.com/Ari-03/MangaDB/issues/7). Ownership, reading history, and future-release interest are separate:

- **Collection** — a Collection Entry targets a Release or Bundle, exactly one state: **Wanted | Ordered | Owned** (Ordered includes preorders; all transitions user-controlled). May pin an owned Variant. Owning a Bundle yields **Derived Ownership** of member Releases (computed, never stored) coexisting with direct entries. No stored Volume-ownership state — displayed through owning covering Releases.
- **Reading** — **Series Reading Status** is explicitly chosen (Plan to Read | Reading | Paused | Dropped | Completed); prompts on starting/finishing never change it without confirmation. **Release Progress** is an active pass with an optional 0–100% slider; confirmed completion increments **Volume Progress** (durable, edition-independent read counts) for every completely covered Volume; partial coverage untouched. Rereads increment; undo decrements.
- **Following** — **Series Follow** is explicit; one non-blocking prompt after the first Collection Entry in a Series, dismissal suppresses future prompts. **My Upcoming Releases** = announced future Canonical Releases from followed Series matching the user's Physical/Digital/Both preference, plus every future Wanted/Ordered Release **and Bundle** regardless of preference; deduplicated, Owned excluded; computed, never stored.
- **Privacy** — private by default. Ownership and Reading have separate visibility defaults + per-Series overrides. Public Ownership never exposes Wanted/Ordered; Follows always private in v1. Sharing is a current-state profile (`/u/{username}`, noindex), not an activity feed.

## 4. Data strategy: hybrid import + governance

Decided in [data strategy](https://github.com/Ari-03/MangaDB/issues/5): approved automated sources provide breadth and freshness; trusted humans correct, enrich, and govern.

- External facts are **Source Observations**; the public record is the **Canonical Record**.
- Approved human corrections are field-level **Human Overrides** — sticky: imports may report conflicts but never silently overwrite; only an explicit Moderator action clears one. Created *implicitly*: any approved human change to an import-authored field marks it overridden ([import rules](https://github.com/Ari-03/MangaDB/issues/13)).
- Approved changes create immutable public **Revisions** (who/what, why); pending and rejected proposals are Data-Team-only in v1.
- **Roles:** Administrators appoint Moderators; Moderators appoint Editors and approve/reject proposals; Editors propose. Admin/Moderator direct edits use the same machinery as immediately approved Proposals. Every role change is permanently audited.
- Duplicates **merge** into one surviving Canonical Record — observations, revisions, and user tracking transfer; obsolete URLs 301.

## 5. Moderation workflow

Decided in [editor proposal and moderation workflow](https://github.com/Ari-03/MangaDB/issues/14). Immutable, versioned **Proposals** are the single write path for human and automated maintenance:

- One coherent atomic intent per Proposal (may span records that must change together; temp-IDs let one proposal create Volume + Edition + coverage atomically).
- Lifecycle `Draft → In Review → Approved | Rejected | Withdrawn`; Request Changes returns to Draft, resubmission creates a new immutable Proposal Version. Reviewers approve the exact version — never edit it.
- Each version records every affected record's **base Revision**; any base change before approval makes it stale → explicit rebase and resubmit, no silent rebase.
- One Moderator/Administrator approval suffices. Submission and approval both run validation; hard invariants cannot be overridden. Every submission needs a change comment; factual changes need source evidence; merge/split/hide/restore/override-removal need reason + impact preview.
- Shared review queue, filterable (operation, record type, author/source, age, warnings, stale); claims coordinate, not lock.
- **Hide** preserves identity/history/tracking; **Restore** reactivates. **Merge** picks a survivor, transfers everything, 301s the loser permanently; reversal only via explicit **Split**. Hidden/Merged records are locked; temporary locks available during disputes.
- Public history per record: final diff, author, approver, timestamp, comment, public evidence citations. Internal discussion stays private.
- Revocation/suspension removes privileges without rewriting attribution; per-user rate limits and bulk caps (Convex rate-limiter component). No reputation/voting/auto-promotion in v1.
- Imports author Proposals too: unambiguous high-confidence → immediately approved system Proposals; everything ambiguous → In Review in the same queue, pre-filled with the parsed guess. A Data Team member may adopt an import conflict as a linked human Draft.

## 6. Import pipeline

Decided in [import reconciliation, provenance, and confidence rules](https://github.com/Ari-03/MangaDB/issues/13), on the source landscape from [data-sources research](https://github.com/Ari-03/MangaDB/issues/2).

**Approved-source registry — data, not code.** Each source carries scope, per-field authority levels, cadence; editable without schema/code change. **v1 sources:** ANN Encyclopedia + OpenLibrary + PRH API (backbone) + Seven Seas + Kodansha (first-party JSON APIs). VIZ and Square Enix sites are never scraped (ToS ban) — their data arrives via ANN/OpenLibrary/PRH. Post-v1 candidates (Yen Press, Dark Horse, BookWalker) slot into the registry.

**Authority table** (authoritative > standard > weak, scope-limited):

| Source | Scope | Date | ISBN | Titles/labels | Creators | Format/Binding |
|---|---|---|---|---|---|---|
| Seven Seas | own catalog | auth | auth | auth | auth | auth |
| Kodansha | own catalog | auth | auth | auth | auth | auth |
| PRH API | PRH-distributed | auth | auth | std | std | std |
| ANN | all English | std | — | std | std | std |
| OpenLibrary | all English | weak | std | weak | weak | std |

**Conflict rules:** auto-update only from strictly higher authority; equal-authority disagreement queues a Proposal; lower-authority disagreement is recorded on the observation only. A more precise consistent date auto-refines at equal-or-higher authority; less precise never replaces more precise.

**Matching ladder** (strongest first): ① stored source-id link (renames become field conflicts, never failed matches) → ② ISBN-13 exact with title-similarity sanity check → ③ publisher + normalized series title + volume label + format, auto only with exactly one candidate and no override/lock → ④ title-only: always review → ⑤ no match: creation path. Two plausible candidates always queue; the importer never merges.

**Creation boundaries (steady-state):** auto-create single-Volume Releases (and their Volume) under an already-linked Series; always review brand-new Series and anything needing multi-Volume Coverage or an Edition Line — pre-filled so a correct guess is one-click.

**Cadence** (Convex scheduled jobs): Seven Seas & Kodansha daily; PRH daily future-dated + weekly full sweep; ANN weekly full mirror (1 req/s); OpenLibrary monthly bulk dump.

**Observations:** identity = (source, source-record-id); latest normalized snapshot read by reconciliation, prior snapshots retained append-only; disappearance marks **withdrawn** (retained; queues review only if the linked Release is future-dated — possible cancellation). Absence is never evidence; source downtime never expires data. Indefinite retention in v1.

**Covers & descriptions:** covers imported to Convex file storage (`{storageId, sourceUrl, attribution}`) under industry-standard tolerance with a documented takedown contact; marketing descriptions **not** imported — description fields are human-written and optional in v1. *(Note: [routes & SEO](https://github.com/Ari-03/MangaDB/issues/19) defines Release Description as what PRH/OpenLibrary imports provide; the #13 rule stands — the field exists, imports don't populate it in v1.)*

**Runs & failure:** Import Runs log source/timing/counts/errors; exponential backoff within a run; atomic per-record application; three consecutive failures → source **unhealthy** (email Admin on transition and recovery + dashboard flag).

**Attribution:** importer-authored Revisions cite the Source Observation (source name + record URL) — also satisfies ANN's license. Rejected import conflicts are **suppressed** keyed on (record, field, source, offered value) until the value, observation, or rules change.

## 7. Catalog seeding & launch

Decided in [initial catalog scope and seeding rollout](https://github.com/Ari-03/MangaDB/issues/15) (its duplicate [#18](https://github.com/Ari-03/MangaDB/issues/18) folded in).

- **Scope:** all English-language manga publishers (ANN backbone); full backlist; uncapped upcoming horizon; digital-partial with an explicit **"about the data" page** (digital-coverage note, ANN attribution, cover takedown contact).
- **Seeding stages, in order:** ① Seven Seas + Kodansha (validates the pipeline cheaply) → ② ANN full mirror (creates the Series/Volume backbone) → ③ PRH overlay (authoritative dates/ISBNs) → ④ OpenLibrary bulk dump (ISBN fill; flat records match *into* the skeleton, never define structure).
- **Bootstrap Mode:** pre-launch registry state lifting both always-review gates (new Series; multi-Volume Coverage/Edition Line) — imports auto-create directly, tagging what steady-state would have queued as **bootstrap-unreviewed** (queryable post-launch backlog, no public effect). Switched off permanently before launch; toggle lives in a singleton `appConfig`.
- **Partially imported Series** show publicly as-is with a per-Series "see something missing/wrong? → report" affordance feeding the proposal queue.
- **Quality gates** (before Bootstrap Mode turns off): random ~50-Series sample verified; ~50 most prominent series verified; title-similarity duplicate sweep resolved; pass = no systemic error pattern (fix the class pipeline-wide and re-run — no numeric threshold).
- **Launch-ready checklist:** ① four seed stages complete ② quality gates pass, Bootstrap off ③ calendar populated, all five sources healthy on steady-state cadence ④ correction loop exercised end-to-end for real ⑤ "about the data" page exists. **Non-gates:** digital parity, empty bootstrap-unreviewed backlog, any minimum series count.

## 8. Convex schema

Decided in [the Convex schema](https://github.com/Ari-03/MangaDB/issues/11); runnable draft at [`convex/schema.ts`](../../convex/schema.ts) (commit [3daac74](https://github.com/Ari-03/MangaDB/blob/3daac74/convex/schema.ts)). Highlights:

- **Catalog:** `publishers`, `seriesFamilies`, `series`, `seriesRelationships`, `volumes`, `editionLines`, `editions`, `volumeCoverages`, `releases`, `releaseVariants`, `releaseBundles`, `bundleMemberships`. Release identity = edition + Format + Binding + language + ISBNs.
- **Provenance/moderation:** `approvedSources`, `sourceObservations` + `observationSnapshots`, `proposals` + immutable `proposalVersions` (typed op union: create/update/merge/split/hide/restore/clearOverride/lock, each op carrying its base Revision), `revisions`, `conflictSuppressions`, `importRuns`, `roleAudit`.
- **Tracking:** `collectionEntries` (exactly-one-of releaseId/bundleId), `userSeriesStates` (one row per user×series: reading status, follow, prompt-dismissal, visibility overrides), `releaseProgress`, `volumeProgress`. Derived Ownership and My Upcoming are computed queries.
- **Canonical envelope** on catalog docs: `status` (active | hidden | merged), `mergedIntoId`, `locked`, `bootstrapUnreviewed`, `overriddenFields` (embedded override list; who/when/why lives in Revisions). Merged docs keep their public ID and point at the winner — no redirects table. Coverage edits as the pseudo-field `volumeCoverage` of the Edition.
- **Public IDs:** per-entity sequential integers from a `counters` table (imports reserve blocks); Releases get none — they anchor on the Edition page by ISBN, else doc ID. Slugs computed, never stored; `publisherSlugRedirects` for publisher renames.
- **Dates:** `{year, month?, day?, sort}` with yyyymmdd `sort` key (calendar/month/upcoming queries); partial dates supported for #13's precision refinement.
- **Vocabularies:** open validated strings for language (ISO 639-1), binding, currency (`{amountCents, currency}`); Format stays a schema literal (`physical | digital`).
- **Covers:** per Release and per Variant in file storage; Series/Volume/Edition pick a representative release cover at query time.
- **Users:** username required at first sign-in, case-insensitively unique (normalized copy), changeable with immediate release, reserved list in code.
- **Denorms** maintained only by shared write helpers: `publisherId` + `seriesIds[]` on `releases` (`by_date`, `by_publisher_date`), `seriesId` on progress tables. Recorded trade-off: followed-Series and format filters apply in memory after the date-window index scan (Convex can't index array containment; windows hold hundreds of rows).
- **Search (v1):** Series only, via a `searchText` (title + altTitles) search index; publishers via the small list; exact ISBN via the route. No volume/bundle search.

## 9. Auth

Decided in [auth provider](https://github.com/Ari-03/MangaDB/issues/10) on [auth research](https://github.com/Ari-03/MangaDB/issues/3): **Clerk** (only option first-party mature on both Start and Convex; free to 50k MAU). Better Auth is the zero-lock-in fallback to reassess at its Convex integration's 1.0; Convex Auth disqualified (no Start support).

- Clerk owns credentials/sessions. Convex `User` created just in time on first sign-in, keyed by the stable Clerk subject — never email. MangaDB-initiated account deletion deletes both sides. No webhooks in v1.
- Sign-in: Google OAuth + verified email/password; Clerk may link safely-verified methods; no enterprise SSO.
- Access boundary: catalog/search/calendar reads public; auth required for collection/reading/follows/personalized upcoming/sharing/account.
- Integration: `@clerk/tanstack-react-start` (`clerkMiddleware()`, `<ClerkProvider>`); Convex OIDC in `convex/auth.config.ts` (`applicationID: "convex"`); SSR token via server function onto the Convex HTTP client; `ConvexProviderWithClerk` client-side; authorization in Convex functions via `ctx.auth.getUserIdentity()`.

## 10. UI direction

Three validated prototypes set the page hierarchies:

- **Releases browser** ([prototype](https://github.com/Ari-03/MangaDB/issues/8), [asset](https://github.com/Ari-03/MangaDB/tree/prototype/release-browse-ui/prototypes/release-browse-ui)): cover-led chronological **Release Agenda** default + **Month Grid** sibling; shared Format, Publisher, and followed-Series filters (followed = subtle marker + filter, never a separate section); views shareable; Agenda is first-visit default. Releases-only (no bundles in the browser).
- **Series & Volume pages** ([prototype](https://github.com/Ari-03/MangaDB/issues/16), [asset](https://github.com/Ari-03/MangaDB/tree/2cbe034/prototype/series-volume-pages)): **Reading Path** hierarchy — Series leads with the canonical Volume sequence; selecting a Volume reveals every covering Release (complete/partial); canonical position stays visibly separate from Edition Line numbering; variants beneath their Release; bundles cross-link; simple Series hide empty concepts. Edition Shelves retained as reference.
- **Publisher pages** ([prototype](https://github.com/Ari-03/MangaDB/issues/17)): **Publisher Spotlight** — publisher-led profile with a bounded upcoming-Releases lane and a clear route into the main Releases browser; no separate cross-publisher overview.

## 11. Routes, SEO, and metadata

Decided in [public page routes and SEO policy](https://github.com/Ari-03/MangaDB/issues/19).

- **Indexable pages:** Series, Volume, Edition, Publisher, Bundle, `/releases`, month views. Not standalone: Release (row on its Edition page), Series Family, Edition Line, Variant.
- **URLs — flat, ID + cosmetic slug:** `/series/{id}/{slug}` · `/volume/{id}/{slug}` · `/edition/{id}/{slug}` · `/bundle/{id}/{slug}` · `/publisher/{slug}` · `/releases` · `/releases/{yyyy-mm}` · `/isbn/{isbn}` (301 → owning Edition anchored at the Release; also matches Bundles, Release wins conflicts) · `/u/{username}` · `/me/…` · `/search`. Stale slugs 301; merges 301 the losing ID permanently; flat beats nested because merges can re-parent (one redirect per record, never a subtree); breadcrumbs convey hierarchy.
- **Indexing:** catalog + month views indexed; filtered browser views noindex/follow with canonical → unfiltered; followed-filter, personalized, `/me`, auth, and `/u/{username}` never indexed; no `?page=N` ever (entity pages don't paginate; the browser paginates by month URL).
- **Host/metadata:** apex `mangadb.org` canonical (www 301, HTTPS-only); formula-generated titles/descriptions per page type; cover-led OG/Twitter cards; source-attribution page.
- **JSON-LD:** BreadcrumbList everywhere; Book per Release row on Edition pages; BookSeries on Series; Organization on Publisher; ItemList on month pages. No ratings markup.
- **Sitemaps:** `/sitemap.xml` index → per-entity children (series, volumes, editions, publishers, months), exactly the indexable canonicals, `lastmod` from latest Revision, generated on demand with cache headers.

## 12. Hosting & deployment

Decided in [hosting and deployment target](https://github.com/Ari-03/MangaDB/issues/9): TanStack Start SSR on **Cloudflare Workers Paid** ($5/mo; 10M requests, 30M CPU-ms, free static assets, no egress) at **`mangadb.org`** (apex canonical). Direct integration via `@cloudflare/vite-plugin` + `wrangler` + `nodejs_compat`. Convex remains the separately hosted cloud backend. **Railway Hobby** is the runtime-compatibility fallback only (if a dependency can't live within Workers' 128 MB / 10 MB-bundle constraints); repointing DNS preserves URLs. Pricing verified 2026-08-13.

---

## Decision ledger

| Ticket | Decides |
|---|---|
| [#2 Research: data sources](https://github.com/Ari-03/MangaDB/issues/2) | Source landscape; ANN/OpenLibrary/PRH backbone; ToS constraints |
| [#3 Research: auth options](https://github.com/Ari-03/MangaDB/issues/3) | Clerk vs Better Auth vs Convex Auth |
| [#4 Research: RanobeDB](https://github.com/Ari-03/MangaDB/issues/4) | Volume/release split; revision-snapshot pattern; what to skip |
| [#5 Data strategy](https://github.com/Ari-03/MangaDB/issues/5) | Hybrid imports + human governance; overrides; roles; merges |
| [#6 Edition modeling](https://github.com/Ari-03/MangaDB/issues/6) | Series/Family/Volume identity; packaging concepts; variants; bundles |
| [#7 Personal tracking](https://github.com/Ari-03/MangaDB/issues/7) | Collection/reading/following; privacy |
| [#8 Prototype: releases browser](https://github.com/Ari-03/MangaDB/issues/8) | Agenda + Month Grid |
| [#9 Hosting](https://github.com/Ari-03/MangaDB/issues/9) | Cloudflare Workers Paid; mangadb.org |
| [#10 Auth provider](https://github.com/Ari-03/MangaDB/issues/10) | Clerk configuration and integration path |
| [#11 Convex schema](https://github.com/Ari-03/MangaDB/issues/11) | `convex/schema.ts`; IDs, dates, vocabularies, denorms, search |
| [#13 Import rules](https://github.com/Ari-03/MangaDB/issues/13) | Registry, authority table, matching ladder, conflicts, retraction |
| [#14 Moderation workflow](https://github.com/Ari-03/MangaDB/issues/14) | Proposals, review, merge/split/hide, roles, abuse controls |
| [#15 Catalog scope & seeding](https://github.com/Ari-03/MangaDB/issues/15) | Scope, four stages, Bootstrap Mode, QA gates, launch checklist |
| [#16 Prototype: series/volume pages](https://github.com/Ari-03/MangaDB/issues/16) | Reading Path hierarchy |
| [#17 Prototype: publisher pages](https://github.com/Ari-03/MangaDB/issues/17) | Publisher Spotlight |
| [#19 Routes & SEO](https://github.com/Ari-03/MangaDB/issues/19) | Edition entity, URL taxonomy, indexing, JSON-LD, sitemaps |

Building the site happens after this map, as its own effort.
