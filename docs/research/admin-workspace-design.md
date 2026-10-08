# Admin workspace: design brief

Written 2026-10-08 against the source on `t3code/admin-workspace` (based on
`setup-discord-server`, after the cover and description layer in
[catalog-editing-design.md](catalog-editing-design.md)). It changes no code.
The companion concept page is `/tmp/mangadb-admin-workspace-design.html`; it
uses the real tokens from `src/styles/tokens.css` and shows every screen in
both themes with labeled sample data.

The brief covers four things the data team asked for: one workroom frame for
the `/mod` pages, a review queue that names the book instead of repeating the
importer's sentence, an Imports page that separates source status from held
books, and a Catalog gaps page with rows you can act on. Plus the Discord
entry point for bug reports and community, at `https://discord.gg/VVcC8a79mz`.

## Decisions in one screen

1. Every `/mod` page renders inside one `ModWorkroom` frame: breadcrumb, a
   tab strip of the tools with small counts, the page title, one line of
   hint, and a right-aligned help group (Discord, Report a bug). Tabs, not a
   sidebar. The ledgers want the whole 1080px, and `/me` already has the tab
   pattern (`.lib-tabs`), so there is nothing new to learn.
2. Queue rows lead with the record: a small jacket, the record's title, and
   a one-line change summary derived server-side from the ops ("Publication
   date: 2026-03-10 → 2026-03-24", "Creates Volume 13, Edition, Release",
   "Report: the omnibus is missing…"). The stored change comment stays what
   it is (versions are immutable) and is shown in full on the proposal page.
3. Filters keep every facet they have, with plain labels, and live in the URL
   so a view is a bookmark. Five preset views sit above the filters (All,
   Import offers, People, Reports, Stale). Presets are filter bundles, not
   new queries.
4. Imports becomes three panels under one title: Sources, Held books, Run
   history. A source row shows health and schedule as two separate facts.
   "Paused" (the `enabled` flag) is muted; "Unhealthy" (three failed runs) is
   red. The two never share a chip.
5. Catalog gaps becomes two panels: Series without books, Unmapped
   packaging. Each row names its real actions: "Add a release" goes to the
   existing `/mod/propose-new` wizard, "Hide or merge…" to the manage page,
   "Map volumes" stays inline for Moderators. A search box filters the
   loaded rows client-side.
6. Discord is a footer link for everyone and a help group in the workroom
   header for the data team. "Report a bug" opens a native dialog with a
   generated context block (page, role, theme, viewport, browser, time, and
   the proposal id when on one), a Copy button, and the Discord link. No
   backend, no token, no bot.
7. No workflow semantics change. Claims stay non-exclusive, proposals stay
   immutable, stale stays a blocker that needs a rebase, placement drafts
   keep their rules, imports keep their guardrails. Nothing here adds an
   unbounded scan; every new count is a `take(101)` shown as "100+".

## As built (2026-10-08)

The first PR follows this brief except where the Convex guidelines or a
review call changed it:

