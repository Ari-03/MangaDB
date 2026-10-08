# Cover upload and description editing: design brief

Written 2026-10-08 against the source read in [the editing baseline](mangadb-editing-baseline.md). This is the decision record the implementer works from. It changes no code. The companion concept page at `/tmp/mangadb-catalog-editing-design.html` shows the three screens in both themes.

## Decisions in one screen

1. The heavy forms stay where they are. `/mod/edit` and `/mod/propose` each gain a **Cover** section (Release and Bundle) and a richer **Description** section (Series, Volume, Release, Bundle). No new route, no modal editor, no third write path.
2. Public pages get two small role-gated links next to the content they correct: **Change cover** under the art and **Edit description** under the blurb. Each resolves the owning record first and deep-links to the matching section of the form. Where the text is inherited the link turns into a two-choice note so nobody edits the wrong record.
3. Every displayed blurb ends with a source footer, `Source: Kodansha USA`, linked to the page the text came from, when the record's history knows that. Pre-history text and original prose show nothing. Nothing is inferred from a hostname.
4. A cover change is a registry field, `coverImage`, on Release and Bundle, kind `image`. It travels through the same `update` op, `applyUpdate`, Revision and History as every other field. Covers are always a Human Override once a person sets or removes one, because the importer leaves no Revision to learn that from.
5. A description's provenance is the Revision's existing `citation`, now written by human edits too. "Use this description" fills the textarea and the citation together, from the blurb's observation. A pasted blurb needs a source name and URL before it gets a footer. "Original prose" is a stated choice, not a default.
6. Blobs referenced by any Revision are never deleted. The importer's `attachCover` refuses a Release whose `coverImage` is overridden and never drops a blob that a Revision names.

## 1. Public pages

### Placement

The links are a second `.mod-edit-link` row placed right beside the thing, not at the page foot where "Edit this record" lives today. Same typography as `.mod-edit-link` (0.82rem, muted, underlined on hover) so they read as maintenance, not as a product feature. Readers without a data-team role see nothing.

| Page | Under the art | Under the blurb |
| --- | --- | --- |
| Edition | `Change cover` | `Edit description` or the inherited-text note |
| Volume | `Change cover` | `Edit description` or the inherited-text note |
| Series | `Change cover` | `Edit synopsis` |
| Bundle | `Change cover` | `Edit description` |

The Edition page also adds `Change cover` to each Release row's right column, under the collection controls, because a Release has no page and that row is the only place its own art is addressable.

### What each link targets

The page queries already know the owning record when they resolve a description or a cover. They return it, and the UI never guesses:

- `description` grows `owner: { type: "series" | "volume" | "release", key: string, label: string }` and `attribution: { sourceName, url: string | null } | null`. `label` is what the link says, for example "the Kodansha paperback (ISBN 978…)".
- `coverUrl` grows a sibling `coverOwner: { type: "release" | "releaseBundle", key, label, editionPublicId? } | null`. Null means the shown art is ISBN-derived or cloth and no record stores it.

Cover link rules:

- Bundle page: targets the Bundle. One link.
- Edition page, stored cover: targets the owning Release. Link text `Change cover`, title attribute names the Release.
- Edition page, no stored cover: link text `Add a cover`, targets the Release that the jacket rule would front, which is the earliest dated physical Release, else the earliest dated one. The form's Cover section then explains why that Release and lists the siblings to switch to.
- Volume and Series pages: the representative cover comes from one Edition. The link goes to that Edition page's `#cover` anchor, text `Change cover` with the title "Edit on the {publisher} edition". Two hops, never a wrong record. No Release chooser on Series or Volume pages.
- Edition with zero Releases: no link. The form could not target anything.

Description link rules, by where the text came from:

| Shown on | `description.source` | What renders |
| --- | --- | --- |
| Edition | release | `Edit description` to `/mod/edit/release/{id}#description` |
| Edition (one whole Volume) | volume | Note: "This is the volume's synopsis. [Edit the volume synopsis] or [write a description for this book]." The second link targets the fronting Release. |
| Edition (omnibus or any) | series | Note: "This is the series synopsis. [Edit the series synopsis] or [write a description for this book]." Never offers the Volume. |
| Edition | none | `Write a description` to the fronting Release. |
| Volume | volume | `Edit synopsis` to `/mod/edit/volume/{id}#description` |
| Volume | edition | Note: "Borrowed from the {publisher} edition. [Edit that release's description] or [write a volume synopsis]." |
| Volume | series | Note: "This is the series synopsis. [Edit the series synopsis] or [write a volume synopsis]." |
| Series | own | `Edit synopsis` |
| Bundle | own | `Edit description` |

Editors get the same links pointed at `/mod/propose/...` with the same anchors, exactly as `ModEditLink` already branches by role. One component, `ContextEditLink`, takes the owner and the anchor and does the role branch.

### Source footer

Rendered after every blurb paragraph on the four pages, inside the existing `.detail-blurb`, `.synopsis` or `.series-synopsis` block:

```html
<p class="blurb-source">Source: <a href="https://kodansha.us/..." rel="noreferrer">Kodansha USA</a></p>
```

Style: `.note` size and colour (0.84rem, `--text-mute`), 6px above, link in `--accent` like `.revision-citation a`. When `url` is null the name renders as plain text. When `attribution` is null the paragraph is absent, not empty.

How the server fills `attribution`, in `catalogPages.ts` where the description is resolved, for the owning record's field only:

1. Take the newest Revision whose `changes` touch the field (`latestTouch`, already in `moderation.ts`).
2. No such Revision: null. This covers bootstrap text that predates history.
3. The Revision has `citation`: use it as is.
4. The Revision's author is a source and it has no citation: `sourceName` is the registry row's `publicName`, falling back to `name`; `url` is the `snapshot.url` of that source's linked observation for the record, if it still exists, else null. This is recorded provenance, not a guess.
5. A human author with no citation: null. The person chose original prose or predates the citation control.

Add `publicName` to the source registry so the footer can say "Anime News Network" and "Penguin Random House" where the internal names say "Encyclopedia" and "API". Label values to set: Seven Seas Entertainment, Kodansha USA, Penguin Random House, Anime News Network, OpenLibrary, Yen Press.

The Bundle page and Series page synopsis blocks follow the same rule with their own records as owner.

## 2. The Cover section of the form

Lives at `#cover` on `/mod/edit/release/{id}`, `/mod/edit/releaseBundle/{id}` and the two `/mod/propose` twins. It is a `.mod-panel` placed above the field list so the deep link lands on it with the record title still visible. Heading `Cover`, then one hint line that names the context: "Art for the Kodansha paperback, ISBN 9781632364210, published Mar 2017. The edition and series pages show this jacket when it is the earliest dated release with art." On a Bundle: "Art for this box set."

### Layout

Two columns on desktop, stacked under 720px.

Left, **Current**: the cover at `--cover-w` (168px) in the real `.cover` frame, which crops to 2:3 with `object-fit: cover`, so the moderator sees exactly what the shelf shows. Under it one line: "Stored art, from kodansha.us" or "No stored art. The shelf shows the jacket fetched for ISBN 978… when one exists, else the cloth placeholder." A `Human Override` chip when the field is overridden.

Right, **Replacement**: a drop zone the same size as the frame. It is a `<label>` wrapping a real `<input type="file" accept="image/jpeg,image/png,image/webp">`, so keyboard users tab to it and press Enter. Inside: "Drop a JPEG, PNG or WebP here, choose a file, or paste an image. Up to 10 MB." Dragging over it tints the border `--accent`. Paste is a document-level `paste` listener active only while the section is focused within. After a file is chosen the zone becomes the new cover in the same `.cover` frame, with a `Replace file` text button and a line of facts: `1400 × 2100 px · 612 KB · JPEG`. If the aspect ratio is not within 5% of 2:3 add "Shelf crop shown; the file is kept whole."

