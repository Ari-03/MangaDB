# CI/CD for MangaDB: GitHub Actions, a protected main, and one staging

Researched 2026-10-01 against docs.convex.dev, developers.cloudflare.com,
docs.github.com, the Convex CLI source in `node_modules/convex` (1.44.0), and
a clean checkout of this repo. Action versions are the GitHub `latest`
releases on that date.

## 0. Where we started

- Deploys ran from a laptop. `npm run deploy` pushed Convex production and the
  `mangadb` Worker. `npm run deploy:staging` did the same for staging and
  needed a gitignored `.env.staging`.
- The repo had no workflows, no secrets, no environments, and no rule on
  `main`. Anyone with write access could push to it.
- The repo is public and has one collaborator, `Ari-03`.
- Review bots installed on the repo: CodeRabbit, Greptile, Claude.

## 1. What a clean checkout needs

I exported `HEAD` to an empty directory with no `.env.local` and ran what CI
would run.

| Step | Result |
|---|---|
| `npm ci` | works on Node 24, npm 11 |
| `npm run typecheck` | passes |
| `npx tsc --noEmit -p convex` | passes. The root `tsconfig.json` only covers `src`, so CI has to run this as well |
| `npm test` | 77 files, 1806 tests pass in about 35 seconds |
| `npm run build` | passes with no env vars at all |

`convex/_generated` is committed, so the typecheck needs no Convex login.

One trap. Symlinking `node_modules` into the checkout instead of running
`npm ci` made 54 tests fail, because `vi.mock("./lib/features")` and the code
under test resolved to two copies of the module. A real `npm ci` fixes it. CI
runs `npm ci`, so it is safe, but do not "speed up" a runner with a symlinked
install.

Timing is tighter than it looks. Pinned to 4 CPUs, the size of a GitHub
runner, the suite takes 45 seconds and its slowest test on vitest's default
5 second timeout takes 3.8. One test crossed 5 seconds on a loaded machine.
`vitest.config.ts` now sets `testTimeout` to 15 seconds so a noisy runner
does not fail the required check.

## 2. Convex from CI

Source: https://docs.convex.dev/cli and `npx convex deploy --help`.

- `CONVEX_DEPLOY_KEY` picks the target. A production deploy key looks like
  `prod:<deployment-name>|<token>` and deploys to that one deployment. Each
  Convex project issues its own, under Settings in the dashboard.
- Staging is the production deployment of a second project, `mangadb-staging`.
  So staging also takes a production deploy key, the one from that project.
- `convex deploy` runs `--cmd` first, with the deployment URL in the variable
  named by `--cmd-url-env-var-name`, and pushes functions and schema only if
  the command exits 0. A check placed inside `--cmd` can stop a deploy before
  anything reaches Convex.
- `--env-file` is no use in CI. `resolveBaseDeploymentSelection` in
  `node_modules/convex/src/cli/lib/deploymentSelection.ts` crashes with "env
  file does not exist" when the file is missing, and ignores
  `process.env.CONVEX_DEPLOY_KEY` when the flag is present. The local
  `deploy:staging` script keeps the flag. CI calls `convex deploy` without it.
- Convex validates the pushed schema against the data already in the
  deployment and rejects the push on a mismatch. A bad schema change fails the
  deploy instead of corrupting data.

## 3. The Worker from CI

Source: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/

- Wrangler reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the
  environment. Cloudflare's "Edit Cloudflare Workers" token template is the
  one its docs recommend for this. I have not run a deploy with such a token,
  so the first run is the test that it covers the R2 binding and the custom
  domains.
- A Cloudflare token is scoped to an account and zone, never to one Worker.
  The token that deploys `mangadb-staging` can deploy `mangadb` too. See
  section 7.
- The Cloudflare Vite plugin picks the Wrangler environment at build time from
  `CLOUDFLARE_ENV`. The build writes a flattened `dist/server/wrangler.json`
  and points `.wrangler/deploy/config.json` at it, and `wrangler deploy`
  follows that pointer. I checked both builds:

  | Build | `name` | `routes` | `vars.VITE_CONVEX_URL` |
  |---|---|---|---|
  | `npm run build` | `mangadb` | mangadb.org, www.mangadb.org | intent-curlew-625 |
  | `CLOUDFLARE_ENV=staging npm run build` | `mangadb-staging` | none | brave-kingfisher-844 |

- That generated file gives us a cheap safety check. After the build, compare
  its `vars.VITE_CONVEX_URL` with the URL the Convex CLI resolved from the
  deploy key. If they differ, the key belongs to a different deployment than
  the Worker being built, for example a production key saved in the staging
  environment. Fail there and nothing is pushed.
- `cloudflare/wrangler-action` adds nothing here. `npx wrangler deploy` with
  the two env vars does the same job with one less third-party action in a
  workflow that holds production secrets.
- Worker secrets set with `wrangler secret put`, such as `CLERK_SECRET_KEY`,
  survive deploys. CI does not need them.
- The `VITE_*` values are inlined by the build, so the build step needs
  `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_PUBLIC_POSTHOG_KEY`. Both ship in the
  client bundle, so they are GitHub environment variables, not secrets.

## 4. GitHub