- The queue page calls a new query, `proposals.reviewQueuePage`, which is
  paginated instead of a full `collect()` with more work per row. It reads
  `by_state` oldest first, at most 50 a page
  (`REVIEW_PAGE_MAX`; the page asks for 25). Every Proposal a page reads
  comes back: a match as a full row with `subject` and `summary`, anything
  else as `{ proposalId, matches: false }`. The queue page therefore says
  how many it has checked and how many match ("2 match among the oldest 5
  of 23 in review checked so far"), and "Check the next 25" reads on. No
  row is dropped unseen. The age filter takes the client's `now`; the query
  never reads the clock, and the client works out "waiting" from
  `submittedAt`.
- The old endpoints keep their contracts. Convex deploys before the Worker,
  and a tab opened before the deploy keeps its old bundle, so for a while
  old clients call the new backend. `proposals.reviewQueue` still takes its
  optional filters with no paging and returns the array of rows with
  `ageMs`, measured by the server's clock as before. `imports.dashboard`
  still returns the array of every source. Both read their whole table as
  they always did, and they share the new code: `queueRowOf` and
  `matchesQueueFilters` for the queue, `sourceRowsOf` for the sources, so
  the rules cannot drift. The site calls only the bounded queries. Remove
  the two old ones once no deployed client calls them.
- Kind, summary and the filter test are pure functions in
  `convex/lib/queueSummary.ts` (`summarizeVersion`, `matchesQueueFilters`).
  `myProposals` carries the same `summary` (no reads); its rows are titled
  by the change comment, because naming the record would mean more reads
  per row on an unbounded list.
- The count query is `workroom.counts` (`convex/workroom.ts`). It returns
  null for anyone outside the Data Team instead of throwing, so the error
  page can draw the tab strip. `COUNT_CAP` lives in `convex/lib/workroom.ts`
  so the browser may import it.
- The sources panel calls a new query, `imports.dashboardPage`, which reads
  at most 50 registry rows (`MAX_SOURCES`) and returns `{ sources, hasMore }`;
  `workroom.counts` reads the same cap.
- `imports.heldBooks` and `packaging.unmappedQueue` rows gain `mature`
  (from rows they already read) so their jackets stay concealed for a
  viewer who has not opted in. The queue subject carries `mature` as well:
  set when the record belongs to a Mature Series or when the version's
  observation evidence rates the book 18+ (`observationRatesMature`, at
  most 10 observations read). A held book's placement cites that
  observation, and its Series is flagged only once approval links it.
- The bug dialog names no channel. It says to paste into the Discord
  server's channel for bugs and feedback. Its report is an editable
  textarea, so the three questions can be answered before copying.
- Held-book reasons are shown in full (no clamp and "more" toggle), and the
  held list is not grouped by series. Both are follow-ups, as are the items
  listed under section 9.
- The edit, propose and manage forms are not wrapped in the frame.

## 1. The workroom frame

### What it is

A component, `ModWorkroom`, in `src/lib/modShell.tsx`, used by every page
that today renders `<main className="mod-page">` with its own breadcrumb and
`ModTools`. It takes `title`, `hint`, an optional `titleAside` (chips beside
the title, as the proposal page does), optional `crumbs` for deeper pages,
and `children`.

```
MangaDB / Workroom / Review queue                         Discord · Report a bug
[Review queue 23] [Imports ·] [Catalog gaps] [My proposals] [Comments 2] [Launch] [Roles]
───────────────────────────────────────────────────────────────────────────────
Review queue
In Review proposals, oldest first. Claiming shows who is looking and never locks.
```

The tab strip is a `<nav aria-label="Data team tools">` of router `Link`s
with `aria-current="page"` on the active one, styled like `.lib-tab`
(underline, accent when current, horizontal scroll on narrow screens). It is
not an ARIA tablist: each tab navigates. Tabs, in order:

| Tab | Route | Who sees it | Count |
| --- | --- | --- | --- |
| Review queue | `/mod/queue` | data team | In Review proposals, "100+" past the cap |
| Imports | `/mod/imports` | data team | a red dot when any source is unhealthy; nothing otherwise |
| Catalog gaps | `/mod/packaging` | data team | none (the two panels show their own) |
| My proposals | `/mod/proposals` | data team | none |
| Comments | `/mod/comments` | data team, only while `FEATURES.comments` | pending, as today |
| Launch | `/mod/launch` | data team | none |
| Roles | `/mod/roles` | Moderator and up | none |

Counts come from one new query, `mod.workroomCounts` (section 6). The strip
renders without them and fills in when they arrive, so the frame never waits
on a query.

The help group sits at the strip's right end on wide screens and wraps under
it on narrow ones: "Discord" (external link, `rel="noreferrer"`) and "Report a
bug" (a button opening the dialog in section 5).

The `.mod-tools` nav and the page-local copies of it (queue, launch, my
proposals) go away. `ModGate` stays exactly as it is and wraps the frame, so
the refusal and "Checking your access…" states keep their current look.

### Hint prose

Each page keeps one sentence under its title. The standing paragraphs that
explain the mechanism (how health is computed, what a held book is, why
bookless series exist) move into a `<details class="mod-explainer">` titled
"How this works" at the top of the panel they explain. Closed by default,
remembered per panel in `localStorage` is not worth it; closed is fine.

### Error state

`/mod` (`src/routes/mod.tsx`) gains an `errorComponent` that renders the
frame with a `.notice`: "This page could not load. Reload" and a button that
calls `router.invalidate()`. Today a thrown Convex query falls through to the
root error boundary and loses the navigation.

### Mobile

Under 720px the strip scrolls horizontally with the current tab scrolled into
view on mount, the help group drops to a single line under the strip, and
ledger rows go from a two-column grid (jacket, text) with right-aligned meta
to stacked text with the jacket kept at 32px. Nothing hides; order is
preserved.

## 2. Review queue

### Views and filters

Above the filters, a row of preset chips (`.mod-views`, buttons with
`aria-pressed`). Each sets the filter state; the filters below show the
result, so a preset is never a hidden rule.

| View | Filters it sets |
| --- | --- |
| All | none |
| Import offers | From: import sources, Change kind: Update fields |
| People | From: people |
| Reports | Kind: Report (the new `kind` facet, section 6) |
| Stale | Stale only |

Filters keep every facet. Labels change; values do not.

| Today | Proposed label | Options |
| --- | --- | --- |
| Operation | Change kind | Any, Create records, Update fields, Clear a Human Override |
| Record type | Record | Any, Publisher, Series family, Series, Volume, Edition line, Edition, Release, Release variant, Bundle |
| Author kind | From | Anyone, People, Import sources |
| Author / source | Name | text, placeholder "username or source key" |
| Min age (hours) | Waiting at least | number, suffix "hours" |
| Stale only | Stale only | checkbox |
| With warnings only | With warnings | checkbox |

Filter state lives in the route's search params (`validateSearch` with
optional strings and booleans), so the back button and bookmarks work and a
reviewer can paste a view into Discord. No `localStorage`.

