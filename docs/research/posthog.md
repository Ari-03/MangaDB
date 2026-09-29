# PostHog for MangaDB: product analytics + Claude Code connector

Researched 2026-09-28 against posthog.com docs, npm, and GitHub. Versions
quoted are the npm `latest` tags on that date.

## 0. How the app boots today (what the integration has to fit)

- `src/routes/__root.tsx`: `shellComponent: RootDocument` renders `<html>`,
  `component: RootComponent` wraps the page in `<AppProviders>` from
  `src/providers.tsx`. There is deliberately no root `beforeLoad`.
- `src/providers.tsx`: reads `import.meta.env.VITE_CONVEX_URL` and
  `VITE_CLERK_PUBLISHABLE_KEY` at module scope; mounts `ClerkProvider` and
  `ConvexProviderWithClerk` only when those exist. Any PostHog provider slots
  in here, inside `ClerkProvider` so it can read `useAuth()`/`useUser()`.
- `src/router.tsx`: `createRouter({ routeTree, scrollRestoration: true,
  defaultPreload: "intent" })`. Navigation goes through the History API.
- `src/server.ts`: custom Worker entry (`wrangler.jsonc` `main`). It already
  short-circuits requests before the Start handler (canonical redirect,
  `/covers/*`, robots/sitemaps), so a PostHog ingest route can be added the
  same way.
- `src/start.ts`: `clerkMiddleware()` registered only when `CLERK_SECRET_KEY`
  exists.
- `VITE_*` vars reach the client through Vite's `import.meta.env`, and they are
  declared in `wrangler.jsonc` `vars` (prod) and `env.staging.vars`
  (staging); the Cloudflare Vite plugin exposes them at build time. So a new
  `VITE_PUBLIC_POSTHOG_KEY` goes in both blocks (and `.env.local` for dev),
  giving staging its own PostHog project if wanted.

## 1. Installing posthog-js in a TanStack Start SSR app

Primary source: https://posthog.com/docs/libraries/tanstack-start and
https://posthog.com/docs/libraries/react.

- Packages: `posthog-js` (core, 1.434.17) and `@posthog/react` (1.11.2, peer
  `posthog-js >= 1.257.2`). The React bindings moved out of `posthog-js/react`
  into `@posthog/react`; the docs' install line is
  `npm install posthog-js @posthog/react` (the TanStack page also lists
  `posthog-node` for the optional server side).
- Client-only init: `<PostHogProvider apiKey={...} options={...}>` calls
  `posthog.init` inside a `useEffect`, with a ref that skips the StrictMode
  double-run, so nothing runs during SSR or on the Worker
  (source: https://github.com/PostHog/posthog-js/blob/main/packages/react/src/context/PostHogProvider.tsx).
  No `typeof window` guard is needed as long as the provider is the only
  place that inits. Do not import a module-scope `posthog.init(...)` in a
  file that the SSR bundle also loads.
- Pageviews: with `defaults: '2025-05-24'` or newer, `capture_pageview`
  becomes `'history_change'`, which hooks `pushState`/`replaceState` and
  `popstate`. TanStack Router navigates via the History API, so SPA
  pageviews work without a `router.subscribe` hook; the TanStack Start doc
  confirms "PostHog automatically captures pageviews, sessions, and web
  vitals" once the provider is mounted. `capture_pageleave` defaults to on
  whenever pageviews are on (https://posthog.com/docs/libraries/js/config).
  A manual `router.subscribe('onResolved', ...)` is only needed if you want
  pageviews stamped with route ids instead of raw URLs.
- `defaults`: the newest value is `'2026-08-30'`. Ladder from the config doc:
  `2025-05-24` history_change pageviews; `2025-11-30` replay
  strictMinimumDuration + rageclick ignorelist; `2026-01-30` scripts inject
  into `<head>`; `2026-05-30` persistence debounce, `split_storage`,
  Google-search-app detection; `2026-06-25` replay network bodies;
  `2026-08-29` `cookieWinsOnConflict`; `2026-08-30` replay `captureJsonLd`.
  The docs' current snippet uses `defaults: '2026-05-30'`. Use that (or
  `'2026-08-30'`); the replay-only ones are harmless with replay off.
- Custom events: `const posthog = usePostHog(); posthog.capture('name', {...})`.
  Outside components import `posthog` from `posthog-js` (after init).

## 2. Identifying users with Clerk, and privacy

https://posthog.com/docs/product-analytics/identify

- Call `posthog.identify(clerkUserId, { $set: {...} })` as soon as the Clerk
  session resolves (`useUser()` from `@clerk/tanstack-react-start` inside
  `ClerkProvider`), on every load; PostHog ignores repeat identifies with the
  same data. Use the Clerk `user.id` (`user_...`) as `distinct_id`: it is
  stable, opaque, and the same id Convex sees as `identity.subject`, so a
  future server-side capture can match it. Do not use email as the id.
- Call `posthog.reset()` when `isSignedIn` flips from true to false (sign
  out), so a shared device does not merge two people.
- Properties: keep them durable and minimal. `username` and `role` (the
  Convex `users.viewer` fields) are useful for breakdowns. Email and display
  name are PII; PostHog allows them but they are not needed for the questions
  the owner asked, so leave them out. Person properties are not stored on the
  event, so anything you want to break down events by must also go on the
  event.
- `person_profiles: 'identified_only'` is the default: anonymous visitors do
  not create person profiles, which also keeps them on the cheaper anonymous
  event rate.
- EU vs US: two clouds, `us.i.posthog.com` / `eu.i.posthog.com` (Frankfurt),
  chosen at signup. MangaDB's audience is English-language readers and the
  owner is not EU-based; US cloud is fine. Pick once; projects do not move.
- Cookieless: `cookieless_mode: 'always'` stores nothing in cookies or
  storage, counts users by a daily salted server-side hash, and "doesn't
  require a cookie banner (unless something else on your website uses
  cookies)". It restricts `identify()` (with `person_profiles: 'never'`
  identify becomes a no-op), which defeats the Clerk join, so it is not the
  right mode for signed-in tracking. `cookieless_mode: 'on_reject'` captures
  nothing until consent is answered, then falls back to the hash for
  refusers. `persistence: 'memory'` is the older equivalent (nothing stored,
  every reload is a new anonymous id) but identify still works.
  https://posthog.com/docs/privacy/data-collection
