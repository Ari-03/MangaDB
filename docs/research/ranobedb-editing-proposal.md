# Proposal for easier catalog editing

Reviewed on 2026-10-08. This proposes improvements to MangaDB; it does not implement them.

## Recommendation

Start with **cover replacement and contextual description editing**. Both should use one small edit panel opened from the content being corrected, with a preview, source citation, change reason and the existing role-dependent save path. Moderators and Administrators save an approved change; Editors submit a proposal.

MangaDB already has direct editing, proposals, public revisions, a review queue, locks, merge/split tools and protection for human corrections. The work is to make routine corrections easier and add the missing cover operation. See the [source baseline](mangadb-editing-baseline.md) and [moderation guide](../moderation.md).

## What I inspected

I used the shared T3 browser to explore RanobeDB's Series, Book and Release pages, record history, editing guidelines and recent changes. I opened the record options menus and applied the recent-changes filter that hides automated changes. Edit redirected to login. A revision detail page encountered Cloudflare verification, so I did not inspect its rendered diff or submit changes.

I also opened MangaDB and inspected its public Chainsaw Man Series page. Its admin forms were checked in repository source, not in an authenticated session. The shared browser disconnected before the rest of that comparison completed. No catalog data was changed.

For gated RanobeDB features, I examined its first-party source at commit `7fbc006fce3d5e86d7e2fb261fc55d9b85f0d23f`. Source inspection establishes what that checkout implements; it does not establish that every feature is deployed or works in production.

## Useful patterns in RanobeDB