### The row

```
┌──┐  Chainsaw Man, Vol. 12 · paperback release                     [Release]
│▒▒│  Publication date: 2026-03-10 → 2026-03-24
└──┘  Kodansha USA · waiting 11 days · v1 · claimed by @ari     [stale] [1 warning]
```

- The jacket is 36px wide: the stored cover when the record has one, else
  the ISBN jacket for a Release or Bundle, else cloth carrying the title.
  Decorative (`alt=""`); the title beside it is the accessible name.
- Line one is the subject title from `displayInfo`, linked to the proposal
  page. The record-type chip at the right uses the readable labels above.
- Line two is the summary (section 6). Up to three fields, "and 2 more" after.
  Before and after render with `renderFieldValue`, `del` and `ins` as the
  history list already does. For a report, the message with the `[Report]
  Series:` prefix stripped, clamped to two lines. For a human proposal with
  an update, the field summary comes first and the author's comment goes
  under it in muted text, clamped to one line.
- Line three is meta in muted tabular text: who (source name, or `@user
  (Editor)`), waiting time, version, claim. Chips at the end: stale (red),
  warnings count (amber, `title` lists them), and the kind chip only when the
  row is not what the current view already says.
- A stale row keeps the red inset edge it has today.

What leaves the row: the sentence "The importer never overwrites — approve to
accept the source's value, reject to suppress this exact offer." It is the
same on every import row. It stays in the proposal's change comment and the
proposal page shows it, and the Import offers view gets it once as its hint
line.

### Empty, loading, error

- Loading: three skeleton rows (jacket block, two text bars) in the ledger,
  no shimmer under `prefers-reduced-motion`.
