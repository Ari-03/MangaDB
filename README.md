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
| `src/routes/` | File-based routes (`__root.tsx` is the document shell; `me.tsx` is the gated shell; `sign-in.$`/`sign-up.$` host Clerk's UI; `claim-username.tsx` is the forced first-sign-in step) |
| `src/router.tsx` | Router factory (`getRouter`) |
| `src/start.ts` | Global Start config: Clerk request middleware (only when credentials exist) |
| `src/providers.tsx` | Client wiring: `<ClerkProvider>` + `ConvexProviderWithClerk`, site header |
| `src/server.ts` | Custom Workers entry: canonical-host redirect, then the Start handler |
| `src/server/` | Server-only code (canonical-host policy, SSR Convex client, SSR Clerk auth/token) |
| `convex/` | Convex schema + functions (`schema.ts` is the v1 schema from wayfinder #11; `users.ts` + `lib/` are accounts from #26) |
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
npm test            # vitest (canonical-host policy, accounts/username policy via convex-test)
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
