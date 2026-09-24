# Porting the Bookshelf look into the real MangaDB app

The owner picked prototype `05-bookshelf` (branch `prototype/site-redesign`, `prototypes/site-redesign/`) as the look and feel
for the production site, with the instruction: **"very subtle skeuomorphism — you are at a
bookshelf, you're reading."** Subtle means: the shelf ledge under rows of covers, covers
that sit like jacketed books (spine shading, lift on hover), coverless books as cloth-bound
placeholders, warm paper/wood tones, quiet gold accent. It does NOT mean wood textures,
page-curl effects, 3D book flips, or decorative illustration. When in doubt, less.

## What already exists (do not rewrite these)
- `src/styles/tokens.css` — colour/type/radius tokens, dark default + `[data-theme=light]`,
  base element styles, legacy variable bridge (`--fg/--muted/--card/--border`).
- `src/styles/shell.css` — `.container`, `.section`, `.section-head/.section-title/
  .section-note/.section-link`, `.btn/.btn-primary/.btn-sm`, `.chip/.chip--physical/
  .chip--digital/.chip--line`, `.select`, the site header + mobile drawer, `.site-footer`,
  a default `main` frame (container width, top padding), `.notice`, `.breadcrumbs`.
- `src/styles/covers.css` — `.cover` (+ spine shading, hover lift), `.cover-ph` cloth
  placeholder (`.cover-ph-title/.cover-ph-foot/.cover-ph-mark`, `.cover-ph--numbered`
  with `.cover-ph-series/.cover-ph-num`), `.cover-badges` + `.badge--owned/ordered/
  wanted/read`, `.cover-flag` (followed ★), `.cover-actions/.quick-btn` hover actions,
  `.shelf` grid + `.shelf-item/.cover-wrap/.cover-link/.caption/.caption-title/
  .caption-meta` (the caption draws the ledge), `.rail` horizontal shelf, `.empty-shelf`.
- `src/lib/cover.tsx` — `<Cover src title foot numbered badges followed lazy>` renders
  the cover-or-placeholder markup above; `<CoverBadge state>` renders a badge. USE THESE
  for every cover on every page. Do not edit cover.tsx (if you truly need something it
  cannot do, build page-local markup with the covers.css classes instead).
- `src/providers.tsx` (header) and `src/routes/__root.tsx` (theme boot, fonts, footer).
- `src/styles.css` imports tokens → shell → covers → one CSS file per page group.

## Your page CSS file
Each page group owns one file under `src/styles/`. Right now it contains the OLD rules for
those pages, copied verbatim from the previous stylesheet. Replace them: delete what you
no longer use, write the new rules composing the shared vocabulary. Copy freely from the
prototype's `styles.css` section for your page (sections are labelled: 7 Home hero,
8 Publisher cards, 9 Toolbar, 10 Agenda, 11 Month grid, 12 Series page, 13 Volume page,
14 Publisher page, 16 Responsive) — but ONLY the rules for your page; shared ones are
already in shell/covers. Keep the old class names where they still make sense so the
existing tests and other pages keep working; rename where the prototype's names are better.

## Rules
- Real data only. The pages are server-rendered from Convex; keep every loader, server
  function, SEO `head()`, JSON-LD, redirect, and gating exactly as it is. Change markup and
  CSS, not data flow. If a shelf needs data the page doesn't load yet (e.g. the home page
  wants this month's covers), reuse an existing server function
  (`fetchMonthReleases` in `src/server/releases.ts`) from the loader — never call Convex
  from the client for public catalog data.
- Keep exported component names and props stable (other agents import them). Adding an
  optional prop is fine.
- Domain vocabulary from `CONTEXT.md` stays: Series, Volume, Edition, Edition Line,
  Release, Release Variant, Release Bundle, Reading Path, Collection Entry (Wanted /
  Ordered / Owned), Series Follow, Reading Status.
- Every page must work signed-out (public catalog) and, where it has them, keep the
  signed-in controls. Never break the noscript/GET-form fallbacks that exist.
- Both themes. Mobile at 390px. No horizontal overflow. Real `<a>` links.
- TypeScript strict; `any` is banned. Run `npx tsc --noEmit` before you finish and fix
  every error in the files you own (errors in files owned by other agents are theirs).
- Do not commit. Do not touch files outside your ownership list. Do not edit
  `prototypes/`, `convex/`, or `src/server/`.

## Verifying visually
A dev server is already running at http://localhost:5173 against a small local Convex seed
(Tokyo Ghoul, Tokyo Ghoul:re, The Quiet Cartographer, One Rainy Evening; 22 releases;
no cover art on file, so you will see the cloth placeholders everywhere — that is the
expected look for coverless books). Series pages: `/series/1/tokyo-ghoul` etc.; follow
links from there to volume, edition, bundle, and publisher pages. Releases: `/releases`
(current month) and `/releases/2026-08`, `/releases/2026-10` — check which months have
rows. Use `npx convex run catalog:listSeries '{}'` etc. to inspect data.
Screenshot with headless Chromium (wait for SSR with the virtual time budget):
```
BIN=/home/ari/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell
$BIN --headless --no-sandbox --disable-gpu --hide-scrollbars --window-size=1440,1800 \
  --virtual-time-budget=12000 --screenshot=/tmp/<name>.png "http://localhost:5173/<path>"
```
Add `?theme=light` to check the light theme; use `--window-size=390,1600` for mobile.
View the PNG with the Read tool. Vite hot-reloads your edits; if a page 500s, read
`/tmp/mangadb-dev.log`. Signed-in states cannot be exercised in the headless browser;
port their markup carefully and rely on tsc.