- Empty with no filters: "Nothing is waiting for review." Empty with
  filters: "Nothing in review matches this view. [Clear filters]".
- Error: the frame's error component.

### What does not change

Order (oldest first), the proposal page, claims, approvals, rejections,
rebases, the `/mod/proposals` list (it adopts the same row component with
the state chip in the meta line).

## 3. Imports

Three panels under one title, switched by a segmented control
(`.mod-subtabs`, the `.lib-subtabs` look: a pill group, buttons with
`aria-pressed`). The active panel is in the URL (`?panel=sources|held|runs`),
default `sources`. Held books carries its count ("100+" past the cap); Run
history carries none.

### Sources

A ledger with aligned columns on wide screens, stacked under 720px.

| Column | Content |
| --- | --- |
| Source | name in bold, `key` in code below |
| Health | `Healthy` (green chip) or `Unhealthy · 10 failed runs` (red chip, red row edge and tint as today) |
| Schedule | `Runs daily` when enabled, `Paused` (muted chip) when not. One fact, so cadence and the flag read together |
| Last run | status chip, then `Oct 4, 09:37 PM`, then `137 seen · 0 changed · 1 error` in tabular numbers; "Never run" when none |

Health and schedule are separate columns on purpose. Staging has every source
paused and healthy; production may have one unhealthy and running. Neither
state borrows the other's colour. Unhealthy rows sort first, as the query
already orders them.

No enable or pause toggle. That is an Administrator action done through
`importSources.upsert` from the CLI today, and adding a button is a workflow
change this layer does not make. A "How this works" explainer carries the
three-failed-runs rule and the email note.

### Held books

Filters stay (Kind, Source), with source names instead of keys in the select
(the row already maps key to name). Rows:

```
┌──┐  Accel World, Vol. 4 (manga)                  [ISBN or slot taken] [OpenLibrary]
│▒▒│  proposes Accel World, vol. 4 → Accel World        ISBN 9780316304528 · Source record
└──┘  held Oct 7 · last listed Oct 4
      Volume 4 already has a physical Yen Press Release (ISBN 9780316302166).
                                               [Placement Draft] Open the proposal · Prepare placement
```

- Jacket from `isbn13` when present (zero extra reads), cloth otherwise.
- The hold kind and source are chips; "proposes X → matched Series" is one
  line with the Series linked when matched.
- The reason stays visible (it is the thing a reviewer reads), clamped to
  two lines with a "more" toggle when longer.
- The action group is unchanged in behaviour: `Placement` as it exists,
  right-aligned.
- "Load more" stays. A "Group by series" toggle groups the loaded rows
  client-side by matched Series or proposed title, with a note "groups the
  rows loaded so far". Useful because Open Library holds many volumes of one
  series at once; it costs nothing server-side.

The long paragraph about what a held book is becomes the panel's explainer.
The hint under the title becomes: "Books a source lists that an import could
not place. Prepare placement drafts the proposal that places one."

### Run history

As today: source filter (names), status chip, time, duration, seen and
changed, errors in a `details`. Failed runs keep the red edge.

## 4. Catalog gaps

Two panels under one title, same segmented control, `?panel=bookless|unmapped`,
default `bookless`. Each tab shows its count from the rows already loaded
("100+" when `hasMore`).

### Series without books

A search box ("Filter these series") and a sort select (Oldest first,
Title, Most volumes) act on the loaded rows. The server returns 100 oldest;
the panel says so when `hasMore`: "100 of more shown, oldest first. Resolve
these to see the rest."

Row:

```
┌──┐  Eden of Witches                                        7 volumes · ANN entry
│▒▒│  Add a release · Open series · Hide or merge…
└──┘
```

- Cloth jacket with the title (series have no ISBN; no extra reads).
- "ANN entry" stays the external link it is.
- "Add a release" links to `/mod/propose-new/{publicId}`, the wizard that
  creates a Volume, Edition and Release at once. That is the rescue action
  the hint paragraph describes in prose today, and it exists for every data
  team member.
