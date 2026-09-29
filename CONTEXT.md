# MangaDB

A public database of manga volume releases, English-first: what volumes exist, when each edition comes out, and which ones you own or want.

"Manga" is judged by look, not origin: a book is in the catalog when it looks like manga rather than a Western comic. Manhua, manhwa, French manga-style books, and English-language (OEL/global) manga are in; US comic-book pamphlets, European album-format bandes dessinées, and graphic-novel biographies are out, as are prose and light novels, picture books, and merchandise.

## Language

**Series**:
A separately named manga work with its own Volume sequence, independent of language or publication packaging. A sequel or spinoff with its own numbering is another Series; a repackaging or renumbering of the same work is not.
_Avoid_: manga, title, work

**Series Family**:
A non-nestable umbrella for two or more related Series, such as "Tokyo Ghoul" and "Tokyo Ghoul:re." A Series belongs to at most one Series Family, while a lone Series does not have or display one.
_Avoid_: franchise, universe

**Series Relationship**:
A typed connection between Series in a Series Family, such as sequel, spinoff, or reboot.

**Source Status**:
The completion state of a Series' source work: Ongoing, Completed, Hiatus, or Cancelled. It describes the original publication, not the English edition's progress, and is imported like any other fact.

**Volume**:
A stable collected-content unit within a Series, normally defined by the work's source publication and independent of later packaging. A separately identifiable published extra may be an unnumbered Volume; incidental bonus material is not a Volume.
_Avoid_: book, tankobon

**Volume Position**:
The placement of a Volume within its Series' single canonical reading sequence. For a numbered Volume it is the volume number itself, so a gap in the sequence shows a missing Volume; an unnumbered Volume sorts after the last numbered one before it. It determines sequence independently of the Volume Label.

**Volume Label**:
The publisher-facing designation shown for a Volume, such as "7.5," "Side Story," or "Spring Log." It is not the Volume's identity or sort order.

**Volume Synopsis**:
An optional edition-independent summary of a Volume's content, curated by Editors. When absent, displays borrow the Release Description of a representative Release.

**Release**:
A specific purchasable publication of an Edition — one Format, Binding where applicable, one language, and optional ISBN-10 and ISBN-13 identifiers. An unchanged reprint or the same digital publication sold by another retailer retains its Release identity; a change to those characteristics creates another Release.
_Avoid_: edition, printing

**Release Description**:
The publisher-provided descriptive text for a specific Release, such as a back-cover blurb. It describes that edition of the content and may differ between Releases covering the same Volume.

**Release Variant**:
A visually distinct form of a Release, such as an alternate or box-set-exclusive cover, whose publication characteristics and content are otherwise unchanged. A user may identify the Release Variant they own without giving it a separate Release identity.

**Edition**:
A publisher's packaging of specific content — one Publisher, one Volume Coverage, and one Edition Line membership or none — realized by one or more Releases that differ only in Format and Binding. "Berserk Deluxe Edition Vol 4" is one Edition; its hardcover and digital Releases belong to it, while a 3-in-1 omnibus of the same chapters is a different Edition.
_Avoid_: version, printing

**Format**:
How a Release is published — physical or digital in v1.

**Binding**:
The physical construction of a Release, such as paperback or hardcover. Binding applies only to physical Releases.

**Edition Line**:
A publisher-named family of Releases, such as "Deluxe Edition" or "3-in-1," with consistent branding, content mapping, and numbering. An Edition Line belongs to the base Series whose Volumes it collects: an omnibus or deluxe book is never a Series or a Volume of its own. An Edition Line may span physical and digital Formats; format alone does not define a different line, and ordinary Releases need not belong to any line.

**Edition Line Position**:
An Edition's sequence label within its Edition Line, independent of the identities and numbers of the Volumes it covers.

**Bookless Series**:
An active Series whose Volumes are known but to which no English book has attached — no Edition covers any Volume and no Edition Line has a member. Usually a backbone a source built (ANN) whose releases could not be placed: an unknown distributor, packaging-only releases, no ISBN. The Series library rebuild derives and clears the flag; while it stands, the Series is kept out of browse, search, the home page and the sitemap, its page stays reachable, and the Data Team reviews it. Not a Hidden Record: imports keep attaching books to it.
_Avoid_: empty series, orphan series