Under the frames, a row of **Reuse related art**: thumbnails at 64px of every active sibling Release in the Edition that stores a different blob, plus, on a Release inside a Bundle, the Bundle's art. Each is a `<button>` with `aria-label="Use the cover from the Kodansha ebook"`. Picking one fills the Replacement frame and sets the value to that blob and its source. Hidden entirely when no sibling has art.

Then the fields:

- **Source** (text input, optional): prefilled with the reuse source when art was reused. Hint: "Where this art came from, for the record. Leave empty for a scan you made." Stored as `coverImage.attribution`; the URL, when it is one, also as `sourceUrl`.
- **Mature art** notice, only when the Series is not Mature: "If this jacket is 18+, set the series content rating too; covers follow the series rating, not the file." Link to the Series form. No new field.
- **Remove cover** (a plain `.btn`, not a checkbox): switches the Replacement frame to the cloth placeholder with the words "No stored art" and sets the value to `null`. Under it, always visible in this state: "After saving, the shelf shows the jacket fetched for ISBN 978… when one exists, else the cloth placeholder. Imports will not attach art again until the Human Override on Cover is cleared." The button becomes `Keep current cover` to undo.

The section shares the form's Change comment and the single Save button. The cover is one more dirty field in `draftChanges`. No separate submit.

### Upload mechanics

1. Choosing a file validates client-side first: type in the three allowed, size 2 KB to 10 MB, decoded dimensions at least 300 px wide. Failures show in a `.form-error` under the zone with `role="alert"` and the frame stays on the current art.
2. The client calls a new `moderation.coverUploadUrl` mutation (data team only) which returns `ctx.storage.generateUploadUrl()` and inserts a `coverUploads` row `{ storageId?: pending, uploaderId, createdAt }`. After the POST, the client reports the storageId back through `moderation.coverUploaded`, which records it on the row and checks `contentType` and `size` server-side with the same limits plus `MIN_COVER_BYTES`.
3. The upload runs while the moderator types the reason. The Save button is disabled with "Uploading…" until the storageId arrives. A failed upload shows "Upload failed. Nothing was changed. Try again." and leaves the chosen file so a retry needs one click.
4. The field value is `{ storageId, sourceUrl?, attribution? }` or `null`. `normalizeFieldValue` for kind `image` checks the shape only; `applyUpdate` verifies the storage object exists, is `image/jpeg`, `image/png` or `image/webp`, and is at least `MIN_COVER_BYTES`. On a proposal, submission runs the same check so a reviewer never approves a dead blob.
5. A daily cron deletes `coverUploads` rows older than 24 hours whose blob is not on any Release or Bundle, in any Revision, or in any Draft or In Review proposal version. The uploader's abandoned files cost nothing after that.

### History and review

- `renderFieldValue` gets a sibling, `renderFieldChange`, that recognises `{ storageId }` values on `coverImage` and renders two 48px `.cover` frames, before and after, with cloth for null. History and the proposal page use it. `Source: kodansha.us` appears under the after frame when `attribution` is set.
- The review queue row for a cover proposal says "Cover" in its field list like any other field. Nothing new.
- Human Override on `coverImage` is set on every human save of the field, including removal, regardless of whether an import-authored Revision exists. Clearing it works through the existing Clear control, and the clear preview says "imports may attach art again".
- `imports.attachCover` returns `refused: "cover is a Human Override"` when `overriddenFields` includes `coverImage`. Its `drop` helper additionally keeps any blob that appears in a `coverImage` value in the record's own Revisions. That read is bounded by the record's history.

### Error and empty states

