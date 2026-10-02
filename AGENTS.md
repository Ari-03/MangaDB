<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

# Local data is not in git

Every checkout and worktree of this repo can hold a Convex local backend
database at `.convex/local/default/` (SQLite, gitignored, hundreds of MB).
`git status` will never show it, and a worktree that reports "0 dirty"
can still be the only copy of weeks of catalog work. On 2026-09-26 the
repair-sandbox database was destroyed this way when its worktree was
removed during a cleanup.

Before removing any worktree, checkout, or directory of this project:

1. Run `find <dir> -name "*.sqlite3" -o -name ".convex" -o -name ".env*"`
   and list what you find to the user, even when git says the tree is clean.
2. If a Convex database is present, export it first:
   `npx convex export --path <name>.zip --include-file-storage` from that
   directory (needs its backend running), and confirm the zip exists.
3. Only then remove the directory. "Delete everything" from the user means
   branches and worktrees; it never includes a database nobody has exported.

The same applies to `npx convex import --replace-all`: it destroys what the
target deployment holds. Export the target first unless the user has
explicitly said the current contents are disposable.

# Environments and deploy safety

Three environments; see README "Environments" for the table and
`docs/deployment.md` for the details.

- Production: Convex `intent-curlew-625`, Worker `mangadb` at mangadb.org.
  Read-only unless the user gives a fresh, explicit yes for that action.
- Staging: Convex `brave-kingfisher-844` (project `mangadb-staging`), Worker
  `mangadb-staging` on workers.dev. Deploy a branch with
  `gh workflow run deploy.yml --ref <branch> -f environment=staging`, or
  `npm run deploy:staging` locally.
- Local: `npx convex dev` (backend on port 3220). Data lives in the main
  checkout's `.convex/`; worktrees symlink to it.

`main` is protected; changes land by pull request. A merge to `main` that
touches more than docs queues a production deploy that waits for the user's
approval in GitHub. Never approve a pending production deployment, never run
the Deploy workflow with `environment=production`, and never weaken the
ruleset or the environment protection without a fresh, explicit yes. See
`docs/deployment.md`.

Wrangler environments inherit top-level `routes`. Any new `env.*` block in
`wrangler.jsonc` must set `"routes": []` or it will take the production
custom domain away from the `mangadb` Worker on its first deploy.

The only surviving copy of the repaired catalog is `~/mangadb-audit/`
(`before19.zip` is the newest sandbox export). Never delete that folder.