**Mature Series**:
A Series for adults only: rated 18+ by a source (a publisher's own age rating, or ANN's), with an Edition from an adult-only publisher, or so rated by the Data Team, whose call wins either way. Discovery (browse, search, the calendar, the Publishers board, author shelves, the sitemap) leaves it out unless the viewer has opted in to mature titles; its pages stay reachable but hide their cover art until then. A publisher's teen or older-teen rating does not make a Series mature.
_Avoid_: NSFW, adult manga, explicit

**Unmapped Packaging**:
An Edition Line member whose source never stated which Volumes it collects — no title range, no blurb statement, no line name with a fixed size. It has no Volume Coverage yet, shows under its line in the publisher's own numbering, and waits in the Data Team's unmapped queue for a Moderator to map its Volumes. Ownership and reading progress follow the Volumes only once mapped.
_Avoid_: unplaced, orphan edition

**Volume Coverage**:
The ordered mapping from an Edition to the Volumes whose content it contains, including whether each Volume is covered completely or partially. A Release inherits the coverage of its Edition; this lets split and omnibus Editions retain the identity of their source Volumes.

**Release Bundle**:
A purchasable, non-nestable package, such as a box set, containing multiple Releases. It has its own publication facts, while its member books retain their individual Release identities; the bundle may identify a particular Release Variant for a member.

**Series Reading Status**:
A user's explicitly chosen overall reading relationship with a Series: Plan to Read, Reading, Paused, Dropped, or Completed. It is not derived from progress through any particular Volume or Release.

**Release Progress**:
A user's active reading pass through a specific Release, optionally expressed as a user-estimated percentage from 0% to 100%. Reaching 100% suggests completion, but the pass is complete only after the user confirms it; confirmation increments the read count of every completely covered Volume and does not affect partially covered Volumes.

**Volume Progress**:
A user's edition-independent completed-reading history for a Volume, expressed as a completed read count. It may be updated directly or by confirmed completion of a Release that covers the Volume; another completed pass is a reread.
_Avoid_: Release Progress

**Collection Entry**:
A user's relationship to a specific Release or Release Bundle, in exactly one of three states: Wanted, Ordered, or Owned. A Release entry may optionally identify a Release Variant, and every Collection Entry is independent of Volume Progress.
_Avoid_: owned Volume, reading status

**Derived Ownership**:
Ownership of a Release inherited from an Owned Collection Entry for a Release Bundle containing it. Derived Ownership coexists with direct ownership and disappears with the bundle entry without erasing any direct entry.

**Series Follow**:
A user's explicit choice to track future Releases for a Series, independent of Collection Entries and Volume Progress. Recording another tracking fact may suggest a Series Follow but never creates one without confirmation.
_Avoid_: subscription

**Upcoming Release**:
A Canonical Release with a known future publication date. A hoped-for publication that no publisher has announced is not an Upcoming Release.

**My Upcoming Releases**:
A user's view of Upcoming Releases that either belong to a followed Series and match the user's Physical, Digital, or Both format preference, or have a Wanted or Ordered Collection Entry. Every item is a known Canonical Release; Wanted and Ordered entries appear regardless of the followed-Series format preference.

**Tracking Visibility**:
A user's private-by-default sharing policy for Ownership and Reading, with separate defaults for each and per-Series overrides. Visibility is not configured separately for individual Volumes or Releases.

**Rating**:
A User's private whole-number score from 1 to 10 for one Series or one Volume, at most one per target, which the User may change or clear. Only the target's average and count are public, apart from the score shown beside the same User's Review; rated Series appear on a profile only where the User's Reading is public.
_Avoid_: score, stars, vote

**Review**:
A User's public plain-text write-up of one Series or one Volume, at most one per target, signed with their username and shown beside their Rating when they have one. It may be marked as containing spoilers, and only its author edits or deletes it. A Moderator may hide it, after which only Moderators and the author see it.
_Avoid_: comment, post

**Comment**:
A User's short public plain-text post on one Series or one Volume page, signed with their username, or a reply to such a post; replies go one level deep. It may be marked as containing spoilers, and only its author edits or deletes it. It is published at once unless a hold rule sends it to the Data Team first; a Moderator may hide, remove, or restore it.
_Avoid_: review, reply thread

**Comment Report**:
One User's flag on another User's published Comment, with a reason (spam, harassment, spoiler, off-topic, or other). A User reports a Comment at most once; three distinct Comment Reports hide it until a Moderator decides.
_Avoid_: flag, complaint