- Consent: PostHog's GDPR guide says that if you use PostHog with cookies for
  logged-out users you should show a cookie banner. Clerk already sets
  cookies, so MangaDB either has or needs that conversation anyway. Options
  from cheapest to strictest: (a) `persistence: 'localStorage'` (not a
  cookie; still "storage" under ePrivacy for EU visitors), (b)
  `opt_out_capturing_by_default: true` plus `posthog.opt_in_capturing()`
  from a small consent bar, (c) `cookieless_mode: 'on_reject'`.
  https://posthog.com/docs/privacy/gdpr-compliance
- Do Not Track: `respect_dnt: true` treats DNT browsers as opted out.
- Session replay: off unless `session_recording` is enabled in the project
  and `disable_session_recording` is false. `maskAllInputs` is on by default,
  `maskTextSelector: '*'` masks all text, and `class="ph-no-capture"` blocks
  an element. Replay is not needed for the stated goals; leave it off in v1
  or gate it behind `posthog.startSessionRecording()` for opted-in accounts.
  https://posthog.com/docs/session-replay/privacy

## 3. Reverse proxy through the Cloudflare Worker

https://posthog.com/docs/advanced/proxy/cloudflare and
https://posthog.com/docs/advanced/proxy

- The guide is a standalone Worker bound to a subdomain (`e.yourdomain.com`),
  but the code is three functions: route `/static/*` and `/array/*` to
  `us-assets.i.posthog.com` (cached in `caches.default`), everything else to
  `us.i.posthog.com`, with `cookie` and `authorization` headers dropped and
  `X-Forwarded-For` set from `CF-Connecting-IP`. There is nothing in it that
  needs its own Worker.
