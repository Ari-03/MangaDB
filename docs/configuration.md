# Configuration

Every environment variable, the Clerk setup, and analytics. Without any of
them the app still runs locally, signed out, with the public catalog
working.

## Clerk

Clerk owns sign-in and sessions (Google OAuth and verified email and
password). The Convex `users` row is created on first sign-in: `/me` sends
a new user to `/claim-username`, and claiming a username inserts the row,
keyed by the Clerk subject and never by email. Usernames are unique
ignoring case, checked against the reserved list in
`convex/lib/usernames.ts`, and can be changed, which frees the old one at
once. Account deletion (`/me`, Settings, Account) is one Convex mutation
that marks the user as deleting and schedules the rest: a batched purge of
every MangaDB record of that user, then the deletion of the Clerk identity
through Clerk's Backend API, retried if Clerk fails, then the user row a
day later ([operations](operations.md#account-deletion)). A signed-in
visitor with no username has no account to delete.

On each server request `clerkMiddleware()` (`src/start.ts`) authenticates.
The gated routes read a Convex token minted from the Clerk JWT template
named `convex` (`src/server/`) and pass it to the Convex HTTP client. The
browser uses `ConvexProviderWithClerk` (`src/providers.tsx`). Convex
checks both through OIDC (`convex/auth.config.ts`) and personal functions
call `ctx.auth.getUserIdentity()` (`requireUser` in `convex/lib/auth.ts`).

One-time setup:

1. Create a Clerk application at [dashboard.clerk.com](https://dashboard.clerk.com).
   Enable Google OAuth and email/password with email verification.
2. Create a JWT template named `convex` (Clerk has a Convex preset) and
   note its issuer domain (`https://<slug>.clerk.accounts.dev` in dev).
   Keep its token lifetime under a day: account deletion keeps the deleted
   user's row a day after Clerk confirms, so a token issued before cannot
   claim a username.
3. Turn off the instance setting "Allow users to delete their accounts".
   Account deletion goes through `/me`; with the setting on, the "Manage
   account" window of `<UserButton />` offers a "Delete account" button
   that deletes only the Clerk sign-in and leaves the user's MangaDB rows
   ([known issues](known-issues.md)).
4. Set the variables below, and allow `mangadb.org` and the staging
   workers.dev origin in the Clerk dashboard.

## App and Worker

| Variable | Where | Purpose |
|---|---|---|
| `VITE_CONVEX_URL` | `.env.local` (written by `npx convex dev`); `vars` in `wrangler.jsonc` for deploys | The Convex deployment URL. Public. |
| `VITE_CLERK_PUBLISHABLE_KEY` | `.env.local`; the build environment and `vars` in `wrangler.jsonc` for deploys | Clerk publishable key (`pk_…`), inlined into the client bundle. Unset turns the auth UI off. |
| `CLERK_SECRET_KEY` | `.dev.vars` locally (workerd reads Worker secrets there, not from `.env.local`); `npx wrangler secret put CLERK_SECRET_KEY` for deploys | Enables `clerkMiddleware()` and SSR auth. Unset treats everyone as signed out. |
| `VITE_PUBLIC_POSTHOG_KEY` | the build environment only, never committed | PostHog project token (`phc_…`). Unset means no analytics script and no requests. |
| `VITE_PUBLIC_POSTHOG_HOST` | build environment, optional | Overrides the SDK's `api_host`. Default `/_s`, the same-origin proxy. |
| `VITE_SITE_URL` | build environment, optional | Origin for canonical links, Open Graph URLs and sitemap locations. Default `https://mangadb.org`. `npm run build:staging` sets the staging origin. |
| `CANONICAL_HOST` | `vars` in `wrangler.jsonc` | Drives the `www` to apex and HTTPS 301s in `src/server.ts`. Empty on staging. `*.workers.dev` hosts are never redirected. |

`VITE_*` values are inlined by `npm run build`, so they must be in the
build environment, not only in `wrangler.jsonc`.

## Convex deployment

Set with `npx convex env set NAME value` or in the Convex dashboard under
Settings, Environment Variables.

| Variable | Purpose |
|---|---|
| `CLERK_JWT_ISSUER_DOMAIN` | Issuer domain of the `convex` JWT template. Unset falls back to a placeholder so codegen and tests run, and sign-in tokens then fail to validate. |
| `CLERK_SECRET_KEY` | The same Clerk secret key, used by account deletion to delete the Clerk identity. Unset refuses account deletion. |
| `PRH_API_KEY`, `PRH_IMPRINT_CODES` | The PRH adapter. Without the key or a non-empty imprint list, a fresh run skips as "unconfigured" and opens none. Removing the key mid-run closes the run as `failed`; removing the codes does not affect it. Setup: [imports](imports.md#penguin-random-house). |
| `OPENLIBRARY_DUMP_URL` | The filtered Open Library dump. Unset makes those runs skip. Setup: [imports](imports.md#open-library). |
| `RESEND_API_KEY`, `IMPORT_ALERT_EMAIL_TO`, optional `IMPORT_ALERT_EMAIL_FROM` | Source-health alert emails. Unset logs and skips. |
| `POSTHOG_PROJECT_TOKEN` | Backend analytics. Required on every deployment: a push fails until it is set, even to an empty string, which turns server events off. |
| `POSTHOG_HOST` | Optional. Default `https://us.i.posthog.com`. |

Alert email setup:

```sh
npx convex env set RESEND_API_KEY <re_…>                       # resend.com API key
npx convex env set IMPORT_ALERT_EMAIL_TO admin@example.com     # the Administrator
# Optional; defaults to "MangaDB imports <alerts@mangadb.org>". The sender
# domain must be verified in Resend either way:
npx convex env set IMPORT_ALERT_EMAIL_FROM "MangaDB imports <alerts@mangadb.org>"
```

Staging has only the two Clerk variables and `POSTHOG_PROJECT_TOKEN`, with
no importer keys and no Resend.

## Analytics (PostHog)

Product analytics run on PostHog Cloud, US region. The reasons for each
choice are in [decisions.md](decisions.md#analytics).

**Browser.** `src/lib/analytics.tsx` loads posthog-js after hydration and
never in the Worker bundle. Autocapture, session replay and feature flags
are off, `respect_dnt` is on, and person profiles exist only for signed-in
users. Pageviews and pageleaves are automatic. posthog-js adds the full
page address (`$current_url`) to every event and the document title to
pageviews, so a search's text reaches PostHog through `/search?q=…` and
the search page's title. Signed-in users are identified by their Clerk
user id with `username` and `role`, never email. Before events go out
under a signed-out visit or another account, the client calls `reset()`,
so two accounts are never merged into one person and no event carries the
other account's id. `reset()` keeps posthog-js's `$device_id`, so events
from two accounts on one browser share it. The Deploy workflow reads
`VITE_PUBLIC_POSTHOG_KEY` from the GitHub environment it deploys to, so
staging and production can use separate projects. A local deploy reads it
from `.env.local` or the shell.

**Opt-out.** Settings, Analytics on `/me` stores `users.analyticsOptOut`
(`users.setAnalyticsOptOut`, absent until chosen). For a signed-in user
who opted out, the browser never loads posthog-js, and `capture` in
`convex/lib/posthog.ts` sends none of their events, moderation included.
A client already running when the user switches Off, or while a signed-in
user's choice is still loading, calls posthog-js's `opt_out_capturing()`:
`capture()` then returns before posthog-js records anything (its session
and entry URL, the previous page), and its logs and metrics, which check
`is_capturing()`, stop too. posthog-js stores the denial in localStorage,
keeping the distinct id it holds. The client's `before_send` drops events
in the same states, as a backstop. Convex having no viewer yet for a new
session counts as still loading. Remote config is off only because
`advanced_disable_flags` is set. A browser sending Do Not Track or Global
Privacy Control sets the opt-out once on an account that has never chosen,
so server events stop too; a browser without it never clears one.
Signed-out visitors have no toggle: `respect_dnt` covers them.

Sending resumes (switching On, signing out, a sign-in's choice answering)
in a fixed order. First `reset()`, when posthog-js holds an identified id
other than the one now signed in: on sign-out, or when a different user
signs in. It clears the stored denial too. Then, if a denial is still
stored, `opt_in_capturing({ captureEventName: false })`, which sends no
`$opt_in` event. Then `identify()`. The client does the same when it
loads, so a denial stored on an earlier page load, by an account since
signed out or before a reload, does not outlive the choice. Opting in
sends the page's initial `$pageview` only if this page load has not sent
it (the client loaded while Off or loading), under the id posthog-js
holds at that moment: the account's, or an anonymous id that `identify()`
then links to it. A sign-in from a signed-out visit does not reset, so
that browsing stays with the account. `reset()` does not clear posthog-js's
record of the last page it captured, so the first pageview after a reset
on the same page carries the previous identity's last page path as
`$prev_pageview_pathname`: an account's last page on the first signed-out
pageview after its sign-out, or one account's on the next account's first
pageview. posthog-js sends captured events in batches, keeps a batch that
fails to send and retries it with backoff, and nothing public clears one,
so events captured before a switch to Off or a sign-out may still be
delivered later, including after a lost connection is restored. Opting out
stops new events; it deletes nothing PostHog already holds.

`src/lib/analyticsClient.test.ts` pins this behaviour against the real
posthog-js: it runs the client in happy-dom with the network stubbed and
checks the events posthog-js would send, so an SDK upgrade that changes
the opt-out, the opt-in or `reset()` fails the suite.

**Proxy.** `src/server/posthogProxy.ts` forwards `/_s/*` from the site's
own origin so ad blockers do not drop events. `/_s/static/*` and
`/_s/array/*` go to `us-assets.i.posthog.com` and are edge cached;
everything else goes to `us.i.posthog.com`. Cookies and auth headers are
stripped and `X-Forwarded-For` comes from `CF-Connecting-IP`. Moving to the
EU cloud means changing `POSTHOG_REGION` in that file and setting
`POSTHOG_HOST=https://eu.i.posthog.com` on each Convex deployment.

**Browser events.** Capture only through the typed `track(event, props)`.
Props are ids, enums and lengths, never free text or personal data;
posthog-js adds the page address and its own properties to each.

| Event | Props |
|---|---|
| `series_followed`, `series_unfollowed` | `seriesId`, `source` |
| `collection_entry_set` | `target` (`release` or `bundle`), `state` (`null` when removed) |
| `reading_status_changed` | `seriesId`, `status` (`null` when cleared), `source` |
| `search_performed` | `queryLength`, `resultCount` |
| `mature_titles_toggled` | `showMature` |
| `comment_posted` | `target`, `seriesId`, `isReply`, `held` |
| `favorite_toggled` | `target` (`series`, `volume` or `edition`), `publicId`, `favorite` |
| `rating_submitted`, `review_submitted` | declared, never sent |

**Backend.** Convex sends events through PostHog's Convex component,
[`@posthog/convex`](https://posthog.com/docs/libraries/convex), registered
in `convex/convex.config.ts` and wrapped by `convex/lib/posthog.ts`
(`capture`, `captureModeration`, `withExceptionCapture`). A capture from a
mutation commits or rolls back with it. User events use the Clerk id as
distinct id, the same id the browser identifies with, and are not sent for
a user who opted out. System events use `server`, create no person and are
always sent. Server events carry `$lib: posthog-convex`; filter on it where
a name also exists in the browser (`favorite_toggled`).

```sh
npx convex env set POSTHOG_PROJECT_TOKEN ""                                       # local dev (off)
npx convex env set --deployment brave-kingfisher-844 POSTHOG_PROJECT_TOKEN phc_…  # staging
npx convex env set --prod POSTHOG_PROJECT_TOKEN phc_…                             # production, when agreed
```

| Event | Distinct id | Props |
|---|---|---|
| `import_run_finished` | `server` | `source_key`, `status` (`succeeded`, `failed`, `stopped`), `records_seen`, `records_changed`, `error_count`, `duration_ms` |
| `source_unhealthy`, `source_recovered` | `server` | `source_key`, `consecutive_failures` |
| `moderation_action` | the Moderator | `action`, `target_kind` (`comment`, `comment_author`, `review`, `proposal`), `actor_role` |
| `rating_set` | the user | `kind`, `score` (`null` when cleared), `cleared` |
| `review_saved` | the user | `kind`, `spoiler`, `length_bucket`, `edited` |
| `favorite_toggled` | the user | `kind`, `favorite` |

The hourly import tick, every adapter's sync and the rebuild crons run
inside `withExceptionCapture`. An error that escapes is sent as PostHog's
`$exception` with a `function_name` such as `ann.sync`, then rethrown so
Convex logs it too. It shows up in PostHog Error tracking.

**Querying from Claude Code.** `.mcp.json` registers PostHog's hosted MCP
server read-only (`https://mcp.posthog.com/mcp?readonly=true`). Run `/mcp`
once and complete the OAuth login. For PostHog's skills too, run
`claude plugin marketplace add PostHog/ai-plugin` then
`claude plugin install posthog@posthog`. Never commit a personal API key
(`phx_…`) into `.mcp.json`.