- "Open series" links to the public page, which shows what exists.
- "Hide or merge…" links to `/mod/manage/series/{publicId}` and shows for
  Moderators only. Editors see the first two.

### Unmapped packaging

Row:

```
┌──┐  Vinland Saga Deluxe Edition 3 · Kodansha USA · 9781646519 · in Vinland Saga
│▒▒│  Collects volumes [ 5 ▾ ] to [ 6 ▾ ]  Why: [publisher page: collects vols. 5–6 ]  [Map]
└──┘
```

- Jacket from the first ISBN when present.
- The inline map form stays for Moderators, with labels "Collects volumes …
  to …" and "Why" (required, becomes the Revision's rationale, as the
  mutation demands). Editors see the row without the form and a muted
  "Moderators map these" in the panel hint.
- Errors render under the form, as today.

## 5. Discord and bug reports

### Footer, everyone

A third footer column, "Community", with "Discord" linking to the invite
(`target="_blank" rel="noreferrer"`) and "Report a problem" linking to
`/about-the-data#corrections`. The About page's Corrections paragraph adds
one sentence: "You can also ask in our Discord." The invite URL lives in one
constant, `DISCORD_INVITE_URL` in `src/lib/community.ts`, with the dialog
component beside it.

### Workroom help group, data team

"Discord" and "Report a bug". The button opens a native `<dialog>`:

```
Report a bug
Copy this, fill in the three questions, and paste it into the MangaDB Discord's channel for bugs and feedback.

┌─────────────────────────────────────────────┐
│ Page: /mod/queue?view=imports               │
│ Role: moderator · Theme: dark · 1440×900    │
│ Browser: Firefox 148 on Linux               │
│ When: 2026-10-08 14:32 UTC                  │
│ Proposal: k57…                              │
│                                             │
│ What happened:                              │
│ What I expected:                            │
│ Steps:                                      │
└─────────────────────────────────────────────┘
[Copy]  [Open Discord]                 [Close]
```

- The block is a `<pre>` built from `location`, the viewer's role, the
  `data-theme` attribute, `innerWidth × innerHeight`, a short `userAgent`
  reduction, the time, and the proposal id when the route has one. No
  username, no email, nothing the person did not already see on screen.
- Copy uses `navigator.clipboard.writeText` and announces "Copied" in an
  `aria-live="polite"` span; when the clipboard API is missing the text is
  selected so Ctrl-C works.
- Escape closes, focus returns to the button, the backdrop uses `--scrim`.
- No channel name is hard-coded past the one line of guidance; the server's
  layout is the user's business, and the dialog only says where to paste.

Nothing joins, posts, or configures anything.

## 6. API and component plan

### `proposals.reviewQueue`: two new fields per row

```ts
subject: {
  recordType: RecordType;             // of the first op with a ref, or "series" for a report
  title: string;                      // displayInfo(...).title, "(missing record)" when gone
  page: { entity, publicId } | null;  // displayInfo(...).backLink, for the public link
  isbn13: string | null;              // Release or Bundle isbn13, for the ISBN jacket
  coverUrl: string | null;            // stored coverImage via ctx.storage.getUrl
  mature: boolean;                    // Mature Series, or observation evidence rates it 18+
} | null;
summary: {
  kind: "report" | "importOffer" | "importCreation" | "newRecords" | "fieldChange" | "sensitive";
  fields: Array<{ label: string; before: unknown; after: unknown }>; // ≤3, from the first update op
  moreFields: number;
  creates: string[];                  // readable record types of create ops, deduped, in order
  clears: string[];                   // field labels of clearOverride ops
};
```

`kind` is a pure function of `ops` and `author`: a source author with only
update ops is `importOffer`; a source author with a create op is
`importCreation`; a user author with zero ops is `report`; any merge, split,
hide, restore, lock or unlock is `sensitive`; a user author with a create op
is `newRecords`; the rest is `fieldChange`. Field labels come from
`fieldDescriptor`. Put it in `convex/lib/queueSummary.ts` and test it in
isolation.

