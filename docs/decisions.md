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

## Staging

One shared staging environment instead of a deployment per branch. The
reasons are in [deployment.md](deployment.md#why-it-is-built-this-way).