| Pattern | Evidence | Implication for MangaDB |
| --- | --- | --- |
| Edit and History beside the record title | Observed on [Series](https://ranobedb.org/series/3343), [Book](https://ranobedb.org/book/12040) and [Release](https://ranobedb.org/release/23700) pages | Move common moderator actions closer to the content being corrected. MangaDB already has record edit links. |
| Covers belong to specific Releases | [Release guidelines](https://ranobedb.org/editing-guidelines/releases); [Book form source](https://github.com/Blastose/ranobedb/blob/7fbc006fce3d5e86d7e2fb261fc55d9b85f0d23f/src/lib/components/form/book/BookForm.svelte) | Identify the underlying Release when an Edition or Series displays its art. |
| Upload, preview, remove and reuse existing art | Source-confirmed [cover input](https://github.com/Blastose/ranobedb/blob/7fbc006fce3d5e86d7e2fb261fc55d9b85f0d23f/src/lib/components/form/release/ReleaseImageInput.svelte) supports JPEG, PNG and WebP, a 10 MB label, related-release thumbnails, image IDs and an NSFW flag | Add a visual cover picker. Related-release thumbnails are more approachable than asking for storage IDs. Upload submission was not tested. |
| Markdown editing with rendered preview | Source-confirmed [description input](https://github.com/Blastose/ranobedb/blob/7fbc006fce3d5e86d7e2fb261fc55d9b85f0d23f/src/lib/components/form/TextareaFieldMarkdown.svelte); [guidelines](https://ranobedb.org/editing-guidelines) request attribution for external descriptions | Give descriptions a rendered preview and a separate source field. Markdown support itself can wait. |
| Revisions, summaries and revert entry points | Observed [record history](https://ranobedb.org/series/3343/history) includes a revert entry; source-confirmed [revision controls](https://github.com/Blastose/ranobedb/blob/7fbc006fce3d5e86d7e2fb261fc55d9b85f0d23f/src/lib/components/history/RevisionInfo.svelte) open the editor with an earlier revision | Add selective field restoration to MangaDB's existing history. |
| Filter out bot activity | Observed and tried on [recent changes](https://ranobedb.org/history?change_type=all&visibility=all&hide_automated=on) | Offer an approved-changes view that separates human corrections from imports. |
| Searchable relationships and book ordering | Source-confirmed [relationship picker](https://github.com/Blastose/ranobedb/blob/7fbc006fce3d5e86d7e2fb261fc55d9b85f0d23f/src/lib/components/form/series/SeriesRelInput.svelte), [drag/up/down ordering](https://github.com/Blastose/ranobedb/blob/7fbc006fce3d5e86d7e2fb261fc55d9b85f0d23f/src/lib/components/form/series/BookDragDrop.svelte); [series guidelines](https://ranobedb.org/editing-guidelines/series) describe automatic reverse relations | Use visual pickers in dedicated catalog repair tools. Preserve MangaDB's identity and ordering rules rather than copying RanobeDB's model. |
| Copy a record into an add form | Observed Copy and Copy as book in record menus; [copy route source](https://github.com/Blastose/ranobedb/blob/7fbc006fce3d5e86d7e2fb261fc55d9b85f0d23f/src/routes/release/%5Bid%3Dinteger%5D/copy/%2Bpage.server.ts) | Prefill a new related Release proposal while requiring its distinct ISBN, format and publication facts. |

## First release

### 1. Replace the cover where you see it

Add a role-visible **Change cover** action beside displayed art and on each Release row. Open a panel that names the target, publisher, format and ISBN. An Edition or Series cover action must resolve its displayed cover to the owning Release; Bundle art targets the Bundle. If there is a choice of Releases, ask the moderator to choose one.

Accept JPEG, PNG and WebP through a file picker, drag-and-drop or clipboard paste. This also lets an assistant use a file the administrator supplies. Show the current and replacement images, dimensions and a shelf-sized preview. Start with uncropped cover art; optional cropping can follow if there is a demonstrated need.

Offer **Upload a file**, **Reuse related cover**, and **Remove cover**. An image URL import is a later convenience, because local file upload covers the main request. Reusing art changes only the selected record's reference, never every record sharing that image. Preserve a source URL when available and the reason for replacement. Show whether a maturity change is needed using MangaDB's existing rules.

Done means a supplied PNG or JPEG can replace the correct Release or Bundle art, appear in every view that derives art from that record, survive the next import, and be restored from history. Editors can propose the same operation for review.

### 2. Edit the description currently displayed

Add **Edit description** beside the public text. Show where the text comes from: Series synopsis, Volume synopsis or a specific Release description. On an inherited description, distinguish **Edit the source text** from **Write a description for this book**. Explain which other views will change before saving. An omnibus must not accidentally overwrite one Volume's synopsis.

Move existing source blurbs into this panel and add **Use this description**. That action fills the draft and carries the source URL or Source Observation into its evidence. It does not save immediately. Keep a field for pasting a newly found description and its source, then show the rendered result and changed text. Markdown can be considered separately; a clear plain-text preview solves the immediate problem.

Done means a moderator can choose a known publisher blurb without manual copying, see the exact destination and citation, and save it as a human correction protected from import replacement. Original editorial prose still follows the existing rule that it needs no factual evidence.

### 3. Preview the change and preserve the draft

Use the same panel for small corrections to dates, ISBNs, titles, binding and price. Before saving, list changed fields, current and proposed values, the affected record and the change reason. Retain server validation, locks and Revision checks.

Save a recoverable draft and warn before leaving it. When another person changes the record, preserve the proposed values and show current versus draft values. Let the moderator reapply chosen fields to an explicitly refreshed base. Never silently overwrite a newer edit. The current direct-edit form tells the user to reload and discard unsaved work.

These panels should share the existing field registry and proposal write path. A second set of validation rules would make the simple editing flow harder to maintain.

## Follow-up releases

4. **Restore individual values from history.** Offer Restore this description or Restore this cover with a preview and reason. Record the restoration as a new Revision. Prefer selected fields over whole-record rewind, so unrelated later corrections survive.
5. **A correction worklist.** Add missing-cover and missing-description filters, followed by reviewed broken-image checks, existing reports and import conflicts. Link each row to the relevant edit panel. Reuse the current review queue and claims; add a separate approved-changes feed with an option to hide imports.
6. **Dedicated relationship repair.** Add searchable pickers for author credits and Series relations, followed by explicit coverage and placement corrections. Show both affected records and the impact. Preserve ISBN ownership, collection references and coverage identities. Existing placement, packaging, merge and reading-path tools remain the starting point.
7. **Prefill related-record creation.** From a Release, open the existing creation/proposal flow with reusable metadata. Require the new identity fields and show likely duplicates. Defer bulk editing until the single-record flows work well.

## Implementation constraints

Cover uploads require backend work. The current importer attachment operation patches art outside revision history and deletes unused previous blobs. A human cover operation must retain art referenced by history and pending proposals, protect approved human art from imports, and apply through the existing Proposal/Revision transaction. Uploading a staged file must not change the catalog until save or approval. See the [cover caveat in the baseline](mangadb-editing-baseline.md#cover-history-implementation-caveat).

Direct edits currently store an empty evidence list. Description selection must extend that path to preserve the chosen citation, rather than merely inserting attribution into a comment. Display resolution also needs to return the owning record for contextual actions.

For assistant use, keep the record ID, field labels and source evidence explicit, and expose an ordinary file input. The first release needs no embedded chatbot. Any later agent integration should produce the same reviewable drafts and use the same permissions as a human contributor. Production edits still need the user's fresh explicit authorization under this repository's deployment rules.

The initial scope is items 1–3. That delivers the image and description workflows requested here while keeping the existing moderation system intact.
