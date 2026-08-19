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
| `src/routes/` | File-based routes (`__root.tsx` is the document shell; `releases.index.tsx` + `releases.$month.tsx` are the Releases browser; `series.$publicId.$slug.tsx`, `volume.…`, `edition.…`, and `bundle.…` are the public catalog pages; `isbn.$isbn.tsx` is the ISBN entry point; `search.tsx` is v1 search; `me.tsx` is the gated shell; `sign-in.$`/`sign-up.$` host Clerk's UI; `claim-username.tsx` is the forced first-sign-in step) |
| `src/router.tsx` | Router factory (`getRouter`) |
| `src/lib/` | Isomorphic helpers (computed slugs + public-ID parsing for catalog URLs; ISBN recognition for search; month arithmetic + the shared Releases-browser UI) |
| `src/start.ts` | Global Start config: Clerk request middleware (only when credentials exist) |
| `src/providers.tsx` | Client wiring: `<ClerkProvider>` + `ConvexProviderWithClerk`, site header |
| `src/server.ts` | Custom Workers entry: canonical-host redirect, then the Start handler |
| `src/server/` | Server-only code (canonical-host policy, SSR Convex client, SSR Clerk auth/token) |
| `convex/` | Convex schema + functions (`schema.ts` is the v1 schema from wayfinder #11; `catalog.ts` public catalog reads; `releases.ts` the Releases-browser month window from #24; `seed.ts` the dev seed from #22; `users.ts` + `lib/` are accounts from #26) |
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

## Search

`/search?q=…` (spec §8/§11, ticket #38) is v1 search, reachable from the box
in the site header. It is deliberately narrow:

- **Series** are matched through the `search_title` search index on
  `searchText` — the title and every alternate title concatenated on write —
  so "Toukyou Kushu" finds Tokyo Ghoul. Results link the canonical
  `/series/{id}/{slug}` pages; hidden and merged records never appear (a
  merged Series is findable through its survivor).
- **Publishers** resolve by case-insensitive name match over the small
  publisher list, linking their `/publisher/{slug}` pages (Publisher
  Spotlight pages are ticket #25).
- **ISBNs**: a query recognized as a valid ISBN-10/13 (`src/lib/isbn.ts` —
  checksum-verified, separators ignored) never runs a text search; the loader
  302s through `/isbn/{isbn}`, the route that owns resolution to the owning
  Edition page anchored at the Release (or the Bundle page) with a 301
  (ticket #23). The dev seed's fake ISBNs are checksum-valid so this is
  demoable locally — try `978-1-9990001-0-3`.

No Volume or Bundle text search in v1, and search pages are noindex — they
are not in the spec's indexable set.

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
npm test            # vitest (canonical-host + slug + ISBN + title policy; seed, series/volume/edition/bundle pages, isbn lookup, search, accounts via convex-test)
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