**Shadowed User**:
A User whose Comments a Moderator has quietly muted: they still look published to that User and are hidden from everyone else. Shadowing covers the User's past and future Comments and is lifted by unshadowing.
_Avoid_: shadow ban, banned user

**User**:
A person with a MangaDB account who owns personal tracking state and visibility choices. A User remains the same person across linked sign-in methods or email-address changes.
_Avoid_: Clerk user, account

**Publisher**:
The company issuing a Release (e.g. VIZ Media, Seven Seas). One company is one Publisher, whatever strings sources use for it ("Kodansha Comics" is Kodansha). An imprint (e.g. Ghost Ship) is a Publisher of its own that names its parent company; imprints nest one level only. A Publisher that no longer publishes English manga (ADV, Tokyopop's Blu, CMX) stays a Publisher, marked defunct; its Releases remain in the catalog.
_Avoid_: brand

**Approved Source**:
An external data source registered for imports, with a defined scope of records it may speak about, per-field Field Authority levels, and an import cadence. Only Approved Sources produce Source Observations.
_Avoid_: scraper, feed

**Field Authority**:
An Approved Source's per-field trust rank — authoritative, standard, or weak — within its scope. An observed value automatically updates a Canonical Record only over a strictly lower-Authority value; equal-Authority disagreement requires human review, and lower-Authority disagreement is recorded without review.

**Bootstrap Mode**:
A pre-launch import state in which Approved Sources may create Canonical Records directly, including new Series, without queued review; quality is checked by sampling instead. It is switched off permanently before public launch, after which steady-state review rules apply.

**Bootstrap-Unreviewed**:
A marker on a Canonical Record created during Bootstrap Mode that steady-state rules would have queued for review. It identifies the post-launch review backlog and does not affect the record's public display.

**Source Observation**:
A fact reported by an external data source about a Series, Volume, or Release. Source Observations inform MangaDB's data but do not override an approved human decision.

**Withdrawn Observation**:
A Source Observation whose record disappeared from a complete sweep of its source. It is retained, never deleted, and never changes a Canonical Record by itself; when its linked Release is still future-dated, it queues a possible-cancellation review.

**Import Run**:
One recorded execution of an Approved Source's import: source, timing, records seen and changed, and errors. Runs happen unattended on the source's registry cadence; three consecutive failed Import Runs mark the source Unhealthy.

**Unhealthy Source**:
An Approved Source whose last three Import Runs all failed. The transition emails the Administrator once and flags the Data Team dashboard; the first succeeding run restores it to healthy with one recovery email.

**Canonical Record**:
MangaDB's currently approved representation of a Series, Volume, or Release. This is what the public site displays.

**Human Override**:
An approved field-level correction to a Canonical Record. Imports may report a conflicting Source Observation but cannot replace the corrected value until a Moderator explicitly clears the override.

**Proposal**:
A coherent, atomic data-maintenance intent submitted for review. A Proposal may affect multiple Canonical Records when all of its changes must succeed or fail together; unrelated changes belong in separate Proposals.

**Proposal Version**:
An immutable snapshot of a Proposal submitted for review. Requested changes return the Proposal to Draft, and its next submission creates another Proposal Version.

**Revision**:
An immutable entry in a Canonical Record's public history describing an approved change, who or what made it, and why.

**Data Team**:
The Editors, Moderators, and Administrators who maintain Canonical Records. All members may inspect submitted Proposals, while only Moderators and Administrators may approve or reject them.

**Hidden Record**:
A Canonical Record removed from public discovery without losing its identity, history, tracking references, or data-team visibility. Restoring it reactivates the same record.

**Merged Record**:
A former Canonical Record atomically subsumed into a surviving Canonical Record. Its identity and history remain available for audit, while its public URLs redirect to the survivor.

**Locked Record**:
A Canonical Record temporarily closed to ordinary changes during a dispute or incident. Hidden Records and Merged Records are locked by their nature, while an active record may be unlocked when the concern is resolved.

**Editor**:
A trusted contributor appointed by an Administrator or Moderator. Editors propose changes to Canonical Records; their proposals require Moderator approval.

**Moderator**:
A reviewer appointed by an Administrator. Moderators approve or reject proposed changes and may appoint Editors.

**Administrator**:
The role responsible for appointing Moderators and governing data-maintenance access.
