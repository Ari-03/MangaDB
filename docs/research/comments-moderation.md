# Comments on Series and Volume pages: options and moderation

Research date: 2026-09-28. Scope: how to add a comments section to Series and Volume pages without creating a moderation burden the current data team cannot carry. Sources are official docs and READMEs fetched on the research date; where a vendor page was unreachable the fallback is noted.

## What MangaDB already has

- **Roles**: `users.role` is `editor | moderator | administrator`, checked live via `requireRole` / `requireModerator` (`convex/lib/roles.ts`). Suspension removes privileges immediately.
- **Reports**: `convex/reports.ts` lets any signed-in user file a free-text report on a Series. It becomes a zero-op In-Review Proposal in the shared `/mod/queue`, rate limited with `@convex-dev/rate-limiter` (`reportSubmit`: token bucket, 10/hour, burst 3, keyed by `user._id`).
- **Rate limiter**: already installed and registered in `convex/convex.config.ts`; `convex/proposals.ts` defines `RATE_LIMITS` for draft saves and submissions.
- **Mature Series**: `convex/lib/mature.ts` exposes `showMatureArg` and `visibleTo(showMature, mature)`; discovery queries hide mature records unless the viewer opts in. Series pages themselves are always viewable.
- **Account deletion**: `users.deleteAccount` (action) calls Clerk, then `purgeUser` deletes tracking rows and the User. Revisions, Proposals and roleAudit are append-only and render as a deleted author.

Anything built for comments should slot into these four pieces rather than duplicating them.

## 1. Third-party embeddable comment systems