| State | What shows |
| --- | --- |
| Record locked or hidden | The section renders the Current frame only and the existing notice. No zone. |
| Mature Series and viewer not opted in | The moderator is editing; show the art. Add "Hidden from readers who have not opted in." |
| Blob missing (deleted upstream) | Current frame shows cloth with "Stored art is missing. Save a replacement or remove the cover." |
| Dropped a GIF, SVG or PDF | "Only JPEG, PNG or WebP. GIF and SVG are not shelved." |
| File over 10 MB | "Over 10 MB. Export a smaller JPEG." |
| Under 300 px wide | "Too small to shelve (needs 300 px wide)." |
| Record changed meanwhile | The form's existing stale notice. The chosen file and its storageId survive Reload latest; only field values reset. |
| Editor's proposal | Same section; the button reads Submit for review; the staged blob is held by the proposal. |

## 3. The Description section of the form

Lives at `#description` on the Series, Volume, Release and Bundle forms. The `textarea` kind stays, with `editorial: true` deciding that `FieldInput` renders `DescriptionField` instead of the bare textarea. It is the one editorial textarea per form today, so this is a wrapper, not a new registry kind.

### Layout

One `.mod-panel`, heading `Description` (or `Series synopsis`, `Volume synopsis`), with a context line that says where the text shows:

- Release: "Shows on the {edition} page and on volume pages when this release outranks the edition's other releases: a Human Override first, then the current publisher's, physical, earliest dated, longest."
- Volume: "Shows on the volume page and on a single-volume edition's page when that edition's releases have no description."
- Series: "Shows on the series page, and on volume and edition pages that have no text of their own, labelled About {title}."
- Bundle: "Shows on the box set page."

Then, left to right on desktop:

1. **Editor**: the textarea, 8 rows, `white-space: pre-line` preview under it that updates as the moderator types, in `.blurb-text` styling at 62ch so the paragraph breaks and length read as the page will show them. A character count at the right of the label. The preview carries the live source footer so the moderator sees what readers will see.
2. **Source** (a fieldset with radios, `legend` "Source of this text"):
   - `Keep: Kodansha USA (kodansha.us/…)`. Present only when the field has a current attribution. Selected by default when the moderator edits existing text. A light copy-edit keeps its source.
   - `From a source listed below`. Selected automatically when Use this description is pressed, with the blurb's source named beside it.
   - `Another page`: reveals Source name and Source URL inputs, both required to pick this option. Name is free text ("Kodansha USA", "Publisher's back cover"). The URL must be `https`.
   - `Original prose, no external source`. The footer then shows nothing. This is the default only when the field is empty and no blurb has been chosen.

The source choice becomes the `citation` on the Revision: `{ sourceName, url }`. Direct edits pass it to `submitDirectEdit`; proposals carry it on the `update` op, and `applyUpdate` writes it on approval. One citation per op; it describes the editorial field in that op. A proposal that changes only facts carries none.

"Use this description" also appends `{ kind: "observation", observationId }` to the proposal evidence so the reviewer sees the blurb it came from. Direct edits store it in `evidence` as well, replacing today's empty list for this one case.

### Source descriptions, moved and given a button

The `SourceDescriptions` panel moves inside the Description section as a list under the editor, titled `From the sources`. Each entry keeps its chips (current, withdrawn at source, recorded only), its seen date and its View link, and gains one button at the right of its meta row:

- `Use this description` fills the textarea, marks the field dirty, selects the `From a source listed below` radio with that blurb's name and URL, and scrolls the editor into view. Nothing is saved.
- If the textarea already holds unsaved edits, the button first asks inline: "Replace your unsaved text?" with Replace and Keep mine. No browser `confirm`.
- The entry whose text equals the current field value shows `In use` instead of a button, disabled.
- A withdrawn blurb still offers the button; the hint beside it says "Withdrawn at the source; cite it only if you have checked it still describes this book."

The panel also serves the Volume form and the Bundle form, where there are no source observations: it says "No sources offer text for this record" and leaves the Another page and Original prose options. The `sourceBlurbs` query widens its `ref.type` to the four types; Volume and Bundle return an empty list without reading observations.

