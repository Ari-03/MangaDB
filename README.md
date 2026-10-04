# MangaDB

MangaDB is a website for keeping track of English manga, one volume at a
time. It lists which volumes and editions exist, when each one comes out in
print and digital, and who publishes it. With an account you can record
which books you own, want, have ordered and have read. It runs at
[mangadb.org](https://mangadb.org).

What a visitor finds:

- **Release calendar** (`/releases`): every announced release, month by
  month, as a dated list or a month grid, filtered by format or publisher.
- **Series library** (`/series`): every series, filtered by publisher,
  volume count, release timing, format and status, sorted by title, recent
  releases, popularity or rating.
- **Series, volume and edition pages**: each series grouped into its
  editions (standard run, omnibus, deluxe), each volume with every release
  that contains it, each edition with its ISBNs, dates and prices.
- **Publishers** (`/publishers`): what every publisher releases this month,
  and a page per publisher with its upcoming books.
- **Authors** (`/authors`): everyone credited on a series, and their work.
- **Search** by title, nickname ("aot"), publisher or ISBN.

Signed-in readers get **My library** (`/me`): a collection of
owned, ordered and wanted books; reading status and read counts per
volume; followed series with their upcoming releases; private ratings,
reviews and favorites; and an optional public profile at `/u/{username}`.

Behind the site, the catalog is imported from publisher and reference
sources and curated by a Data Team of Editors, Moderators and
Administrators. [CONTEXT.md](CONTEXT.md) defines the vocabulary (Series,
Volume, Edition, Release and so on), which the code and these docs use
exactly.

## Stack

[TanStack Start](https://tanstack.com/start) (React, server-side rendered)
runs on Cloudflare Workers. [Convex](https://convex.dev) is the database
and backend. [Clerk](https://clerk.com) handles sign-in. PostHog collects
analytics, and Resend sends import alerts.

Feature switches live in `convex/lib/features.ts`:

| Switch | Now | Effect |
|---|---|---|
| `publicReviews` | off | Reviews can be written but only their author sees them |
| `comments` | off | Comments on series and volume pages are refused and hidden |

## Run it locally

```sh
npm install
npx convex dev   # terminal 1: Convex backend, pushes convex/ and writes .env.local
npm run dev      # terminal 2: the app, with SSR inside workerd
```

On first run `npx convex dev` asks you to log in or create a project and
writes `CONVEX_DEPLOYMENT` and `VITE_CONVEX_URL` to `.env.local`. Without an
account, `CONVEX_AGENT_MODE=anonymous npx convex dev` runs a local backend.
The app needs `VITE_CONVEX_URL`: without it every page fails with an error
naming the variable.
A push fails until the deployment has `POSTHOG_PROJECT_TOKEN`; set it
empty to keep analytics off, then load a small fake catalog:

```sh
npx convex env set POSTHOG_PROJECT_TOKEN ""
npx convex run seed:run '{}'
```

Sign-in is optional. Without Clerk keys the app runs signed out and the
public catalog works.

**Configuration.** Every service reads environment variables, all listed
with setup steps in [docs/configuration.md](docs/configuration.md):
Convex (`VITE_CONVEX_URL`), [Clerk](docs/configuration.md#clerk),
[PostHog](docs/configuration.md#analytics-posthog), Resend for import alert
emails, and the [PRH](docs/imports.md#penguin-random-house) and
[Open Library](docs/imports.md#open-library) importers.

## Commands

```sh
npm run dev         # app on workerd, against the deployment in .env.local
npm run typecheck   # tsc for src/, then for convex/
npm test            # vitest
npm run build       # production client and Worker bundles in dist/
npm run preview     # serve the production build locally in workerd
npm run deploy      # deploy production from this machine (see Deployment)
```

## Repo layout

| Path | What |
|---|---|
| `src/routes/` | One file per page (TanStack file routes); `mod.*` are the Data Team tools |
| `src/lib/` | Shared client code: catalog data loaders, covers, collection and reading controls, SEO |
| `src/server.ts`, `src/server/` | Worker entry: canonical-host redirects, `/covers/*`, sitemaps, the analytics proxy, SSR auth |
| `src/styles/` | CSS split by concern: tokens, shell, covers, then one file per page group |
| `convex/schema.ts` | The database schema |
| `convex/*.ts` | Backend functions per area: catalog pages, browse, tracking, moderation, imports |
| `convex/lib/` | Shared backend logic: matching, authority rules, title parsing, merges |
| `convex/{sevenSeas,kodansha,prh,ann,openLibrary,yenPress}.ts` | One import adapter per source |
| `scripts/` | Deploy target check, Open Library dump filter, catalog repair runner |
| `wrangler.jsonc` | Worker config for production and staging |

## How data gets in

Seven source feeds (Seven Seas, Kodansha and its back catalog, Penguin
Random House, Yen Press, Anime News Network and Open Library) run daily,
weekly or monthly from an hourly scheduler. Each fetched record is stored as a Source Observation. A
shared pipeline matches it to an existing book by source link, ISBN or
title, and applies changes by per-field authority, so a publisher's own
catalog and its distributor outrank reference sites. Ambiguous
matches, conflicts at equal authority and new series go to a review queue.
Every change, imported or human, leaves a public revision.
[docs/imports.md](docs/imports.md) has the rules and per-source setup.

## Environments

| | Convex | Frontend |
|---|---|---|
| Production | `intent-curlew-625` (project `mangadb`) | Worker `mangadb` at mangadb.org |
| Staging | `brave-kingfisher-844` (project `mangadb-staging`) | Worker `mangadb-staging` at mangadb-staging.mangadb.workers.dev |
| Local | `npx convex dev` (SQLite under `.convex/local/default`) | `npm run dev` |

Staging and local hold a production snapshot, refreshed by hand
([docs/operations.md](docs/operations.md#refresh-local-or-staging-from-production)).
Staging has every import source disabled.

## Deployment

Changes land on `main` by pull request. CI typechecks, tests and builds
every pull request. A merge that touches more than docs queues a
production deploy in GitHub Actions, which waits for the owner's approval.
Any branch can go to staging:

```sh
gh workflow run deploy.yml --ref <branch> -f environment=staging
```

Each deploy pushes Convex and then the Worker, with a check that the build
targets the right environment. The runbook, including the one-time GitHub,
Cloudflare and Convex setup, is [docs/deployment.md](docs/deployment.md).

## Docs

- [docs/product.md](docs/product.md): every page and feature, URL rules, SEO, covers
- [docs/moderation.md](docs/moderation.md): roles, proposals, the review queue, merges
- [docs/imports.md](docs/imports.md): the import pipeline and each source
- [docs/operations.md](docs/operations.md): seeding, snapshots, post-deploy commands, the repair tool
- [docs/configuration.md](docs/configuration.md): Clerk, environment variables, analytics
- [docs/deployment.md](docs/deployment.md): environments, CI/CD and setup
- [docs/known-issues.md](docs/known-issues.md): open problems
- [docs/decisions.md](docs/decisions.md): choices and the alternatives ruled out
- [docs/spec-v1.md](docs/spec-v1.md): the frozen v1 decision record, cited in code as "spec §N"
- [CONTEXT.md](CONTEXT.md): the domain glossary

Before deleting a worktree, importing over a deployment, or touching
production, read [AGENTS.md](AGENTS.md). Local Convex databases are not in
git, and the rules there exist because one was lost.