| System | Hosting / cost | Commenter auth | Moderation tooling | Privacy / ads | Fit for Workers + Convex + Clerk |
|---|---|---|---|---|---|
| [Giscus](https://github.com/giscus/giscus) | Free; data lives in GitHub Discussions on a **public** repo; self-hostable | GitHub OAuth only | GitHub's tools: lock, block user, hide comments ([docs](https://docs.github.com/en/discussions/managing-discussions-for-your-community/moderating-discussions)); no pre-approval, no report button | "No tracking, no ads" | Poor: forces a second identity, no Clerk sharing, no pre-moderation, per-page discussions are searched by title match |
| [Utterances](https://github.com/utterance/utterances) | Free; data in GitHub Issues | GitHub OAuth only | Same as above (Issues) | No tracking, no ads | Poor, for the same reasons; smaller feature set than Giscus |
| [Cusdis](https://github.com/djyde/cusdis) | Open source, self-host (Postgres) or cloud | Anonymous, no sign-in | Manual approval only: "comments won't be displayed until you approve them", no spam filter | No cookies | **Ruled out**: repo is archived and marked deprecated (July 2026); users are told to export data |
| [Commento++](https://github.com/souramoo/commentoplusplus) | Self-host (Go + Postgres), Docker, Heroku/Railway | Guest, OAuth (Google/GitHub/Twitter), SSO | Approve/delete dashboard, thread locking, Akismet and Perspective API hooks | No ads | Medium-poor: needs a Postgres VM; a fork of an abandoned project; Perspective API is being sunset after 2026 ([perspectiveapi.com](https://www.perspectiveapi.com/)) |
| [Remark42](https://github.com/umputun/remark42) | Self-host, single Go binary or Docker, embedded BoltDB file | Many OAuth providers, email, anonymous, custom OAuth2 (`AUTH_CUSTOM_NAME`) | Admins delete, block (temporary/permanent), set read-only; `RESTRICTED_WORDS`, `LOW_SCORE` auto-hide, `UPDATE_LIMIT`, `MAX_COMMENT_SIZE` ([params](https://remark42.com/docs/configuration/parameters/)); no pre-approval queue ([admin docs](https://remark42.com/docs/manuals/admin-interface/)) | Privacy focused, no external DB | Medium: best of the self-hosted set, but needs a stateful server (not Workers), a separate moderation UI, and Clerk would have to be wrapped as a custom OAuth2 provider |
| [Disqus](https://help.disqus.com/en/articles/1717110-comments-pricing-and-plans) | SaaS. Basic: free but "Top ads placement required". Plus $12 to $35/mo (100K to 900K pageviews). Pro $115 to $180/mo. Business: custom | Disqus accounts or social; **SSO only on Business** | Pre-moderation, word filters, Akismet-style spam filter, shadow banning (Pro+) ([shadow ban doc](https://help.disqus.com/en/articles/1717067-shadow-banning)) | Privacy policy covers targeted advertising; heavy embed | Poor: sharing Clerk identity requires the custom-priced tier; ads or $115/mo for the tier with shadow bans |
| [Hyvor Talk](https://talk.hyvor.com/pricing) | SaaS. Personal €5/mo (1 site, 1 moderator, 2,500 credits), Premium €12/mo (unlimited moderators), Business €40/mo, Enterprise (SAML) | Hyvor accounts, or **Stateless SSO** via HMAC signed by your backend, or OIDC ([SSO docs](https://talk.hyvor.com/docs/sso)) | Moderation rules, spam detection, webhooks and Data API on higher tiers | GDPR compliant, no ads | Medium-good: the SSO model fits a Convex HTTP action signing the Clerk identity; moderation stays in Hyvor's dashboard, not `/mod` |
| [Talkyard](https://www.talkyard.io/pricing) | Open source self-host or SaaS: €4/mo per active member (Standard) or €12/mo (Business, €300 minimum) | Password, social, OIDC, Azure AD; SSO on self-host | Forum-grade: flags, review, trust levels, "Unwanted" votes | Daily backups, unmetered views | Medium-poor: it is a whole forum product; overkill for per-page comments, and self-hosting is a Docker stack |

Common thread: none of these put the comment queue inside the existing `/mod` UI or reuse `users.role`. The two that can share Clerk identity (Hyvor Talk via HMAC SSO, Remark42 via custom OAuth2) still keep the moderation surface elsewhere, so the data team learns a second tool. The GitHub-backed ones require a public repo and a GitHub account per commenter, which is the wrong ask for a manga catalog audience.

## 2. Building comments natively in Convex

### Existing components

The [Convex components directory](https://www.convex.dev/components) lists two community comment components; neither is an official `@convex-dev/*` package and neither has moderation states.

| Component | What it does | Gap for MangaDB |
|---|---|---|
| [`@vllnt/convex-comments`](https://github.com/vllnt/convex-comments) | Threaded comments on an opaque `resourceRef`, author-gated edit/remove/resolve, soft delete with cron pruning, reactive pagination. Auth-agnostic (host passes `authorRef`). Backend only. 1 star, 13 commits. | States are only `open / deleted / resolved`; "broader access rules such as who may post or moderate are entirely the host's responsibility". No pending/hidden state, no report counts, no target-type index we can join to Series/Volume, and comments would live in sandboxed tables the `/mod` queries cannot read directly. |
| [`@hamzasaleemorg/convex-comments`](https://www.convex.dev/components/hamzasaleem2/convex-comments) | Threads, mentions, reactions, typing indicators, React components. | Aimed at chat-like UX; no moderation model; unknown maintenance. |

`@convex-dev/agent` "threads" are AI conversation threads, not user comments ([docs](https://docs.convex.dev/agents/threads)). Conclusion: the component ecosystem does not save any of the hard part (the moderation model), and the easy part (a table with a parent id) is a few dozen lines. Build it in the app schema.

### Schema sketch

```ts
comments: defineTable({
  target: v.union(
    v.object({ type: v.literal("series"), id: v.id("series") }),
    v.object({ type: v.literal("volume"), id: v.id("volumes") }),
  ),
  seriesId: v.id("series"),          // denormalized; mature check and merge transfer
  authorId: v.id("users"),
  parentId: v.optional(v.id("comments")), // one level of replies in v1
  body: v.string(),                   // plain text, max 2000 chars like reports
  status: v.union(
    v.literal("pending"),             // awaiting a moderator (new accounts, spam hits)
    v.literal("approved"),            // public
    v.literal("hidden"),              // auto-hidden by reports, still visible to author
    v.literal("removed"),             // moderator action; body kept for audit, not rendered
  ),
  spoiler: v.boolean(),
  reportCount: v.number(),
  editedAt: v.optional(v.number()),
  decidedBy: v.optional(v.id("users")),
  decisionReason: v.optional(v.string()),
})
  .index("by_target_status", ["target.type", "target.id", "status"])
  .index("by_author", ["authorId"])
  .index("by_status", ["status"])           // the moderation queue
  .index("by_series", ["seriesId"]),        // merge transfer, mature toggles

commentReports: defineTable({
  commentId: v.id("comments"),
  reporterId: v.id("users"),
  reason: v.union(v.literal("spam"), v.literal("abuse"), v.literal("spoiler"), v.literal("other")),
  note: v.optional(v.string()),
})
  .index("by_comment", ["commentId"])
  .index("by_comment_reporter", ["commentId", "reporterId"]),  // one report per user per comment
```

Mirror the existing pattern: a `commentAudit` row (or reuse the `decidedBy/decisionReason` fields) for each moderator decision, so the team gets the same append-only trail `roleAudit` gives roles.

### Moderation flow

1. **Submit** (`comments.submit` mutation): `requireUser`, refuse if `user.suspended`, rate limit, validate length, run cheap heuristics (below), then choose `status`:
   - `pending` if the account is under the new-account hold, or the heuristic score is high;
   - `approved` otherwise (post-moderation).
2. **Report** (`comments.report`): one row per (comment, reporter); increment `reportCount`; when `reportCount >= 3` from distinct users flip `approved -> hidden` and enqueue for review. Rate limit reports harder than comments.
3. **Queue**: a `/mod/comments` route listing `pending` and `hidden` comments, sortable by report count, with approve / remove / suspend-author actions gated by `requireModerator`. This is the same shape as `/mod/queue`; it can even reuse the queue's list component.
4. **Shadow-hide**: a `users.commentShadowed: boolean` flag makes every future comment land as `hidden` while still rendering for its author. Disqus recommends this "to avoid instances of troublesome users coming back with new accounts" ([Disqus](https://help.disqus.com/en/articles/1717067-shadow-banning)).

### Rate limiting with `@convex-dev/rate-limiter`

The installed component supports token bucket and fixed window, per-key limits, `check`, `reset` and `reserve` ([README](https://github.com/get-convex/rate-limiter)). Proposed table, keyed by `user._id`:

| Name | Kind | Rate | Purpose |
|---|---|---|---|
| `commentSubmit` | token bucket | 20/hour, capacity 5 | ordinary posting |
| `commentSubmitNew` | fixed window | 3/day | accounts younger than 7 days |
| `commentReport` | token bucket | 10/hour, capacity 3 | same as `reportSubmit` today |
| `commentEdit` | token bucket | 30/hour | edits within the edit window |

Add one global fixed-window limit (`commentSubmitGlobal`, say 600/hour, sharded) so a bot swarm cannot exceed what the team can review in a day.

### Spam defences

| Defence | Cost | Notes |
|---|---|---|
| Heuristics in the mutation | free | Link count > 2 goes to `pending`; any URL from an account under 7 days old goes to `pending`; duplicate body from the same user within 10 minutes is rejected; body under 3 characters rejected. Discourse applies the same "no more than 2 hyperlinks" restriction to new users ([Discourse](https://blog.discourse.org/2018/06/understanding-discourse-trust-levels/)). |
| New-account hold | free | First N (say 3) comments from any account are `pending`; approving one lifts the hold. MyAnimeList users have asked for a one-day account age gate against alt-account floods ([MAL forum](https://myanimelist.net/forum/message/64013049?goto=topic)). |
| [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) | free (20 widgets, 10 hostnames each) ([plans](https://developers.cloudflare.com/turnstile/plans/)) | Invisible or managed widget on the composer; verify the token server side at `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`, tokens are single use and valid 300 s ([siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)). The verify call is an outbound fetch, so it runs in a Convex action or the Worker before the mutation. |
| [Akismet](https://akismet.com/developers/comment-check/) | Pro $9.95/mo for 500 checks, Business $49.95/mo for 5,000 ([pricing](https://akismet.com/pricing/)); Personal plan forbids commercial use | `POST rest.akismet.com/1.1/comment-check` returns `true/false`; `X-akismet-pro-tip: discard` marks blatant spam. Only worth it once volume exceeds what heuristics catch. |
| [OOPSpam](https://www.oopspam.com/) | Starter $23/mo for 25,000 calls | Checks content, IP and email reputation; no free tier. Skip for v1. |
| Perspective API | free | Google is sunsetting it after 2026 ([announcement](https://www.perspectiveapi.com/)). Do not adopt. |

### Auto-moderation with an LLM

| Service | Cost | Fit |
|---|---|---|
| [OpenAI moderation](https://developers.openai.com/api/docs/guides/moderation) (`omni-moderation-latest`) | "The moderation endpoint is free to use" | 13 categories (harassment, hate, sexual, sexual/minors, violence, self-harm, illicit). Returns `flagged` plus per-category scores. Good first-pass classifier for abuse, useless for spam or spoilers. |
| Claude Haiku 4.5 | $1 / MTok input, $5 / MTok output; batch halves it ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)) | A 200-token comment with a cached policy prompt and a 30-token JSON verdict costs roughly $0.0004. 10,000 comments a month is about $4. Can classify spam, abuse, spoilers and off-topic in one call, which the OpenAI endpoint cannot. |

Either runs from a scheduled Convex action after insert, patching `status` from `pending` to `approved` when the score is clean. Keep it advisory in v1: the model routes, humans decide on anything flagged.

## 3. Moderation policy patterns on comparable sites

| Site | Model | Gating | Reports and hiding |
|---|---|---|---|
| MyAnimeList | Post-moderation by volunteer forum moderators; warnings then bans | 30-character minimum post length since 2015 ([MAL forum](https://myanimelist.net/forum/message/50739814?goto=topic)); account-age gate discussed but not adopted | Report button per post; reports go to moderators |
| AniList | Post-moderation; "ignoring any of these guidelines may result in content being removed, locked, or even your account being banned" ([Guidelines](https://anilist.co/forum/thread/14)) | 18+ content hidden until the user enables it in settings ([FAQ](https://anilist.co/forum/thread/76239)) | Report feature, plus user-level block; "not every report may be actionable" |
| MangaUpdates | Post-moderation by admins | Registration required to post | "Report" link on every post; series-comment complaints go through a Change Request form ([FAQ](https://www.mangaupdates.com/site/faq/5)) |
| Goodreads | Post-moderation by staff; flags are private | None at post time | Staff actions include removing content, "limiting accounts to a certain number of posts per day", temporary or permanent blocks ([Meta-Wiki summary](https://meta.wikimedia.org/wiki/Research:Online_Community_Conduct_Policies/Goodreads)) |
| Discourse (reference design) | Post-moderation with trust levels | TL0 cannot post more than 2 links or 1 image; TL1 after entering 5 topics, reading 30 posts, 10 minutes reading ([Discourse](https://blog.discourse.org/2018/06/understanding-discourse-trust-levels/)) | Flags from trusted users hide TL0 posts immediately; multiple flags auto-silence |

Every comparable catalog runs **post-moderation with reports**, not pre-approval. Pre-approval of everything is what the deprecated Cusdis did, and it only works at blog scale. The compromise that scales is: pre-approve only the risky slice (new accounts, link-heavy, model-flagged), publish the rest, and let reports plus a threshold hide the misses.

Reputation gating for MangaDB can use signals already in the database: account age (`users._creationTime`), number of `userSeriesStates` rows, and whether a previous comment was approved. A user with 5 tracked Series and one approved comment is unlikely to be a bot.

## 4. Legal and operational

**GDPR erasure.** Art. 17 requires deletion "without undue delay" ([gdpr-info.eu](https://gdpr-info.eu/art-17-gdpr/)). Pseudonymised data is still personal data; truly anonymised data is not. Comment bodies are the user's expression and can identify them, so `purgeUser` should **delete comment rows outright**, not anonymise them. Replies lose their parent; render "comment removed" in place, as `revisions` already render a deleted author. `commentReports` filed by the user are deleted; reports about their comments go with the comments. Clerk's `user.deleted` webhook can arrive late, out of order or twice ([Clerk](https://clerk.com/docs/guides/development/webhooks/syncing)), so the purge must be idempotent, which the current `purgeUser` already is.

**Mature Series.** Comments are per-page, and Series pages are already visible to everyone, so comments on a Mature Series are not a discovery leak. The risks are elsewhere: (a) a comment feed or "recent comments" widget on the home page must apply `visibleTo(showMature, series.mature)`, hence the denormalised `seriesId`; (b) a user profile page listing comments must hide mature-Series comments unless the viewer opted in; (c) Volume comments inherit the Series' mature flag. Simplest v1 rule: no global or profile comment feeds, so there is nothing to filter.

**Notification email.** Do not send any in v1. Reply notifications multiply moderation load (every notification is a spam vector) and need unsubscribe handling. Moderators get a badge count on `/mod`, which Convex queries make reactive for free. If a digest is wanted later, one daily cron email to moderators with the pending count is enough.

## Recommendation

**Build comments natively in Convex.** No third-party option puts the queue in `/mod`, reuses `users.role`, or shares Clerk identity without paying for an enterprise tier (Disqus Business) or running a stateful server (Remark42, Commento++). The one hosted option that fits the auth model, Hyvor Talk with HMAC SSO, still gives the data team a second dashboard. The Convex build is small: two tables, four mutations, one query, one moderation route, and it inherits rate limiting, roles, suspension, audit and account purge for free.

### v1 scope

| Area | Decision |
|---|---|
| Targets | Series and Volume pages only. One level of replies. Plain text, 2,000-char cap, spoiler checkbox that blurs the body. |
| Data model | `comments` and `commentReports` as sketched above, plus `users.commentShadowed` and `users.commentHold` (approved-comment count). |
| Moderation mode | Post-moderation by default. `pending` for: accounts under 7 days old or with fewer than 3 approved comments, bodies with more than 2 links, Turnstile failure. `hidden` once 3 distinct users report. Suspended users cannot post. |
| Queue | `/mod/comments` for Moderators and Administrators (Editors can view, not act), with approve, remove (reason required), shadow-hide author, suspend author. Pending and hidden counts on the `/mod` nav. |
| Rate limits | `commentSubmit` 20/h burst 5, `commentSubmitNew` 3/day, `commentReport` 10/h burst 3, global sharded 600/h. |
| Spam | Heuristics plus Turnstile (free). No Akismet, no LLM in v1; leave a `spamScore` field so a scheduled action can be added later without a migration. |
| Erasure | `purgeUser` deletes the user's comments and reports; replies show a placeholder. |
| Mature | No global or profile comment feeds, so no new filtering surface. |
| Notifications | None. Moderator badge count only. |

### Deferred

Deep threading, reactions and votes, edit history, per-user block lists, comment feeds on home or profile pages, reply notifications, Akismet, LLM triage (Claude Haiku 4.5 at roughly $0.0004 per comment when volume justifies it), comment transfer on Series merge (v1: `by_series` index exists, transfer is a follow-up in the merge manifest).

### Three biggest risks

1. **Moderation load is set by the hold thresholds, and the team is small.** If too much goes to `pending`, the queue stalls and commenters leave; if too little, abuse sits public until reported. Mitigation: ship the thresholds as `appConfig` rows the Administrator can tune without a deploy, and watch the pending age for the first month.
2. **Spoilers and toxicity are not spam.** Heuristics and Turnstile stop bots, not people. A hidden-on-3-reports rule can be gamed by brigading and misses harassment nobody reports. Mitigation: shadow-hide plus suspension for repeat offenders; add the Haiku classifier as the second step once real traffic shows what slips through.
3. **Comments are the first public user-generated content on the site**, which changes the legal surface: takedown requests, defamation, minors on mature Series pages. Mitigation: a short comment policy page linked from the composer, a per-comment report reason of "other" with a note, and outright deletion on account purge so erasure requests are one action.
