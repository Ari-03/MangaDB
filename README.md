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
| `src/routes/` | File-based routes (`__root.tsx` is the document shell) |
| `src/router.tsx` | Router factory (`getRouter`) |
| `src/server.ts` | Custom Workers entry: canonical-host redirect, then the Start handler |
| `src/server/` | Server-only code (canonical-host policy, SSR Convex client) |
| `convex/` | Convex schema + functions (`schema.ts` is the v1 schema from wayfinder #11) |
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

The Convex deployment needs one environment variable
(Convex dashboard → Settings → Environment Variables, or `npx convex env set`):

- `CLERK_JWT_ISSUER_DOMAIN` — issuer domain of the Clerk JWT template named
  `convex` (see `convex/auth.config.ts`). Until Clerk is provisioned, any
  placeholder value (e.g. `https://placeholder.clerk.accounts.dev`) unblocks
  deploys; nothing calls it until authed features land.

Other commands:

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest (canonical-host policy, convex-test against the schema)
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
3. **Domain** — in the Cloudflare dashboard attach `mangadb.org` and
   `www.mangadb.org` as custom domains for the Worker (or uncomment `routes`
   in `wrangler.jsonc`). `src/server.ts` then enforces the canonical-host
   policy from the spec (§11): apex canonical, `www` 301s to it, HTTPS-only.
   The `CANONICAL_HOST` var in `wrangler.jsonc` controls this; `*.workers.dev`
   preview hosts are never redirected.

## Verifying a deploy

Visit the deployed URL: the home page is server-rendered on Workers and shows
live catalog counts fetched from Convex during SSR — a full
SSR → Convex round-trip on every request.