`subject` costs one `getCanonical` and one `displayInfo` for the first ref
op, plus one `storage.getUrl` when a cover is stored. For a report (zero
ops) it parses the `/series/{publicId}` evidence URL and reads the series by
`by_publicId`. The query already does `getCanonical` and a latest-Revision
read per op for staleness, so this is at most a doubling per row on a list
the code comments describe as tens of rows. If the queue ever grows past
that, cap the scan with `take(500)` and say "oldest 500 shown". Not now.

One new filter arg, `kind`, matched against `summary.kind` in the same
in-memory filter the others use.

### `mod.workroomCounts`: one new query

```ts
// convex/workroom.ts, requireDataTeam
{ inReview: number /* ≤101 */, heldBooks: number /* ≤101 */, unhealthySources: number, pausedSources: number }
```

`inReview` is `proposals.by_state("inReview").take(101).length`;
`heldBooks` is `placementHolds.by_held.take(101).length`; the source counts
come from the `approvedSources` table, which holds seven rows. Around 210
documents at most. The UI shows 101 as "100+". Comments keep their own
`queueCounts`.

### Unchanged queries

`imports.dashboard`, `imports.recentRuns`, `imports.heldBooks`,
`packaging.unmappedQueue`, `packaging.booklessQueue`, `proposals.myProposals`,
`proposals.proposalDetail`. Every jacket on those pages comes from fields the
rows already carry (`isbn13`, `isbns[0]`, title).

### Front end

| File | Change |
| --- | --- |
| `src/lib/modShell.tsx` | `ModWorkroom`, the tab strip, `ModSubtabs`, `Explainer`, `WorklistSkeleton`, `WorkRow` (jacket + three lines + aside) |
| `src/lib/community.ts(x)` | `DISCORD_INVITE_URL`, `BugReportDialog` |
| `src/lib/moderation.tsx` | drop `ModTools` and `MOD_TOOLS`; keep everything else |
| `src/routes/mod.tsx` | `errorComponent` rendering the frame with a reload notice |
| `src/routes/mod.queue.tsx` | `validateSearch`, views, labels, `WorkRow` |
| `src/routes/mod.proposals.tsx` | `WorkRow` with the state chip |
| `src/routes/mod.imports.tsx` | panels, sources ledger, held rows, group toggle |
| `src/routes/mod.packaging.tsx` | panels, search and sort, row actions, `ModGate` instead of its hand-rolled gate |
| `src/routes/mod.launch.tsx`, `mod.comments.tsx`, `mod.roles.tsx`, `mod.proposal.$id.tsx` | wrap in the frame; no other change |
| `src/routes/__root.tsx` | Community footer column |
| `src/routes/about-the-data.tsx` | one sentence, `id="corrections"` on the heading |
| `src/styles/mod.css` | new `.mod-workroom`, `.mod-nav`, `.mod-subtabs`, `.mod-views`, `.worklist`, `.work-row`, `.mod-explainer`, `.bug-report` rules; delete `.mod-tools` |

CSS stays scoped under those new class names. `.mod-edit-form`,
`.cover-section`, `.description-section`, `.queue-filters`, the proposal
page panels and every public page rule are not touched. The `Cover`
component is reused as is with a `work-jacket` class that sets width.

## 7. Roles

| Can | Editor | Moderator | Administrator |
| --- | --- | --- | --- |
| See the frame, queue, imports, gaps, launch, comments | yes | yes | yes |
| Decide a proposal, map packaging, hide or merge | no (links hidden) | yes | yes |
| See the Roles tab | no | yes | yes |
| Pause a source, bootstrap mode | no | no (launch controls say so) | CLI and launch page as today |
| Open the bug dialog | yes | yes | yes |

