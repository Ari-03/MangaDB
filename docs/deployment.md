# Deployment

Convex and the Worker deploy together. `convex deploy` runs the Worker build
with the deployment's URL in `VITE_CONVEX_URL`, then runs the target check
below, and pushes functions and schema only if both pass. `wrangler deploy`
then uploads the Worker. GitHub Actions runs this for both environments:

```
pull request ──> CI ──> merge to main ──> CI again ──> approval ──> production
any branch ──> Run workflow (staging) ──> CI ──> staging
```

## Environments

| | Convex | Frontend | Data |
|---|---|---|---|
| **Production** | project `mangadb`, deployment `intent-curlew-625` | Worker `mangadb` at mangadb.org | live |
| **Staging** | project `mangadb-staging`, deployment `brave-kingfisher-844` | Worker `mangadb-staging` at https://mangadb-staging.mangadb.workers.dev | prod snapshot, refreshed by hand |
| **Local** | `npx convex dev` local backend (`.convex/local/default`, SQLite) | `npm run dev` | prod snapshot, refreshed by hand |

Staging is a separate Convex project, so it has its own env vars, deploy
history and dashboard. A staging build sets `CLOUDFLARE_ENV=staging` so the
`env.staging` block in `wrangler.jsonc` applies. Any new `env.*` block there
must set `"routes": []`, or it inherits the production custom domains.
The local fallback, `npm run deploy:staging`, picks the staging project
from `.env.staging` (gitignored; `CONVEX_DEPLOYMENT=dev:<staging dev deployment>`).
Staging has no importer keys and no Resend, and every Approved Source is
disabled there, so it never fetches from publishers or emails anyone. In
the Clerk dashboard the staging origin must be allowed for sign-in to work.
Refreshing staging from production is in
[operations.md](operations.md#refresh-local-or-staging-from-production).

## Production

1. Open a pull request. `.github/workflows/ci.yml` checks its formatting
   and lint, typechecks, tests and builds it, and its `check` job must pass
   before the pull request can merge. The "Protect main" ruleset
   (`.github/rulesets/main.json`) blocks direct pushes, force pushes and
   deletion of `main`, so every change lands this way.
2. Merge it. `.github/workflows/deploy.yml` runs CI again on `main` and queues
   a production deploy. A merge that touches only Markdown files or `docs/`
   queues no deploy.
3. Approve it. The run waits on the `production` environment until a
   required reviewer opens it in the Actions tab and clicks Review
   deployments, then Approve and deploy. Until then the job cannot read the
   `production` environment's secrets.

The approval only protects production if the `staging` environment holds
nothing that can reach it. Anyone with write access can edit the workflow on
a branch and run it against staging without approval, so the staging secrets
must be staging-only. The Convex deploy key already is. The Cloudflare token
must be scoped to the `mangadb-staging` Worker alone, as One-time setup
describes. A token with account-wide Workers access in `staging` could
replace the `mangadb` Worker from any branch. Fork pull requests get no
secrets either way.

A production run waiting for approval holds the production queue. A later
merge waits behind it and cannot be approved yet, and a third merge replaces
the second. To ship the newest merge, reject the older waiting run first, or
approve the runs in order. A run nobody approves expires after 30 days.

Production only deploys from `main`. The workflow refuses any other ref, and
the `production` environment's branch policy refuses it again.

## Staging

Any branch can go to staging. In the Actions tab open Deploy, click Run
workflow, pick the branch, and leave the environment on `staging`. From a
terminal:

```sh
gh workflow run deploy.yml --ref <branch> -f environment=staging
```

GitHub only runs `workflow_dispatch` on a branch that contains the workflow
file, so a branch cut before the workflow existed has to merge `main` first.

Staging is shared. Deploys to it take turns and the last one wins, so a
second branch replaces the first. If a deploy is waiting when a newer one
queues, GitHub cancels the waiting one. A branch with a schema change can
leave data on staging that an older branch's schema rejects, and that
branch's Convex deploy then fails. Refresh staging from a production export
to start clean.

## What a deploy runs

After CI passes, the deploy job:

1. refuses production from any ref but `main`,
2. checks that the environment's secrets and Clerk variable are set,
3. checks that the Cloudflare token can read the target Worker, so a bad
   token, a wrong account ID, or the other environment's token fails before
   Convex is touched. This cannot prove every permission `wrangler deploy`
   needs,
4. runs `convex deploy`, which builds the Worker, runs the target check and
   then pushes Convex functions and schema,
5. runs `wrangler deploy`,
6. requests the site URL until it answers with a 2xx, up to five tries.

What a failure leaves behind:

| Failing step | State |
|---|---|
| Steps 1 to 3, the build, or the target check | Nothing pushed |
| The Convex push | Nothing pushed |
| `wrangler deploy` | Convex is new and the Worker is old. Rerun the job |
| The smoke test | Both halves are live; only the job is red |

## The target check

`scripts/check-deploy-target.mjs` runs inside `convex deploy --cmd`, after the
build and before anything is pushed. The workflow and both local deploy
scripts call it. It stops the deploy when:

- the build's Wrangler environment or Worker name does not match the target
  (`mangadb` for production, `mangadb-staging` for staging),
- a staging build carries routes, which would take the production custom
  domains from the `mangadb` Worker,
- the Convex credentials select a different deployment than the Convex URL in
  the built Worker's `vars`, such as a production deploy key saved in the
  staging environment,
- the `VITE_CLERK_PUBLISHABLE_KEY` the build inlined differs from the key in
  the Worker's `vars`, which would leave the client bundle and the server on
  different Clerk keys. The check resolves the key as Vite does, from the
  shell and then `.env.local`. A build with no key skips this check.

## Local fallback

The same deploys run from a laptop when Actions is unavailable:

```sh
npm run deploy           # production
npm run deploy:staging   # staging, picks the staging project from .env.staging
```

`npm run deploy` runs:

```sh
convex deploy --cmd-url-env-var-name VITE_CONVEX_URL --cmd "npm run build && node scripts/check-deploy-target.mjs production" && wrangler deploy
```

They use the Convex and Wrangler logins on that machine and read the
`VITE_*` build values from `.env.local`. A local production deploy skips CI
and the approval step.

## One-time setup

Set up GitHub before merging the pull request that adds the workflows. A
deploy to an environment that does not exist yet creates it with no
protection, and then fails because it has no secrets.

1. Create the `production` and `staging` environments under Settings,
   Environments. On `production`, add yourself as a required reviewer and
   leave Prevent self-review off, since the person who merges also approves.
   Set Deployment branches and tags to Selected branches and tags with the
   single rule `main`. `staging` needs no protection.
2. Add the secrets. Both environments use the same names. `gh secret set`
   prompts for each value, which keeps it out of shell history.

   ```sh
   gh secret set CONVEX_DEPLOY_KEY --env production
   gh secret set CONVEX_DEPLOY_KEY --env staging
   gh secret set CLOUDFLARE_API_TOKEN --env production
   gh secret set CLOUDFLARE_API_TOKEN --env staging
   gh secret set CLOUDFLARE_ACCOUNT_ID --env production
   gh secret set CLOUDFLARE_ACCOUNT_ID --env staging
   ```

   The production `CONVEX_DEPLOY_KEY` is a production deploy key generated
   under Settings in the `mangadb` Convex project. The staging one comes from
   the `mangadb-staging` project's production deployment,
   `brave-kingfisher-844`, in the same place.

   Create two Cloudflare tokens, one per environment, so the staging token
   cannot touch production. In the Cloudflare dashboard go to Manage Account,
   Account API Tokens, create a token, set its scope to Specified Workers,
   pick the one Worker, and give it the Editor role: `mangadb-staging` for
   the `staging` secret and `mangadb` for the `production` secret. Editor can
   deploy an existing Worker with its R2 binding but cannot create or delete
   one. Do not use the "Edit Cloudflare Workers" template, which covers every
   Worker on the account. Per-Worker roles do not cover custom domains yet.
   Cloudflare's docs say a deploy that leaves the configured domains
   unchanged needs only Editor. If the production `wrangler deploy` is still
   refused over `mangadb.org`, add Workers Routes Write for that zone to the
   production token. `npx wrangler whoami` prints the account ID.
3. Add the build-time keys as variables, not secrets, since both ship in the
   client bundle. The deploy fails without the Clerk key. Leave the PostHog
   key unset to keep analytics off in that environment.

   ```sh
   gh variable set VITE_CLERK_PUBLISHABLE_KEY --env production --body pk_…
   gh variable set VITE_CLERK_PUBLISHABLE_KEY --env staging --body pk_…
   gh variable set VITE_PUBLIC_POSTHOG_KEY --env production --body phc_…
   gh variable set VITE_PUBLIC_POSTHOG_KEY --env staging --body phc_…
   ```

4. Apply the ruleset that protects `main`:

   ```sh
   gh api repos/Ari-03/MangaDB/rulesets --method POST --input .github/rulesets/main.json
   ```

   After editing the file, update the existing ruleset instead of adding a
   second one:

   ```sh
   id=$(gh api repos/Ari-03/MangaDB/rulesets --jq '.[] | select(.name == "Protect main") | .id')
   gh api "repos/Ari-03/MangaDB/rulesets/$id" --method PUT --input .github/rulesets/main.json
   ```

Outside GitHub, once per environment:

1. Each environment is the production deployment of its own Convex project:
   `mangadb` (`intent-curlew-625`) and `mangadb-staging`
   (`brave-kingfisher-844`). Create a project with `npx convex dev` once or in
   the [dashboard](https://dashboard.convex.dev), then set
   `CLERK_JWT_ISSUER_DOMAIN` and the other Convex variables listed in
   [configuration.md](configuration.md#convex-deployment).
2. `vars.VITE_CONVEX_URL` in `wrangler.jsonc` is the Convex URL each Worker
   uses at runtime, at the top level for production and under `env.staging`
   for staging. It is public, and the target check compares
   against it, so keep it in `vars` rather than in a Worker secret.
3. Run `npx wrangler secret put CLERK_SECRET_KEY`, adding `--env staging` for
   the staging Worker, and keep `VITE_CLERK_PUBLISHABLE_KEY` under `vars` in
   `wrangler.jsonc`. The publishable key must also be in the
   build environment, since `npm run build` inlines it into the client
   bundle. In the Clerk dashboard allow `mangadb.org` and the staging
   workers.dev origin.
4. `mangadb.org` and `www.mangadb.org` are attached to the
   `mangadb` Worker as Cloudflare custom domains and listed under `routes` in
   `wrangler.jsonc`, so `wrangler deploy` keeps them attached.
   `src/server.ts` enforces the canonical-host policy: apex canonical, `www`
   301s to it, HTTPS-only. The `CANONICAL_HOST` var in `wrangler.jsonc`
   controls this, and `*.workers.dev` hosts are never redirected.

## Verifying a deploy

Visit the deployed URL. The home page is server-rendered on the Worker and
shows live catalog counts fetched from Convex during SSR, so it proves the
SSR to Convex round trip.

Scripts and styles under `/assets/` should answer `Cache-Control: public,
max-age=31536000, immutable` (`public/_headers`; their names carry a content
hash, so a deploy gives changed files new URLs). The favicons and every page
keep the default revalidation.

## Why it is built this way

**One shared staging, not a deployment per branch.** Convex preview
deployments start empty, and an empty MangaDB shows almost nothing worth
reviewing. The catalog is about 6,000 Series imported over weeks. Seeding each preview from a production export would
be slow and heavy. Each branch would also need its own Worker name, R2
bucket or shared bucket, and Clerk origin. Staging already holds a
production snapshot and a working Clerk origin. The cost is that two
branches on staging overwrite each other. Revisit previews if a second
regular contributor joins.

**No `--env-file` in CI.** With `--env-file`, the Convex CLI ignores
`CONVEX_DEPLOY_KEY` from the environment and crashes when the file is
missing (`resolveBaseDeploymentSelection` in the Convex CLI). The local
`deploy:staging` script keeps the flag; the workflow calls `convex deploy`
without it.

**Install with `npm ci`.** A `node_modules` symlinked from another checkout
made 54 tests fail, because `vi.mock("./lib/features")` and the code under
test resolved to two copies of the module. CI runs `npm ci`. `vitest.config.ts`
sets a 15 second test timeout so a loaded runner does not fail the check.

**No `wrangler-action`.** `npx wrangler deploy` with the two Cloudflare
variables does the same job with one less third-party action in a workflow
that holds production secrets.

**The required check names its source.** The ruleset pins the `check`
status to the GitHub Actions app, so another installed app cannot report a
passing `check`.

Left out on purpose: per-branch previews, deploy notifications and
automatic rollback. Convex and Cloudflare keep deploy history, and a
rollback is a revert pull request through the same path.

Not yet proven by a real run: whether Cloudflare challenges the smoke
test's `curl` from a runner. If it does, the job turns red after a deploy
that worked.
