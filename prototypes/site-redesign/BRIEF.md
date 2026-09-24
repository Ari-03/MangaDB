# MangaDB site redesign — design brief for mock-up variants

## What MangaDB is
A public database of **English manga volume releases**: what volumes exist, when each
edition comes out, and which ones you own, want, or have read. Think "RanobeDB, but for
manga". Stack: TanStack Start SSR + Convex + Clerk on Cloudflare Workers at mangadb.org.
Read `CONTEXT.md` (glossary) and `.scratch/v1-spec/spec.md` §10–§11 (UI direction, routes)
in the repo root before designing. Use the glossary's words in the UI: Series, Volume,
Edition, Edition Line, Release, Release Variant, Release Bundle, Publisher, Format
(physical/digital), Binding (paperback/hardcover), Reading Path, Collection Entry
(Wanted / Ordered / Owned), Series Follow, Reading Status.

## Why we are redesigning
The current site (see `/tmp/mangadb-redesign-ref/mangadb-*.png`, live at
https://mangadb.mangadb.workers.dev) is a narrow 44rem single column with a plain link
list for series, a cover-less series page that is just a stack of collapsed accordions
("Reading path"), and a release agenda whose rows are mostly text. It reads as a
scaffold, not a product. Covers are the product's strongest asset and are barely used.

## The reference: https://ranobedb.org
Screenshots in `/tmp/mangadb-redesign-ref/ranobedb-*.png` (home, series page, book page,
series list, releases list, releases calendar, publishers). What the owner likes about it:
- Persistent left sidebar navigation (Database section + User section + footer links),
  search in the top bar, avatar/profile top right.
- Dark theme by default (it also has light). Neutral greys, one accent.
- Home is **cover-led**: hero with stats + CTA buttons, then horizontal rows of covers
  ("Most popular series", "Upcoming releases", "Recently released", "New licenses",
  "Recent changes").
- Series page: cover + title + native title, quick facts as a definition list, chips for
  tags/links, then "Books in series" as a numbered cover grid.
- Release rows carry small metadata tags (date, language, format).
- Dense but calm; a lot of data without feeling cluttered.
Do NOT clone it pixel for pixel. Use it as the bar for information density and polish and
give MangaDB its own identity.

## Pages every variant must include
Each variant is a directory of static, hand-written HTML + one CSS file (vanilla, no build
step, no framework). Pages link to each other. Fake, in-memory data only.
1. `index.html` — Home. Stats, primary CTA to the release calendar, cover rows
   (this week's releases, upcoming, recently added series, publishers), search.
2. `releases.html` — the **Release Agenda** (spec §10 default): September 2026 grouped by
   publication day, cover-led rows, Format + Publisher filters, month navigation, a
   "followed series" marker (★) on a few rows, and a visible toggle to the Month Grid.
3. `releases-grid.html` — the **Month Grid** sibling: calendar month-at-a-glance for
   September 2026 with covers/titles inside the day cells.
4. `series.html` — Series page in the **Reading Path** hierarchy: cover hero + facts
   (source status, alt titles, publisher, volume count, series family links), signed-in
   controls (Follow, Reading Status, visibility), then the canonical volume sequence as a
   cover grid/list where one volume is expanded to show its Editions → Releases
   (with one omnibus/Edition Line example: "Deluxe Edition 1 covers Vol. 1–3").
5. `volume.html` — Volume page: cover, synopsis, every Edition covering it with its
   Releases (date, format, binding, ISBN, price), Collection Entry controls
   (Wanted / Ordered / Owned), read count.
6. `publisher.html` — Publisher Spotlight: profile + bounded upcoming lane + link into the
   filtered Releases browser.
Also include a signed-in header state on at least one page (avatar + "My releases").

## Sample data
`prototypes/site-redesign/sample-releases.json` holds 171 real September 2026 releases
from the live site: date, cover URL (52 have real covers; use them — they are hotlinked
from the production Convex storage and load fine), series title, volume label, format,
publisher. Series to feature by name: Welcome to Demon School! Iruma-kun (26 volumes,
Vertical Comics), Blue Lock, Witch Hat Atelier, Initial D Omnibus, MF Ghost, Grand Blue
Dreaming, Rent-A-Girlfriend, WIND BREAKER, Giant Killing, Nina the Starry Bride. For
covers you don't have, use a tasteful placeholder (tinted panel with title text), never
a broken image and never fabricated art.

## Technical constraints
- Self-contained: `index.html`, `releases.html`, `releases-grid.html`, `series.html`,
  `volume.html`, `publisher.html`, `styles.css` in the variant directory. A few lines of
  vanilla JS for a theme toggle or expand/collapse are fine.
- Responsive: must look right at 1440px, 1024px, and 390px wide. Sidebar collapses to a
  top bar / drawer on narrow screens.
- Light AND dark themes via `prefers-color-scheme`, with a toggle. State which is default.
- Google Fonts allowed (one or two families max). Accessible contrast. Real `<a>` links.
- Keep CSS organised under a single set of custom properties; another engineer will port
  the winning variant into the real `src/styles.css` + React routes, so keep class names
  meaningful and the structure portable.
- Do not touch anything outside your variant directory.

## Screenshot yourself before you finish
A headless Chromium is available. From the repo root:
```
BIN=/home/ari/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell
$BIN --headless --no-sandbox --disable-gpu --hide-scrollbars --window-size=1440,2000 \
  --screenshot=/tmp/<variant>-index.png file://$PWD/prototypes/site-redesign/<variant>/index.html
```
Repeat at `--window-size=390,1600` for mobile. View the PNGs with the Read tool and fix
what looks wrong (overflow, clipped text, unreadable contrast, empty space) before
returning. Load the `frontend-design:frontend-design` skill before you start designing.