Sources: https://docs.github.com/en/rest/repos/rules and
https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments

- **Rulesets** replace classic branch protection. One ruleset on the default
  branch can require a pull request, require a status check, and block force
  pushes and deletion. With no bypass actors it binds admins too. A solo repo
  sets the required approval count to 0, since nobody can approve their own
  pull request.
- **Environments** hold secrets per target and can require a reviewer before
  a job starts. The job cannot read the environment's secrets until someone
  approves. Required reviewers are free on public repos. An environment can
  also restrict which branches may deploy to it.
- **`workflow_dispatch`** is the "click a button" trigger. It appears as "Run
  workflow" in the Actions tab with a branch picker, and only people with
  write access can use it. `gh workflow run` does the same from a terminal.
  The workflow file must exist on the default branch and on the branch being
  run.
- **Fork pull requests** run `pull_request` workflows with a read-only token
  and no secrets. CI on a public repo is safe as long as deploys never use
  the `pull_request_target` trigger.
- Latest action releases, pinned by commit in the workflows:
  `actions/checkout` v7.0.1 `3d3c42e5aac5ba805825da76410c181273ba90b1`,
  `actions/setup-node` v7.0.0 `820762786026740c76f36085b0efc47a31fe5020`.

## 5. One shared staging, or one environment per branch

Convex has preview deployments. With a preview deploy key, `convex deploy`
creates a deployment named after the branch, and the free plan deletes it
after 5 days. I decided against them for now.

- A preview deployment starts empty. This app is its catalog, about 6,000
  Series imported over weeks. An empty MangaDB shows almost nothing worth
  reviewing, and seeding one from a production export on every push is slow
  and heavy.
- Each branch would also need its own Worker name, its own R2 bucket or a
  shared one, and its own origin allowed in Clerk before sign-in works.
- Staging already holds a production snapshot and a working Clerk origin.

So branches share the one staging environment. Any branch can be deployed to
it with the button, and a concurrency group makes deploys take turns. The
cost is that two people testing two branches overwrite each other, and a
branch with a schema change can leave staging data that an older branch
rejects. Refreshing staging from a production export fixes that. With one
developer this is a fair trade. Revisit previews if a second regular
contributor shows up.

## 6. The design

```
pull request ──> CI (typecheck, test, build) ──> merge to main
                                                     │
                                                     v
                              Deploy: CI again ──> wait for approval ──> production

any branch ──> "Run workflow" (environment: staging) ──> CI ──> staging
```

- `ci.yml` runs on every pull request and is reusable by other workflows.
- `deploy.yml` runs on a push to `main`, targeting production, and on
  `workflow_dispatch` with an `environment` choice that defaults to staging.
  Production only deploys from `main`. The workflow checks that itself and
  the `production` environment's branch policy enforces it again.
- The `production` environment requires approval from `Ari-03`. Merging
  queues the deploy and one click releases it. This keeps the rule in
  `CLAUDE.md` that production changes need a fresh, explicit yes from a
  person. Remove the reviewer in the environment settings for fully automatic
  deploys.
- Both environments use the same secret names, so one job serves both:
  `CONVEX_DEPLOY_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- `scripts/check-deploy-target.mjs` runs inside `--cmd` after the build and
  applies the check from section 3. It also checks the Worker's name, that a
  staging build carries no routes, and that the Clerk key in the build
  environment matches the Worker's. The local `deploy` scripts call it too.
- The ruleset lives in `.github/rulesets/main.json` so the repo records what
  protects `main`.

Left out on purpose: per-branch previews, deploy notifications, automatic
rollback. Convex and Cloudflare both keep deploy history, and a rollback is a
revert pull request through the same path.

## 7. What the review changed, and what stays open

A second pass over the finished workflows found these.

- **The approval gate covers less than it seems.** It guards the secrets in
  the `production` environment. Because of the token scoping in section 3,
  the Cloudflare token in the unprotected `staging` environment can also
  replace the production Worker. So approval really gates the production
  Convex deploy key, and write access to the repo gates the production
  Worker. Fork pull requests get no secrets and cannot do this. Closing the
  gap needs a second Cloudflare account for staging.
- **A waiting production run holds the queue.** The deploy job's concurrency
  group counts a run that is waiting for approval as running. A second merge
  waits behind it and cannot be approved, and a third replaces the second.
  Reject the stale run first. This comes from GitHub community discussion
  17401, not from a test here. To keep the queue short, merges that touch
  only Markdown, `docs/` or `.scratch/` queue no deploy.
- **Convex goes first, so a bad Cloudflare token used to strand a deploy
  halfway.** The workflow now asks the Cloudflare API to list Workers on the
  account before it pushes Convex. That proves the token and account ID are
  valid. It cannot prove every permission `wrangler deploy` needs.
- **The required check names its source.** The ruleset pins the `check`
  context to the GitHub Actions app, id 15368, so another installed app
  cannot report a passing `check`.

Still untested until the first real run: the exact URL string Convex hands to
`--cmd`, which the target check compares with `wrangler.jsonc`, and whether
Cloudflare challenges the smoke test's `curl` from a runner's address. Both
fail safe. The first stops the deploy before anything is pushed, and the
second turns the job red after a deploy that worked.