Editors see the same panel on `/mod/propose`. `sourceBlurbs` currently requires a Moderator; relax it to the data team so the picker works for Editors. The blurbs are the sources' own public text, so nothing private leaks.

### Inherited text, stated at the top

When the moderator arrived from an inherited blurb, the deep link carries `?from=edition:123`. The section opens with one notice naming the choice they made: "You are editing the volume synopsis. The Kodansha omnibus page shows it only because that edition collects this one volume whole." This is the omnibus guard made visible: the Edition page never offers the Volume link for an omnibus, and the form names the owner it landed on.

### Error and empty states

| State | What shows |
| --- | --- |
| Another page chosen, URL empty | Inline error under the URL: "Add the page the text came from, or choose Original prose." Save disabled. |
| Blurb identical to current text | `In use`, disabled. |
| Over 50 source records | The existing "Showing the first 50" hint stays. |
| Field cleared to empty | Source radios disabled; the preview says "No description. The page falls back to the volume or series text." |
| Stale record | The existing notice. The chosen citation survives Reload latest. |

## 4. Accessibility

- Every control is a native element: `<input type="file">` inside a `<label>`, radios in a `fieldset` with a `legend`, buttons for Use, Reuse and Remove. No div buttons.
- Drop zone and paste are additions, never the only way. The zone's label text names all three methods.
- The upload state line and errors are in one `aria-live="polite"` region per section. Errors also carry `role="alert"`.
- Cover previews have alt text: "Current cover of {title}" and "Replacement cover, 1400 by 2100 pixels". Thumbnails in Reuse are buttons with `aria-label` naming the sibling.
- Deep-link anchors `#cover` and `#description` move focus to the section heading (`tabindex="-1"`) so screen readers land where the link said.
- Colour never carries the only meaning: the reuse selection shows a 2px `--accent` ring and the word Selected.
- Contrast: all text uses `--text`, `--text-dim` or `--text-mute` on `--surface` or `--surface-2`, which already pass in both themes. Buttons keep the shell's `.btn` and `.btn-primary`.

## 5. Backend changes, in order

1. `moderationFields.ts`: kind `image`; `coverImage` on `release` and `releaseBundle` with `help` text. `normalizeFieldValue` for the shape. `factualOverrides` treats `coverImage` as editorial, so a cover does not stop matching.
2. `schema.ts`: `coverUploads` table; `publicName` on the import source rows; `citation` accepted on the `update` op.
3. `moderation.ts`: `coverUploadUrl`, `coverUploaded`; `submitDirectEdit` takes `citation` and `evidence`; `applyUpdate` verifies image blobs, writes `citation`, forces the override on `coverImage`; `editForm` returns the cover's current URL, the sibling art list and the current attribution; `sourceBlurbs` widens to the data team and four types.
4. `proposals.ts`: `checkEvidence` and `submitProposal` verify staged blobs; approval passes `citation` through.
5. `imports.ts`: `attachCover` refuses overridden covers and keeps Revision-referenced blobs.
6. `catalogPages.ts`: `owner` and `attribution` on descriptions; `coverOwner` beside `coverUrl`.
7. `crons.ts`: the daily `coverUploads` sweep.
8. Front end: `DescriptionField`, `CoverField`, `ContextEditLink`, `BlurbSource`, `renderFieldChange`; the four pages; `mod.css` additions under a `/* ---------- cover + description ---------- */` block.

Tests to add, each a single file beside its subject: `coverField.test.ts` (normalize and verify), `attachCover` refusal and blob retention in `imports.test.ts`, `attribution` resolution in `catalogPages.test.ts`, `citation` round trip in `moderation.test.ts` and `proposals.test.ts`.

## 6. Out of scope here

Cropping, image URL import, restoring a cover from History with one click, Markdown, and the worklist of missing covers. The History thumbnails from section 2 make a later Restore cover action a small addition.