- Path-based proxying on the app's own origin is supported: the Next.js guide
  rewrites `/yourpath/static/*`, `/yourpath/array/*`, `/yourpath/*` and
  inits with `api_host: '/yourpath'`
  (https://posthog.com/docs/advanced/proxy/nextjs). So MangaDB can add a
  `src/server/posthogProxy.ts` handler in `src/server.ts`, ahead of the
  cover route, that strips a prefix and forwards, exactly like `coverResponse`.
  No new wrangler route, no DNS, and staging gets it for free on workers.dev.
- Name the prefix something non-obvious (docs: not `/analytics`,
  `/tracking`, `/telemetry`, `/posthog`). Suggestion: `/shelf-stats` or
  `/ph-ingest` is still guessable; something like `/_s` is better.
- `ui_host` must be `https://us.posthog.com` (or `eu.posthog.com`) whenever
  `api_host` is a proxy, otherwise toolbar and dashboard links point at the
  proxy. `api_host` is the proxy origin + prefix, e.g.
  `https://mangadb.org/_s` or just `/_s` (relative works because init runs
  in the browser).
- Alternative: PostHog's managed reverse proxy is free for all Cloud users
  but needs a CNAME on a subdomain of mangadb.org. The in-Worker path is
  simpler here and has no per-request cost beyond Worker invocations.
- Cost: proxied requests count as Worker requests; at hobby volume this is
  within the free 100k/day.

## 4. Server-side capture and feature flags

https://posthog.com/docs/libraries/node

- `posthog-node` 5.54.1 ships an `./edge` entry (workerd, edge-light listed),
  so it runs in the Worker and in Convex Node actions. In short-lived
  runtimes it needs `flushAt: 1, flushInterval: 0` and `await shutdown()`
  (or `ctx.waitUntil`). Every server event needs a `distinctId` equal to the
  browser's identified id (Clerk user id) or it lands on an orphan person.
- Verdict for v1: skip. Every feature the owner wants to measure has a
  client-side call site, the extra hop adds a network round trip to Convex
  mutations, and the Worker has no user identity except via Clerk middleware.
  Revisit if you need events ad blockers cannot drop even with the proxy, or
  events from crons/importers.
- Feature flags: `posthog-js` bootstraps flags on init; 1M requests/month
  are free. Nothing in the current backlog needs them. Skip.

## 5. The PostHog MCP server and the "context connector"

https://posthog.com/docs/model-context-protocol,
https://posthog.com/docs/model-context-protocol/claude-code,
https://posthog.com/docs/model-context-protocol/faq,
source https://github.com/PostHog/posthog/tree/master/services/mcp

- What it is: a hosted remote MCP server at `https://mcp.posthog.com/mcp`
  (Streamable HTTP) that proxies your PostHog project. It stores no analytics
  data; session state is cached 24h keyed by API key hash. Region (US/EU) is
  picked automatically from the account.
- Tools: 50+ across insights/trends/dashboards, HogQL (`execute-sql`),
  error tracking issues, feature flags, experiments, cohorts/persons/actions,
  surveys, session replay, CDP destinations, a beta semantic layer. Default
  "CLI mode" exposes a single `posthog` tool that wraps all of them; add
  `?mode=tools` for one tool per function. Filter with
  `?features=insights,dashboards`, `?tools=execute-sql,...`, or
  `?readonly=true` (drops create/update/delete tools, sensible for an
  analytics-query agent).
- Install for Claude Code (docs' command, OAuth login on first use):
  `claude mcp add --transport http posthog https://mcp.posthog.com/mcp -s user`
  Or with a personal API key instead of OAuth, create one from the "MCP
  Server" preset at https://us.posthog.com/settings/user-api-keys?preset=mcp_server
  and pass `Authorization: Bearer phx_...`.
- Cost: connecting and calling tools is free. Tools that call an LLM
  internally bill as "PostHog AI" spend and only work when "AI data
  processing" is enabled in org settings; plain query tools do not.
- What "PostHog context connector" most likely means: PostHog ships three
  layers for agents. (1) The MCP server above. (2) The Claude Code plugin
  `claude plugin install posthog` (repo https://github.com/PostHog/ai-plugin;
  marketplace form `claude plugin marketplace add PostHog/ai-plugin` then
  `claude plugin install posthog@posthog`) which bundles the MCP server plus
  30+ skills and authenticates through `/mcp` OAuth. (3) The CLI
  (`npx @posthog/wizard cli add`, https://posthog.com/docs/cli) which writes
  agent instructions into CLAUDE.md/AGENTS.md, installs skills into
  `.agents/skills/`, and exposes `posthog-cli api ...` including SQL, which
  the docs say is more token-efficient than MCP for large result sets.
  PostHog's "context-mill" repo (https://github.com/PostHog/context-mill) is
  the internal assembler for those skills, not a user-facing product. "Max
  AI" is the in-app assistant and is unrelated. For an agent that queries
  analytics in-session, the plain MCP entry is enough; the plugin is the
  one-liner if you also want the skills.

## 6. Pricing

https://posthog.com/pricing (free tier) and
https://posthog.com/docs/product-analytics/pricing (unit prices).

- Free every month, no card: 1M product analytics events, 5K session replay
  recordings, 1M feature flag requests, 100K error-tracking exceptions,
  1,500 survey responses, 1M data-warehouse rows.
- Beyond that: events from $0.00005 each for the 1-2M tier, stepping down to
  $0.000009 at 250M+; identified events add a person-profile charge from
  $0.000198 each after the first 1M; replay from $0.005/recording after 5K.
- Billing limits are per product and are a hard stop ("your additional data
  is lost forever"); email alerts at 80% and 100% of the free allotment.
  https://posthog.com/docs/billing/limits-alerts
- A hobby site with a few thousand visitors a month generates well under
  100K events; MangaDB will pay $0 in v1.

## Recommended implementation for MangaDB

Packages: `posthog-js@^1.434.17`, `@posthog/react@^1.11.2`. No `posthog-node`.

Env vars (both are public, they ship in the bundle):
- `VITE_PUBLIC_POSTHOG_KEY` = the project token (`phc_...`). Prod value in
  `wrangler.jsonc` `vars`; staging value (a separate PostHog project, or the
  same token with an `env` super-property) in `env.staging.vars`; local in
  `.env.local`. Absent key = PostHog not mounted, matching the Clerk/Convex
  pattern.
- `VITE_PUBLIC_POSTHOG_HOST` = `/_s` in prod and staging (the in-Worker
  proxy path); `https://us.i.posthog.com` in local dev where `src/server.ts`
  also runs under the Cloudflare plugin so `/_s` works there too. Keep
  `ui_host: 'https://us.posthog.com'` as a constant in code.

Files to touch:
1. `src/providers.tsx`: add `posthogEnabled = Boolean(VITE_PUBLIC_POSTHOG_KEY)`;
   inside `ClerkProvider` (and in the no-Clerk branch) wrap `inner` in
   `<PostHogProvider apiKey={key} options={{ api_host, ui_host, defaults:
   '2026-05-30', person_profiles: 'identified_only', respect_dnt: true,
   autocapture: false, capture_exceptions: true }}>`. Autocapture off keeps
   volume low and makes the named events below the source of truth.
2. New `src/lib/analytics.tsx`: a `PostHogIdentity` component that reads
   `useUser()` from Clerk and calls `identify(user.id, { $set: { username,
   role } })` or `reset()` on transition; plus a typed `track()` helper over
   `posthog.capture` whose event names are a union type so call sites stay
   consistent. Mount it inside `PostHogProvider`.
3. New `src/server/posthogProxy.ts` + two lines in `src/server.ts`: if
   `url.pathname.startsWith('/_s/')`, strip the prefix, route `/static` and
   `/array` to `us-assets.i.posthog.com` with `caches.default`, everything
   else to `us.i.posthog.com` with cookie/authorization removed and
   `X-Forwarded-For` from `CF-Connecting-IP`. Place it before `coverResponse`.
4. `wrangler.jsonc`: the two vars in both `vars` blocks.
5. `README.md` Environments: document the vars and the proxy path.
6. Consent: add `respect_dnt` now; add an opt-out toggle on `/me` settings
   (`posthog.opt_out_capturing()`) in the same PR and note in the privacy
   copy that analytics uses localStorage. A banner can wait until there is
   EU traffic worth the friction.

Proxy decision: yes, in the existing Worker, path-based (`/_s`). No new
route, no DNS, works on staging's workers.dev host.

v1 custom events (snake_case, one property set each, all client-side):
- `series_followed` / `series_unfollowed` { seriesId, source: 'series_page' | 'search' }
- `collection_entry_added` { seriesId, releaseId, status: 'own' | 'want' | 'read' }
- `reading_status_changed` { seriesId, from, to }
- `search_performed` { query_length, result_count, via: 'header' | 'page' }
- `rating_submitted` { seriesId, rating }
- `review_submitted` { seriesId, length_bucket }
- `comment_posted` { target_type, targetId }
- `mature_titles_toggled` { enabled }
Pageviews, pageleave, and web vitals come free from `defaults`. Do not put
review or comment text in properties.

MCP for Claude Code (project-scoped, read-only, no AI tools):

```sh
claude mcp add --transport http posthog "https://mcp.posthog.com/mcp?readonly=true" -s project
```

which writes `.mcp.json`:

```json
{
  "mcpServers": {
    "posthog": {
      "type": "http",
      "url": "https://mcp.posthog.com/mcp?readonly=true"
    }
  }
}
```

On first use run `/mcp` and complete the PostHog OAuth login. To use a
personal API key instead (CI or headless), create one from the MCP Server
preset and add `"headers": { "Authorization": "Bearer phx_..." }`; do not
commit that variant. If the owner also wants the skills bundle:
`claude plugin install posthog`.