Role checks in the UI stay cosmetic. Every mutation re-checks on the server
as it does now.

## 8. Accessibility

- The tab strip is links with `aria-current`; the segmented controls are
  buttons with `aria-pressed`; filters are native `select`, `input`, and
  checkboxes with visible labels.
- Each ledger is an `<ol>` and each row's title is its one link. Actions are
  buttons or links with their own text, never icon-only.
- State is never colour alone: every chip has text, the red row edge
  accompanies a "stale" or "Unhealthy" chip.
- Jackets are decorative (`alt=""`).
- Focus rings use the shell's `:focus-visible` rule unchanged. The dialog
  traps focus natively and returns it on close.
- Skeletons and the segmented switch respect `prefers-reduced-motion`.

## 9. Priority boundary

Build in this PR:

1. `ModWorkroom`, tab strip, counts query, error component, footer and About
   change, bug dialog.
2. Queue: summary and subject fields, `kind` filter, URL search state, views,
   labels, `WorkRow`.
3. Imports: three panels, sources ledger with separate health and schedule,
   held rows with jackets and the explainer.
4. Catalog gaps: two panels, search and sort, row actions.
5. Wrap launch, comments, roles, proposal, my proposals in the frame.

Leave for a follow-up:

- Proposal page title showing the subject ("Proposal · Chainsaw Man, Vol.
  12"); the data is already in `proposalDetail`.
- Held books "Group by series".
- A jacket on report rows (needs the series read described above).
- Any Administrator toggle for pausing a source.
- Tidying the Launch page body.

Not in scope at all: bulk approvals, changing claim or stale semantics,
server-side search over gaps, counts that need a full scan, restyling public
pages or the edit forms.

## 10. Acceptance checks

Code and data:

- `npm run format`, `npm run check`, `npm run typecheck`, `npm run test` pass.
- `convex/lib/queueSummary.test.ts` covers: an import conflict on one field
  yields `importOffer` with one labeled field; a `[Report]` proposal yields
  `report`; a user create proposal yields `newRecords` with `creates` in
  order; a merge yields `sensitive`.
- `convex/proposals.test.ts` asserts `subject.title` for a Release update
  matches `displayInfo`, `subject.isbn13` is the Release's, and a missing
  record gives "(missing record)" without throwing.
- `workroomCounts` returns 101 at most for `inReview` and `heldBooks`, and
  refuses a signed-in reader without a data-team role.
- No new `.collect()` over `proposals`, `placementHolds`, `importRuns`,
  `series`, `editions` or `volumes`.

Screens, checked in both themes at 1280px and 390px:

- Every `/mod` page shows the same strip; the current tab is underlined; the
  queue count matches the unfiltered queue length (or "100+").
- A queue row for an import conflict shows the record title, the field with
  before and after, the source name, and no "importer never overwrites"
  sentence. The proposal page still shows that sentence.
- Changing a filter changes the URL; reloading keeps the view; "Clear
  filters" appears only when filters are set.
- Imports: a paused healthy source shows a green Health chip and a muted
  Paused chip; an unhealthy source shows a red chip, the failed-run count,
  and the red edge; the two never appear in the same chip.
- Held books: a row with an ISBN shows a jacket or cloth, never a broken
  image; "Prepare placement" behaves exactly as before, including the
  refusal message.
- Catalog gaps: an Editor sees "Add a release" and "Open series" but not
  "Hide or merge…"; a Moderator sees all three; the map form posts the same
  arguments as before.
- The footer shows "Discord" on the home page signed out; the workroom
  header shows "Discord" and "Report a bug"; the dialog's Copy puts the
  context block on the clipboard and the text starts with `Page:`.
- Tab through a queue row: title link, then the chips are skipped (not
  focusable), then the next row. Tab through the dialog: Copy, Open Discord,
  Close, then it wraps.
- `/mod/edit/...` and `/mod/propose/...` forms look identical to before the
  change, including the Cover and Description sections.
